import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {SendMessageRequest, SendMessageResponse} from "@a2a-js/sdk";
import {
    DefaultRequestHandler,
    InMemoryTaskStore,
    defaultServerCallContextBuilder,
} from "@a2a-js/sdk/server";
import {
    InternalAgentRegistry,
    registerPantheonAgents,
    type A2AAgentHandle,
    type PantheonAgentSet,
} from "../src/backend/A2A/InternalAgentRegistry.ts";
import {createInternalA2AApp} from "../src/backend/A2A/InternalA2AServer.ts";
import type {DelegationTrace} from "../src/backend/A2A/DelegationContext.ts";
import {PantheonAgentExecutor} from "../src/backend/A2A/GexepA2AServer.ts";

class FakeAgent implements A2AAgentHandle {
    readonly traces: Array<DelegationTrace | undefined> = [];

    setEventListener(): void {}

    async ask(input: string, options?: {delegationTrace?: DelegationTrace}): Promise<string> {
        this.traces.push(options?.delegationTrace);
        return `handled: ${input}`;
    }
}

function createRegistry(
    internalBaseUrl = "http://127.0.0.1:3001",
    agents?: PantheonAgentSet,
): InternalAgentRegistry {
    const fallbackAgent = new FakeAgent();
    const registry = new InternalAgentRegistry();
    registerPantheonAgents(
        registry,
        agents ?? {
            Gexep: fallbackAgent,
            Jezeh: fallbackAgent,
            Lexey: fallbackAgent,
            Zebeh: fallbackAgent,
        },
        {
            publicBaseUrl: "https://pantheon.example",
            internalBaseUrl,
        },
    );
    return registry;
}

describe("Pantheon peer A2A registry", () => {
    it("lets each agent discover every other Agent Card but not itself", () => {
        const registry = createRegistry();

        assert.deepEqual(
            registry.discover(undefined, "Gexep").agentCards.map(({name}) => name),
            ["Jezeh", "Lexey", "Zebeh"],
        );
        assert.deepEqual(
            registry.discover(undefined, "Lexey").agentCards.map(({name}) => name),
            ["Gexep", "Jezeh", "Zebeh"],
        );
    });

    it("returns standard callable cards and filters them by skill", () => {
        const registry = createRegistry();
        const result = registry.discover("translation", "Gexep");

        assert.equal(result.total, 1);
        assert.equal(result.agentCards[0]?.name, "Lexey");
        assert.equal(
            result.agentCards[0]?.supportedInterfaces[0]?.url,
            "http://127.0.0.1:3001/agents/lexey/a2a",
        );
        assert.equal(result.agentCards[0]?.skills[0]?.id, "language-research");
    });

    it("mounts one path-scoped official A2A app for every internal agent", () => {
        const app = createInternalA2AApp(createRegistry());
        const layers = app.router.stack as unknown as Array<{
            matchers: Array<(path: string) => false | {path: string}>;
        }>;

        assert.equal(layers.length, 3);
        for (const name of ["jezeh", "lexey", "zebeh"]) {
            assert.ok(layers.some((layer) => layer.matchers[0]?.(`/agents/${name}/a2a`) !== false));
        }
        assert.ok(layers.every((layer) => layer.matchers[0]?.("/agents/gexep/a2a") === false));
    });

    it("keeps only Gexep in the public registration", () => {
        const publicEntries = createRegistry().entries("public");

        assert.equal(publicEntries.length, 1);
        assert.equal(publicEntries[0]?.card.name, "Gexep");
    });

    it("delegates through the official client/server path and propagates loop metadata", async () => {
        const lexey = new FakeAgent();
        const other = new FakeAgent();
        const handlers = new Map<string, DefaultRequestHandler>();
        const sdkFetch: typeof fetch = async (input, init) => {
            const handler = handlers.get(String(input));
            assert.ok(handler !== undefined, `missing handler for ${String(input)}`);
            const envelope = JSON.parse(String(init?.body)) as {
                id: number;
                method: string;
                params: unknown;
            };
            assert.equal(envelope.method, "SendMessage");
            const request = SendMessageRequest.fromJSON(envelope.params);
            const context = defaultServerCallContextBuilder({
                extensions: undefined,
                user: undefined,
                headers: {},
                requestedVersion: "1.0",
                tenant: request.tenant,
            });
            const result = await handler.sendMessage(request, context);
            const payload = "id" in result
                ? {$case: "task" as const, value: result}
                : {$case: "message" as const, value: result};
            return Response.json({
                jsonrpc: "2.0",
                id: envelope.id,
                result: SendMessageResponse.toJSON({payload}),
            });
        };
        const registry = new InternalAgentRegistry(undefined, sdkFetch);
        registerPantheonAgents(registry, {
            Gexep: other,
            Jezeh: other,
            Lexey: lexey,
            Zebeh: other,
        }, {
            publicBaseUrl: "https://pantheon.example",
            internalBaseUrl: "http://internal.example",
        });
        for (const entry of registry.entries("internal")) {
            const endpoint = entry.card.supportedInterfaces[0]?.url;
            assert.ok(endpoint !== undefined);
            handlers.set(endpoint, new DefaultRequestHandler(
                entry.card,
                new InMemoryTaskStore(),
                new PantheonAgentExecutor(entry.agent, entry.card.name),
            ));
        }

        const result = await registry.delegate("Gexep", "Lexey", "翻译 hello", undefined, {
            traceId: crypto.randomUUID(),
            path: ["Gexep"],
        });

        assert.equal(result.agentName, "Lexey");
        assert.equal(result.text, "handled: 翻译 hello");
        assert.deepEqual(lexey.traces[0]?.path, ["Gexep", "Lexey"]);
        await assert.rejects(
            registry.delegate("Lexey", "Gexep", "回传", undefined, lexey.traces[0]),
            /循环委派/,
        );
    });
});
