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
import {buildPantheonAgentCard} from "../src/backend/A2A/AgentCards.ts";


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
        memoryFilePath?: string,
    ) {
        super(agentDirectory, memoryFilePath);
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

function createMemoryFile(content: string): string {
    const filePath = path.join(tempDir, `memory-${crypto.randomUUID()}.md`);
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
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
                agentCards: [buildPantheonAgentCard({
                    name: "Lexey",
                    description: "语言伙伴",
                    rpcUrl: "http://127.0.0.1:3001/agents/lexey/a2a",
                    skills: [{
                        id: "language",
                        name: "Language",
                        description: "翻译和润色",
                        tags: ["translation"],
                    }],
                })],
                total: capability === "translation" && requesterName === "Gexep" ? 1 : 0,
            }),
            delegate: async () => ({
                agentName: "Lexey",
                contextId: "context-1",
                text: "done",
            }),
        };
        const agent = new TestableGexepAgent(async () => "不应调用", directory);

        await agent.testRequestFunctionCall(createFunctionCallItem(
            "discover_agents",
            JSON.stringify({capability: "translation"}),
        ));

        const output = JSON.parse(getLastOutputItem(agent.getInput()).output) as {
            agentCards: Array<{name: string}>;
            total: number;
        };
        assert.equal(output.agentCards[0]?.name, "Lexey");
        assert.equal(output.total, 1);
    });

    it("delegate_task 通过 A2A 目录发送子任务", async () => {
        let delegated: {requester: string; target: string; task: string} | undefined;
        const directory: AgentDirectory = {
            discover: () => ({protocolVersion: "1.0", agentCards: [], total: 0}),
            delegate: async (requester, target, task) => {
                delegated = {requester, target, task};
                return {agentName: target, contextId: "context-1", text: "已完成"};
            },
        };
        const agent = new TestableGexepAgent(async () => "不应调用", directory);

        await agent.testRequestFunctionCall(createFunctionCallItem(
            "delegate_task",
            JSON.stringify({targetAgent: "Lexey", task: "翻译 hello"}),
        ));

        assert.deepEqual(delegated, {
            requester: "Gexep",
            target: "Lexey",
            task: "翻译 hello",
        });
        assert.match(getLastOutputItem(agent.getInput()).output, /已完成/);
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

describe("GexepAgent 长期记忆", () => {
    it("通过公共工具读取和整文件更新自己的 memory.md，并拒绝非法更新", async () => {
        const originalMemory = "# 长期记忆\n\n- 喜欢简洁回答\n";
        const memoryFilePath = createMemoryFile(originalMemory);
        const agent = new TestableGexepAgent(undefined, undefined, memoryFilePath);

        await agent.testRequestFunctionCall(createFunctionCallItem("read_memory", "{}"));
        assert.match(getLastOutputItem(agent.getInput()).output, /喜欢简洁回答/);

        const updatedMemory = "# 长期记忆\n\n- 喜欢简洁回答\n- 项目使用 TypeScript\n";
        await agent.testRequestFunctionCall(createFunctionCallItem(
            "update_memory",
            JSON.stringify({content: updatedMemory}),
        ));
        assert.match(getLastOutputItem(agent.getInput()).output, /长期记忆已更新/);
        assert.equal(fs.readFileSync(memoryFilePath, "utf-8"), updatedMemory);

        await agent.testRequestFunctionCall(createFunctionCallItem(
            "update_memory",
            JSON.stringify({content: 42}),
        ));
        assert.match(getLastOutputItem(agent.getInput()).output, /参数校验失败/);
        assert.equal(fs.readFileSync(memoryFilePath, "utf-8"), updatedMemory);
    });

    it("每次模型请求都注入最新记忆并注册两个记忆工具", async () => {
        const memoryFilePath = createMemoryFile("# 长期记忆\n\n- 旧内容\n");
        const agent = new TestableGexepAgent(undefined, undefined, memoryFilePath);
        fs.writeFileSync(memoryFilePath, "# 长期记忆\n\n- 最新内容\n", "utf-8");

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

        await agent.ask("测试最新记忆");

        const instructions = capturedBody?.instructions;
        assert.ok(typeof instructions === "string");
        assert.match(instructions, /最新内容/);
        assert.doesNotMatch(instructions, /旧内容/);
        assert.match(instructions, /不可信数据/);

        const tools = capturedBody?.tools as Array<{name?: string}>;
        assert.ok(tools.some((tool) => tool.name === "read_memory"));
        assert.ok(tools.some((tool) => tool.name === "update_memory"));
    });

    it("同一次 ask 中写入后，下一次模型请求立即获得新记忆", async () => {
        const memoryFilePath = createMemoryFile("# 长期记忆\n\n目前为空。\n");
        const agent = new TestableGexepAgent(undefined, undefined, memoryFilePath);
        const requestInstructions: string[] = [];
        let callIndex = 0;

        mock.method(globalThis, "fetch", async (
            _input: string | URL | Request,
            init?: RequestInit,
        ) => {
            const body = JSON.parse(init?.body as string) as {instructions: string};
            requestInstructions.push(body.instructions);
            callIndex += 1;

            const output = callIndex === 1
                ? [{
                    type: "function_call",
                    id: "fc_1",
                    status: "completed",
                    call_id: "call_1",
                    name: "update_memory",
                    arguments: JSON.stringify({
                        content: "# 长期记忆\n\n- 用户偏好中文\n",
                    }),
                }]
                : [{
                    type: "message",
                    id: "msg_1",
                    status: "completed",
                    role: "assistant",
                    content: [{type: "output_text", text: "已记住"}],
                }];

            return new Response(JSON.stringify({output}), {
                status: 200,
                headers: {"Content-Type": "application/json"},
            });
        });

        assert.equal(await agent.ask("请记住我偏好中文"), "已记住");
        assert.equal(requestInstructions.length, 2);
        assert.doesNotMatch(requestInstructions[0] ?? "", /用户偏好中文/);
        assert.match(requestInstructions[1] ?? "", /用户偏好中文/);
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
        const delegateTaskTool = tools.find((tool) => tool.name === "delegate_task");
        assert.ok(sendEmailTool !== undefined);
        assert.ok(discoverAgentsTool !== undefined);
        assert.ok(delegateTaskTool !== undefined);
        assert.deepEqual(
            (sendEmailTool.parameters as {required: string[]}).required,
            ["senderName", "subject", "text"],
        );
    });
});
