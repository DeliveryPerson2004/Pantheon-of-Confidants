export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_RPC_PATH = "/a2a";

export type JsonRpcId = string | number;

export interface AgentInterface {
    url: string;
    protocolBinding: "JSONRPC";
    protocolVersion: string;
}

export interface AgentCard {
    name: string;
    description: string;
    supportedInterfaces: AgentInterface[];
    version: string;
    capabilities: {
        streaming?: boolean;
        pushNotifications?: boolean;
        extendedAgentCard?: boolean;
    };
    securitySchemes?: Record<string, {
        httpAuthSecurityScheme: {
            scheme: string;
            description?: string;
        };
    }>;
    securityRequirements?: Array<Record<string, string[]>>;
    defaultInputModes: string[];
    defaultOutputModes: string[];
    skills: Array<{
        id: string;
        name: string;
        description: string;
        tags: string[];
        examples?: string[];
    }>;
}

export interface A2APart {
    text?: string;
    raw?: string;
    url?: string;
    data?: unknown;
    mediaType?: string;
    filename?: string;
    metadata?: Record<string, unknown>;
}

export interface A2AMessage {
    messageId: string;
    role: "ROLE_USER" | "ROLE_AGENT";
    parts: A2APart[];
    contextId?: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
    extensions?: string[];
    referenceTaskIds?: string[];
}

export type TaskState =
    | "TASK_STATE_SUBMITTED"
    | "TASK_STATE_WORKING"
    | "TASK_STATE_COMPLETED"
    | "TASK_STATE_FAILED"
    | "TASK_STATE_CANCELED"
    | "TASK_STATE_INPUT_REQUIRED"
    | "TASK_STATE_REJECTED"
    | "TASK_STATE_AUTH_REQUIRED";

export interface TaskStatus {
    state: TaskState;
    timestamp: string;
    message?: A2AMessage;
}

export interface Artifact {
    artifactId: string;
    name?: string;
    description?: string;
    parts: A2APart[];
}

export interface Task {
    id: string;
    contextId: string;
    status: TaskStatus;
    artifacts?: Artifact[];
    history?: A2AMessage[];
    metadata?: Record<string, unknown>;
}

export interface TaskStatusUpdateEvent {
    taskId: string;
    contextId: string;
    status: TaskStatus;
}

export interface TaskArtifactUpdateEvent {
    taskId: string;
    contextId: string;
    artifact: Artifact;
    append?: boolean;
    lastChunk?: boolean;
}

export type StreamResponse =
    | {task: Task}
    | {message: A2AMessage}
    | {statusUpdate: TaskStatusUpdateEvent}
    | {artifactUpdate: TaskArtifactUpdateEvent};

export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: JsonRpcId;
    method: string;
    params?: unknown;
}

export interface JsonRpcSuccess<T> {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result: T;
}

export interface JsonRpcErrorObject {
    code: number;
    message: string;
    data?: Array<Record<string, unknown>>;
}

export interface JsonRpcError {
    jsonrpc: "2.0";
    id: JsonRpcId | null;
    error: JsonRpcErrorObject;
}

export type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError;

export interface SendMessageParams {
    message: A2AMessage;
    configuration?: {
        acceptedOutputModes?: string[];
        historyLength?: number;
        returnImmediately?: boolean;
        taskPushNotificationConfig?: unknown;
    };
    metadata?: Record<string, unknown>;
}

export interface SendMessageResult {
    task?: Task;
    message?: A2AMessage;
}

export interface ListTasksResult {
    tasks: Task[];
    nextPageToken: string;
    pageSize: number;
    totalSize: number;
}

export function textFromParts(parts: A2APart[]): string {
    return parts
        .map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n");
}

export function textFromTask(task: Task): string {
    return (task.artifacts ?? [])
        .flatMap((artifact) => artifact.parts)
        .map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n\n");
}
