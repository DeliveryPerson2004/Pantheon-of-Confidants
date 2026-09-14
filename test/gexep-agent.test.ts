import assert from "node:assert/strict";
import {after, afterEach, describe, it, mock} from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
    InputFunctionCallItem,
    InputFunctionCallOutputItem,
    InputItemType,
} from "../src/backend/DeepSeek/API/responses.ts";
import type {SendEmailInputType} from "../src/backend/Tools/sendEmail.ts";
import type {AgentDirectory} from "../src/backend/A2A/InternalAgentRegistry.ts";


const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-forge-test-"));
process.chdir(tempDir);

mock.method(console, "log", () => {});
process.env.DEEPSEEK_API_KEY = "test-api-key";

const {db} = await import("../src/backend/database/db.ts");
await import("../src/backend/database/initDatabase.ts");
const {selectIdFromAgentTableStmt} = await import("../src/backend/database/stmt.ts");
const {GexepAgent} = await import("../src/backend/DeepSeek/Agents/Gexep/GexepAgent.ts");

const dbAgentId = selectIdFromAgentTableStmt.get("Gexep") as number;

class TestableGexepAgent extends GexepAgent {
    private readonly sendEmailFunction: (input: SendEmailInputType) => Promise<string>;

    constructor(
        sendEmailFunction: (input: SendEmailInputType) => Promise<string> = async () => "邮件已发送",
        agentDirectory?: AgentDirectory,
    ) {
        super(agentDirectory);
        this.sendEmailFunction = sendEmailFunction;
    }

    public getInput(): InputItemType[] {
        return this.input;
    }

    public getAgentId(): number {
        return this.agentId;
    }

    public getAgentName(): string {
        return this.agentName;
    }

    public testRequestFunctionCall(item: InputFunctionCallItem): Promise<void> {
        return this.requestFunctionCallWithCommonTools(item);
    }

    protected override executeSendEmail(input: SendEmailInputType): Promise<string> {
        return this.sendEmailFunction(input);
    }
}

function createFunctionCallItem(name: string, args: string): InputFunctionCallItem {
    return {
        type: "function_call",
        call_id: "call_1",
        name,
        arguments: args,
    };
}

function getLastOutputItem(input: InputItemType[]): InputFunctionCallOutputItem {
    const item = input[input.length - 1];
    assert.ok(item !== undefined, "input 应包含回填项");
    assert.equal((item as {type?: string}).type, "function_call_output");
    return item as InputFunctionCallOutputItem;
}

afterEach(() => {
    mock.restoreAll();
    mock.method(console, "log", () => {});
});

after(() => {
    db.close();
    fs.rmSync(tempDir, {recursive: true, force: true});
});

describe("GexepAgent 构造函数", () => {
    it("公开构造函数没有形参", () => {
        assert.equal(GexepAgent.length, 0);
        assert.doesNotThrow(() => new GexepAgent());
    });

    it("从数据库读取 Gexep 的 agentId 与 agentName", () => {
        const agent = new TestableGexepAgent();

        assert.equal(agent.getAgentId(), dbAgentId);
        assert.equal(agent.getAgentName(), "Gexep");
    });
});

describe("GexepAgent.requestFunctionCall()", () => {
    it("send_email 正常调用后回填 function_call_output", async () => {
        let receivedInput: SendEmailInputType | undefined;
        const agent = new TestableGexepAgent(async (input) => {
            receivedInput = input;
            return "邮件已发送";
        });
        const toolInput = {
            senderName: "Gexep",
            subject: "测试主题",
            text: "测试正文",
        };

        await agent.testRequestFunctionCall(createFunctionCallItem("send_email", JSON.stringify(toolInput)));

        assert.deepEqual(receivedInput, toolInput);
        const outputItem = getLastOutputItem(agent.getInput());
        assert.equal(outputItem.call_id, "call_1");
        assert.equal(outputItem.name, "send_email");
        assert.equal(outputItem.output, "邮件已发送");
    });

    it("arguments 不是合法 JSON 时回填解析失败信息", async () => {
        const agent = new TestableGexepAgent(async () => "不应调用");

        await agent.testRequestFunctionCall(createFunctionCallItem("send_email", "not-json"));

        assert.match(getLastOutputItem(agent.getInput()).output, /参数解析失败/);
    });

    it("参数 schema 校验失败时不发送并回填校验失败信息", async () => {
        let called = false;
        const agent = new TestableGexepAgent(async () => {
            called = true;
            return "不应调用";
        });

        await agent.testRequestFunctionCall(createFunctionCallItem(
            "send_email",
            JSON.stringify({senderName: "Gexep", subject: "缺少正文"}),
        ));

        assert.equal(called, false);
        assert.match(getLastOutputItem(agent.getInput()).output, /参数校验失败/);
    });

    it("未知工具名不回填", async () => {
        const agent = new TestableGexepAgent(async () => "不应调用");
        const before = agent.getInput().length;

        await agent.testRequestFunctionCall(createFunctionCallItem("unknown_tool", "{}"));

        assert.equal(agent.getInput().length, before);
    });

    it("discover_agents 返回运行时目录中的其他 Agent", async () => {
        const directory: AgentDirectory = {
            discover: (capability, requesterName) => ({
                protocolVersion: "1.0",
                agents: [{
                    name: "Lexey",
                    description: "语言伙伴",
                    status: "available",
                    visibility: "internal",
                    protocolVersion: "1.0",
                    agentCardUrl: "http://127.0.0.1:3001/agents/lexey/.well-known/agent-card.json",
                    rpcUrl: "http://127.0.0.1:3001/agents/lexey/a2a",
                    supportedOperations: ["SendMessage"],
                    skills: [{
                        id: "language",
                        name: "Language",
                        description: "翻译和润色",
                        tags: ["translation"],
                    }],
                }],
                total: capability === "translation" && requesterName === "Gexep" ? 1 : 0,
            }),
        };
        const agent = new TestableGexepAgent(async () => "不应调用", directory);

        await agent.testRequestFunctionCall(createFunctionCallItem(
            "discover_agents",
            JSON.stringify({capability: "translation"}),
        ));

        const output = JSON.parse(getLastOutputItem(agent.getInput()).output) as {
            agents: Array<{name: string}>;
            total: number;
        };
        assert.equal(output.agents[0]?.name, "Lexey");
        assert.equal(output.total, 1);
    });

    it("discover_agents 参数不合法时返回校验错误", async () => {
        const agent = new TestableGexepAgent();

        await agent.testRequestFunctionCall(createFunctionCallItem(
            "discover_agents",
            JSON.stringify({capability: ""}),
        ));

        assert.match(getLastOutputItem(agent.getInput()).output, /参数校验失败/);
    });
});

describe("GexepAgent 工具注册", () => {
    it("向模型注册 send_email 的参数定义", async () => {
        let capturedBody: Record<string, unknown> | undefined;
        mock.method(globalThis, "fetch", async (
            _input: string | URL | Request,
            init?: RequestInit,
        ) => {
            capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
            return new Response(JSON.stringify({
                output: [{
                    type: "message",
                    id: "msg_1",
                    status: "completed",
                    role: "assistant",
                    content: [{type: "output_text", text: "done"}],
                }],
            }), {
                status: 200,
                headers: {"Content-Type": "application/json"},
            });
        });

        const agent = new TestableGexepAgent();
        await agent.ask("发送一封邮件");

        const tools = capturedBody?.tools as Array<Record<string, unknown>>;
        const sendEmailTool = tools.find((tool) => tool.name === "send_email");
        const discoverAgentsTool = tools.find((tool) => tool.name === "discover_agents");
        assert.ok(sendEmailTool !== undefined);
        assert.ok(discoverAgentsTool !== undefined);
        assert.deepEqual(
            (sendEmailTool.parameters as {required: string[]}).required,
            ["senderName", "subject", "text"],
        );
    });
});
