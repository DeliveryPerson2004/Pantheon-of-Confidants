# Pantheon A2A 接口

本目录按 A2A 1.0 官方 JavaScript SDK 的推荐结构实现 Agent 发现与通信，不再自行维护 JSON-RPC、SSE 或 Task 状态机。Gexep、Jezeh、Lexey、Zebeh 都发布标准 Agent Card；每个 Agent 都能从内部目录发现其余 Agent，并通过官方 Client 将子任务发送到对方的 A2A 服务。公网仍只暴露 Gexep，其他服务只监听 `127.0.0.1`。

## 与官方示例的对应关系

| 官方抽象 | 本项目实现 |
| -------- | ---------- |
| `AgentCard` / `AgentSkill` | `AgentCards.ts` 构造标准能力描述、接口和安全声明 |
| `AgentExecutor` | `PantheonAgentExecutor` 将 A2A Message 交给具体 Agent，并发布 Task、状态和 Artifact 事件 |
| `DefaultRequestHandler` | 处理 Task 生命周期、查询、流式事件和内存 Task Store |
| `agentCardHandler` / `jsonRpcHandler` | 挂载标准 well-known Card 和 JSON-RPC HTTP 端点 |
| `InMemoryTaskStore` | 按 Agent 保存当前进程内的 A2A Task |
| `ClientFactory` / `JsonRpcTransportFactory` | 前端调用 Gexep，以及 Agent 之间发送消息 |

官方规范将发现方式分为 well-known Card、受控注册表和直接配置，但没有规定通用的注册中心 API。本项目采用“标准 Agent Card + 进程内受控目录”：目录只负责持有和筛选 Card，真正的通信仍由 Card 中的 `supportedInterfaces` 和官方 A2A Client 完成。

## 公开端点

| 方法 | 路径 | 用途 |
| ---- | ---- | ---- |
| `GET` | `/.well-known/agent-card.json` | Gexep 的标准 Agent Card；带 5 分钟缓存 |
| `POST` | `/a2a` | A2A 1.0 JSON-RPC 入口，支持同步与 SSE 流式消息 |

公开 Card 只描述 Gexep，不列出内部 Agent。设置 `PANTHEON_API_TOKEN` 后，Card 通过 `securitySchemes` 声明 Bearer Auth，`/a2a` 会验证令牌；well-known Card 保持可发现。

## 内部发现与通信

内部服务固定绑定 `127.0.0.1:<PANTHEON_INTERNAL_PORT>`，默认端口为 `3001`：

| Agent | Agent Card | JSON-RPC |
| ----- | ---------- | -------- |
| Jezeh | `/agents/jezeh/.well-known/agent-card.json` | `/agents/jezeh/a2a` |
| Lexey | `/agents/lexey/.well-known/agent-card.json` | `/agents/lexey/a2a` |
| Zebeh | `/agents/zebeh/.well-known/agent-card.json` | `/agents/zebeh/a2a` |

`BaseAgent` 为四个 Agent 统一提供两个模型工具：

- `discover_agents`：读取标准 Agent Card，排除调用者自身，并可按名称、描述或 Skill 标签筛选。
- `delegate_task`：根据目标 Card 创建官方 A2A Client，调用 `SendMessage`，等待 Task 完成并返回 Artifact 文本。

每次委派会在 Message metadata 中附带内部追踪信息。运行时最多允许四层委派，并拒绝路径中已经出现的目标，以避免 Agent 之间循环转交。该 metadata 是本项目的内部约束，不被包装成 A2A 标准字段。

一次典型协作链路为：

```text
Gexep → discover_agents → 读取 Lexey Agent Card
      → delegate_task → ClientFactory 选择 JSON-RPC transport
      → Lexey /a2a → DefaultRequestHandler → PantheonAgentExecutor
      → Task Artifact → Gexep 验收并组织最终答复
```

## 调用示例

启动后端：

```bash
pnpm start
```

读取 Card：

```bash
curl http://127.0.0.1:3000/.well-known/agent-card.json
```

同步发送消息：

```bash
curl http://127.0.0.1:3000/a2a \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "demo-message-1",
        "role": "ROLE_USER",
        "parts": [{"text": "你好，请介绍你自己", "mediaType": "text/plain"}]
      },
      "configuration": {"acceptedOutputModes": ["text/markdown"]}
    }
  }'
```

将方法改为 `SendStreamingMessage` 并给 `curl` 增加 `-N`，即可查看 Task、工作状态、Artifact 和完成状态。应用代码应优先使用 `@a2a-js/sdk/client`，由 SDK 负责协议版本、序列化、传输选择和 SSE 解析。

## 配置与边界

| 环境变量 | 默认值 | 作用 |
| -------- | ------ | ---- |
| `PANTHEON_HOST` | `127.0.0.1` | Gexep 公开服务监听地址 |
| `PANTHEON_PORT` | `3000` | Gexep 公开服务端口 |
| `PANTHEON_INTERNAL_PORT` | `3001` | 内部 A2A 端口；始终只绑定回环地址 |
| `PANTHEON_PUBLIC_URL` | `http://127.0.0.1:<port>` | 写入 Gexep Agent Card 的公开基址 |
| `PANTHEON_API_TOKEN` | 未设置 | 公开 `/a2a` 的 Bearer Token；内部 Client 使用同一令牌配置 |
| `PANTHEON_A2A_CARD_URL` | 本机 Gexep Card | 独立终端 UI 要读取的 Card URL |

生产环境应在 Gexep 前配置 HTTPS 反向代理，并且只转发公开端口。不要转发 `PANTHEON_INTERNAL_PORT`。A2A 输出只包含公开任务状态和结果，不包含 DeepSeek reasoning、工具参数、其他 Agent 的提示词或私有上下文。

Task 当前使用官方 `InMemoryTaskStore`，进程重启后不可恢复；模型对话历史仍由 SQLite 持久化。由于 `BaseAgent` 保有可变对话状态，每个 Agent 的执行器分别串行处理任务。若要水平扩展，需要替换为持久化 Task Store，并把取消信号继续传入模型与工具执行链。

参考：[A2A 1.0 Specification](https://a2a-protocol.org/v1.0.0/specification/)、[Agent Discovery](https://a2a-protocol.org/v1.0.0/topics/agent-discovery/)、[官方 JavaScript SDK](https://github.com/a2aproject/a2a-js)。
