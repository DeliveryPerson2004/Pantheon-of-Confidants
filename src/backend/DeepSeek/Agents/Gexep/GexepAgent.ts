import {BaseAgent} from "#base-agent";
import {type InputFunctionCallItem, ModelType, type ToolsType} from "../../API/responses.ts";
import {loadInstructions} from "../../../Tools/loadInstructions.ts";
import {sendEmail, sendEmailInputSchema, type SendEmailInputType} from "../../../Tools/sendEmail.ts";
import {selectIdFromAgentTableStmt} from "../../../database/stmt.ts";
import {
    type AgentDirectory,
    emptyAgentDirectory,
} from "../../../A2A/InternalAgentRegistry.ts";
import path from "node:path";


const dirPath = import.meta.dirname;
export class GexepAgent extends BaseAgent {
    constructor(
        agentDirectory: AgentDirectory = emptyAgentDirectory,
        memoryFilePath: string = path.join(dirPath, "memory.md"),
    ) {
        const instructions = loadInstructions(dirPath);
        const agentName = path.basename(dirPath);
        const agentId = selectIdFromAgentTableStmt.get(agentName) as number;

        const funcTools: ToolsType = [
            {
                type: "function",
                name: "send_email",
                description: "向预先配置的固定邮箱发送真实邮件。仅在用户明确要求发送时调用；发件人显示名称应准确反映调用者或邮件用途，不得冒充他人。",
                parameters: {
                    "type": "object",
                    "properties": {
                        "senderName": {
                            "type": "string",
                            "description": "收件箱中显示的发件人名称，例如 Gexep。"
                        },
                        "subject": {
                            "type": "string",
                            "description": "邮件主题。"
                        },
                        "text": {
                            "type": "string",
                            "description": "邮件的纯文本正文。"
                        },
                        "html": {
                            "type": "string",
                            "description": "可选的 HTML 正文。"
                        }
                    },
                    "required": ["senderName", "subject", "text"]
                },
            },
        ];

        super(
            ModelType.DeepSeekFlash,
            instructions,
            agentId,
            funcTools,
            memoryFilePath,
            agentDirectory,
        );
    }

    protected executeSendEmail(input: SendEmailInputType): Promise<string> {
        return sendEmail(input);
    }

    protected async requestFunctionCall(inputFunctionCallItem: InputFunctionCallItem): Promise<void> {
        if (inputFunctionCallItem.name !== "send_email") {
            return;
        }

        let sendEmailInputJSONed: unknown;
        try {
            sendEmailInputJSONed = JSON.parse(inputFunctionCallItem.arguments);
        } catch {
            this.createFunctionCallOutputItemAndPush(
                inputFunctionCallItem,
                "send_email 参数解析失败：arguments 不是合法的 JSON。",
            );
            return;
        }

        const schemaParseResult = sendEmailInputSchema.safeParse(sendEmailInputJSONed);
        if (!schemaParseResult.success) {
            this.createFunctionCallOutputItemAndPush(
                inputFunctionCallItem,
                `send_email 参数校验失败：${schemaParseResult.error.message}`,
            );
            return;
        }

        const output = await this.executeSendEmail(schemaParseResult.data);
        this.createFunctionCallOutputItemAndPush(inputFunctionCallItem, output);
    }
}
