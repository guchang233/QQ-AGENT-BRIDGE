# 安装与配置

## 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | 24+ | 使用内置 `node:sqlite`，无需编译原生模块 |
| OneBot v11 协议端 | — | 推荐 [SnowLuma](https://github.com/SnowLuma/SnowLuma)；NapCat / LLOneBot / Lagrange 等同样可用（部分扩展动作如 QQ 空间依赖协议端支持） |
| Python | 3.10+（可选） | 仅 AstrBot 兼容层需要 |

## 安装

```bash
npm install
npm run build     # 构建控制台（console/dist）
npm start         # 或 Windows 双击 start.bat（崩溃自动重启）
```

首次启动生成 `config/qab.yaml`，并自动在浏览器打开 `http://127.0.0.1:3210` 的设置向导（设 `QAB_NO_BROWSER=1` 不自动打开）。

## 设置向导

1. **设置控制台密码**：后面几步会读写 token、往 DSH 里装预设，所以先确认是机器的主人在操作。
2. **连接 QQ**：找到 SnowLuma 和它登录的每个账号，检查 HTTP、WebSocket 服务开没开、能不能连上、token 对不对。选一个账号就连好；通过向导连接的默认开启自动连接和断线重连。
3. **接入 AI**：逐项检查 DeepSeek Harness 装没装、登没登录、开没开、接没接入，点「一键接入」，再选模型。可以跳过（只用 MCP 客户端，机器人不会自己回复）。
4. **在哪里回复**：管理员 QQ；「全部启用」或「只在勾选的会话里回复」。
5. **试一试**：在群里 @ 机器人或私聊它，实时看到它的处理过程。

向导可以在「设置 → 基本」里重新运行。从老版本升级上来的不会弹出向导。

## 连接协议端

**SnowLuma（推荐，自动发现）**：把 SnowLuma 解压在本项目的上级目录（或设置环境变量 `SNOWLUMA_HOME`、或在向导中填写目录），在其 WebUI 中为账号添加 HTTP 服务端（如 3000）与 WebSocket 服务端（如 3001）。桥接会读取 `config/onebot_<QQ号>.json` 中的端口与 token，并逐个探测——**切换 QQ 账号无需改任何配置**。

**其它协议端**：在向导里点「不用 SnowLuma，手动填写地址」，或在「设置 → QQ 连接 → 高级设置」填写 WS 地址、HTTP 地址与 Access Token（WS 为正向 WebSocket，桥接作为客户端连接）。

检查连接：控制台「设置 → QQ 连接 → 测试连接」，或在终端运行：

```bash
node bin/qab.mjs status
```

## 配置文件

`config/qab.yaml` 的所有项都可在控制台修改（保存即生效，监听地址/端口除外）。设置页和各功能页只把常用的几项放在上面，其余在「高级设置」里。完整默认值见 [config/qab.example.yaml](../config/qab.example.yaml)。

| 段 | 关键项 |
|---|---|
| `onebot` | `wsUrl` `httpUrl` `accessToken` `httpToken` `snowlumaHome` `autoDiscover` |
| `server` | `host`（默认仅本机）`port`（3210）`consolePassword` |
| `owners` | 管理员 QQ 列表（插件管理命令、请求通知） |
| `access` | 在哪些会话回复：`mode`（all 全部启用 / allowlist 只启用勾选的）与各会话的开关，在控制台「回复与人格设置」里改；`readOnly` |
| `limits` | 发送限流与分条节奏 |
| `agents` | `tokens`、各等级策略 `policy`、审批超时、`disabledTools` |
| `media` | `uploadRoots`（Agent 可读取的本地目录）、大小限制 |
| `features` | 内置功能（回复与人格设置、记忆、表情包、语音等）的设置，每个功能一节；在各功能页修改 |
| `plugins` | `dir`、`overrides`（插件开关）、`hotReload`、`commandPrefixes`、`astrbot` |
| `ui` | `wizard`：设置向导是否走完 |

环境变量：`QAB_NO_BROWSER`（首次启动不自动打开浏览器）、`QAB_CONFIG`（配置文件路径）、`QAB_LOG_LEVEL`（debug/info/warn/error）、`SNOWLUMA_HOME`、`QAB_TOKEN` / `QAB_URL`（stdio 模式）。

## 常见问题

**机器人不回复**
打开控制台「回复流程」页。每次有人 @ 它、私聊它，都会显示一条流程：收到 → 会话启用 → 唤醒 → 交给 AI → AI 处理 → 回复。卡在哪一步会标红，写明原因，并给出去处理的按钮。常见原因：会话没启用（「回复与人格设置」里打开）、DSH 没开或没接入、模型不可用、唤醒被限流。

**控制台显示"未连接"**
确认 SnowLuma 已启动且 QQ 已登录；`qab status` 查看每个候选的探测结果。`401/1401` 表示 token 不对；`ECONNREFUSED` 表示端口没开。

**Agent 说发送成功但群里没看到**
不会发生——被拦截时工具一定返回错误。检查「调用审计」中的记录，以及协议端日志（可能被 QQ 风控）。

**忘记控制台密码**
`node bin/qab.mjs password 新密码`，然后重启。

**Edge TTS 没声音**
需要能访问微软语音服务；也可在「更多功能 → 语音 → 设置」中改用 OpenAI 兼容接口或本地命令（如 piper）。

**想在局域网/服务器上访问控制台**
设置 `server.host: 0.0.0.0` 并使用强密码；对公网暴露时请放在 HTTPS 反向代理之后。

**备份与迁移**
复制 `config/qab.yaml` 与 `data/` 目录即可。
