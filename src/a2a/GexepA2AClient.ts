import {randomUUID} from "node:crypto";
import {
    A2A_AGENT_CARD_PATH,
    A2A_PROTOCOL_VERSION,
    type AgentCard,
    type JsonRpcError,
    type JsonRpcId,
    type JsonRpcResponse,
    type SendMessageResult,
    type StreamResponse,
    type Task,
    textFromParts,
    textFromTask,
} from "./types.ts";

export type GexepClientEvent =
    | {type: "start"}
    | {type: "status"; text: string}
    | {type: "message"; text: string}
    | {type: "complete"}
    | {type: "error"; error: Error};

export type GexepClientEventListener = (event: GexepClientEvent) => void;

export interface GexepA2AClientOptions {
    agentCardUrl?: string;
    apiToken?: string;
    fetchImplementation?: typeof fetch;
}

function isJsonRpcError<T>(response: JsonRpcResponse<T>): response is JsonRpcError {
    return "error" in response;
}

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export class GexepA2AClient {
    private readonly agentCardUrl: string;
    private readonly apiToken: string | undefined;
    private readonly fetchImplementation: typeof fetch;
    private cardPromise: Promise<AgentCard> | undefined;
    private contextId: string | undefined;
    private listener: GexepClientEventListener | undefined;

    constructor(options: GexepA2AClientOptions = {}) {
        this.agentCardUrl = options.agentCardUrl
            ?? `http://127.0.0.1:3000${A2A_AGENT_CARD_PATH}`;
        this.apiToken = options.apiToken;
        this.fetchImplementation = options.fetchImplementation ?? fetch;
    }

    setEventListener(listener: GexepClientEventListener | undefined): void {
        this.listener = listener;
    }

    async getAgentCard(): Promise<AgentCard> {
        this.cardPromise ??= this.fetchAgentCard();
        return this.cardPromise;
    }

    async ask(input: string): Promise<string> {
        this.listener?.({type: "start"});
        try {
            const card = await this.getAgentCard();
            const rpcInterface = card.supportedInterfaces.find(
                (candidate) => candidate.protocolBinding === "JSONRPC"
                    && candidate.protocolVersion === A2A_PROTOCOL_VERSION,
            );
            if (rpcInterface === undefined) {
                throw new Error(`Gexep Agent Card 未声明 A2A ${A2A_PROTOCOL_VERSION} JSON-RPC 接口。`);
            }

            const answer = card.capabilities.streaming === true
                ? await this.askStreaming(rpcInterface.url, input)
                : await this.askBlocking(rpcInterface.url, input);
            this.listener?.({type: "message", text: answer});
            this.listener?.({type: "complete"});
            return answer;
        } catch (error) {
            const normalized = normalizeError(error);
            this.listener?.({type: "error", error: normalized});
            throw normalized;
        }
    }

    private async fetchAgentCard(): Promise<AgentCard> {
        const response = await this.fetchImplementation(this.agentCardUrl, {
            headers: {Accept: "application/a2a+json, application/json"},
        });
        if (!response.ok) {
            throw new Error(`读取 Gexep Agent Card 失败（HTTP ${response.status}）。`);
        }
        return await response.json() as AgentCard;
    }

    private createRequest(input: string, method: "SendMessage" | "SendStreamingMessage") {
        return {
            jsonrpc: "2.0" as const,
            id: randomUUID(),
            method,
            params: {
                message: {
                    messageId: randomUUID(),
                    role: "ROLE_USER" as const,
                    parts: [{text: input, mediaType: "text/plain"}],
                    ...(this.contextId === undefined ? {} : {contextId: this.contextId}),
                },
                configuration: {
                    acceptedOutputModes: ["text/markdown", "text/plain"],
                },
            },
        };
    }

    private requestHeaders(): Record<string, string> {
        return {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "A2A-Version": A2A_PROTOCOL_VERSION,
            ...(this.apiToken === undefined ? {} : {Authorization: `Bearer ${this.apiToken}`}),
        };
    }

    private async askBlocking(url: string, input: string): Promise<string> {
        const request = this.createRequest(input, "SendMessage");
        const response = await this.fetchImplementation(url, {
            method: "POST",
            headers: this.requestHeaders(),
            body: JSON.stringify(request),
        });
        const payload = await response.json() as JsonRpcResponse<SendMessageResult>;
        this.throwForRpcError(payload, response.status);
        const result = payload.result;
        if (result.task !== undefined) {
            return this.answerFromTask(result.task);
        }
        if (result.message !== undefined) {
            this.contextId = result.message.contextId;
            return textFromParts(result.message.parts);
        }
        throw new Error("Gexep A2A 响应未包含 task 或 message。");
    }

    private async askStreaming(url: string, input: string): Promise<string> {
        const request = this.createRequest(input, "SendStreamingMessage");
        const response = await this.fetchImplementation(url, {
            method: "POST",
            headers: this.requestHeaders(),
            body: JSON.stringify(request),
        });
        if (!response.ok || !response.body) {
            const payload = await response.json().catch(() => undefined) as JsonRpcError | undefined;
            if (payload !== undefined && "error" in payload) {
                throw new Error(`Gexep A2A 错误 ${payload.error.code}：${payload.error.message}`);
            }
            throw new Error(`Gexep A2A 流式请求失败（HTTP ${response.status}）。`);
        }

        let answer = "";
        let latestTask: Task | undefined;
        await this.consumeSse(response.body, request.id, (event) => {
            if ("task" in event) {
                latestTask = event.task;
                this.contextId = event.task.contextId;
                this.listener?.({type: "status", text: "Gexep 已接收任务…"});
                return;
            }
            if ("statusUpdate" in event) {
                const status = event.statusUpdate.status;
                const detail = status.message === undefined ? "" : textFromParts(status.message.parts);
                if (status.state === "TASK_STATE_FAILED") {
                    throw new Error(detail || "Gexep 任务执行失败。");
                }
                if (status.state === "TASK_STATE_WORKING") {
                    this.listener?.({type: "status", text: detail || "Gexep 正在处理…"});
                }
                return;
            }
            if ("artifactUpdate" in event) {
                answer += textFromParts(event.artifactUpdate.artifact.parts);
                return;
            }
            if ("message" in event) {
                answer += textFromParts(event.message.parts);
                this.contextId = event.message.contextId;
            }
        });

        if (!answer && latestTask !== undefined) {
            answer = textFromTask(latestTask);
        }
        if (!answer) {
            throw new Error("Gexep A2A 流已结束，但没有返回文本结果。");
        }
        return answer;
    }

    private async consumeSse(
        body: ReadableStream<Uint8Array>,
        requestId: JsonRpcId,
        onEvent: (event: StreamResponse) => void,
    ): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const {done, value} = await reader.read();
            buffer += decoder.decode(value, {stream: !done});
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) {
                this.consumeSseBlock(block, requestId, onEvent);
            }
            if (done) {
                if (buffer.trim()) {
                    this.consumeSseBlock(buffer, requestId, onEvent);
                }
                break;
            }
        }
    }

    private consumeSseBlock(
        block: string,
        requestId: JsonRpcId,
        onEvent: (event: StreamResponse) => void,
    ): void {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trimStart())
            .join("\n");
        if (!data) {
            return;
        }
        const payload = JSON.parse(data) as JsonRpcResponse<StreamResponse>;
        this.throwForRpcError(payload, 200);
        if (payload.id !== requestId) {
            throw new Error("Gexep A2A 流返回了不匹配的 JSON-RPC id。");
        }
        onEvent(payload.result);
    }

    private answerFromTask(task: Task): string {
        this.contextId = task.contextId;
        if (task.status.state === "TASK_STATE_FAILED") {
            const detail = task.status.message === undefined ? "" : textFromParts(task.status.message.parts);
            throw new Error(detail || "Gexep 任务执行失败。");
        }
        const answer = textFromTask(task);
        if (!answer) {
            throw new Error(`Gexep 任务状态为 ${task.status.state}，尚无可用结果。`);
        }
        return answer;
    }

    private throwForRpcError<T>(payload: JsonRpcResponse<T>, httpStatus: number): asserts payload is Exclude<JsonRpcResponse<T>, JsonRpcError> {
        if (isJsonRpcError(payload)) {
            throw new Error(`Gexep A2A 错误 ${payload.error.code}：${payload.error.message}`);
        }
        if (httpStatus < 200 || httpStatus >= 300) {
            throw new Error(`Gexep A2A 请求失败（HTTP ${httpStatus}）。`);
        }
    }
}
