# Pantheon A2A 接口

本目录实现 Pantheon 的 A2A 1.0 对等网络与公开边界。协议采用 JSON-RPC over HTTP，并用 SSE 返回流式任务事件。Gexep、Jezeh、Lexey、Zebeh 都有自己的 Agent Card 和消息端点，也共享同一个运行时目录，因此每个 Agent 都能通过 `discover_agents` 感知其余在线节点。对外仍只发布 Gexep；其他 Agent 的 A2A 路由固定监听 `127.0.0.1`。

## 公开端点

| 方法 | 路径 | 用途 |
| ---- | ---- | ---- |
| `GET` | `/.well-known/agent-card.json` | Gexep Agent Card；带 5 分钟缓存和 ETag |
| `POST` | `/a2a` | A2A 1.0 JSON-RPC 入口 |

RPC 支持以下方法：

| 方法 | 状态 | 说明 |
| ---- | ---- | ---- |
| `SendMessage` | 支持 | 默认等待任务结束；结果写入 Task Artifact |
| `SendStreamingMessage` | 支持 | SSE 依次返回 Task、状态更新、Artifact 更新和最终状态 |
| `GetTask` | 支持 | 查询目标 Agent 当前进程内的任务 |
| `ListTasks` | 支持 | 按上下文或状态筛选并分页 |
| `CancelTask` | 有标准错误语义 | 当前 Agent Loop 不能安全中断，返回 `-32002` |
| 订阅、Push Notification、Extended Card | 不支持 | 返回 A2A `UnsupportedOperationError` |

所有 RPC 请求必须发送 `A2A-Version: 1.0`。按 1.0 规范，缺少该头会按旧版 `0.3` 解释，因此本服务返回 `VersionNotSupportedError`（`-32009`）。输入只接受文本，输出为 `text/markdown`。

## 内部对等发现

内部服务固定绑定 `127.0.0.1:<PANTHEON_INTERNAL_PORT>`，默认端口为 `3001`。三个非公开 Agent 使用路径作用域端点：

| Agent | Agent Card | JSON-RPC |
| ----- | ---------- | -------- |
| Jezeh | `/agents/jezeh/.well-known/agent-card.json` | `/agents/jezeh/a2a` |
| Lexey | `/agents/lexey/.well-known/agent-card.json` | `/agents/lexey/a2a` |
| Zebeh | `/agents/zebeh/.well-known/agent-card.json` | `/agents/zebeh/a2a` |

启动时，四个 Agent 连同职责、技能、Card URL、RPC URL 和支持的 A2A 操作一起注册。`BaseAgent` 为所有 Agent 注入相同的 `discover_agents` 工具；查询会排除调用者自身，并可按能力关键词筛选。这解决的是“彼此感知与可寻址”，不是自动委派：当前尚未向模型提供跨 Agent 发送消息的工具，所以不得把一次发现描述成已经委派或收到结果。

## 示例

先启动服务：

```bash
pnpm start
```

读取 Agent Card：

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
    "id": "demo-1",
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

将方法改为 `SendStreamingMessage` 并给 `curl` 增加 `-N`，即可查看 SSE 事件。

## 配置与安全边界

| 环境变量 | 默认值 | 作用 |
| -------- | ------ | ---- |
| `PANTHEON_HOST` | `127.0.0.1` | 监听地址；默认不接受其他主机连接 |
| `PANTHEON_PORT` | `3000` | 服务端口 |
| `PANTHEON_INTERNAL_PORT` | `3001` | 内部对等 A2A 端口；始终只绑定 `127.0.0.1` |
| `PANTHEON_PUBLIC_URL` | `http://127.0.0.1:<port>` | 写入 Agent Card 的公开基址 |
| `PANTHEON_API_TOKEN` | 未设置 | 设置后，`/a2a` 要求 Bearer Token；Agent Card 保持可发现 |
| `PANTHEON_A2A_CARD_URL` | 本机 Agent Card | 前端连接的 Agent Card 地址 |

生产环境应配置 HTTPS 反向代理、`PANTHEON_PUBLIC_URL` 和强随机 `PANTHEON_API_TOKEN`。反向代理只应转发公开端口，不应转发 `PANTHEON_INTERNAL_PORT`。Agent Card 不包含密钥。服务不会通过 A2A 输出 DeepSeek reasoning、工具参数或其他 Agent 的私有上下文；function call 只会被映射为不含工具细节的通用工作状态。

## 状态与并发

A2A Task 当前按 Agent 保存在服务进程内，重启后不可继续通过 `GetTask` 查询；模型对话历史仍由 SQLite 持久化。由于每个 `BaseAgent` 都维护可变对话上下文，各 Agent 的 A2A 任务分别串行执行，避免同一 Agent 的并发请求交叉污染历史。

前端通过 Agent Card 发现 RPC 地址，不导入后端 Agent 类。公网边界是“外部客户端或终端 UI ⇄ Gexep”，内部边界是四个 Agent 的对等发现与可寻址 A2A 服务；自动选择目标、发送消息并汇总结果的委派工具仍是后续工作。
