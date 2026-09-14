import "dotenv/config";
import {A2A_AGENT_CARD_PATH} from "../a2a/types.ts";
import {GexepA2AClient} from "../a2a/GexepA2AClient.ts";
import {PantheonApp} from "./PantheonApp.ts";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Pantheon UI 需要在交互式终端中运行。");
}

const agentCardUrl = process.env.PANTHEON_A2A_CARD_URL
    || `http://127.0.0.1:${process.env.PANTHEON_PORT || "3000"}${A2A_AGENT_CARD_PATH}`;
const apiToken = process.env.PANTHEON_API_TOKEN || undefined;
const client = new GexepA2AClient(
    apiToken === undefined ? {agentCardUrl} : {agentCardUrl, apiToken},
);

const app = new PantheonApp({
    name: "Gexep",
    title: "唯一公开入口",
    description: "理解你的目标，并在明确授权后执行外部操作。",
    client,
});
app.start();
