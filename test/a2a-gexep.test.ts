import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {GexepA2AClient, type GexepClientEvent} from "../src/a2a/GexepA2AClient.ts";
import {
    A2A_AGENT_CARD_PATH,
    A2A_PROTOCOL_VERSION,
    type JsonRpcRequest,
    type JsonRpcSuccess,
    type ListTasksResult,
    type StreamResponse,
} from "../src/a2a/types.ts";
import {
    buildGexepAgentCard,
    GexepTaskService,
    type GexepAgentPort,
} from "../src/backend/A2A/GexepA2AServer.ts";
import type {AgentEventListener} from "../src/backend/DeepSeek/Agents/BaseAgent.ts";

class FakeGexepAgent implements GexepAgentPort {
    private listener: AgentEventListener | undefined;

    setEventListener(listener: AgentEventListener | undefined): void {
        this.listener = listener;
    }

    async ask(input: string): Promise<string> {
        this.listener?.({type: "start", agentName: "Gexep"});
        this.listener?.({type: "function_call", name: "internal_tool"});
        const answer = `Gexep: ${input}`;
        this.listener?.({type: "message", text: answer});
        this.listener?.({type: "complete", agentName: "Gexep"});
        return answer;
    }
}

function sendParams(text: string, contextId?: string) {
    return {
        message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER" as const,
            parts: [{text, mediaType: "text/plain"}],
            ...(contextId === undefined ? {} : {contextId}),
        },
        configuration: {acceptedOutputModes: ["text/markdown"]},
    };
}

describe("Gexep A2A public boundary", () => {
    it("Agent Card only advertises Gexep and A2A 1.0 JSON-RPC", () => {
        const card = buildGexepAgentCard({publicBaseUrl: "https://pantheon.example"});

        assert.equal(card.name, "Gexep");
        assert.equal(card.supportedInterfaces[0]?.url, "https://pantheon.example/a2a");
        assert.equal(card.supportedInterfaces[0]?.protocolBinding, "JSONRPC");
        assert.equal(card.supportedInterfaces[0]?.protocolVersion, "1.0");
        assert.equal(card.capabilities.streaming, true);
        assert.equal(JSON.stringify(card).includes("Lexey"), false);
        assert.equal(JSON.stringify(card).includes("Jezeh"), false);
        assert.equal(JSON.stringify(card).includes("Zebeh"), false);
    });

    it("only declares Bearer authentication when a token is configured", () => {
        const publicCard = buildGexepAgentCard({publicBaseUrl: "https://pantheon.example"});
        const protectedCard = buildGexepAgentCard({
            publicBaseUrl: "https://pantheon.example",
            apiToken: "secret",
        });

        assert.equal(publicCard.securitySchemes, undefined);
        assert.equal(protectedCard.securitySchemes?.bearerAuth?.httpAuthSecurityScheme.scheme, "Bearer");
        assert.deepEqual(protectedCard.securityRequirements, [{bearerAuth: []}]);
    });
});

describe("Gexep A2A task service", () => {
    it("creates a completed task whose answer is an artifact", async () => {
        const service = new GexepTaskService(new FakeGexepAgent());
        const params = sendParams("你好");
        const task = service.createTask(params);
        await service.runTask(task, "你好");

        const fetched = service.getTask(task.id);
        assert.equal(fetched.status.state, "TASK_STATE_COMPLETED");
        assert.equal(fetched.artifacts?.[0]?.parts[0]?.text, "Gexep: 你好");
        assert.equal(fetched.history?.[0]?.messageId, params.message.messageId);
    });

    it("lists newest tasks and omits artifacts by default", async () => {
        const service = new GexepTaskService(new FakeGexepAgent());
        const task = service.createTask(sendParams("列表测试"));
        await service.runTask(task, "列表测试");

        const listed: ListTasksResult = service.listTasks({});
        assert.equal(listed.totalSize, 1);
        assert.equal(listed.tasks[0]?.artifacts, undefined);
        assert.equal(service.listTasks({includeArtifacts: true}).tasks[0]?.artifacts?.length, 1);
    });

    it("serializes execution because BaseAgent conversation state is mutable", async () => {
        const order: string[] = [];
        const agent: GexepAgentPort = {
            setEventListener: () => undefined,
            ask: async (input) => {
                order.push(`start:${input}`);
                await Promise.resolve();
                order.push(`end:${input}`);
                return input;
            },
        };
        const service = new GexepTaskService(agent);
        const first = service.createTask(sendParams("first"));
        const second = service.createTask(sendParams("second"));

        await Promise.all([
            service.runTask(first, "first"),
            service.runTask(second, "second"),
        ]);
        assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
    });
});

describe("Gexep A2A frontend client", () => {
    it("discovers the card, consumes SSE, and reuses the server contextId", async () => {
        const requests: JsonRpcRequest[] = [];
        const fetchImplementation: typeof fetch = async (input, init) => {
            if (String(input).endsWith(A2A_AGENT_CARD_PATH)) {
                return Response.json(buildGexepAgentCard({publicBaseUrl: "https://pantheon.example"}), {
                    headers: {"Content-Type": "application/a2a+json"},
                });
            }

            const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
            requests.push(request);
            const params = request.params as ReturnType<typeof sendParams>;
            const contextId = params.message.contextId ?? "server-context";
            const taskId = crypto.randomUUID();
            const answer = `Gexep: ${params.message.parts[0]?.text}`;
            const events: StreamResponse[] = [
                {
                    task: {
                        id: taskId,
                        contextId,
                        status: {state: "TASK_STATE_SUBMITTED", timestamp: new Date().toISOString()},
                    },
                },
                {
                    statusUpdate: {
                        taskId,
                        contextId,
                        status: {state: "TASK_STATE_WORKING", timestamp: new Date().toISOString()},
                    },
                },
                {
                    artifactUpdate: {
                        taskId,
                        contextId,
                        artifact: {
                            artifactId: crypto.randomUUID(),
                            parts: [{text: answer, mediaType: "text/markdown"}],
                        },
                        lastChunk: true,
                    },
                },
                {
                    statusUpdate: {
                        taskId,
                        contextId,
                        status: {state: "TASK_STATE_COMPLETED", timestamp: new Date().toISOString()},
                    },
                },
            ];
            const sse = events.map((event) => {
                const envelope: JsonRpcSuccess<StreamResponse> = {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: event,
                };
                return `data: ${JSON.stringify(envelope)}\n\n`;
            }).join("");
            return new Response(sse, {headers: {"Content-Type": "text/event-stream"}});
        };
        const client = new GexepA2AClient({
            agentCardUrl: "https://pantheon.example/.well-known/agent-card.json",
            fetchImplementation,
        });
        const events: GexepClientEvent[] = [];
        client.setEventListener((event) => events.push(event));

        assert.equal(await client.ask("第一轮"), "Gexep: 第一轮");
        assert.equal(await client.ask("第二轮"), "Gexep: 第二轮");
        assert.equal(requests[0]?.method, "SendStreamingMessage");
        assert.equal(
            (requests[1]?.params as ReturnType<typeof sendParams>).message.contextId,
            "server-context",
        );
        assert.ok(events.some((event) => event.type === "status"));
        assert.equal(A2A_PROTOCOL_VERSION, "1.0");
    });
});
