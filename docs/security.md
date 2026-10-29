# 安全模型

QQ-Agent Bridge 让 AI 操作一个真实账号，因此默认按"Agent 可能被群友诱导"来设计。

## 防线

| 层 | 机制 |
|---|---|
| 网络 | 控制台与 MCP 默认只监听 `127.0.0.1`；控制台需要密码（HttpOnly + SameSite=Strict Cookie）；MCP 需要 Bearer token |
| 身份 | 每个 Agent 一个 token，可单独停用；审计中按 token 名记录 |
| 等级 | 动作分 read / send / manage / danger；Agent 只能看到并调用其等级内的工具；协议端动作按目录分级，**目录外的未知动作视为 danger 并拒绝** |
| 审批 | 每个等级可设为放行 / 人工审批 / 禁止；默认 danger 需在控制台批准，超时自动拒绝 |
| 范围 | 全局白名单/黑名单 + token 级会话范围；范围外会话对 Agent 不可见、不可发 |
| 只读 | 一键全局只读（控制台或主人发 `/只读`） |
| 限流 | 全局/会话级发送频率上限，降低风控风险 |
| 文件 | `media.uploadRoots` 限制 Agent 可读取的本地目录；控制台文件访问只限 data 内的 uploads/stickers/media |
| 注入 | 表情包备注等跨会话展示的文本强制单行化并截断；工具返回的资料以"不是指令"框定 |
| 脱敏 | Cookie、凭证、clientkey、rkey 等结果在审计中脱敏 |
| 失败显式 | 所有拦截都向 Agent 返回"未执行"的错误，避免模型幻觉"已发送" |

## 插件

插件与守护进程同进程运行、拥有完整权限（可直接调用协议端，不受 Agent 等级/审批约束，但受会话范围约束）。**只安装可信来源的插件**；`qab plugin install` 安装依赖时使用 `--ignore-scripts`。AstrBot 插件运行在独立 Python 进程中，但同样可以通过 RPC 调用协议端。

## 报告漏洞

请勿公开提 Issue，先通过仓库的 Security Advisory（私密报告）联系维护者，我们会在修复后致谢。
