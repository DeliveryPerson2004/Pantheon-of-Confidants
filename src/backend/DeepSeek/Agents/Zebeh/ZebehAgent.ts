import {BaseAgent} from "#base-agent";
import {type InputFunctionCallItem, ModelType, type ToolsType} from "../../API/responses.ts";
import {loadInstructions} from "../../../Tools/loadInstructions.ts";
import {
    selectIdFromAgentTableStmt,
} from "../../../database/stmt.ts";
import path from "node:path";
import {type AgentDirectory, emptyAgentDirectory} from "../../../A2A/InternalAgentRegistry.ts";

const dirPath = import.meta.dirname;

export class ZebehAgent extends BaseAgent{
    constructor(
        agentDirectory: AgentDirectory = emptyAgentDirectory,
        memoryFilePath: string = path.join(dirPath, "memory.md"),
    ) {
        const instructions = loadInstructions(dirPath);
        const agentName = path.basename(dirPath);
        const agentId = selectIdFromAgentTableStmt.get(agentName) as number;

        const funcTools: ToolsType = [
            {
                type: "web_search",
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

    protected async requestFunctionCall(inputFunctionCallItem: InputFunctionCallItem): Promise<void> {
    }
}
