# 架构与代码导览

```
                ┌─────────────── QQ-Agent Bridge 守护进程 (Node 24) ───────────────┐
 QQ 客户端      │                                                                   │
 + SnowLuma ◄──►│ onebot/client  ──►  Bridge（核心枢纽）  ◄── plugins/host ◄─ 系统/用户插件│
 (OneBot v11    │  WS 主通道          ├ store (SQLite)        └ astrbot ◄─► Python 宿主   │
  WS + HTTP)    │  HTTP 降级          ├ media（下载/上传）                               │
                │  自动发现            ├ policy（权限/限流/审批）                         │
                │                     └ faces / DSL / render                            │
                │                         ▲                ▲                           │
                │          mcp/server ────┘                └──── web/server            │
                └──────────▲─────────────────────────────────────────▲───────────────┘
                           │ MCP (HTTP / stdio 代理)                  │ HTTP + WS
                       AI Agent                                  浏览器控制台 (Vue)
```

## 设计原则

1. **单一枢纽**：MCP、控制台、插件都只通过 `Bridge` 操作 QQ，鉴权、限流、审计只实现一次。
2. **调用方即身份**（`Caller`）：`agent`（带 token 与权限）/ `console`（人）/ `plugin`。策略按身份执行。
3. **失败要显式**：被拦截的操作抛 `PolicyError`，工具返回"未执行"，绝不静默吞掉。
4. **内置功能与插件分开**：回复与人格设置、记忆、表情包、语音等是内置功能（`src/features/`），随版本一起改，可以用内部接口；插件只能用公开 SDK（`src/sdk.ts`，带 `API_VERSION`），QAB 内部重构不影响插件。
5. **零原生依赖**：存储用 Node 内置 `node:sqlite`，TS 由 `tsx` 直接运行，Windows 开箱即用。
6. **不静默**：每次叫醒 AI 都记在回复流程里（`src/trace.ts`），卡在哪一步、为什么，控制台上直接看得到。

## 目录

| 路径 | 职责 |
|---|---|
| `src/cli.ts` | 命令行入口 |
| `src/config.ts` | 配置 schema（zod）、读写、SnowLuma 目录探测 |
| `src/bridge.ts` | 核心：事件入库、发送（DSL→段→媒体解析）、等待新消息、历史补拉、统一 `invoke()` 鉴权审计 |
| `src/onebot/client.ts` | OneBot v11 客户端：WS echo 调用、事件、重连、HTTP 降级 |
| `src/onebot/discover.ts` | 读取 SnowLuma per-account 配置，逐个候选 token 探测 |
| `src/onebot/catalog.ts` + `actions.json` | 动作目录与权限分级（未知动作 = danger） |
| `src/message/` | 段模型、CQ 码、发送 DSL、接收渲染、系统表情表 |
| `src/store/db.ts` | SQLite：消息、会话、名字、媒体、表情包、审计、KV |
| `src/media.ts` | 媒体引用登记、按需下载缓存、发送源解析（路径/URL/base64/#ref，受 uploadRoots 限制） |
| `src/policy.ts` | 会话范围、token 等级、审批队列、限流、打字节奏 |
| `src/mcp/tools.ts` | 核心 MCP 工具定义（声明式 `ToolDef`） |
| `src/mcp/server.ts` | 按 token 构建 MCP Server、Streamable HTTP 会话管理、插件工具合并 |
| `src/mcp/stdio.ts` | stdio 入口：代理到守护进程或独立运行 |
| `src/sdk.ts` | **插件公开 SDK（稳定契约，`API_VERSION`）** |
| `src/plugins/api.ts` | 内部上下文类型（内置功能用，比 SDK 多出内部对象） |
| `src/plugins/host.ts` | 内置功能与插件的加载、依赖排序、上下文、权限检查、出错隔离、分发、热重载 |
| `src/plugins/package.ts` | 插件包：检查、安装、卸载、打包 |
| `src/plugins/astrbot.ts` + `astrbot_shim/` | AstrBot 兼容层（Python 子进程 + JSON-RPC） |
| `src/features/*` | 内置功能（设置在主配置 `features.<名称>`） |
| `src/system-plugins/*` | 随附的小插件（只用公开 SDK，也是插件示例） |
| `src/trace.ts` | 回复流程：每次叫醒 AI 经过的步骤 |
| `src/web/server.ts` | Fastify：控制台 API、插件路由 `/api/p/*`、MCP 挂载、WS 推送、静态文件 |
| `src/web/wizard.ts` | 首次设置向导的接口（SnowLuma 检查、连接、DSH 状态、回复范围） |
| `console/` | Vue 3 + Naive UI 控制台 |
| `test/` | Mock OneBot、端到端测试、单元测试、演示模式 |
| `scripts/gen-docs.ts` | 生成工具、内置功能与随附插件的参考文档 |

## 一条消息的旅程

1. SnowLuma 通过 WS 推送 `message` 事件 → `OneBotClient` emit `event`
2. `Bridge.ingestMessage`：规范化段、记录名字、渲染文本（媒体登记为 `#ref`）、判断是否 @我 → `Store.insertMessage` → emit `message`
3. 监听者并行处理：
   - `PluginHost.dispatch` 按优先级执行命令/正则/消息处理器（可 `stop()`），再交给 AstrBot 兼容层
   - 正在 `waitForMessages` 的 Agent 收集消息，安静窗口结束后返回
   - 控制台 WS 推送到浏览器
4. Agent 调用 `qq_send` → `runTool` → `Bridge.send`：会话范围检查 → `invoke`（等级/审批/审计）→ 限流 → DSL 解析与媒体解析 → `send_group_msg` → 自己的消息入库

## 稳定性约定（面向生态）

- **稳定**：`src/plugins/api.ts` 中的类型与 `src/sdk.ts` 的导出、MCP 工具名与参数、配置文件结构、`/api/p/*` 路由约定。破坏性变更只在主版本号升级时进行，并在 CHANGELOG 中注明迁移方法。
- **内部**：`ctx.bridge` 及其它 `src/` 模块，可能随版本调整。

## 数据

全部在 `data/`（可在配置中修改）：`qab.db`（SQLite，WAL）、`media/`（缓存的图片语音）、`stickers/`、`uploads/`、`plugins/<name>/`（插件配置与数据）、`plugin_data/`（AstrBot 插件数据）。备份只需复制 `data/` 与 `config/qab.yaml`。
