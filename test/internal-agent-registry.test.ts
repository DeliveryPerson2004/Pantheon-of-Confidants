import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
    InternalAgentRegistry,
    registerPantheonAgents,
    type A2AAgentHandle,
} from "../src/backend/A2A/InternalAgentRegistry.ts";
import {createInternalA2AApp} from "../src/backend/A2A/InternalA2AServer.ts";

const fakeAgent: A2AAgentHandle = {
    ask: async (input) => input,
    setEventListener: () => undefined,
};

function createRegistry(): InternalAgentRegistry {
    const registry = new InternalAgentRegistry();
    registerPantheonAgents(
        registry,
        {Gexep: fakeAgent, Jezeh: fakeAgent, Lexey: fakeAgent, Zebeh: fakeAgent},
        {
            publicBaseUrl: "https://pantheon.example",
            internalBaseUrl: "http://127.0.0.1:3001",
        },
    );
    return registry;
}

describe("Pantheon peer A2A registry", () => {
    it("lets each agent discover every other agent but not itself", () => {
        const registry = createRegistry();

        assert.deepEqual(
            registry.discover(undefined, "Gexep").agents.map(({name}) => name),
            ["Jezeh", "Lexey", "Zebeh"],
        );
        assert.deepEqual(
            registry.discover(undefined, "Lexey").agents.map(({name}) => name),
            ["Gexep", "Jezeh", "Zebeh"],
        );
    });

    it("returns callable A2A locations and filters by capability", () => {
        const registry = createRegistry();
        const result = registry.discover("translation", "Gexep");

        assert.equal(result.total, 1);
        assert.equal(result.agents[0]?.name, "Lexey");
        assert.equal(result.agents[0]?.status, "available");
        assert.equal(
            result.agents[0]?.agentCardUrl,
            "http://127.0.0.1:3001/agents/lexey/.well-known/agent-card.json",
        );
        assert.equal(result.agents[0]?.rpcUrl, "http://127.0.0.1:3001/agents/lexey/a2a");
        assert.ok(result.agents[0]?.supportedOperations.includes("SendMessage"));
    });

    it("mounts one path-scoped A2A application for every internal agent", () => {
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

    it("does not expose internal identities in Gexep's public registration", () => {
        const registry = createRegistry();
        const publicEntries = registry.entries("public");

        assert.equal(publicEntries.length, 1);
        assert.equal(publicEntries[0]?.profile.name, "Gexep");
    });
});
