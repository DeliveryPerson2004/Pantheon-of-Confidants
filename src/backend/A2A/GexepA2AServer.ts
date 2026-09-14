import {randomUUID, timingSafeEqual} from "node:crypto";
import express, {type Express, type NextFunction, type Request, type Response} from "express";
import {z} from "zod";
import type {AgentEvent, AgentEventListener} from "../DeepSeek/Agents/BaseAgent.ts";
import {
    A2A_AGENT_CARD_PATH,
    A2A_PROTOCOL_VERSION,
    A2A_RPC_PATH,
    type A2AMessage,
    type AgentCard,
    type Artifact,
    type JsonRpcError,
    type JsonRpcErrorObject,
    type JsonRpcId,
    type JsonRpcRequest,
    type JsonRpcSuccess,
    type ListTasksResult,
    type SendMessageParams,
    type SendMessageResult,
    type StreamResponse,
    type Task,
    type TaskState,
    textFromParts,
} from "../../a2a/types.ts";
import {logger} from "../logger.ts";

export interface A2AAgentPort {
    ask(input: string): Promise<string>;
    setEventListener(listener: AgentEventListener | undefined): void;
}

export type GexepAgentPort = A2AAgentPort;

export interface GexepA2AServerOptions {
    publicBaseUrl: string;
    apiToken?: string;
}

export interface A2AAgentCardDefinition {
    name: string;
    description: string;
    rpcUrl: string;
    version?: string;
    skills: AgentCard["skills"];
    apiToken?: string;
}

export interface A2AAgentAppOptions {
    agentCard: AgentCard;
    apiToken?: string;
}

interface TaskObserver {
    emit(response: StreamResponse): void;
}

interface ListTaskParams {
    contextId?: string;
    status?: TaskState;
    pageSize?: number;
    pageToken?: string;
    historyLength?: number;
    includeArtifacts?: boolean;
}

const textPartSchema = z.object({
    text: z.string(),
    mediaType: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const messageSchema = z.object({
    messageId: z.string().min(1),
    role: z.literal("ROLE_USER"),
    parts: z.array(textPartSchema).min(1),
    contextId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    extensions: z.array(z.string()).optional(),
    referenceTaskIds: z.array(z.string()).optional(),
}).passthrough();

const sendMessageParamsSchema = z.object({
    message: messageSchema,
    configuration: z.object({
        acceptedOutputModes: z.array(z.string()).optional(),
        historyLength: z.number().int().min(0).optional(),
        returnImmediately: z.boolean().optional(),
        taskPushNotificationConfig: z.unknown().optional(),
    }).passthrough().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const jsonRpcRequestSchema = z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]),
    method: z.string().min(1),
    params: z.unknown().optional(),
}).passthrough();

const getTaskParamsSchema = z.object({
    id: z.string().min(1),
    historyLength: z.number().int().min(0).optional(),
}).passthrough();

const listTasksParamsSchema = z.object({
    contextId: z.string().min(1).optional(),
    status: z.enum([
        "TASK_STATE_SUBMITTED",
        "TASK_STATE_WORKING",
        "TASK_STATE_COMPLETED",
        "TASK_STATE_FAILED",
        "TASK_STATE_CANCELED",
        "TASK_STATE_INPUT_REQUIRED",
        "TASK_STATE_REJECTED",
        "TASK_STATE_AUTH_REQUIRED",
    ]).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    pageToken: z.string().optional(),
    historyLength: z.number().int().min(0).optional(),
    includeArtifacts: z.boolean().optional(),
}).passthrough();

class A2AServiceError extends Error {
    constructor(
        public readonly code: number,
        message: string,
        public readonly reason: string,
        public readonly metadata?: Record<string, string>,
    ) {
        super(message);
    }
}

function now(): string {
    return new Date().toISOString();
}

function agentStatusMessage(task: Task, text: string): A2AMessage {
    return {
        messageId: randomUUID(),
        role: "ROLE_AGENT",
        parts: [{text, mediaType: "text/plain"}],
        contextId: task.contextId,
        taskId: task.id,
    };
}

function copyTask(task: Task, historyLength?: number, includeArtifacts = true): Task {
    const copy: Task = {
        id: task.id,
        contextId: task.contextId,
        status: structuredClone(task.status),
    };

    if (includeArtifacts && task.artifacts !== undefined) {
        copy.artifacts = structuredClone(task.artifacts);
    }
    if (historyLength !== 0 && task.history !== undefined) {
        copy.history = structuredClone(
            historyLength === undefined ? task.history : task.history.slice(-historyLength),
        );
    }
    if (task.metadata !== undefined) {
        copy.metadata = structuredClone(task.metadata);
    }
    return copy;
}

export class GexepTaskService {
    private readonly tasks = new Map<string, Task>();
    private executionQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly agent: A2AAgentPort,
        private readonly agentName = "Gexep",
    ) {}

    createTask(params: SendMessageParams): Task {
        if (params.configuration?.taskPushNotificationConfig !== undefined) {
            throw new A2AServiceError(
                -32003,
                "Push notifications are not supported",
                "PUSH_NOTIFICATION_NOT_SUPPORTED",
            );
        }

        if (params.message.taskId !== undefined) {
            const referenced = this.tasks.get(params.message.taskId);
            if (referenced === undefined) {
                throw this.taskNotFound(params.message.taskId);
            }
            throw new A2AServiceError(
                -32004,
                `Messages cannot be appended to an existing ${this.agentName} task; continue with its contextId instead`,
                "UNSUPPORTED_OPERATION",
                {taskId: referenced.id},
            );
        }

        const task: Task = {
            id: randomUUID(),
            contextId: params.message.contextId ?? randomUUID(),
            status: {
                state: "TASK_STATE_SUBMITTED",
                timestamp: now(),
            },
            history: [structuredClone(params.message)],
        };
        if (params.metadata !== undefined) {
            task.metadata = structuredClone(params.metadata);
        }
        this.tasks.set(task.id, task);
        return task;
    }

    runTask(task: Task, input: string, observer?: TaskObserver): Promise<void> {
        const execution = this.executionQueue.then(() => this.execute(task, input, observer));
        this.executionQueue = execution.catch(() => undefined);
        return execution;
    }

    getTask(id: string, historyLength?: number): Task {
        const task = this.tasks.get(id);
        if (task === undefined) {
            throw this.taskNotFound(id);
        }
        return copyTask(task, historyLength);
    }

    listTasks(params: ListTaskParams): ListTasksResult {
        const pageSize = params.pageSize ?? 50;
        const offset = params.pageToken === undefined || params.pageToken === ""
            ? 0
            : Number.parseInt(params.pageToken, 10);
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new A2AServiceError(-32602, "Invalid pageToken", "INVALID_PARAMS");
        }

        const filtered = [...this.tasks.values()]
            .filter((task) => params.contextId === undefined || task.contextId === params.contextId)
            .filter((task) => params.status === undefined || task.status.state === params.status)
            .sort((left, right) => right.status.timestamp.localeCompare(left.status.timestamp));
        const page = filtered.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;

        return {
            tasks: page.map((task) => copyTask(task, params.historyLength, params.includeArtifacts === true)),
            nextPageToken: nextOffset < filtered.length ? String(nextOffset) : "",
            pageSize,
            totalSize: filtered.length,
        };
    }

    cancelTask(id: string): never {
        const task = this.tasks.get(id);
        if (task === undefined) {
            throw this.taskNotFound(id);
        }
        throw new A2AServiceError(
            -32002,
            `${this.agentName} tasks cannot be canceled once submitted`,
            "TASK_NOT_CANCELABLE",
            {taskId: id},
        );
    }

    private async execute(task: Task, input: string, observer?: TaskObserver): Promise<void> {
        this.updateStatus(task, "TASK_STATE_WORKING", undefined, observer);
        const listener = (event: AgentEvent): void => {
            if (event.type === "function_call") {
                this.updateStatus(
                    task,
                    "TASK_STATE_WORKING",
                    `${this.agentName} 正在执行操作。`,
                    observer,
                );
            }
        };

        this.agent.setEventListener(listener);
        try {
            const answer = await this.agent.ask(input);
            const artifact: Artifact = {
                artifactId: randomUUID(),
                name: `${this.agentName} response`,
                parts: [{text: answer, mediaType: "text/markdown"}],
            };
            task.artifacts = [artifact];
            observer?.emit({
                artifactUpdate: {
                    taskId: task.id,
                    contextId: task.contextId,
                    artifact: structuredClone(artifact),
                    lastChunk: true,
                },
            });
            this.updateStatus(task, "TASK_STATE_COMPLETED", undefined, observer);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updateStatus(task, "TASK_STATE_FAILED", message, observer);
        } finally {
            this.agent.setEventListener(undefined);
        }
    }

    private updateStatus(
        task: Task,
        state: TaskState,
        message: string | undefined,
        observer?: TaskObserver,
    ): void {
        task.status = {
            state,
            timestamp: now(),
            ...(message === undefined ? {} : {message: agentStatusMessage(task, message)}),
        };
        observer?.emit({
            statusUpdate: {
                taskId: task.id,
                contextId: task.contextId,
                status: structuredClone(task.status),
            },
        });
    }

    private taskNotFound(id: string): A2AServiceError {
        return new A2AServiceError(-32001, "Task not found", "TASK_NOT_FOUND", {taskId: id});
    }
}

export function buildGexepAgentCard(options: GexepA2AServerOptions): AgentCard {
    return buildAgentCard({
        name: "Gexep",
        description: "Pantheon of Confidants 的唯一公开入口 Agent，负责理解请求、协调处理并执行已授权的邮件操作。",
        rpcUrl: new URL(A2A_RPC_PATH, options.publicBaseUrl).toString(),
        ...(options.apiToken === undefined ? {} : {apiToken: options.apiToken}),
        skills: [{
            id: "gexep-conversation",
            name: "Gexep conversation",
            description: "理解用户目标、给出答复，并在用户明确授权时向预配置邮箱发送邮件。",
            tags: ["conversation", "coordination", "email"],
            examples: ["帮我梳理这个目标", "给我发送一封提醒邮件"],
        }],
    });
}

export function buildAgentCard(definition: A2AAgentCardDefinition): AgentCard {
    const card: AgentCard = {
        name: definition.name,
        description: definition.description,
        supportedInterfaces: [{
            url: definition.rpcUrl,
            protocolBinding: "JSONRPC",
            protocolVersion: A2A_PROTOCOL_VERSION,
        }],
        version: definition.version ?? "1.0.0",
        capabilities: {
            streaming: true,
            pushNotifications: false,
            extendedAgentCard: false,
        },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/markdown"],
        skills: structuredClone(definition.skills),
    };

    if (definition.apiToken !== undefined) {
        card.securitySchemes = {
            bearerAuth: {
                httpAuthSecurityScheme: {
                    scheme: "Bearer",
                    description: "通过 PANTHEON_API_TOKEN 配置的访问令牌。",
                },
            },
        };
        card.securityRequirements = [{bearerAuth: []}];
    }
    return card;
}

function jsonRpcSuccess<T>(id: JsonRpcId, result: T): JsonRpcSuccess<T> {
    return {jsonrpc: "2.0", id, result};
}

function jsonRpcError(id: JsonRpcId | null, error: JsonRpcErrorObject): JsonRpcError {
    return {jsonrpc: "2.0", id, error};
}

function serviceErrorPayload(error: A2AServiceError): JsonRpcErrorObject {
    return {
        code: error.code,
        message: error.message,
        data: [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: error.reason,
            domain: "a2a-protocol.org",
            metadata: {
                ...error.metadata,
                timestamp: now(),
            },
        }],
    };
}

function parseRequest(body: unknown): JsonRpcRequest {
    const result = jsonRpcRequestSchema.safeParse(body);
    if (!result.success) {
        throw new A2AServiceError(-32600, "Request payload validation error", "INVALID_REQUEST");
    }
    return result.data as JsonRpcRequest;
}

function parseSendParams(params: unknown, agentName = "Gexep"): SendMessageParams {
    const result = sendMessageParamsSchema.safeParse(params);
    if (!result.success) {
        throw new A2AServiceError(-32602, "Invalid parameters", "INVALID_PARAMS");
    }
    const accepted = result.data.configuration?.acceptedOutputModes;
    if (accepted !== undefined && !accepted.includes("text/markdown") && !accepted.includes("text/plain")) {
        throw new A2AServiceError(
            -32005,
            `${agentName} only produces text/markdown or text/plain`,
            "CONTENT_TYPE_NOT_SUPPORTED",
        );
    }
    if (result.data.message.parts.some(
        (part) => part.mediaType !== undefined && part.mediaType !== "text/plain",
    )) {
        throw new A2AServiceError(
            -32005,
            `${agentName} only accepts text/plain message parts`,
            "CONTENT_TYPE_NOT_SUPPORTED",
        );
    }
    return result.data as SendMessageParams;
}

function extractRequestId(body: unknown): JsonRpcId | null {
    if (typeof body !== "object" || body === null || !("id" in body)) {
        return null;
    }
    const id = (body as {id?: unknown}).id;
    return typeof id === "string" || typeof id === "number" ? id : null;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
    if (header === undefined || !header.startsWith("Bearer ")) {
        return false;
    }
    const actual = Buffer.from(header.slice("Bearer ".length));
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function validateVersion(request: Request): void {
    const version = request.header("A2A-Version") || "0.3";
    if (version !== A2A_PROTOCOL_VERSION) {
        throw new A2AServiceError(
            -32009,
            `A2A protocol version ${version} is not supported`,
            "VERSION_NOT_SUPPORTED",
            {requestedVersion: version, supportedVersion: A2A_PROTOCOL_VERSION},
        );
    }
}

export function createGexepA2AApp(
    agent: GexepAgentPort,
    options: GexepA2AServerOptions,
): Express {
    const card = buildGexepAgentCard(options);
    return createAgentA2AApp(agent, options.apiToken === undefined
        ? {agentCard: card}
        : {agentCard: card, apiToken: options.apiToken});
}

export function createAgentA2AApp(
    agent: A2AAgentPort,
    options: A2AAgentAppOptions,
): Express {
    const app = express();
    const service = new GexepTaskService(agent, options.agentCard.name);
    const card = structuredClone(options.agentCard);
    const cardETag = `"${card.name.toLocaleLowerCase()}-${card.version}-a2a-${A2A_PROTOCOL_VERSION}"`;

    app.disable("x-powered-by");
    app.use(express.json({limit: "1mb", type: ["application/json", "application/a2a+json"]}));

    app.get(A2A_AGENT_CARD_PATH, (request, response) => {
        if (request.header("If-None-Match") === cardETag) {
            response.status(304).end();
            return;
        }
        response
            .set("Cache-Control", "public, max-age=300")
            .set("ETag", cardETag)
            .type("application/a2a+json")
            .json(card);
    });

    app.post(A2A_RPC_PATH, async (request, response) => {
        const requestId = extractRequestId(request.body);
        try {
            if (options.apiToken !== undefined && !tokenMatches(request.header("Authorization"), options.apiToken)) {
                response.set("WWW-Authenticate", "Bearer").status(401).json(
                    jsonRpcError(requestId, {code: -32000, message: "Authentication required"}),
                );
                return;
            }
            validateVersion(request);
            const rpcRequest = parseRequest(request.body);

            if (rpcRequest.method === "SendStreamingMessage") {
                const params = parseSendParams(rpcRequest.params, card.name);
                const input = textFromParts(params.message.parts);
                const task = service.createTask(params);
                response.status(200)
                    .set("Content-Type", "text/event-stream")
                    .set("Cache-Control", "no-cache, no-transform")
                    .set("Connection", "keep-alive");
                response.flushHeaders();

                const observer: TaskObserver = {
                    emit: (event) => {
                        if (!response.writableEnded) {
                            response.write(`data: ${JSON.stringify(jsonRpcSuccess(rpcRequest.id, event))}\n\n`);
                        }
                    },
                };
                observer.emit({task: copyTask(task)});
                await service.runTask(task, input, observer);
                response.end();
                return;
            }

            const result = await dispatchJsonRpc(service, rpcRequest, card.name);
            response.type("application/json").json(jsonRpcSuccess(rpcRequest.id, result));
        } catch (error) {
            const payload = error instanceof A2AServiceError
                ? serviceErrorPayload(error)
                : {code: -32603, message: "Internal error"};
            if (!(error instanceof A2AServiceError)) {
                logger.error(error, `${card.name} A2A request failed`);
            }
            if (!response.headersSent) {
                response.type("application/json").json(jsonRpcError(requestId, payload));
            } else if (!response.writableEnded) {
                response.write(`data: ${JSON.stringify(jsonRpcError(requestId, payload))}\n\n`);
                response.end();
            }
        }
    });

    app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
        if (error instanceof SyntaxError && "body" in error) {
            response.status(400).type("application/json").json(
                jsonRpcError(null, {code: -32700, message: "Invalid JSON payload"}),
            );
            return;
        }
        next(error);
    });

    return app;
}

async function dispatchJsonRpc(
    service: GexepTaskService,
    request: JsonRpcRequest,
    agentName: string,
): Promise<unknown> {
    switch (request.method) {
        case "SendMessage": {
            const params = parseSendParams(request.params, agentName);
            const task = service.createTask(params);
            const execution = service.runTask(task, textFromParts(params.message.parts));
            if (params.configuration?.returnImmediately !== true) {
                await execution;
            }
            const result: SendMessageResult = {task: service.getTask(task.id, params.configuration?.historyLength)};
            return result;
        }
        case "GetTask": {
            const params = getTaskParamsSchema.safeParse(request.params);
            if (!params.success) {
                throw new A2AServiceError(-32602, "Invalid parameters", "INVALID_PARAMS");
            }
            return service.getTask(params.data.id, params.data.historyLength);
        }
        case "ListTasks": {
            const params = listTasksParamsSchema.safeParse(request.params ?? {});
            if (!params.success) {
                throw new A2AServiceError(-32602, "Invalid parameters", "INVALID_PARAMS");
            }
            return service.listTasks(params.data as ListTaskParams);
        }
        case "CancelTask": {
            const params = getTaskParamsSchema.pick({id: true}).safeParse(request.params);
            if (!params.success) {
                throw new A2AServiceError(-32602, "Invalid parameters", "INVALID_PARAMS");
            }
            return service.cancelTask(params.data.id);
        }
        case "SubscribeToTask":
        case "CreateTaskPushNotificationConfig":
        case "GetTaskPushNotificationConfig":
        case "ListTaskPushNotificationConfigs":
        case "DeleteTaskPushNotificationConfig":
        case "GetExtendedAgentCard":
            throw new A2AServiceError(-32004, "Operation is not supported", "UNSUPPORTED_OPERATION");
        default:
            throw new A2AServiceError(-32601, "Method not found", "METHOD_NOT_FOUND");
    }
}
