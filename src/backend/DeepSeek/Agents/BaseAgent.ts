import {
    type InputFunctionCallItem,
    type InputFunctionCallOutputItem,
    type InputItemType,
    type InputMessageItem,
    ModelType,
    type ResponseSchema,
    type ToolsType
} from "../API/responses.ts";
import {ModelClient} from "../ModelClient.ts";
import {logger} from "../../logger.ts";
import {
    insertIntoMessageTableStmt,
    selectMaxTurnFromAgentTableStmt,
    selectMessageFromMessageTableStmt, selectNameFromAgentTableStmt
} from "../../database/stmt.ts";
import {z} from "zod";
import {
    type AgentDirectory,
    emptyAgentDirectory,
} from "../../A2A/InternalAgentRegistry.ts";
import type {DelegationTrace} from "../../A2A/DelegationContext.ts";
import fs from "node:fs";
import path from "node:path";
import {
    readAgentMemory,
    updateAgentMemory,
    updateAgentMemoryInputSchema,
} from "../../Tools/agentMemory.ts";


const longTermMemoryInstructions = fs.readFileSync(
    path.join(import.meta.dirname, "memory-instructions.md"),
    "utf-8",
);

export type AgentEvent =
    | {type: "start"; agentName: string}
    | {type: "reasoning"; text: string}
    | {type: "message"; text: string}
    | {type: "function_call"; name: string}
    | {type: "function_result"; name: string; output: string}
    | {type: "web_search"}
    | {type: "complete"; agentName: string}
    | {type: "error"; error: Error};

export interface ConversationMessage {
    role: "user" | "assistant";
    text: string;
}

export type AgentEventListener = (event: AgentEvent) => void;



export abstract class BaseAgent{
    private readonly functionTools: ToolsType;
    private readonly baseInstructions: string;
    private readonly memoryFilePath: string;
    private readonly model: ModelType;
    private modelClient: ModelClient;
    private eventListener: AgentEventListener | undefined;
    private readonly agentDirectory: AgentDirectory;
    private delegationTrace: DelegationTrace | undefined;

    protected readonly agentId: number;
    protected readonly agentName: string;
    protected maxTurn: number;
    protected input: InputItemType[];

    protected constructor(
        model: ModelType,
        instructions: string,
        agentId: number,
        functionTools: ToolsType,
        memoryFilePath: string,
        agentDirectory: AgentDirectory = emptyAgentDirectory,
    ) {
        this.functionTools = [
            ...functionTools,
            {
                type: "function",
                name: "read_memory",
                description: "读取当前 Agent 自己的完整长期记忆。仅在需要确认最新原文、准备覆盖更新或用户明确要求查看时调用；不能读取其他 Agent 的记忆。",
                parameters: {
                    type: "object",
                    properties: {},
                    required: [],
                },
            },
            {
                type: "function",
                name: "update_memory",
                description: "用完整 Markdown 内容替换当前 Agent 自己的长期记忆。用于保存稳定且未来有用的信息，或落实用户要求的记住、纠正和遗忘；必须保留仍有效的无关条目。",
                parameters: {
                    type: "object",
                    properties: {
                        content: {
                            type: "string",
                            description: "更新后的 memory.md 完整 Markdown 内容，不是增量或补丁。",
                        },
                    },
                    required: ["content"],
                },
            },
            {
                type: "function",
                name: "discover_agents",
                description: "通过运行时 A2A 目录发现其他在线 Agent。返回符合 A2A 官方结构的 Agent Card；结果自动排除当前 Agent，可按能力关键词筛选。",
                parameters: {
                    type: "object",
                    properties: {
                        capability: {
                            type: "string",
                            description: "可选的能力关键词，例如 translation、memo、research 或备忘录。省略时返回其他全部在线 Agent。",
                        },
                    },
                    required: [],
                },
            },
            {
                type: "function",
                name: "delegate_task",
                description: "通过 A2A 协议把一个边界清晰的子任务发送给已发现的 Agent，并取得对方返回的消息或任务结果。调用前应先用 discover_agents 确认目标及其技能。",
                parameters: {
                    type: "object",
                    properties: {
                        targetAgent: {
                            type: "string",
                            description: "目标 Agent Card 中的 name，例如 Jezeh、Lexey 或 Zebeh。",
                        },
                        task: {
                            type: "string",
                            description: "交给目标 Agent 的完整任务描述，应包含完成任务所需上下文。",
                        },
                        contextId: {
                            type: "string",
                            description: "可选。延续此前与目标 Agent 的 A2A 上下文时传入。",
                        },
                    },
                    required: ["targetAgent", "task"],
                },
            },
        ];
        this.baseInstructions = instructions;
        this.memoryFilePath = memoryFilePath;
        readAgentMemory(this.memoryFilePath);
        this.model = model;
        this.modelClient = new ModelClient();
        this.agentDirectory = agentDirectory;
        this.agentId = agentId;

        const max_turn = selectMaxTurnFromAgentTableStmt.get(agentId) as number;

        const messageRows = selectMessageFromMessageTableStmt.all(agentId);
        const input: InputItemType[] = [];
        for (const row of messageRows) {
            try {
                input.push(...(JSON.parse(row.content) as InputItemType[]));
            } catch {
                logger.warn(`跳过无法解析的 message 行: ${row.content}`);
            }
        }

        const agentName = selectNameFromAgentTableStmt.get(agentId) as string;

        this.maxTurn = max_turn;
        this.input = input;
        this.agentName = agentName;

        logger.info("new class BaseAgent()");
    }

    public setEventListener(listener: AgentEventListener | undefined): void {
        this.eventListener = listener;
    }

    public getConversationHistory(): ConversationMessage[] {
        const messages: ConversationMessage[] = [];

        for (const rawItem of this.input as unknown[]) {
            if (typeof rawItem !== "object" || rawItem === null) {
                continue;
            }

            const item = rawItem as Record<string, unknown>;
            if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) {
                continue;
            }

            if (typeof item.content === "string") {
                messages.push({role: item.role, text: item.content});
                continue;
            }

            if (!Array.isArray(item.content)) {
                continue;
            }

            const text = item.content
                .map((contentItem: unknown) => {
                    if (typeof contentItem !== "object" || contentItem === null) {
                        return "";
                    }
                    const content = contentItem as Record<string, unknown>;
                    return typeof content.text === "string" ? content.text : "";
                })
                .filter(Boolean)
                .join("\n");

            if (text) {
                messages.push({role: item.role, text});
            }
        }

        return messages;
    }

    private emit(event: AgentEvent): void {
        this.eventListener?.(event);
    }

    private createInputMessageItemAndPush(userInput: string) {
        const inputMessageItem: InputMessageItem = {
            type: "message",
            role: "user",
            content: userInput,
        };
        logger.info(inputMessageItem.type);
        logger.info(inputMessageItem.content);
        this.input.push(inputMessageItem);
    }

    protected abstract requestFunctionCall(inputFunctionCallItem: InputFunctionCallItem): Promise<void>;

    private getInstructions(): string {
        const memory = readAgentMemory(this.memoryFilePath);
        return `${this.baseInstructions}\n\n${longTermMemoryInstructions}\n${JSON.stringify(memory)}`;
    }

    protected async requestFunctionCallWithCommonTools(inputFunctionCallItem: InputFunctionCallItem): Promise<void> {
        const commonToolNames = new Set([
            "read_memory",
            "update_memory",
            "discover_agents",
            "delegate_task",
        ]);
        if (!commonToolNames.has(inputFunctionCallItem.name)) {
            await this.requestFunctionCall(inputFunctionCallItem);
            return;
        }

        let parsedArguments: unknown;
        try {
            parsedArguments = JSON.parse(inputFunctionCallItem.arguments);
        } catch {
            this.createFunctionCallOutputItemAndPush(
                inputFunctionCallItem,
                `${inputFunctionCallItem.name} 参数解析失败：arguments 不是合法的 JSON。`,
            );
            return;
        }

        if (inputFunctionCallItem.name === "read_memory") {
            const result = z.object({}).strict().safeParse(parsedArguments);
            if (!result.success) {
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    `read_memory 参数校验失败：${result.error.message}`,
                );
                return;
            }

            try {
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    readAgentMemory(this.memoryFilePath),
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    `读取长期记忆失败：${message}`,
                );
            }
            return;
        }

        if (inputFunctionCallItem.name === "update_memory") {
            const result = updateAgentMemoryInputSchema.safeParse(parsedArguments);
            if (!result.success) {
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    `update_memory 参数校验失败：${result.error.message}`,
                );
                return;
            }

            try {
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    updateAgentMemory(this.memoryFilePath, result.data),
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    `更新长期记忆失败：${message}`,
                );
            }
            return;
        }

        if (inputFunctionCallItem.name === "delegate_task") {
            const result = z.object({
                targetAgent: z.string().trim().min(1),
                task: z.string().trim().min(1),
                contextId: z.string().trim().min(1).optional(),
            }).safeParse(parsedArguments);
            if (!result.success) {
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    `delegate_task 参数校验失败：${result.error.message}`,
                );
                return;
            }

            try {
                const delegation = await this.agentDirectory.delegate(
                    this.agentName,
                    result.data.targetAgent,
                    result.data.task,
                    result.data.contextId,
                    this.delegationTrace,
                );
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    JSON.stringify(delegation),
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    `A2A 委派失败：${message}`,
                );
            }
            return;
        }

        const result = z.object({
            capability: z.string().trim().min(1).optional(),
        }).safeParse(parsedArguments);
        if (!result.success) {
            this.createFunctionCallOutputItemAndPush(
                inputFunctionCallItem,
                `discover_agents 参数校验失败：${result.error.message}`,
            );
            return;
        }

        this.createFunctionCallOutputItemAndPush(
            inputFunctionCallItem,
            JSON.stringify(this.agentDirectory.discover(result.data.capability, this.agentName)),
        );
    }

    protected createFunctionCallOutputItemAndPush(inputFunctionCallItem: InputFunctionCallItem, output: string){
        const functionCallOutputItem: InputFunctionCallOutputItem = {
            type: "function_call_output",
            call_id: inputFunctionCallItem.call_id,
            name: inputFunctionCallItem.name,
            arguments: inputFunctionCallItem.arguments,
            output: output,
        };

        this.input.push(functionCallOutputItem);
        this.emit({type: "function_result", name: inputFunctionCallItem.name, output});
    }

    public async ask(
        userInput: string,
        options: {delegationTrace?: DelegationTrace} = {},
    ): Promise<string> {
        logger.info("class BaseAgent public loop() start");

        const inputLengthBeforeLoop = this.input.length;
        const answerParts: string[] = [];
        const previousDelegationTrace = this.delegationTrace;
        this.delegationTrace = options.delegationTrace ?? {
            traceId: crypto.randomUUID(),
            path: [this.agentName],
        };

        this.createInputMessageItemAndPush(userInput);
        this.emit({type: "start", agentName: this.agentName});

        try {
            while(true){
                const response: ResponseSchema = await this.modelClient.requestResponsesAPI(
                    this.model,
                    this.input,
                    this.getInstructions(),
                    this.functionTools,
                    this.agentName,
                );

                if (!Array.isArray(response.output)) {
                    throw new Error("模型响应中缺少 output 数组。");
                }

                let hasFunctionCall = false;
                for(const item of response.output){
                    this.input.push(item);
                    if(item.type == "message"){
                        logger.info(item.type);
                        for(const contentItem of item.content){
                            logger.info("\n" + contentItem.text);
                            answerParts.push(contentItem.text);
                            this.emit({type: "message", text: contentItem.text});
                        }
                    }else if(item.type == "reasoning"){
                        logger.info(item.type);
                        for(const contentItem of item.content){
                            logger.info("\n" + contentItem.text);
                            this.emit({type: "reasoning", text: contentItem.text});
                        }
                    }else if(item.type == "function_call"){
                        logger.info(item.type);
                        this.emit({type: "function_call", name: item.name});
                        await this.requestFunctionCallWithCommonTools(item);
                        hasFunctionCall = true;
                    }else if(item.type == "web_search_call"){
                        logger.info(item.type);
                        this.emit({type: "web_search"});
                    }
                }
                if(!hasFunctionCall){
                    break;
                }
            }

            const inputDeltaAfterLoop = this.input.slice(inputLengthBeforeLoop);

            insertIntoMessageTableStmt.run(this.agentId, this.maxTurn, JSON.stringify(inputDeltaAfterLoop), 1);

            logger.info("class BaseAgent public loop() end");
            this.emit({type: "complete", agentName: this.agentName});
            return answerParts.join("\n\n");
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            this.emit({type: "error", error: normalizedError});
            throw normalizedError;
        } finally {
            this.delegationTrace = previousDelegationTrace;
        }
    }
}
