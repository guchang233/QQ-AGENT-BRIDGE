# 🐧 QQ-Agent Bridge

**一体化的 QQ ↔ AI Agent 桥接框架**：让任何支持 MCP 的 AI（Claude Code、Cursor、Cline、自研 Agent…）直接"用 QQ"；同时也是一个开箱即用、带 Web 控制台的 QQ 机器人，以及一个对社区友好的插件生态。

| 给使用者 | 给 AI | 给开发者 |
|---|---|---|
| 双击启动，向导带你连上 QQ、接入 AI，几分钟就能用 | 70 多个条目清晰的 MCP 工具，权限分级 | 稳定的插件 SDK：一个文件即一个插件，保存即热重载 |
| 浏览器里直接聊 QQ、发说说、管表情包 | 统一的消息格式与内联标记，图片可直接看 | 插件包一键安装，声明权限，跨版本不用改 |
| 「回复流程」页：每次回复走到哪一步、卡在哪，一眼看清 | 长轮询等消息、长期记忆、表情包、语音 | 代码内声明配置 → 自动生成控制台表单 |
| 高危操作人工审批、全量审计、限流防风控 | 无需写任何胶水代码 | 兼容常用 AstrBot 插件 |

---

## ✨ 功能一览

- **消息**：收发群聊/私聊、回复、@、表情、图片、语音、视频、文件、合并转发、撤回、贴表情回应、戳一戳、正在输入
- **QQ 空间**：浏览好友动态、发说说（带图、可见范围）、点赞、评论、删除
- **群管理**：禁言/全员禁言、踢人（需审批）、名片/头衔/管理员、精华、公告、群文件、加群请求
- **表情包**：同步 QQ 收藏表情、自动收藏群友表情、AI 认知笔记（看图后记住含义）、按情绪检索发送
- **语音**：Edge TTS（免配置）/ OpenAI 兼容 / 自定义 HTTP / 本地命令；收到语音自动转写
- **记忆**：遗忘曲线（可关）、间隔重复强化、相似记忆合并、FTS5 全文索引 + 可选向量语义检索
- **内置功能**：回复与人格设置、冒泡、请示管理员、定时提醒、群聊统计日报、申请自动处理
- **随附插件**（按需开启）：入群欢迎、刷屏防护、群消息互通、关键词回复、复读机
- **兜底**：协议端 200+ 个 OneBot 动作全部可调（按目录分级鉴权，未知动作默认拒绝）
- **Web 控制台**：仪表盘、回复流程、聊天、QQ空间、AI 接入（一键复制配置）、回复与人格设置、记忆、表情包、插件（可上传安装）、审批、审计、动作调试台、日志、设置。设置分基础和高级，常用的几项放在最上面

## 🚀 快速开始

### 1. 准备

- [Node.js](https://nodejs.org/) **24+**
- 一个 OneBot v11 协议端，推荐 [SnowLuma](https://github.com/SnowLuma/SnowLuma)（也兼容 NapCat / LLOneBot / Lagrange 等）。启动并登录 QQ，在其 WebUI 中开启 **HTTP 服务端** 与 **WebSocket 服务端**。
- （可选）Python 3.10+：仅在使用 AstrBot 兼容层时需要

### 2. 安装与启动

**方式一：下载发布包（推荐普通用户）**

在 [Releases](https://github.com/guchang233/QQ-AGENT-BRIDGE/releases) 页面下载 `qq-agent-bridge-v<版本>-win-x64.zip`（已含依赖，解压即用）或 `qq-agent-bridge-v<版本>.zip`（首次启动自动安装依赖），解压后双击 `start.bat`（macOS / Linux 运行 `./start.sh`）。

**方式二：npm 全局安装**

```bash
npm install -g qq-agent-bridge
qab start
```

**方式三：源码**

```bash
git clone https://github.com/guchang233/QQ-AGENT-BRIDGE.git qq-agent-bridge
cd qq-agent-bridge
npm install
npm run build      # 构建 Web 控制台
npm start
```

Windows 也可以直接双击 `start.bat`（首次会自动安装依赖并构建）。

### 3. 跟着向导走

首次启动会自动打开浏览器（没打开就访问 **http://127.0.0.1:3210**），按向导完成设置：

1. **设置控制台密码**
2. **连接 QQ**：自动找到 SnowLuma 和它登录的账号，检查 HTTP、WebSocket 服务有没有开、能不能连上；选一个账号就连好，不用手抄地址和 token。没开的服务会告诉你在 SnowLuma 里打开哪一项
3. **接入 AI**：检查 DeepSeek Harness 装没装、登没登录、开没开，点「一键接入」，再从下拉框选模型
4. **在哪里回复**：填管理员 QQ，选「全部启用」或「只在勾选的会话里回复」
5. **试一试**：用另一个 QQ 号在群里 @ 机器人或私聊它，页面上实时显示它怎么处理

之后哪里不回复，打开控制台的「回复流程」页，卡在哪一步、为什么、去哪里改都写着。

### 4. 用别的 AI 客户端（可选）

除了 DeepSeek Harness，任何支持 MCP 的客户端都能接入。在控制台「AI 接入 → MCP 接入」复制配置。以 Claude Code 为例：

```bash
claude mcp add --transport http qq http://127.0.0.1:3210/mcp --header "Authorization: Bearer <你的 token>"
```

然后对 Claude 说："看看 QQ 有什么新消息，帮我回复一下"。

> 只支持 stdio 的客户端：`node <安装目录>/bin/qab.mjs mcp`（自动代理到运行中的守护进程）。

## 🧭 文档

| 文档 | 内容 |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | 安装、配置项、常见问题 |
| [docs/agent-guide.md](docs/agent-guide.md) | 给 AI / Agent 开发者：工作循环、消息格式、权限与审批 |
| [docs/tools.md](docs/tools.md) | 全部 MCP 工具参考（自动生成） |
| [docs/system-plugins.md](docs/system-plugins.md) | 内置功能与随附插件的命令和配置（自动生成） |
| [docs/memory.md](docs/memory.md) | 记忆系统：写入、检索、关联网络、评测结果 |
| [docs/plugins.md](docs/plugins.md) | 插件开发指南 |
| [docs/astrbot.md](docs/astrbot.md) | AstrBot 插件兼容说明 |
| [docs/architecture.md](docs/architecture.md) | 架构与代码导览 |
| [docs/security.md](docs/security.md) | 安全模型 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 参与贡献 |

## 🧩 写一个插件只需要一个文件

```ts
// plugins/hello.ts —— 保存即自动加载
import { definePlugin, z } from 'qq-agent-bridge';

export default definePlugin({
  name: 'hello',
  apiVersion: 1,                          // 按插件 API v1 编写
  permissions: ['send', 'agent-tools'],   // 用到的能力，安装时展示给用户
  config: { greeting: { type: 'string', default: '你好', description: '问候语' } },
  setup(ctx) {
    ctx.command('hello', (e) => e.reply(`${ctx.config.greeting}，${e.senderName}！`), { desc: '打招呼' });
    ctx.tool({
      name: 'roll', description: '掷骰子', tier: 'read',
      input: { sides: z.number().default(6) },
      handler: ({ sides }) => `${1 + Math.floor(Math.random() * sides)}`,
    });
  },
});
```

`qab plugin new 名字` 从模板生成，`qab plugin pack 目录` 打成插件包，别人在控制台「插件 → 安装插件」上传即可。插件 API 主版本不变，插件就不用改。详见 [插件开发指南](docs/plugins.md)。

## 🛠 命令行

```
qab start               启动守护进程（OneBot 连接 + Web 控制台 + MCP + 插件）
qab mcp                 stdio MCP 服务（代理到守护进程，连不上则独立运行）
qab status              探测 SnowLuma / OneBot 连接，并显示守护进程的真实状态
qab update [install]    检查 / 下载新版本
qab token               显示 MCP 接入方式与 token
qab password <pwd>      重设控制台密码
qab dsh [install|uninstall]   接入 / 移除 DeepSeek Harness
qab migrate qq-bridge [目录]  从 qq-bridge 迁移
qab plugin new <名称>   从模板创建插件
qab plugin pack <目录>  打包成插件包
qab plugin install <git地址> [--astrbot]  从 git 仓库安装插件
```

开发：`npm run dev`（热重载）、`npm run demo`（Mock QQ 演示，无需真实账号；加 `-- --fresh` 模拟全新安装走向导）、`npm run check`（类型检查 + 测试）、`npm run docs:gen`（重新生成参考文档）。

## ⚠️ 免责声明

本项目通过第三方 OneBot 协议端与 QQ 通信，**不是腾讯官方产品**。使用非官方客户端/自动化可能违反 QQ 用户协议并导致账号受限，请自行评估风险，合理设置限流，不要用于骚扰、刷屏、诈骗等违法违规用途。协议端（如 SnowLuma）有其自身的许可协议，请分别遵守。

## 📄 许可

[MIT](LICENSE)
