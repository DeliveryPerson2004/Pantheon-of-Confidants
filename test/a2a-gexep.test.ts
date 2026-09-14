import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
    AgentCard,
    SendMessageRequest,
    StreamResponse,
} from "@a2a-js/sdk";
import {
    DefaultRequestHandler,
    InMemoryTaskStore,
    defaultServerCallContextBuilder,
} from "@a2a-js/sdk/server";
import {GexepA2AClient, type GexepClientEvent} from "../src/a2a/GexepA2AClient.ts";
import {A2A_AGENT_CARD_PATH, A2A_PROTOCOL_VERSION} from "../src/a2a/types.ts";
import {
    buildGexepAgentCard,
    createGexepA2AApp,
    PantheonAgentExecutor,
    type GexepAgentPort,
} from "../src/backend/A2A/GexepA2AServer.ts";
import type {DelegationTrace} from "../src/backend/A2A/DelegationContext.ts";
import type {AgentEventListener} from "../src/backend/DeepSeek/Agents/BaseAgent.ts";

class FakeGexepAgent implements GexepAgentPort {
    private listener: AgentEventListener | undefined;
    readonly traces: Array<DelegationTrace | undefined> = [];

    setEventListener(listener: AgentEventListener | undefined): void {
        this.listener = listener;
    }

    async ask(input: string, options?: {delegationTrace?: DelegationTrace}): Promise<string> {
        this.traces.push(options?.delegationTrace);
        this.listener?.({type: "function_call", name: "internal_tool"});
        return `Gexep: ${input}`;
    }
}

function createSdkFetch(
    card: AgentCard,
    handler: DefaultRequestHandler,
    requests: Array<Record<string, unknown>>,
): typeof fetch {
    return async (_input, init) => {
        if (init?.body === undefined) {
            return Response.json(AgentCard.toJSON(card), {
                headers: {"Content-Type": "application/a2a+json"},
            });
        }

        const envelope = JSON.parse(String(init.body)) as {
            id: number;
            method: string;
            params: unknown;
        };
        requests.push(envelope as unknown as Record<string, unknown>);
        assert.equal(envelope.method, "SendStreamingMessage");
        const request = SendMessageRequest.fromJSON(envelope.params);
        const context = defaultServerCallContextBuilder({
            extensions: undefined,
            user: undefined,
            headers: {},
            requestedVersion: A2A_PROTOCOL_VERSION,
            tenant: request.tenant,
        });
        const chunks: string[] = [];
        for await (const event of handler.sendMessageStream(request, context)) {
            chunks.push(`data: ${JSON.stringify({
                jsonrpc: "2.0",
                id: envelope.id,
                result: StreamResponse.toJSON(event),
            })}\n\n`);
        }
        return new Response(chunks.join(""), {
            headers: {"Content-Type": "text/event-stream"},
        });
    };
}

describe("Gexep A2A public boundary", () => {
    it("Agent Card only advertises Gexep and A2A 1.0 JSON-RPC", () => {
        const card = buildGexepAgentCard({publicBaseUrl: "https://pantheon.example"});

        assert.equal(card.name, "Gexep");
        assert.equal(card.supportedInterfaces[0]?.url, "https://pantheon.example/a2a");
        assert.equal(card.supportedInterfaces[0]?.protocolBinding, "JSONRPC");
        assert.equal(card.supportedInterfaces[0]?.protocolVersion, A2A_PROTOCOL_VERSION);
        assert.equal(card.capabilities?.streaming, true);
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

        assert.deepEqual(publicCard.securitySchemes, {});
        assert.equal(
            protectedCard.securitySchemes.bearerAuth?.scheme?.$case,
            "httpAuthSecurityScheme",
        );
        assert.deepEqual(
            protectedCard.securityRequirements,
            [{schemes: {bearerAuth: {list: []}}}],
        );
    });

    it("mounts only discovery, bearer guard, and the JSON-RPC handler", () => {
        const app = createGexepA2AApp(new FakeGexepAgent(), {
            publicBaseUrl: "https://pantheon.example",
            apiToken: "secret",
        });
        const layers = app.router.stack as Array<{path?: string}>;

        assert.equal(layers.length, 3);
        assert.equal(JSON.stringify(layers).includes("Jezeh"), false);
        assert.equal(A2A_AGENT_CARD_PATH, "/.well-known/agent-card.json");
    });
});

describe("Gexep official A2A client/server integration", () => {
    it("runs the official ClientFactory against DefaultRequestHandler and reuses contextId", async () => {
        const agent = new FakeGexepAgent();
        const card = buildGexepAgentCard({publicBaseUrl: "https://pantheon.example"});
        const handler = new DefaultRequestHandler(
            card,
            new InMemoryTaskStore(),
            new PantheonAgentExecutor(agent, "Gexep"),
        );
        const requests: Array<Record<string, unknown>> = [];
        const client = new GexepA2AClient({
            agentCardUrl: "https://pantheon.example/.well-known/agent-card.json",
            fetchImplementation: createSdkFetch(card, handler, requests),
        });
        const events: GexepClientEvent[] = [];
        client.setEventListener((event) => events.push(event));

        assert.equal(await client.ask("第一轮"), "Gexep: 第一轮");
        assert.equal(await client.ask("第二轮"), "Gexep: 第二轮");
        const first = SendMessageRequest.fromJSON(requests[0]?.params);
        const second = SendMessageRequest.fromJSON(requests[1]?.params);
        assert.equal(first.message?.contextId, "");
        assert.ok((second.message?.contextId.length ?? 0) > 0);
        assert.equal(first.message?.parts[0]?.content?.$case, "text");
        assert.ok(events.some((event) => event.type === "status"));
    });
});
