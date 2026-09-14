# Agents 名册与协作边界

本文记录各 Agent 的职责、实现状态和协作方向。项目名称与完整命名故事见 [根目录 README](../../../../README.md)，具体运行机制见 [DeepSeek 模块说明](../README.md)。

## 命名规则

Agent 名称来自现实好友中文名的拼音首字母：在三个字母之间插入两个 `e`，得到 `C1eC2eC3`，例如 `gxp → Gexep`、`lxy → Lexey`。每个名称还会关联一个英文词根，用来提示职责主题，如 `lex` 对应语言、`beh` 对应行为。

## 当前名册

| Agent | 职责 | 当前状态 |
| ----- | ---- | -------- |
| **Gexep** | 面向用户的唯一公开入口；当前可向固定邮箱发送邮件 | 邮件工具、公开 A2A 服务、发现与委派已实现 |
| **Jezeh** | 在 E2B Sandbox 中创建、查询、整理和导出 Markdown 备忘录 | 沙箱工具、内部 A2A 服务、发现与委派已实现 |
| **Lexey** | 多语言学习辅导与翻译、润色、校对、摘要等文本处理 | 网页搜索、Skill、内部 A2A 服务、发现与委派已实现 |
| **Zebeh** | 开发阶段的 Agent 行为验证与调试 | 基础角色、内部 A2A 服务、发现与委派已实现；专用验证工具待补充 |
| **Jeyeh** | 图像、视频、OCR、图表和界面元素理解 | 规划中 |
| **Weseh** | 任务拆解、规划与决策 | 规划中 |
| **Xedec** | 待定 | 规划中 |
| **Celey** | 待定 | 规划中 |

## 协作边界

对外边界已经收敛为 Gexep：终端 UI 或第三方客户端先读取 Gexep Agent Card，再使用 A2A 1.0 的 JSON-RPC/SSE 接口提交任务。公开卡片不列出其他 Agent，协议事件也不会传递 reasoning、内部工具参数或其他 Agent 状态。

内部形成对等拓扑：四个已实现 Agent 共享受控 Agent Card 目录，每个 Agent 的模型工具中都有 `discover_agents` 和 `delegate_task`。发现会排除自身并返回其他在线 Agent 的标准 Card；委派则由官方 A2A Client 调用 Card 中的接口。Jezeh、Lexey、Zebeh 的端点只监听回环地址，因此能被同一运行环境中的伙伴寻址，却不会进入公开 API。

当前感知、可寻址和跨 Agent 消息委派均已实现。运行时会等待下游 Task 结束并把 Artifact 文本交回调用 Agent；多目标并行调度、跨重启恢复和独立的长期任务监控仍未实现。

关于路由、Sandbox、工具归属和审核 Agent 的设计理由，见 [THINKING.md](../../THINKING.md)。
