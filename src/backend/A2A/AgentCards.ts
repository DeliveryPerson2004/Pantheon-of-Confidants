import {
    A2A_PROTOCOL_VERSION,
    type AgentCard,
    type AgentSkill,
} from "@a2a-js/sdk";

export interface PantheonAgentCardDefinition {
    name: string;
    description: string;
    rpcUrl: string;
    skills: Array<Pick<AgentSkill, "id" | "name" | "description" | "tags"> & {
        examples?: string[];
    }>;
    apiToken?: string;
}

export function buildPantheonAgentCard(definition: PantheonAgentCardDefinition): AgentCard {
    const protectedByBearer = definition.apiToken !== undefined;
    return {
        name: definition.name,
        description: definition.description,
        supportedInterfaces: [{
            url: definition.rpcUrl,
            protocolBinding: "JSONRPC",
            tenant: "",
            protocolVersion: A2A_PROTOCOL_VERSION,
        }],
        provider: {
            organization: "Pantheon of Confidants",
            url: "https://github.com/DeliveryPerson2004/DeepForge",
        },
        version: "1.0.0",
        capabilities: {
            streaming: true,
            pushNotifications: false,
            extensions: [],
            extendedAgentCard: false,
        },
        securitySchemes: protectedByBearer ? {
            bearerAuth: {
                scheme: {
                    $case: "httpAuthSecurityScheme",
                    value: {
                        description: "通过 PANTHEON_API_TOKEN 配置的访问令牌。",
                        scheme: "Bearer",
                        bearerFormat: "opaque",
                    },
                },
            },
        } : {},
        securityRequirements: protectedByBearer ? [{
            schemes: {bearerAuth: {list: []}},
        }] : [],
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/markdown", "text/plain"],
        skills: definition.skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            tags: [...skill.tags],
            examples: [...(skill.examples ?? [])],
            inputModes: ["text/plain"],
            outputModes: ["text/markdown", "text/plain"],
            securityRequirements: protectedByBearer ? [{
                schemes: {bearerAuth: {list: []}},
            }] : [],
        })),
        signatures: [],
    };
}

export function buildGexepAgentCard(publicBaseUrl: string, apiToken?: string): AgentCard {
    return buildPantheonAgentCard({
        name: "Gexep",
        description: "Pantheon of Confidants 的唯一公开入口 Agent，负责理解请求、协调处理并执行已授权的邮件操作。",
        rpcUrl: new URL("/a2a", publicBaseUrl).toString(),
        ...(apiToken === undefined ? {} : {apiToken}),
        skills: [{
            id: "gexep-conversation",
            name: "Gexep conversation and coordination",
            description: "理解用户目标、发现并委派给合适的伙伴，并在用户明确授权时发送邮件。",
            tags: ["conversation", "coordination", "delegation", "email"],
            examples: ["帮我梳理这个目标", "请让语言 Agent 翻译这段话"],
        }],
    });
}
