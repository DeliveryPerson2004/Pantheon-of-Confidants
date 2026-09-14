import fs from "node:fs";
import path from "node:path";
import {z} from "zod";


export const MAX_AGENT_MEMORY_CHARACTERS = 65_536;

export const updateAgentMemoryInputSchema = z.object({
    content: z.string().max(
        MAX_AGENT_MEMORY_CHARACTERS,
        `长期记忆不能超过 ${MAX_AGENT_MEMORY_CHARACTERS} 个字符。`,
    ),
});

export type UpdateAgentMemoryInput = z.infer<typeof updateAgentMemoryInputSchema>;

export function readAgentMemory(memoryFilePath: string): string {
    return fs.readFileSync(memoryFilePath, "utf-8");
}

export function updateAgentMemory(
    memoryFilePath: string,
    input: UpdateAgentMemoryInput,
): string {
    const temporaryFilePath = path.join(
        path.dirname(memoryFilePath),
        `.${path.basename(memoryFilePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );

    try {
        fs.writeFileSync(temporaryFilePath, input.content, {
            encoding: "utf-8",
            flag: "wx",
        });
        fs.renameSync(temporaryFilePath, memoryFilePath);
    } catch (error) {
        try {
            fs.rmSync(temporaryFilePath, {force: true});
        } catch {
            // 保留原始写入错误。
        }
        throw error;
    }

    return `长期记忆已更新，共 ${input.content.length} 个字符。`;
}
