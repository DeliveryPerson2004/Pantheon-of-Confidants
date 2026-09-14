import {
    A2A_PROTOCOL_VERSION,
    Role,
    TaskState,
    type AgentCard,
    type Message,
    type SendMessageRequest,
    type Task,
} from "@a2a-js/sdk";
import {
    ClientFactory,
    JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import type {AgentEventListener} from "../DeepSeek/Agents/BaseAgent.ts";
import {taskStateLabel, textFromMessage, textFromTask, textPart} from "../../a2a/types.ts";
import {
    buildGexepAgentCard,
    buildPantheonAgentCard,
} from "./AgentCards.ts";
import type {DelegationTrace} from "./DelegationContext.ts";

export interface A2AAgentHandle {
    ask(input: string, options?: {delegationTrace?: DelegationTrace}): Promise<string>;
    setEventListener(listener: AgentEventListener | undefined): void;
}

export interface RegisteredAgent {
    agentCardUrl: string;
    card: AgentCard;
    visibility: "public" | "internal";
    agent: A2AAgentHandle;
}

export interface AgentDiscoveryResult {
    protocolVersion: typeof A2A_PROTOCOL_VERSION;
    agentCards: AgentCard[];
    total: number;
}

export interface AgentDelegationResult {
    agentName: string;
    contextId: string;
    taskId?: string;
    state?: string;
    text: string;
}

export interface AgentDirectory {
    discover(capability?: string, requesterName?: string): AgentDiscoveryResult;
    delegate(
        requesterName: string,
        targetName: string,
        input: string,
        contextId?: string,
        trace?: DelegationTrace,
    ): Promise<AgentDelegationResult>;
}

function normalized(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function createAuthenticatedFetch(fetchImplementation: typeof fetch, apiToken?: string): typeof fetch {
    if (apiToken === undefined) {
        return fetchImplementation;
    }
    return async (input, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${apiToken}`);
        return fetchImplementation(input, {...init, headers});
    };
}

export const emptyAgentDirectory: AgentDirectory = {
    discover: () => ({
        protocolVersion: A2A_PROTOCOL_VERSION,
        agentCards: [],
        total: 0,
    }),
    delegate: async () => {
        throw new Error("当前运行时没有可用的 A2A Agent 目录。");
    },
};

export class InternalAgentRegistry implements AgentDirectory {
    private readonly registrations = new Map<string, RegisteredAgent>();
    private readonly clientFactory: ClientFactory;

    constructor(apiToken?: string, fetchImplementation?: typeof fetch) {
        const transportFetch = createAuthenticatedFetch(fetchImplementation ?? fetch, apiToken);
        this.clientFactory = new ClientFactory({
            transports: [new JsonRpcTransportFactory({fetchImpl: transportFetch})],
        });
    }

    register(
        card: AgentCard,
        agentCardUrl: string,
        visibility: RegisteredAgent["visibility"],
        agent: A2AAgentHandle,
    ): void {
        const key = normalized(card.name);
        if (this.registrations.has(key)) {
            throw new Error(`Agent ${card.name} 已经注册。`);
        }
        this.registrations.set(key, {
            agentCardUrl,
            card: structuredClone(card),
            visibility,
            agent,
        });
    }

    discover(capability?: string, requesterName?: string): AgentDiscoveryResult {
        const query = capability === undefined ? undefined : normalized(capability);
        const requester = requesterName === undefined ? undefined : normalized(requesterName);
        const agentCards = [...this.registrations.entries()]
            .filter(([key]) => key !== requester)
            .map(([, registration]) => registration.card)
            .filter((card) => query === undefined || this.matchesCapability(card, query))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((card) => structuredClone(card));

        return {
            protocolVersion: A2A_PROTOCOL_VERSION,
            agentCards,
            total: agentCards.length,
        };
    }

    async delegate(
        requesterName: string,
        targetName: string,
        input: string,
        contextId?: string,
        trace?: DelegationTrace,
    ): Promise<AgentDelegationResult> {
        const requester = normalized(requesterName);
        const target = normalized(targetName);
        if (requester === target) {
            throw new Error("Agent 不能通过 A2A 将任务委派给自己。");
        }
        const registration = this.registrations.get(target);
        if (registration === undefined) {
            throw new Error(`未发现名为 ${targetName} 的 A2A Agent。`);
        }

        const path = trace?.path ?? [requesterName];
        if (path.some((name) => normalized(name) === target)) {
            throw new Error(`检测到循环委派：${[...path, registration.card.name].join(" -> ")}`);
        }
        if (path.length >= 4) {
            throw new Error("A2A 委派深度已达到上限 4。请由当前 Agent 汇总已有结果。");
        }
        const delegationTrace: DelegationTrace = {
            traceId: trace?.traceId ?? crypto.randomUUID(),
            path: [...path, registration.card.name],
        };

        const request: SendMessageRequest = {
            tenant: "",
            message: {
                messageId: crypto.randomUUID(),
                contextId: contextId ?? "",
                taskId: "",
                role: Role.ROLE_USER,
                parts: [textPart(input)],
                metadata: {pantheonDelegation: delegationTrace},
                extensions: [],
                referenceTaskIds: [],
            },
            configuration: {
                acceptedOutputModes: ["text/markdown", "text/plain"],
                taskPushNotificationConfig: undefined,
                returnImmediately: false,
            },
            metadata: {pantheonDelegation: delegationTrace},
        };

        const client = await this.clientFactory.createFromAgentCard(registration.card);
        const result = await client.sendMessage(request, {
            signal: AbortSignal.timeout(120_000),
        });
        return this.delegationResult(registration.card.name, result);
    }

    entries(visibility?: RegisteredAgent["visibility"]): RegisteredAgent[] {
        return [...this.registrations.values()]
            .filter((registration) => visibility === undefined || registration.visibility === visibility)
            .map((registration) => ({
                ...registration,
                card: structuredClone(registration.card),
            }));
    }

    private matchesCapability(card: AgentCard, query: string): boolean {
        const searchable = [
            card.name,
            card.description,
            ...card.skills.flatMap((skill) => [
                skill.id,
                skill.name,
                skill.description,
                ...skill.tags,
            ]),
        ].join("\n").toLocaleLowerCase();
        return searchable.includes(query);
    }

    private delegationResult(agentName: string, result: Message | Task): AgentDelegationResult {
        if ("messageId" in result) {
            return {
                agentName,
                contextId: result.contextId,
                text: textFromMessage(result),
            };
        }

        const state = result.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
        if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED) {
            const detail = result.status?.message === undefined
                ? ""
                : textFromMessage(result.status.message);
            throw new Error(detail || `${agentName} 的 A2A 任务执行失败。`);
        }
        return {
            agentName,
            contextId: result.contextId,
            taskId: result.id,
            state: taskStateLabel(state),
            text: textFromTask(result),
        };
    }
}

export interface PantheonAgentSet {
    Gexep: A2AAgentHandle;
    Jezeh: A2AAgentHandle;
    Lexey: A2AAgentHandle;
    Zebeh: A2AAgentHandle;
}

export interface PantheonAgentUrls {
    publicBaseUrl: string;
    internalBaseUrl: string;
    apiToken?: string;
}

export function registerPantheonAgents(
    registry: InternalAgentRegistry,
    agents: PantheonAgentSet,
    urls: PantheonAgentUrls,
): void {
    const publicCard = buildGexepAgentCard(urls.publicBaseUrl, urls.apiToken);
    registry.register(
        publicCard,
        new URL("/.well-known/agent-card.json", urls.publicBaseUrl).toString(),
        "public",
        agents.Gexep,
    );

    const definitions = [
        {
            name: "Jezeh",
            description: "负责云端 Markdown 备忘录的创建、检索、编辑与下载。",
            skills: [{
                id: "memo-management",
                name: "Memo management",
                description: "在隔离环境中管理 Markdown 备忘录。",
                tags: ["memo", "markdown", "notes", "备忘录"],
            }],
            agent: agents.Jezeh,
        },
        {
            name: "Lexey",
            description: "语言、翻译、写作、资料检索与技能驱动的知识 Agent。",
            skills: [{
                id: "language-research",
                name: "Language and research",
                description: "处理翻译、润色、写作和联网资料检索。",
                tags: ["language", "translation", "writing", "research", "翻译"],
            }],
            agent: agents.Lexey,
        },
        {
            name: "Zebeh",
            description: "通用分析与联网检索 Agent。",
            skills: [{
                id: "general-research",
                name: "General research",
                description: "执行通用分析与联网信息检索。",
                tags: ["analysis", "research", "web", "检索"],
            }],
            agent: agents.Zebeh,
        },
    ] as const;

    for (const definition of definitions) {
        const prefix = `/agents/${definition.name.toLocaleLowerCase()}`;
        const card = buildPantheonAgentCard({
            name: definition.name,
            description: definition.description,
            rpcUrl: new URL(`${prefix}/a2a`, urls.internalBaseUrl).toString(),
            skills: definition.skills.map((skill) => ({...skill, tags: [...skill.tags]})),
        });
        registry.register(
            card,
            new URL(`${prefix}/.well-known/agent-card.json`, urls.internalBaseUrl).toString(),
            "internal",
            definition.agent,
        );
    }
}
