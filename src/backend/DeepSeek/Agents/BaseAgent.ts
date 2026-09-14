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
    private readonly instructions: string;
    private readonly model: ModelType;
    private modelClient: ModelClient;
    private eventListener: AgentEventListener | undefined;
    private readonly agentDirectory: AgentDirectory;

    protected readonly agentId: number;
    protected readonly agentName: string;
    protected maxTurn: number;
    protected input: InputItemType[];

    protected constructor(
        model: ModelType,
        instructions: string,
        agentId: number,
        functionTools: ToolsType,
        agentDirectory: AgentDirectory = emptyAgentDirectory,
    ) {
        this.functionTools = [
            ...functionTools,
            {
                type: "function",
                name: "discover_agents",
                description: "通过运行时 A2A 目录发现其他在线 Agent。返回对方的职责、技能、Agent Card URL、A2A 消息端点和支持的操作；结果自动排除当前 Agent，可按能力关键词筛选。",
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
        ];
        this.instructions = instructions;
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

    protected async requestFunctionCallWithCommonTools(inputFunctionCallItem: InputFunctionCallItem): Promise<void> {
        if (inputFunctionCallItem.name !== "discover_agents") {
            await this.requestFunctionCall(inputFunctionCallItem);
            return;
        }

        let parsedArguments: unknown;
        try {
            parsedArguments = JSON.parse(inputFunctionCallItem.arguments);
        } catch {
            this.createFunctionCallOutputItemAndPush(
                inputFunctionCallItem,
                "discover_agents 参数解析失败：arguments 不是合法的 JSON。",
            );
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

    public async ask(userInput: string): Promise<string> {
        logger.info("class BaseAgent public loop() start");

        const inputLengthBeforeLoop = this.input.length;
        const answerParts: string[] = [];

        this.createInputMessageItemAndPush(userInput);
        this.emit({type: "start", agentName: this.agentName});

        try {
            while(true){
                const response: ResponseSchema = await this.modelClient.requestResponsesAPI(
                    this.model,
                    this.input,
                    this.instructions,
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
        }
    }
}
