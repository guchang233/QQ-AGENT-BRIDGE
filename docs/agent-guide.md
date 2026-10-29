# Agent 接入指南

本文面向：把 QQ-Agent Bridge 接入 AI 客户端的使用者，以及基于它开发 Agent 的开发者。完整工具列表见 [tools.md](tools.md)。

## 接入方式

| 方式 | 地址 | 适用 |
|---|---|---|
| MCP Streamable HTTP（推荐） | `http://127.0.0.1:3210/mcp`，Header `Authorization: Bearer <token>` | Claude Code、Cursor、Cline、自研 Agent |
| MCP stdio | `node <安装目录>/bin/qab.mjs mcp [--token xxx]` | 只支持 stdio 的客户端；自动代理到守护进程 |
| MCP stdio 独立模式 | `qab mcp --standalone` | 不想常驻守护进程时 |

控制台「Agent 接入」页可一键复制各客户端配置。

**Claude Code**

```bash
claude mcp add --transport http qq http://127.0.0.1:3210/mcp --header "Authorization: Bearer qab_xxx"
```

**JSON 配置（Cursor / Cline / Claude Desktop 等）**

```json
{ "mcpServers": { "qq": { "type": "http", "url": "http://127.0.0.1:3210/mcp", "headers": { "Authorization": "Bearer qab_xxx" } } } }
```

## Token 与权限

每个 token 是一个 Agent 身份，可以设置：

- **权限等级**：`read`（读取）/ `send`（发消息、表情、空间互动）/ `manage`（群管理、资料）/ `danger`（踢人、退群、改头像、取 Cookie 等）。Agent 只能**看到**其等级内的工具。
- **会话范围**：只允许操作指定的群/私聊。

全局策略（控制台「Agent 接入 → 权限策略」）决定每个等级是**直接放行 / 人工审批 / 禁止**。默认 `danger` 需审批：Agent 调用时会挂起，控制台弹出通知，人点「批准」后才执行。

另有**全局只读**开关与**会话白/黑名单**。被拦截的操作一律返回 `错误：…未执行`，Agent 不会误以为已发出。

## 推荐工作循环

```
qq_status                       # 了解连接、身份、未读
loop:
  qq_wait_messages(timeoutSec=120, quietSec=4[, mentionOnly])   # 等新消息，对方说完才返回
  qq_memory_context(conv)       # 取回与该会话/发言者相关的记忆
  qq_get_history(conv)          # 需要时看更多上下文
  qq_send / qq_reply / qq_send_burst / qq_send_sticker / qq_speak
  qq_memory_remember(...)       # 值得长期记住的事
```

## 消息格式

工具返回的消息一行一条：

```
#1024 [12:01] 张三(123456): @我 今晚吃什么[图片#a1b2c3d4]
#1025 [12:02] 我(10000): 火锅吧[表情:doge]
```

- `#1024` 是消息 ID，用于 `qq_reply`、`qq_recall`、`replyTo` 等
- `[图片#a1b2c3d4]` 用 `qq_get_image(ref="a1b2c3d4")` 直接看图
- `[语音#ref]（转写：…）` 语音自动转文字（voice 插件）
- `[回复#ID]` `[合并转发#ID]`（用 `qq_get_forward` 展开）`[文件#ref:名称]`（用 `qq_download_media` 下载）

## 发送：内联标记

```
你好[at:123456] 看这个[face:微笑][image:C:\pics\a.png]
[reply:1024]收到！[sticker:3]
[at:all] [dice] [rps] [record:D:\v.mp3] [file:D:\a.zip|name=资料.zip]
[image:#a1b2c3d4]        ← 转发收到过的图片
[image:路径|sticker]     ← 以表情（小图）形式发送
\[ 输出字面方括号
```

分条发送用 `qq_send_burst(messages=[...])`，会按字数插入打字延迟，更像真人。

## 限流

为降低账号风控，Agent 与插件发送受限（可在设置中调整）：全局每分钟 20 条、每小时 300 条、单会话每分钟 8 条。超限返回错误。

## 审计

每次工具调用（调用方、参数、结果、耗时）都记录在控制台「调用审计」，Cookie/凭证类结果自动脱敏。

## 资源与提示词

- 资源：`qq://conversations`、`qq://conv/{conv}/recent`
- 提示词：`qq_chat_guide`（像普通群友一样聊天的行为准则）

## 自研 Agent（不用 MCP SDK 的情况）

MCP 是标准 JSON-RPC over HTTP，任何语言都能直接调用。用官方 SDK 最省事：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const c = new Client({ name: 'my-agent', version: '1' });
await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3210/mcp'), {
  requestInit: { headers: { authorization: 'Bearer qab_xxx' } },
}));
const r = await c.callTool({ name: 'qq_wait_messages', arguments: { timeoutSec: 60 } }, undefined, { timeout: 120_000 });
```

注意：`qq_wait_messages` 是长轮询，客户端请求超时要大于 `timeoutSec`。
