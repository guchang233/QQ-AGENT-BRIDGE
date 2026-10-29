# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。
公共契约（插件 API / SDK 导出 / MCP 工具 / 配置结构）的破坏性变更只在主版本升级，并附迁移说明。

## [Unreleased]

## [0.1.0] - 2026-10-30

### 新增
- OneBot v11 连接层：WS 主通道 + HTTP 降级、自动重连、SnowLuma 自动发现（换号免配置）
- 动作目录 200+ 项与权限分级（未知动作默认拒绝）
- 消息模型：统一会话 ID、发送内联标记 DSL、可读渲染、媒体短引用
- SQLite 存储、媒体缓存、长轮询等待新消息、历史补拉
- 策略：token 等级、会话范围、人工审批、限流、全量审计
- MCP Server（Streamable HTTP + stdio 代理/独立模式），67 个工具
- Web 控制台：设置向导、聊天、QQ 空间、表情包、Agent 接入与审批、审计、插件、动作调试台、记忆、日志、设置
- 插件系统：`definePlugin`、代码内配置声明、依赖与服务、HTTP 路由、热重载、脚手架与 git 安装
- 系统插件：表情包、语音（Edge TTS 等）、记忆（遗忘曲线/强化/全文与向量检索）、定时提醒、群聊统计、入群欢迎、刷屏防护、请求自动处理、消息互通、关键词回复、复读机、基础管理
- AstrBot 插件轻兼容层
