import {BaseAgent} from "#base-agent";
import {type InputFunctionCallItem, ModelType, type ToolsType} from "../../API/responses.ts";
import {loadInstructions} from "../../../Tools/loadInstructions.ts";
import {
    selectIdFromAgentTableStmt,
} from "../../../database/stmt.ts";
import {loadSkill, loadSkillInputSchema, type loadSkillInputType} from "../../../Tools/loadSkill.ts";
import path from "node:path";
import {type AgentDirectory, emptyAgentDirectory} from "../../../A2A/InternalAgentRegistry.ts";

const dirPath = import.meta.dirname;
const skillsDirPath = path.join(dirPath, "skills");

export class LexeyAgent extends BaseAgent{
    constructor(agentDirectory: AgentDirectory = emptyAgentDirectory) {
        const instructions = loadInstructions(dirPath, true);
        const agentName = path.basename(dirPath);
        const agentId = selectIdFromAgentTableStmt.get(agentName) as number;

        const funcTools: ToolsType = [
            {
                type: "web_search",
            },
            {
                type: "function",
                name: "load_skill",
                description: "可以使用该工具加载skill的详细内容。",
                parameters: {
                    "type": "object",
                    "properties": {
                        "skillName": {
                            "type": "string",
                            "description": "要加载的skill名字"
                        },
                    },
                    "required": ["skillName"]
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
    }

    protected async requestFunctionCall(inputFunctionCallItem: InputFunctionCallItem): Promise<void> {
        if (inputFunctionCallItem.name === "load_skill") {
            let loadSkillInputJSONed: loadSkillInputType;
            try {
                loadSkillInputJSONed = JSON.parse(inputFunctionCallItem.arguments);
            } catch {
                this.createFunctionCallOutputItemAndPush(inputFunctionCallItem, "load_skill 参数解析失败：arguments 不是合法的 JSON。");
                return;
            }

            const schemaParseResult = loadSkillInputSchema.safeParse(loadSkillInputJSONed);

            if(schemaParseResult.success){
                const output = loadSkill(skillsDirPath, schemaParseResult.data.skillName);
                this.createFunctionCallOutputItemAndPush(inputFunctionCallItem, output);
            }else{
                this.createFunctionCallOutputItemAndPush(inputFunctionCallItem, `load_skill 参数校验失败：${schemaParseResult.error.message}`);
            }
        }
    }
}
