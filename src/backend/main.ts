import "dotenv/config";
import {createServer} from "node:http";
import {createGexepA2AApp} from "./A2A/GexepA2AServer.ts";
import {createInternalA2AApp} from "./A2A/InternalA2AServer.ts";
import {
    InternalAgentRegistry,
    registerPantheonAgents,
} from "./A2A/InternalAgentRegistry.ts";
import {logger} from "./logger.ts";

await import("./database/initDatabase.ts");
const [{GexepAgent}, {JezehAgent}, {LexeyAgent}, {ZebehAgent}] = await Promise.all([
    import("./DeepSeek/Agents/Gexep/GexepAgent.ts"),
    import("./DeepSeek/Agents/Jezeh/JezehAgent.ts"),
    import("./DeepSeek/Agents/Lexey/LexeyAgent.ts"),
    import("./DeepSeek/Agents/Zebeh/ZebehAgent.ts"),
]);

const host = process.env.PANTHEON_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PANTHEON_PORT || "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PANTHEON_PORT 必须是 1 到 65535 之间的整数。");
}

const internalHost = "127.0.0.1";
const internalPort = Number.parseInt(process.env.PANTHEON_INTERNAL_PORT || "3001", 10);
if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535) {
    throw new Error("PANTHEON_INTERNAL_PORT 必须是 1 到 65535 之间的整数。");
}
if (internalPort === port && (host === internalHost || host === "0.0.0.0" || host === "::")) {
    throw new Error("PANTHEON_INTERNAL_PORT 不能与公开 A2A 服务使用同一监听端口。");
}

const publicBaseUrl = process.env.PANTHEON_PUBLIC_URL || `http://127.0.0.1:${port}`;
const internalBaseUrl = `http://${internalHost}:${internalPort}`;
const apiToken = process.env.PANTHEON_API_TOKEN || undefined;
const internalAgentRegistry = new InternalAgentRegistry(apiToken);
const gexep = new GexepAgent(internalAgentRegistry);
const jezeh = new JezehAgent(undefined, undefined, internalAgentRegistry);
const lexey = new LexeyAgent(internalAgentRegistry);
const zebeh = new ZebehAgent(internalAgentRegistry);
registerPantheonAgents(
    internalAgentRegistry,
    {Gexep: gexep, Jezeh: jezeh, Lexey: lexey, Zebeh: zebeh},
    apiToken === undefined
        ? {publicBaseUrl, internalBaseUrl}
        : {publicBaseUrl, internalBaseUrl, apiToken},
);

const app = createGexepA2AApp(
    gexep,
    apiToken === undefined ? {publicBaseUrl} : {publicBaseUrl, apiToken},
);
const server = createServer(app);
const internalServer = createServer(createInternalA2AApp(internalAgentRegistry));

server.listen(port, host, () => {
    logger.info({host, port, publicBaseUrl}, "Gexep A2A server started");
});
internalServer.listen(internalPort, internalHost, () => {
    logger.info(
        {host: internalHost, port: internalPort, agents: ["Jezeh", "Lexey", "Zebeh"]},
        "Internal peer A2A server started",
    );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        for (const activeServer of [server, internalServer]) {
            activeServer.close((error) => {
                if (error !== undefined) {
                    logger.error(error, "Failed to stop A2A server");
                    process.exitCode = 1;
                }
            });
        }
    });
}
