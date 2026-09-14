# Tools 模块

本目录保存 Agent 可调用的具体能力。function tool 由具体 Agent 以 JSON Schema 声明给模型；模型返回 `function_call` 后，Agent 解析并校验参数、执行函数，再将结果作为 `function_call_output` 回填。模型协议与循环细节见 [DeepSeek 模块说明](../DeepSeek/README.md)。

## 工具清单

| 文件 | 工具或用途 | 使用方 |
| ---- | ---------- | ------ |
| `loadInstructions.ts` | 读取 `instructions.md`，并可选注入 Skill 元数据 | 所有 Agent；元数据注入目前仅用于 Lexey |
| `agentMemory.ts` | `read_memory`、`update_memory`：读取或原子替换 Agent 自身的 `memory.md` | 所有 Agent，由 `BaseAgent` 统一注册 |
| `loadSkill.ts` | `load_skill`：按 frontmatter 中的 `name` 加载 `SKILL.md` 正文 | Lexey |
| `sendEmail.ts` | `send_email`：通过固定 QQ SMTP 配置发送邮件 | Gexep |
| `executeE2BShell.ts` | `e2b_shell_execute`：在 E2B 的 `/memos` 中执行命令 | Jezeh |
| `downloadMemo.ts` | `download_memo`：将沙箱中的 Markdown 备忘录导出到固定宿主机目录 | Jezeh |
| `askDeveloper.ts` | 通过警告日志向开发者显示问题 | 已实现，尚未注册到 Agent |

所有 function tool 都遵循同一条本地调用链：具体 Agent 显式注册工具，解析模型给出的 JSON 参数，使用 Zod `safeParse()` 校验，再调用实现函数并回填字符串结果。解析、校验或执行失败时，工具返回可供模型理解的失败信息，而不是伪造成功状态。

## Instructions 与 Skills

`loadInstructions(dirPath, isLoadSkills)` 始终读取 Agent 目录中的 `instructions.md`。当 `isLoadSkills` 为 `true` 时，它还会扫描同级 `skills/*/SKILL.md`，提取 frontmatter 中的 `name` 和 `description`，将能力清单追加到角色指令中。

模型需要详细步骤时可调用 `load_skill`。`loadSkill()` 会按 `name` 找到目标文件，移除 frontmatter 后返回正文。这样常驻上下文只包含简短元数据，完整 Skill 内容按需加载。

## 长期记忆

每个 Agent 绑定自己目录中的 `memory.md`，模型不能通过工具参数选择路径或访问其他 Agent 的文件。`BaseAgent` 在每次模型请求前读取最新内容，并将公共规则 `Agents/memory-instructions.md` 与 JSON 编码后的记忆正文追加到系统指令。

`read_memory` 返回当前完整正文；`update_memory` 要求模型提交更新后的完整 Markdown，最多 65,536 个字符。更新先写同目录临时文件，再原子替换目标文件；参数无效或写入失败时保留原内容。系统规则要求只保存稳定且未来有用的信息，落实用户的记住、纠正和遗忘要求，并禁止保存凭据等秘密。

## 邮件工具

`sendEmail()` 接受发件人显示名称、主题、纯文本正文和可选 HTML 正文。SMTP 主机、认证账号、实际发件地址和收件地址固定在工具内部，模型不能在调用时更改收件人；`SMTP_PASS` 则从环境变量读取，不写入源码。

发送行为通过 Nodemailer 完成。工具会校验输入与 SMTP 配置、关闭 transport，并返回服务端结果或错误信息。`messageId` 只表示发信服务已经接受邮件，不代表收件人已阅读。

## Jezeh 的沙箱与导出

`executeE2BShell()` 通过 E2B SDK 在网络隔离的 Sandbox 中运行命令：

- 工作目录固定为 `/memos`，单次命令超时 30 秒；
- 不挂载宿主机目录，也不在宿主机执行 Shell；
- 标准输出和错误输出分别限制为 100,000 个字符；
- `E2B_MEMO_SANDBOX_ID` 可用于复用 Sandbox，未配置时会创建新实例。

`downloadMemo()` 是沙箱到宿主机的受限出口。它只接受 `/memos` 下的相对 Markdown 路径，将文件复制到预先配置的固定目录，并保留相对层级。工具拒绝路径穿越、非 Markdown 文件、超过 5 MiB 的文件、符号链接路径和覆盖已有文件；新文件权限为 `0600`。

Jezeh 的日常创建、读取、搜索、修改和整理都在 Sandbox 中完成，只有明确调用 `download_memo` 且返回成功后，文件才算已经导出到用户可见的宿主机目录。Sandbox 本身是临时工作区，不能替代持久化存储。

## 配置与测试

| 能力 | 环境变量 |
| ---- | ---------- |
| Gexep 邮件 | `SMTP_PASS` |
| Jezeh Sandbox | `E2B_API_KEY`；可选 `E2B_MEMO_SANDBOX_ID` |

自动化测试会注入假的 SMTP transport、E2B Sandbox 和文件存储，因此不会发送真实邮件或调用真实 E2B 服务。真实链路脚本 `src/backend/test.ts` 不属于默认测试套件，运行前应确认服务凭据和宿主机写入行为。
