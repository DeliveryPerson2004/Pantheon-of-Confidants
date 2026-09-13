# Pantheon of Confidants

> **A multi-agent runtime where every agent is a confidant.**
>
> **多智能体运行时——每一个 Agent，都是一位挚友。**

我想要学习 Agent，源于曾经看过的一场 Google 大会：会上以规划一场马拉松为例，展示了 Agent 在多方协作场景中的潜力。马拉松涉及主办方、政府部门、赞助商、参赛者及周边社区等众多利益相关方；若想制定一套让各方满意且符合相关规定的方案，往往需要大量沟通与磋商，而文件在各方之间的流转也十分缓慢。引入 Agent 后，各方可以借助各自的 Agent 对齐诉求、交换信息并协助检查合规性，从而显著降低沟通成本。受此启发，这个项目旨在“粘合”我学习和构建 Agent 过程中产生的想法，以及接触到的各类协议与技术，并借此记录和表达自己的观点，包括但不限于 MCP、A2A、Sandbox 和 GraphRAG。其中，A2A、GraphRAG 等方向的具体实现仍需进一步调研与验证。

## 名字从哪来

每个 Agent 都以现实中的一位好友为原型：取好友中文名的拼音首字母，在字母之间插入两个 `e`，例如 `gxp → Gexep`、`lxy → Lexey`、`jyh → Jeyeh`。`Pantheon` 是众 Agent 的群像，`Confidant` 则表达“挚友”这一共同身份。完整名册见 [Agents 说明](src/backend/DeepSeek/Agents/README.md)。

## 已实现的能力

- **强类型 Agent Loop**：通过 Node.js 原生 `fetch` 调用 DeepSeek `/responses` API，逐项处理 `message`、`reasoning`、`function_call` 和 `web_search_call`，并将工具结果回填给模型继续推理。
- **按角色分配能力**：Gexep 可向固定邮箱发送邮件，以便主动与我联系，让我离开电脑时也能通过手机查看它想传达的消息；Lexey 负责语言任务，并支持网页搜索和按需加载 Skill；Jezeh 在网络隔离的 E2B Sandbox 中管理 Markdown 备忘录；Zebeh 用于开发阶段的行为验证。
- **受控工具边界**：工具由具体 Agent 显式注册，入参经 Zod 校验；Jezeh 的命令默认在 E2B 的 `/memos` 中运行，并通过受限下载工具将备忘录导出到固定宿主机目录。
- **本地会话持久化**：使用 `better-sqlite3` 管理单文件 `database.db`，按 Agent 保存对话历史，并通过激活态控制恢复范围。该状态也为后续长期记忆机制预留：届时可判断哪些短期记忆不应继续占用当前上下文，将其置为非激活态，从而实现上下文管理。
- **全屏终端界面**：基于 `pi-tui` 提供无闪烁的对话界面、角色切换、Markdown 渲染、滚动搜索、命令补全，以及推理和工具调用状态提示。
- **轻量工程栈**：TypeScript、ESM、pnpm、tsx 和 Node.js 内置测试框架，不引入模型 SDK 或 ORM。

MCP 客户端、基于 A2A 的 Agent 协作以及 GraphRAG 长期记忆仍处于设计阶段；文档会明确区分已经落地的能力与尚未实现的设想。

## 快速开始

```bash
pnpm install
cp .env.example .env
pnpm dev:backend:initDatabase
pnpm exec tsc --noEmit
pnpm test
pnpm start
```

调用模型时需要配置 `DEEPSEEK_API_KEY`。使用 Gexep 的邮件工具还需配置 `SMTP_PASS`；使用 Jezeh 则需配置 `E2B_API_KEY`，也可通过 `E2B_MEMO_SANDBOX_ID` 连接已有 Sandbox。

`pnpm start` 会初始化本地数据库并进入全屏终端界面。输入 `/agent Lexey` 等命令可切换角色，`/help` 查看完整帮助，`Ctrl+C` 或 `/quit` 退出。界面依赖 Node.js 22.19 或更高版本。

`src/backend/test.ts` 是会调用真实 DeepSeek、E2B 和宿主机文件系统的 Jezeh 完整链路脚本，不属于默认测试套件。

## 目录速览

```text
src/
├── backend/
│   ├── DeepSeek/          # 模型客户端、API 类型、Agent Loop 与具体 Agent
│   ├── E2B/               # Jezeh 的 Sandbox 创建和复用
│   ├── Tools/             # Skill、邮件、E2B Shell 与备忘录下载工具
│   ├── database/          # SQLite 初始化与 prepared statements
│   ├── logger.ts          # 统一日志
│   ├── main.ts            # TUI 程序入口
│   └── test.ts            # Jezeh 真实链路脚本
└── ui/                    # pi-tui 界面、主题与交互状态

test/                      # 隔离的自动化测试
```

## 给面试官的阅读导航

如果时间有限，建议先用 5 分钟阅读本页的“已实现的能力”，再依次查看“设计思考”和“DeepSeek 模块”：前者集中说明关键技术取舍，后者展示这些判断如何落实为 Agent Loop。若希望进一步考察工程完整性，可继续阅读后端架构、工具边界和自动化测试。

| 顺序 | 文档 | 建议关注 |
| ---- | ---- | -------- |
| 1 | [设计思考](src/backend/THINKING.md) | Workflow 与 Agentic 的关系，以及模型耦合、MCP、A2A、Sandbox 和 GraphRAG 等方向上的判断与取舍 |
| 2 | [DeepSeek 模块](src/backend/DeepSeek/README.md) | 强类型模型协议、Agent Loop、工具结果回填和循环终止条件 |
| 3 | [后端架构](src/backend/README.md) | 技术栈、模块边界、持久化方案、运行方式，以及已实现能力与路线图的区分 |
| 4 | [Tools 模块](src/backend/Tools/README.md) | 工具注册、参数校验、按角色授权，以及 E2B Sandbox 与宿主机之间的安全边界 |
| 5 | [Agents 名册](src/backend/DeepSeek/Agents/README.md) | 各 Agent 的职责划分、命名来源、当前实现状态与未来协作方式 |
| 6 | [自动化测试](test) | Agent、工具、数据库和模型客户端的回归测试，用于验证核心行为而非只描述设计 |
