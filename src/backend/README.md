# Pantheon of Confidants · 后端架构

> 项目定位、命名故事和快速概览见 [根目录 README](../../README.md)。本文只说明后端的实际结构、运行方式与当前边界；设计层面的观点集中记录在 [THINKING.md](THINKING.md)。

后端基于 DeepSeek `/responses` API 构建，并通过 A2A 1.0 只公开 Gexep。四个已实现 Agent 都注册标准 Agent Card 和消息端点，`BaseAgent` 为它们统一提供发现与委派工具；非 Gexep 端点固定绑定回环地址。A2A 协议层使用官方 `@a2a-js/sdk`，具体 Agent 负责角色指令和专属工具，`ModelClient` 负责模型 HTTP 请求。终端 UI 已移出后端进程，通过公开 Agent Card 调用 Gexep。

## 1. 技术栈

| 类别 | 选型 | 用途 |
| ---- | ---- | ---- |
| 语言与模块 | TypeScript 7、ESM | 严格类型检查，源码使用 `.ts` 扩展名导入 |
| 运行与包管理 | tsx、pnpm | 直接运行 TypeScript，并通过 `tsc --noEmit` 检查类型 |
| 模型接口 | DeepSeek `/responses`、原生 `fetch` | 保留 provider 特有的请求字段和输出项，不依赖模型 SDK |
| Agent 协议 | `@a2a-js/sdk`、A2A 1.0、JSON-RPC、SSE | 用官方 Server/Client 抽象发布 Card、发现伙伴和交换 Task/Artifact |
| 参数校验 | Zod | 在运行时校验 function tool 的入参 |
| 持久化 | better-sqlite3 | 以单文件 `database.db` 保存 Agent 与消息历史 |
| HTTP 服务 | Express 5 | 承载公开 Gexep 入口和仅回环可达的内部 Agent 端点 |
| 终端界面 | pi-tui | 独立前端进程，通过 A2A 与 Gexep 对话 |
| 沙箱 | E2B | 为 Jezeh 提供网络隔离的备忘录工作区 |
| 邮件 | Nodemailer | 由 Gexep 通过固定 QQ SMTP 配置发送邮件 |
| 日志与测试 | Pino、`node:test` | 统一日志和无额外测试框架的自动化测试 |

## 2. 目录结构

```text
src/backend/
├── A2A/
│   ├── AgentCards.ts              # Gexep 与内部 Agent 的标准 Agent Card
│   ├── DelegationContext.ts       # 内部委派路径与循环保护 metadata
│   ├── GexepA2AServer.ts          # 官方 Executor、RequestHandler、TaskStore 与 Express handler
│   ├── InternalA2AServer.ts       # Jezeh、Lexey、Zebeh 的回环 A2A 路由
│   ├── InternalAgentRegistry.ts   # 受控 Card 目录与官方 A2A Client 委派
│   └── README.md                 # 公开协议、示例与安全边界
├── DeepSeek/
│   ├── API/responses.ts          # 请求和响应的 TypeScript 类型契约
│   ├── Agents/
│   │   ├── BaseAgent.ts          # 对话循环、共同发现/委派工具、工具回填和历史持久化
│   │   ├── Gexep/                # 入口 Agent；已接入邮件工具
│   │   ├── Jezeh/                # 备忘录 Agent；已接入 E2B 与下载工具
│   │   ├── Lexey/                # 语言 Agent；已接入网页搜索与 Skill
│   │   └── Zebeh/                # 开发阶段的行为验证 Agent
│   ├── ModelClient.ts            # `/responses` HTTP 客户端
│   └── README.md                 # DeepSeek 模块细节
├── E2B/
│   └── jezehMemoSandbox.ts       # 创建、连接并复用 Jezeh Sandbox
├── Tools/
│   ├── loadInstructions.ts       # 读取角色指令，可选注入 Skill 元数据
│   ├── loadSkill.ts              # 按名称加载 Skill 正文
│   ├── sendEmail.ts              # 向固定邮箱发送邮件
│   ├── executeE2BShell.ts        # 在 `/memos` 中执行沙箱命令
│   ├── downloadMemo.ts           # 将 Markdown 备忘录受限导出到宿主机
│   └── README.md                 # 工具配置与安全边界
├── database/
│   ├── db.ts                     # SQLite 连接与外键配置
│   ├── initDatabase.ts           # 建表并登记默认 Agent
│   └── stmt.ts                   # prepared statements
├── logger.ts                     # Pino 日志封装
├── main.ts                       # 初始化 Gexep 并启动 A2A 服务
└── test.ts                       # Jezeh 真实服务链路脚本
```

共享的 A2A 数据类型和前端客户端位于 `src/a2a/`，终端入口位于 `src/ui/main.ts`；二者都不导入或实例化后端 Agent。

## 3. 请求链路

```text
终端 UI 或其他 A2A Client
  → 获取 Gexep Agent Card
  → 使用 A2A-Version: 1.0 调用 /a2a
  → 官方 DefaultRequestHandler 校验协议并创建 Task
  → Gexep 加载角色指令、专属工具和共同的 discover_agents / delegate_task
  → 需要了解伙伴时，从运行时目录获取其 Agent Card、能力与 RPC 地址
  → 需要专业协作时，ClientFactory 根据目标 Card 调用其 A2A 端点
  → BaseAgent 调用 ModelClient
  → DeepSeek 返回 message / reasoning / function_call / web_search_call
  → function_call 由具体 Agent 校验并分发给对应工具
  → function_call_output 回填上下文，继续请求模型
  → 没有新的 function_call 时结束，并持久化本轮增量
  → A2A 层将答案放入 Artifact，并返回最终 Task 或 SSE 事件
```

这条链路的分工如下：

- [`DeepSeek/`](DeepSeek/README.md) 负责模型协议、循环控制和 Agent 定制。
- [`A2A/`](A2A/README.md) 负责公开 Gexep 边界、内部对等目录和回环端点；公开 Card 不暴露内部 Agent、reasoning 或工具参数。
- [`Tools/`](Tools/README.md) 负责具体能力及其运行时边界，不负责模型通信。
- `database/` 负责保存 Agent 元数据和已激活的消息记录。
- `E2B/` 只负责 Jezeh Sandbox 的生命周期与文件访问适配。

## 4. 会话持久化

数据库包含两张表：

| 表 | 作用 |
| -- | ---- |
| `agent` | 保存 Agent 名称、当前最大轮次和创建时间；初始化时登记 Gexep、Jezeh、Lexey、Zebeh |
| `message` | 按 `agent_id` 保存序列化的输入项数组，并通过 `is_activated` 控制是否恢复 |

每次实例化 Agent 时，`BaseAgent` 会读取该 Agent 的已激活历史；一次 `ask()` 完成后，只写入本轮新增的输入与输出。这里保存的是对话上下文，不是可检索、可归纳的长期记忆。

## 5. 配置与运行

```bash
pnpm install
cp .env.example .env
pnpm dev:backend:initDatabase
pnpm exec tsc --noEmit
pnpm test
pnpm start
pnpm start:ui # 另一个终端
```

| 环境变量 | 是否必需 | 用途 |
| -------- | -------- | ---- |
| `DEEPSEEK_API_KEY` | 调用 Agent 时必需 | 访问 DeepSeek `/responses` API |
| `PANTHEON_HOST` / `PANTHEON_PORT` | 可选 | A2A 监听地址与端口，默认 `127.0.0.1:3000` |
| `PANTHEON_INTERNAL_PORT` | 可选 | 内部对等 A2A 端口，默认 `3001`；监听地址固定为 `127.0.0.1` |
| `PANTHEON_PUBLIC_URL` | 对外部署时必需 | 写入 Agent Card 的公开服务基址 |
| `PANTHEON_API_TOKEN` | 建议对外部署时配置 | 保护 `/a2a` 的 Bearer Token |
| `PANTHEON_A2A_CARD_URL` | UI 连接远端时配置 | 前端读取的 Gexep Agent Card 地址 |
| `SMTP_PASS` | 使用 Gexep 邮件工具时必需 | QQ SMTP 授权码 |
| `E2B_API_KEY` | 使用 Jezeh 时必需 | 创建或连接 E2B Sandbox |
| `E2B_MEMO_SANDBOX_ID` | 可选 | 复用一个仍在运行或已暂停的 Sandbox |

`pnpm start` 会初始化数据库，启动公开 Gexep 服务，并在回环地址启动内部对等 A2A 服务；`pnpm start:ui` 启动独立终端客户端。后端从 SQLite 恢复各 Agent 的已激活历史，UI 只维护本次客户端进程的显示记录。A2A Task 当前保存在内存中，服务重启后不能继续查询旧 Task。协议方法、curl 示例和生产部署边界见 [A2A 说明](A2A/README.md)。

`src/backend/test.ts` 会访问真实服务并向固定宿主机目录写入备忘录，仅应在配置完整且明确需要端到端验证时手动运行。

## 6. 自动化测试

默认测试使用 `node:test` 和临时目录，不会访问真实 DeepSeek、SMTP 或 E2B 服务。

| 范围 | 测试文件 |
| ---- | -------- |
| Agent 构造、工具分发与循环 | `gexep-agent.test.ts`、`jezeh-agent.test.ts`、`lexey-agent.test.ts` |
| A2A 卡片、任务、流、对等目录与前端客户端 | `a2a-gexep.test.ts`、`internal-agent-registry.test.ts` |
| 工具行为与安全约束 | `send-email.test.ts`、`e2b-shell-execute.test.ts`、`download-memo.test.ts`、`load-skill.test.ts`、`load-instructions.test.ts`、`ask-developer.test.ts` |
| 模型请求与持久化 | `model-client.test.ts`、`database.test.ts` |

其中网络请求、SMTP transport 和 E2B Sandbox 均由测试替身代替；数据库和文件测试在临时目录中运行并在结束后清理。

## 7. 当前边界与后续方向

已经落地的基础包括多轮 Agent Loop、按角色注册工具、Skill 按需加载、SQLite 对话历史、Gexep 邮件发送，以及 Jezeh 的隔离备忘录链路。

当前仍有以下边界：

- 四个 Agent 已能发现彼此，并通过 `delegate_task` 调用官方 A2A Client 发送子任务；当前委派采用等待最终 Task 的同步模式，尚未实现多目标并行调度与持久化下游 Task 恢复。
- 对外没有 Jezeh、Lexey、Zebeh 的 Agent Card 或 API；旧版 UI 的直接角色切换已经移除。
- A2A Task 暂存内存；`CancelTask` 会标记任务取消，但底层 Agent Loop 尚未贯穿 `AbortSignal`，因此不能立即停止已经发出的模型或工具请求。
- MCP 客户端尚未实现，第三方工具仍需以本地 function tool 直接集成。
- GraphRAG 和跨 Agent 的长期记忆尚未实现；SQLite 历史只用于恢复原始上下文。
- Zebeh 目前只有角色与基础 Agent 实现，专门的测试、审核工具仍待补充。

这些方向背后的判断与预期边界见 [THINKING.md](THINKING.md)，不在本文重复展开。
