import {
    AGENT_CARD_PATH,
    Role,
    TaskState,
    type Message,
    type Part,
    type Task,
} from "@a2a-js/sdk";

export {
    A2A_PROTOCOL_VERSION,
    Role,
    TaskState,
    type AgentCard,
    type AgentSkill,
    type Artifact,
    type Message,
    type Part,
    type SendMessageRequest,
    type SendMessageResult,
    type StreamResponse,
    type Task,
    type TaskArtifactUpdateEvent,
    type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";

export const A2A_AGENT_CARD_PATH = `/${AGENT_CARD_PATH}`;
export const A2A_RPC_PATH = "/a2a";

export function textPart(text: string, mediaType = "text/plain"): Part {
    return {
        content: {$case: "text", value: text},
        metadata: undefined,
        filename: "",
        mediaType,
    };
}

export function userMessage(text: string, contextId?: string): Message {
    return {
        messageId: crypto.randomUUID(),
        contextId: contextId ?? "",
        taskId: "",
        role: Role.ROLE_USER,
        parts: [textPart(text)],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
    };
}

export function textFromParts(parts: Part[]): string {
    return parts
        .flatMap((part) => part.content?.$case === "text" ? [part.content.value] : [])
        .filter(Boolean)
        .join("\n");
}

export function textFromMessage(message: Message): string {
    return textFromParts(message.parts);
}

export function textFromTask(task: Task): string {
    return task.artifacts
        .flatMap((artifact) => artifact.parts)
        .flatMap((part) => part.content?.$case === "text" ? [part.content.value] : [])
        .filter(Boolean)
        .join("\n\n");
}

export function taskStateLabel(state: TaskState): string {
    return TaskState[state] ?? "TASK_STATE_UNSPECIFIED";
}
