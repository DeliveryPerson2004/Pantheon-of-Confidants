import express, {type Express} from "express";
import {buildAgentCard, createAgentA2AApp} from "./GexepA2AServer.ts";
import type {InternalAgentRegistry} from "./InternalAgentRegistry.ts";

/**
 * Creates the path-scoped A2A endpoints for non-public Pantheon agents.
 * The caller must bind this app to a loopback address.
 */
export function createInternalA2AApp(registry: InternalAgentRegistry): Express {
    const app = express();
    app.disable("x-powered-by");

    for (const {profile, agent} of registry.entries("internal")) {
        const card = buildAgentCard({
            name: profile.name,
            description: profile.description,
            rpcUrl: profile.rpcUrl,
            skills: profile.skills,
        });
        app.use(
            `/agents/${profile.name.toLocaleLowerCase()}`,
            createAgentA2AApp(agent, {agentCard: card}),
        );
    }

    return app;
}
