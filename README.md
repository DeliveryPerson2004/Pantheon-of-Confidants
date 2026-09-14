# Pantheon of Confidants

> **A multi-agent runtime where every agent is a confidant.**
>
> **多智能体运行时——每一个 Agent，都是一位挚友。**

我想要学习 Agent，源于曾经看过的一场 Google 大会：会上以规划一场马拉松为例，展示了 Agent 在多方协作场景中的潜力。马拉松涉及主办方、政府部门、赞助商、参赛者及周边社区等众多利益相关方；若想制定一套让各方满意且符合相关规定的方案，往往需要大量沟通与磋商，而文件在各方之间的流转也十分缓慢。引入 Agent 后，各方可以借助各自的 Agent 对齐诉求、交换信息并协助检查合规性，从而显著降低沟通成本。受此启发，这个项目旨在“粘合”我学习和构建 Agent 过程中产生的想法，以及接触到的各类协议与技术，并借此记录和表达自己的观点，包括但不限于 MCP、A2A、Sandbox 和 GraphRAG。当前已经以 A2A 1.0 建立 Gexep 的公开服务边界；GraphRAG 等方向仍需进一步调研与验证。

## 名字从哪来

每个 Agent 都以现实中的一位好友为原型：取好友中文名的拼音首字母，在字母之间插入两个 `e`，例如 `gxp → Gexep`、`lxy → Lexey`、`jyh → Jeyeh`。`Pantheon` 是众 Agent 的群像，`Confidant` 则表达“挚友”这一共同身份。完整名册见 [Agents 说明](src/backend/DeepSeek/Agents/README.md)。

## 已实现的能力

- **强类型 Agent Loop**：通过 Node.js 原生 `fetch` 调用 DeepSeek `/responses` API，逐项处理 `message`、`reasoning`、`function_call` 和 `web_search_call`，并将工具结果回填给模型继续推理。
- **官方 A2A 1.0 对等网络**：基于 `@a2a-js/sdk` 的 Agent Card、`AgentExecutor`、`DefaultRequestHandler`、`ClientFactory` 和 JSON-RPC/SSE transport；四个 Agent 可以发现彼此并真正委派子任务。
- **前后端进程分离**：终端 UI 作为独立客户端读取 Gexep Agent Card 后调用远端接口，不直接实例化任何后端 Agent；后端同时承载公开入口与仅回环可达的内部 A2A 服务。
- **单一公开 Agent**：对外只暴露 Gexep 的 Agent Card 与 RPC 入口；Jezeh、Lexey、Zebeh 的卡片和路由固定监听 `127.0.0.1`，不成为公网 API。可选 Bearer Token 用于保护公开 RPC。
- **按角色分配能力**：Gexep 可向固定邮箱发送邮件，以便主动与我联系，让我离开电脑时也能通过手机查看它想传达的消息；Lexey 负责语言任务，并支持网页搜索和按需加载 Skill；Jezeh 在网络隔离的 E2B Sandbox 中管理 Markdown 备忘录；Zebeh 用于开发阶段的行为验证。
- **受控工具边界**：工具由具体 Agent 显式注册，入参经 Zod 校验；Jezeh 的命令默认在 E2B 的 `/memos` 中运行，并通过受限下载工具将备忘录导出到固定宿主机目录。
- **本地会话持久化**：使用 `better-sqlite3` 管理单文件 `database.db`，按 Agent 保存对话历史，并通过激活态控制恢复范围。该状态也为后续长期记忆机制预留：届时可判断哪些短期记忆不应继续占用当前上下文，将其置为非激活态，从而实现上下文管理。
- **全屏终端界面**：基于 `pi-tui` 提供独立的 Gexep A2A 客户端、Markdown 渲染、滚动搜索、命令补全和任务状态提示。
- **轻量工程栈**：TypeScript、ESM、pnpm、tsx 和 Node.js 内置测试框架，不引入模型 SDK 或 ORM。

MCP 客户端与 GraphRAG 长期记忆仍处于设计阶段。A2A 的对等发现和消息委派已经落地：模型先通过 `discover_agents` 选择标准 Agent Card，再通过 `delegate_task` 使用官方 Client 发送任务，并对下游结果进行验收与汇总。

## 快速开始

```bash
pnpm install
cp .env.example .env
pnpm dev:backend:initDatabase
pnpm exec tsc --noEmit
pnpm test
pnpm start
# 在另一个终端中启动前端
pnpm start:ui
```

调用模型时需要配置 `DEEPSEEK_API_KEY`。使用 Gexep 的邮件工具还需配置 `SMTP_PASS`。A2A 服务默认监听 `127.0.0.1:3000`；需要鉴权时，在服务端和 UI 两侧设置相同的 `PANTHEON_API_TOKEN`。UI 可通过 `PANTHEON_A2A_CARD_URL` 连接远端 Gexep。

`pnpm start` 会初始化本地数据库并启动 Gexep A2A 后端；`pnpm start:ui` 单独启动全屏终端客户端。输入 `/help` 查看帮助，`Ctrl+C` 或 `/quit` 退出。界面依赖 Node.js 22.19 或更高版本。协议端点、请求示例和生产安全建议见 [Gexep A2A 接口说明](src/backend/A2A/README.md)。

`src/backend/test.ts` 是会调用真实 DeepSeek、E2B 和宿主机文件系统的 Jezeh 完整链路脚本，不属于默认测试套件。

## 目录速览

```text
src/
├── a2a/                  # 官方 A2A 类型适配与 Gexep ClientFactory 客户端
├── backend/
│   ├── A2A/               # A2A 对等目录、内部端点与公开 Gexep 服务
│   ├── DeepSeek/          # 模型客户端、API 类型、Agent Loop 与具体 Agent
│   ├── E2B/               # Jezeh 的 Sandbox 创建和复用
│   ├── Tools/             # Skill、邮件、E2B Shell 与备忘录下载工具
│   ├── database/          # SQLite 初始化与 prepared statements
│   ├── logger.ts          # 统一日志
│   ├── main.ts            # Gexep A2A 后端入口
│   └── test.ts            # Jezeh 真实链路脚本
└── ui/                    # 独立的 pi-tui A2A 客户端与主题

test/                      # 隔离的自动化测试
```

## 给面试官的阅读导航

如果时间有限，建议先用 5 分钟阅读本页的“已实现的能力”，再依次查看“设计思考”和“DeepSeek 模块”：前者集中说明关键技术取舍，后者展示这些判断如何落实为 Agent Loop。若希望进一步考察工程完整性，可继续阅读后端架构、工具边界和自动化测试。

| 顺序 | 文档 | 建议关注 |
| ---- | ---- | -------- |
| 1 | [设计思考](src/backend/THINKING.md) | Workflow 与 Agentic 的关系，以及模型耦合、MCP、A2A、Sandbox 和 GraphRAG 等方向上的判断与取舍 |
| 2 | [DeepSeek 模块](src/backend/DeepSeek/README.md) | 强类型模型协议、Agent Loop、工具结果回填和循环终止条件 |
| 3 | [Gexep A2A 接口](src/backend/A2A/README.md) | A2A 1.0 Agent Card、JSON-RPC/SSE、公开边界、鉴权与任务状态 |
| 4 | [后端架构](src/backend/README.md) | 前后端分离、模块边界、持久化方案、运行方式，以及已实现能力与路线图的区分 |
| 5 | [Tools 模块](src/backend/Tools/README.md) | 工具注册、参数校验、按角色授权，以及 E2B Sandbox 与宿主机之间的安全边界 |
| 6 | [Agents 名册](src/backend/DeepSeek/Agents/README.md) | 各 Agent 的职责划分、公开范围、当前实现状态与未来协作方式 |
| 7 | [自动化测试](test) | A2A、Agent、工具、数据库和模型客户端的回归测试，用于验证核心行为而非只描述设计 |
