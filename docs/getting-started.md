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

首次启动生成 `config/qab.yaml`，并打开 `http://127.0.0.1:3210` 的设置向导。

## 连接协议端

**SnowLuma（推荐，自动发现）**：把 SnowLuma 解压在本项目的上级目录（或设置环境变量 `SNOWLUMA_HOME`、或在向导中填写目录），在其 WebUI 中为账号添加 HTTP 服务端（如 3000）与 WebSocket 服务端（如 3001）。桥接会读取 `config/onebot_<QQ号>.json` 中的端口与 token，并逐个探测——**切换 QQ 账号无需改任何配置**。

**其它协议端**：在向导或设置页填写 WS 地址、HTTP 地址与 Access Token（WS 为正向 WebSocket，桥接作为客户端连接）。

检查连接：

```bash
node bin/qab.mjs status
```

## 配置文件

`config/qab.yaml` 的所有项都可在控制台「设置」页修改（保存即生效，监听地址/端口除外）。完整默认值见 [config/qab.example.yaml](../config/qab.example.yaml)。

| 段 | 关键项 |
|---|---|
| `onebot` | `wsUrl` `httpUrl` `accessToken` `httpToken` `snowlumaHome` `autoDiscover` |
| `server` | `host`（默认仅本机）`port`（3210）`consolePassword` |
| `owners` | 主人 QQ 列表（插件管理命令、请求通知） |
| `access` | `mode`（all / allowlist）、白名单、黑名单、`readOnly` |
| `limits` | 发送限流与分条节奏 |
| `agents` | `tokens`、各等级策略 `policy`、审批超时、`disabledTools` |
| `media` | `uploadRoots`（Agent 可读取的本地目录）、大小限制 |
| `plugins` | `dir`、`overrides`（插件开关）、`hotReload`、`commandPrefixes`、`astrbot` |

环境变量：`QAB_CONFIG`（配置文件路径）、`QAB_LOG_LEVEL`（debug/info/warn/error）、`SNOWLUMA_HOME`、`QAB_TOKEN` / `QAB_URL`（stdio 模式）。

## 常见问题

**控制台显示"未连接"**
确认 SnowLuma 已启动且 QQ 已登录；`qab status` 查看每个候选的探测结果。`401/1401` 表示 token 不对；`ECONNREFUSED` 表示端口没开。

**Agent 说发送成功但群里没看到**
不会发生——被拦截时工具一定返回错误。检查「调用审计」中的记录，以及协议端日志（可能被 QQ 风控）。

**忘记控制台密码**
`node bin/qab.mjs password 新密码`，然后重启。

**Edge TTS 没声音**
需要能访问微软语音服务；也可在「插件 → 语音 → 配置」中改用 OpenAI 兼容接口或本地命令（如 piper）。

**想在局域网/服务器上访问控制台**
设置 `server.host: 0.0.0.0` 并使用强密码；对公网暴露时请放在 HTTPS 反向代理之后。

**备份与迁移**
复制 `config/qab.yaml` 与 `data/` 目录即可。
