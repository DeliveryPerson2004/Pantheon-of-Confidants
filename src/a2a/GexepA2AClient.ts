import {
    TaskState,
    type AgentCard,
    type SendMessageRequest,
    type Task,
} from "@a2a-js/sdk";
import {
    ClientFactory,
    DefaultAgentCardResolver,
    JsonRpcTransportFactory,
    type Client,
} from "@a2a-js/sdk/client";
import {
    A2A_AGENT_CARD_PATH,
    taskStateLabel,
    textFromMessage,
    textFromParts,
    textFromTask,
    userMessage,
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

function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export class GexepA2AClient {
    private readonly clientPromise: Promise<Client>;
    private contextId: string | undefined;
    private listener: GexepClientEventListener | undefined;

    constructor(options: GexepA2AClientOptions = {}) {
        const agentCardUrl = options.agentCardUrl
            ?? `http://127.0.0.1:3000${A2A_AGENT_CARD_PATH}`;
        const publicFetch = options.fetchImplementation ?? fetch;
        const transportFetch = this.authenticatedFetch(publicFetch, options.apiToken);
        const factory = new ClientFactory({
            cardResolver: new DefaultAgentCardResolver({fetchImpl: publicFetch}),
            transports: [new JsonRpcTransportFactory({fetchImpl: transportFetch})],
        });
        this.clientPromise = factory.createFromUrl(agentCardUrl, "");
    }

    setEventListener(listener: GexepClientEventListener | undefined): void {
        this.listener = listener;
    }

    async getAgentCard(): Promise<AgentCard> {
        return await (await this.clientPromise).getAgentCard();
    }

    async ask(input: string): Promise<string> {
        this.listener?.({type: "start"});
        try {
            const client = await this.clientPromise;
            const request: SendMessageRequest = {
                tenant: "",
                message: userMessage(input, this.contextId),
                configuration: {
                    acceptedOutputModes: ["text/markdown", "text/plain"],
                    taskPushNotificationConfig: undefined,
                    returnImmediately: false,
                },
                metadata: undefined,
            };

            let answer = "";
            let latestTask: Task | undefined;
            for await (const event of client.sendMessageStream(request)) {
                const payload = event.payload;
                if (payload === undefined) {
                    continue;
                }
                switch (payload.$case) {
                    case "task":
                        latestTask = payload.value;
                        this.contextId = payload.value.contextId;
                        this.listener?.({type: "status", text: "Gexep 已接收任务…"});
                        break;
                    case "message":
                        answer += textFromMessage(payload.value);
                        this.contextId = payload.value.contextId;
                        break;
                    case "artifactUpdate":
                        if (payload.value.artifact !== undefined) {
                            answer += textFromParts(payload.value.artifact.parts);
                        }
                        break;
                    case "statusUpdate": {
                        const status = payload.value.status;
                        if (status === undefined) {
                            break;
                        }
                        const detail = status.message === undefined
                            ? ""
                            : textFromMessage(status.message);
                        if (
                            status.state === TaskState.TASK_STATE_FAILED
                            || status.state === TaskState.TASK_STATE_REJECTED
                            || status.state === TaskState.TASK_STATE_CANCELED
                        ) {
                            throw new Error(detail || `Gexep 任务状态为 ${taskStateLabel(status.state)}。`);
                        }
                        if (status.state === TaskState.TASK_STATE_WORKING) {
                            this.listener?.({type: "status", text: detail || "Gexep 正在处理…"});
                        }
                        break;
                    }
                }
            }

            if (!answer && latestTask !== undefined) {
                answer = textFromTask(latestTask);
            }
            if (!answer) {
                throw new Error("Gexep A2A 请求已结束，但没有返回文本结果。");
            }
            this.listener?.({type: "message", text: answer});
            this.listener?.({type: "complete"});
            return answer;
        } catch (error) {
            const normalized = normalizeError(error);
            this.listener?.({type: "error", error: normalized});
            throw normalized;
        }
    }

    private authenticatedFetch(fetchImplementation: typeof fetch, apiToken?: string): typeof fetch {
        if (apiToken === undefined) {
            return fetchImplementation;
        }
        return async (input, init = {}) => {
            const headers = new Headers(init.headers);
            headers.set("Authorization", `Bearer ${apiToken}`);
            return fetchImplementation(input, {...init, headers});
        };
    }
}
