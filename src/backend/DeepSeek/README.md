# DeepSeek 模块

本目录封装与 DeepSeek `/responses` API 直接相关的类型、网络请求和 Agent 运行时。它是后端内部实现，不是公开 HTTP API；外部客户端只通过 [Gexep A2A 接口](../A2A/README.md) 访问。整体架构与运行方式见 [后端架构说明](../README.md)；这里聚焦模型链路的实现细节。

## 目录职责

| 路径 | 职责 |
| ---- | ---- |
| `API/responses.ts` | 定义请求体、输入项、输出项、模型和工具的 TypeScript 类型 |
| `ModelClient.ts` | 使用原生 `fetch` 发送 `/responses` 请求，并注入鉴权信息 |
| `Agents/BaseAgent.ts` | 实现多轮循环、共同 A2A 发现工具、function tool 回填和消息历史持久化 |
| `Agents/<name>/` | 保存具体 Agent 的角色指令、工具声明与调用分发逻辑 |

## 请求与循环

`ModelClient.requestResponsesAPI()` 接收 `model`、`input`、`instructions`、`tools` 和 `user`，组装请求体后向 `https://api.deepseek.com/responses` 发起请求。`DEEPSEEK_API_KEY` 通过环境变量读取；上层不处理 URL、请求头或序列化细节。

`BaseAgent.ask()` 驱动完整循环：

1. 将用户输入转换成 `message` 并追加到当前上下文。
2. 调用 `ModelClient` 获取模型输出。
3. 将每个输出项追加到上下文，并按类型处理：
   - `message`：记录模型回复；
   - `reasoning`：记录推理文本；
   - `web_search_call`：由模型服务完成，本地只记录；
   - `function_call`：共同的 `discover_agents` 由基类执行，专属工具交给具体 Agent 校验和执行。
4. 将工具结果包装成 `function_call_output`，回填后再次请求模型。
5. 当一轮不再出现 `function_call` 时结束，并将本轮新增上下文写入 SQLite。

`BaseAgent` 在构造时还会根据 `agentId` 恢复所有 `is_activated = 1` 的历史记录。无法解析的旧记录会被跳过并写入警告日志。

## 具体 Agent

| Agent | 模型可见工具 | 说明 |
| ----- | ------------ | ---- |
| `GexepAgent` | `discover_agents`、`send_email` | 发现其他 Agent；使用固定 SMTP 发件人与收件人发送邮件 |
| `JezehAgent` | `discover_agents`、`e2b_shell_execute`、`download_memo` | 发现其他 Agent；在 `/memos` 沙箱工作区处理备忘录并导出 |
| `LexeyAgent` | `discover_agents`、`web_search`、`load_skill` | 发现其他 Agent；处理语言任务并按需加载 Skill 正文 |
| `ZebehAgent` | `discover_agents`、`web_search` | 发现其他 Agent；用于开发阶段的行为验证 |

具体 Agent 只负责定制四件事：加载 `instructions.md`、从数据库取得自身 ID、声明模型可见工具，以及实现 `requestFunctionCall()`。对话循环、历史恢复和持久化统一由 `BaseAgent` 完成。

后端入口会实例化四个 Agent 并注册到同一个运行时目录。Gexep 连接公开 A2A 执行器；Jezeh、Lexey、Zebeh 分别连接只监听 `127.0.0.1` 的路径作用域 A2A 执行器。A2A 层把输入 Message 转换为 `ask()` 调用，把输出转换为 Task Artifact，并按 Agent 串行化请求以保护各自的可变上下文。

`discover_agents` 会返回调用者之外的在线节点、职责、技能、Agent Card URL 与 RPC URL。这是共同感知能力；跨 Agent 发送消息仍需单独的运行时工具，不能把发现结果当成已完成委派。

## 类型与 provider 边界

请求和响应契约直接依据 DeepSeek API 建模，运行时不会再次校验模型响应。这种实现保留了 `reasoning`、`web_search_call` 和结构化文本格式等 provider 特性，也意味着更换 provider 时需要同时调整 `responses.ts`、`ModelClient` 与 `BaseAgent` 消费输出项的逻辑。

为何选择直接调用 API、以及为何不预先抽象统一模型层，见 [THINKING.md](../THINKING.md)。工具的参数校验、配置和安全边界见 [Tools 说明](../Tools/README.md)。

## 测试

- `test/model-client.test.ts` 验证请求 URL、请求头、请求体和响应解析，测试中不会发起真实网络请求。
- `test/gexep-agent.test.ts`、`test/jezeh-agent.test.ts` 和 `test/lexey-agent.test.ts` 覆盖构造、工具分发、错误回填及 Agent Loop。
- `test/a2a-gexep.test.ts` 覆盖 Gexep Agent Card、任务生命周期、串行执行、SSE 客户端解析和上下文延续。
- `test/internal-agent-registry.test.ts` 覆盖对等发现、自身排除、能力筛选、内部路由与公开边界。
- `test/database.test.ts` 覆盖默认 Agent、消息读写、激活过滤和外键约束。
