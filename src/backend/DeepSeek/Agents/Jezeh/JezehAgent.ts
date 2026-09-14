import {BaseAgent} from "#base-agent";
import {type InputFunctionCallItem, ModelType, type ToolsType} from "../../API/responses.ts";
import {loadInstructions} from "../../../Tools/loadInstructions.ts";
import {
    downloadMemo,
    downloadMemoInputSchema,
    type DownloadMemoInputType,
} from "../../../Tools/downloadMemo.ts";
import {
    executeE2BShell,
    executeE2BShellInputSchema,
    type ExecuteE2BShellInputType,
} from "../../../Tools/executeE2BShell.ts";
import {selectIdFromAgentTableStmt} from "../../../database/stmt.ts";
import path from "node:path";
import {type AgentDirectory, emptyAgentDirectory} from "../../../A2A/InternalAgentRegistry.ts";

const dirPath = import.meta.dirname;

export type DownloadMemoFunction = (input: DownloadMemoInputType) => Promise<string>;
export type ExecuteE2BShellFunction = (input: ExecuteE2BShellInputType) => Promise<string>;

export class JezehAgent extends BaseAgent {
    private readonly downloadMemoFunction: DownloadMemoFunction;
    private readonly executeE2BShellFunction: ExecuteE2BShellFunction;

    constructor(
        downloadMemoFunction: DownloadMemoFunction = downloadMemo,
        executeE2BShellFunction: ExecuteE2BShellFunction = executeE2BShell,
        agentDirectory: AgentDirectory = emptyAgentDirectory,
    ) {
        const instructions = loadInstructions(dirPath);
        const agentName = path.basename(dirPath);
        const agentId = selectIdFromAgentTableStmt.get(agentName) as number;

        const funcTools: ToolsType = [
            {
                type: "function",
                name: "e2b_shell_execute",
                description: "在 Jezeh 的隔离 E2B Sandbox 中执行 Shell 命令，默认工作目录固定为 /memos。用于创建、读取、搜索和编辑云端 Markdown 备忘录；命令不会在宿主机执行。",
                parameters: {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要在 E2B Sandbox 的 /memos 工作目录中执行的 Shell 命令。"
                        }
                    },
                    "required": ["command"]
                },
            },
            {
                type: "function",
                name: "download_memo",
                description: "将 E2B 沙箱备忘录区中的一份 Markdown 备忘录下载到预先配置的固定宿主机目录，并保留备忘录的相对路径。只创建新文件，不覆盖已有文件。",
                parameters: {
                    "type": "object",
                    "properties": {
                        "memoPath": {
                            "type": "string",
                            "description": "E2B 备忘录区 memos/ 下的相对 Markdown 路径，例如 notes/today.md。"
                        }
                    },
                    "required": ["memoPath"]
                },
            },
        ];

        super(
            ModelType.DeepSeekFlash,
            instructions,
            agentId,
            funcTools,
            agentDirectory,
        );

        this.downloadMemoFunction = downloadMemoFunction;
        this.executeE2BShellFunction = executeE2BShellFunction;
    }

    protected async requestFunctionCall(inputFunctionCallItem: InputFunctionCallItem): Promise<void> {
        if (inputFunctionCallItem.name === "e2b_shell_execute") {
            let shellInputJSONed: unknown;
            try {
                shellInputJSONed = JSON.parse(inputFunctionCallItem.arguments);
            } catch {
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    "e2b_shell_execute 参数解析失败：arguments 不是合法的 JSON。",
                );
                return;
            }

            const schemaParseResult = executeE2BShellInputSchema.safeParse(shellInputJSONed);
            if (!schemaParseResult.success) {
                this.createFunctionCallOutputItemAndPush(
                    inputFunctionCallItem,
                    `e2b_shell_execute 参数校验失败：${schemaParseResult.error.message}`,
                );
                return;
            }

            const output = await this.executeE2BShellFunction(schemaParseResult.data);
            this.createFunctionCallOutputItemAndPush(inputFunctionCallItem, output);
            return;
        }

        if (inputFunctionCallItem.name !== "download_memo") {
            return;
        }

        let downloadMemoInputJSONed: unknown;
        try {
            downloadMemoInputJSONed = JSON.parse(inputFunctionCallItem.arguments);
        } catch {
            this.createFunctionCallOutputItemAndPush(
                inputFunctionCallItem,
                "download_memo 参数解析失败：arguments 不是合法的 JSON。",
            );
            return;
        }

        const schemaParseResult = downloadMemoInputSchema.safeParse(downloadMemoInputJSONed);
        if (!schemaParseResult.success) {
            this.createFunctionCallOutputItemAndPush(
                inputFunctionCallItem,
                `download_memo 参数校验失败：${schemaParseResult.error.message}`,
            );
            return;
        }

        const output = await this.downloadMemoFunction(schemaParseResult.data);
        this.createFunctionCallOutputItemAndPush(inputFunctionCallItem, output);
    }
}
