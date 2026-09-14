import {timingSafeEqual} from "node:crypto";
import express, {type Express, type NextFunction, type Request, type Response} from "express";
import {
    Role,
    TaskState,
    type AgentCard,
    type Artifact,
    type Message,
    type Task,
    type TaskArtifactUpdateEvent,
    type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
    AgentEvent,
    DefaultRequestHandler,
    InMemoryTaskStore,
    type AgentExecutor,
    type ExecutionEventBus,
    type RequestContext,
    type TaskStore,
} from "@a2a-js/sdk/server";
import {
    UserBuilder,
    agentCardHandler,
    jsonRpcHandler,
} from "@a2a-js/sdk/server/express";
import type {AgentEventListener} from "../DeepSeek/Agents/BaseAgent.ts";
import {A2A_AGENT_CARD_PATH, A2A_RPC_PATH, textFromMessage, textPart} from "../../a2a/types.ts";
import {parseDelegationTrace} from "./DelegationContext.ts";
import type {DelegationTrace} from "./DelegationContext.ts";
import {
    buildGexepAgentCard as createGexepAgentCard,
} from "./AgentCards.ts";

export interface A2AAgentPort {
    ask(input: string, options?: {delegationTrace?: DelegationTrace}): Promise<string>;
    setEventListener(listener: AgentEventListener | undefined): void;
}

export type GexepAgentPort = A2AAgentPort;

export interface GexepA2AServerOptions {
    publicBaseUrl: string;
    apiToken?: string;
}

export interface A2AAgentAppOptions {
    agentCard: AgentCard;
    apiToken?: string;
    executor?: PantheonAgentExecutor;
    taskStore?: TaskStore;
}

function agentMessage(text: string, taskId: string, contextId: string): Message {
    return {
        messageId: crypto.randomUUID(),
        contextId,
        taskId,
        role: Role.ROLE_AGENT,
        parts: [textPart(text)],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
    };
}

function statusUpdate(
    taskId: string,
    contextId: string,
    state: TaskState,
    message?: string,
): TaskStatusUpdateEvent {
    return {
        taskId,
        contextId,
        status: {
            state,
            timestamp: new Date().toISOString(),
            message: message === undefined ? undefined : agentMessage(message, taskId, contextId),
        },
        metadata: undefined,
    };
}

export class PantheonAgentExecutor implements AgentExecutor {
    private readonly canceledTasks = new Set<string>();
    private executionQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly agent: A2AAgentPort,
        private readonly agentName: string,
    ) {}

    cancelTask = async (taskId: string): Promise<void> => {
        this.canceledTasks.add(taskId);
    };

    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
        const task = requestContext.task ?? this.createTask(requestContext);
        eventBus.publish(AgentEvent.task(task));

        const execution = this.executionQueue.then(
            () => this.executeSerially(requestContext, eventBus),
        );
        this.executionQueue = execution.catch(() => undefined);
        await execution;
    }

    private createTask(requestContext: RequestContext): Task {
        return {
            id: requestContext.taskId,
            contextId: requestContext.contextId,
            status: {
                state: TaskState.TASK_STATE_SUBMITTED,
                timestamp: new Date().toISOString(),
                message: undefined,
            },
            artifacts: [],
            history: [requestContext.userMessage],
            metadata: requestContext.userMessage.metadata,
        };
    }

    private async executeSerially(
        requestContext: RequestContext,
        eventBus: ExecutionEventBus,
    ): Promise<void> {
        const {taskId, contextId} = requestContext;
        if (this.canceledTasks.has(taskId)) {
            eventBus.publish(AgentEvent.statusUpdate(
                statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED),
            ));
            this.canceledTasks.delete(taskId);
            return;
        }

        eventBus.publish(AgentEvent.statusUpdate(
            statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING),
        ));

        const listener: AgentEventListener = (event) => {
            if (event.type === "function_call") {
                eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
                    taskId,
                    contextId,
                    TaskState.TASK_STATE_WORKING,
                    `${this.agentName} 正在执行操作。`,
                )));
            }
        };

        this.agent.setEventListener(listener);
        try {
            const delegationTrace = parseDelegationTrace(
                requestContext.userMessage.metadata?.pantheonDelegation,
            );
            const answer = await this.agent.ask(
                textFromMessage(requestContext.userMessage),
                delegationTrace === undefined ? {} : {delegationTrace},
            );

            if (this.canceledTasks.has(taskId)) {
                eventBus.publish(AgentEvent.statusUpdate(
                    statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED),
                ));
                return;
            }

            const artifact: Artifact = {
                artifactId: crypto.randomUUID(),
                name: `${this.agentName} response`,
                description: `${this.agentName} 生成的最终结果。`,
                parts: [textPart(answer, "text/markdown")],
                metadata: undefined,
                extensions: [],
            };
            const artifactUpdate: TaskArtifactUpdateEvent = {
                taskId,
                contextId,
                artifact,
                append: false,
                lastChunk: true,
                metadata: undefined,
            };
            eventBus.publish(AgentEvent.artifactUpdate(artifactUpdate));
            eventBus.publish(AgentEvent.statusUpdate(
                statusUpdate(taskId, contextId, TaskState.TASK_STATE_COMPLETED),
            ));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
                taskId,
                contextId,
                TaskState.TASK_STATE_FAILED,
                message,
            )));
        } finally {
            this.agent.setEventListener(undefined);
            this.canceledTasks.delete(taskId);
        }
    }
}

export function buildGexepAgentCard(options: GexepA2AServerOptions): AgentCard {
    return createGexepAgentCard(options.publicBaseUrl, options.apiToken);
}

function tokenMatches(header: string | undefined, expected: string): boolean {
    if (header === undefined || !header.startsWith("Bearer ")) {
        return false;
    }
    const actual = Buffer.from(header.slice("Bearer ".length));
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function bearerMiddleware(expected: string) {
    return (request: Request, response: Response, next: NextFunction): void => {
        if (!tokenMatches(request.header("Authorization"), expected)) {
            response
                .set("WWW-Authenticate", "Bearer")
                .status(401)
                .json({error: "Authentication required"});
            return;
        }
        next();
    };
}

export function createAgentA2AApp(
    agent: A2AAgentPort,
    options: A2AAgentAppOptions,
): Express {
    const executor = options.executor
        ?? new PantheonAgentExecutor(agent, options.agentCard.name);
    const taskStore = options.taskStore ?? new InMemoryTaskStore();
    const requestHandler = new DefaultRequestHandler(
        options.agentCard,
        taskStore,
        executor,
    );
    const app = express();
    app.disable("x-powered-by");
    app.use(A2A_AGENT_CARD_PATH, agentCardHandler({
        agentCardProvider: requestHandler,
        cache: {maxAge: 300},
    }));
    app.use(
        A2A_RPC_PATH,
        ...(options.apiToken === undefined ? [] : [bearerMiddleware(options.apiToken)]),
        jsonRpcHandler({
            requestHandler,
            userBuilder: UserBuilder.noAuthentication,
        }),
    );
    return app;
}

export function createGexepA2AApp(
    agent: GexepAgentPort,
    options: GexepA2AServerOptions,
): Express {
    const agentCard = buildGexepAgentCard(options);
    return createAgentA2AApp(agent, options.apiToken === undefined
        ? {agentCard}
        : {agentCard, apiToken: options.apiToken});
}
