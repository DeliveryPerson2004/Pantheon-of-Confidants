import type {AgentEventListener} from "../DeepSeek/Agents/BaseAgent.ts";
import {A2A_PROTOCOL_VERSION} from "../../a2a/types.ts";

export interface A2AAgentHandle {
    ask(input: string): Promise<string>;
    setEventListener(listener: AgentEventListener | undefined): void;
}

export interface InternalAgentSkill {
    id: string;
    name: string;
    description: string;
    tags: string[];
    examples?: string[];
}

export interface InternalAgentProfile {
    name: string;
    description: string;
    status: "available";
    visibility: "public" | "internal";
    protocolVersion: typeof A2A_PROTOCOL_VERSION;
    agentCardUrl: string;
    rpcUrl: string;
    supportedOperations: string[];
    skills: InternalAgentSkill[];
}

export interface AgentDiscoveryResult {
    protocolVersion: typeof A2A_PROTOCOL_VERSION;
    agents: InternalAgentProfile[];
    total: number;
}

export interface AgentDirectory {
    discover(capability?: string, requesterName?: string): AgentDiscoveryResult;
}

export interface RegisteredAgent {
    profile: InternalAgentProfile;
    agent: A2AAgentHandle;
}

const supportedOperations = [
    "SendMessage",
    "SendStreamingMessage",
    "GetTask",
    "ListTasks",
];

function normalized(value: string): string {
    return value.trim().toLocaleLowerCase();
}

function copyProfile(profile: InternalAgentProfile): InternalAgentProfile {
    return structuredClone(profile);
}

export const emptyAgentDirectory: AgentDirectory = {
    discover: () => ({
        protocolVersion: A2A_PROTOCOL_VERSION,
        agents: [],
        total: 0,
    }),
};

export class InternalAgentRegistry implements AgentDirectory {
    private readonly registrations = new Map<string, RegisteredAgent>();

    register(profile: Omit<InternalAgentProfile, "status" | "protocolVersion" | "supportedOperations">, agent: A2AAgentHandle): void {
        const key = normalized(profile.name);
        if (this.registrations.has(key)) {
            throw new Error(`Agent ${profile.name} 已经注册。`);
        }

        this.registrations.set(key, {
            profile: {
                ...structuredClone(profile),
                status: "available",
                protocolVersion: A2A_PROTOCOL_VERSION,
                supportedOperations: [...supportedOperations],
            },
            agent,
        });
    }

    discover(capability?: string, requesterName?: string): AgentDiscoveryResult {
        const query = capability === undefined ? undefined : normalized(capability);
        const requester = requesterName === undefined ? undefined : normalized(requesterName);
        const agents = [...this.registrations.entries()]
            .filter(([key]) => key !== requester)
            .map(([, registration]) => registration.profile)
            .filter((profile) => {
                if (query === undefined) {
                    return true;
                }
                const searchable = [
                    profile.name,
                    profile.description,
                    ...profile.skills.flatMap((skill) => [
                        skill.id,
                        skill.name,
                        skill.description,
                        ...skill.tags,
                    ]),
                ].join("\n").toLocaleLowerCase();
                return searchable.includes(query);
            })
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(copyProfile);

        return {
            protocolVersion: A2A_PROTOCOL_VERSION,
            agents,
            total: agents.length,
        };
    }

    entries(visibility?: InternalAgentProfile["visibility"]): RegisteredAgent[] {
        return [...this.registrations.values()]
            .filter(({profile}) => visibility === undefined || profile.visibility === visibility)
            .map(({profile, agent}) => ({profile: copyProfile(profile), agent}));
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
}

export function registerPantheonAgents(
    registry: InternalAgentRegistry,
    agents: PantheonAgentSet,
    urls: PantheonAgentUrls,
): void {
    const publicBaseUrl = new URL(urls.publicBaseUrl);
    const internalBaseUrl = new URL(urls.internalBaseUrl);
    const internalUrls = (name: string) => {
        const prefix = `/agents/${name.toLocaleLowerCase()}`;
        return {
            agentCardUrl: new URL(`${prefix}/.well-known/agent-card.json`, internalBaseUrl).toString(),
            rpcUrl: new URL(`${prefix}/a2a`, internalBaseUrl).toString(),
        };
    };

    registry.register({
        name: "Gexep",
        description: "Pantheon 的公开入口与协调 Agent，可理解请求并执行已授权的邮件操作。",
        visibility: "public",
        agentCardUrl: new URL("/.well-known/agent-card.json", publicBaseUrl).toString(),
        rpcUrl: new URL("/a2a", publicBaseUrl).toString(),
        skills: [{
            id: "gexep-conversation",
            name: "Conversation and coordination",
            description: "理解目标、协调处理并执行已授权的邮件操作。",
            tags: ["conversation", "coordination", "email"],
        }],
    }, agents.Gexep);

    registry.register({
        name: "Jezeh",
        description: "负责云端 Markdown 备忘录的创建、检索、编辑与下载。",
        visibility: "internal",
        ...internalUrls("Jezeh"),
        skills: [{
            id: "memo-management",
            name: "Memo management",
            description: "在隔离环境中管理 Markdown 备忘录。",
            tags: ["memo", "markdown", "notes", "备忘录"],
        }],
    }, agents.Jezeh);

    registry.register({
        name: "Lexey",
        description: "语言、翻译、写作、资料检索与技能驱动的知识 Agent。",
        visibility: "internal",
        ...internalUrls("Lexey"),
        skills: [{
            id: "language-research",
            name: "Language and research",
            description: "处理翻译、润色、写作和联网资料检索。",
            tags: ["language", "translation", "writing", "research", "翻译"],
        }],
    }, agents.Lexey);

    registry.register({
        name: "Zebeh",
        description: "通用分析与联网检索 Agent。",
        visibility: "internal",
        ...internalUrls("Zebeh"),
        skills: [{
            id: "general-research",
            name: "General research",
            description: "执行通用分析与联网信息检索。",
            tags: ["analysis", "research", "web", "检索"],
        }],
    }, agents.Zebeh);
}
