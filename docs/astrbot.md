# AstrBot 插件兼容

QQ-Agent Bridge 可以运行**常用的 AstrBot 插件**：用 Python 子进程加载插件，提供 `astrbot.api` 的一个子集，通过 JSON-RPC 与守护进程通信。目标是"有用的插件能直接跑"，而不是 100% 复刻 AstrBot。

## 开启

1. 安装 Python 3.10+
2. 控制台「设置 → 插件」开启 **AstrBot 兼容层**（或 `plugins.astrbot.enabled: true`），按需填写 Python 路径
3. 把插件放进 `astrbot_plugins/<插件目录>/`（或 `qab plugin install <git地址> --astrbot`），插件的 `requirements.txt` 需手动 `pip install`
4. 重启守护进程。插件出现在「插件 → AstrBot」页，可开关、配置（`_conf_schema.json` 自动生成表单）

## 支持情况

| 能力 | 状态 |
|---|---|
| `Star` 子类自动注册、`@register` | ✅ |
| `metadata.yaml`、`_conf_schema.json` → `AstrBotConfig`（含 `save_config`） | ✅ |
| `initialize()` / `terminate()` | ✅ |
| `@filter.command`（参数按类型注解转换、`GreedyStr`、别名、指令组 `command_group`） | ✅ |
| `@filter.regex`、`event_message_type`、`permission_type(ADMIN)`、`custom_filter` | ✅ |
| `yield event.plain_result / image_result / chain_result`、`await event.send()` | ✅ |
| 消息组件 `Plain Image Record Video File Face At AtAll Reply Poke Node Nodes Forward Json` | ✅ |
| `event.get_sender_id / get_group_id / get_message_str / is_admin / stop_event …` | ✅ |
| `event.bot.api.call_action(...)`、`isinstance(event, AiocqhttpMessageEvent)` | ✅ |
| `context.send_message(unified_msg_origin, chain)`、`StarTools.get_data_dir()` | ✅ |
| `put_kv_data / get_kv_data` | ✅ |
| `@filter.llm_tool` → 自动注册为 MCP 工具 `astrbot_<目录>_<工具名>` | ✅ |
| `on_llm_request` 等 LLM 钩子 | ⚠️ 可注册但不会触发（本项目的 LLM 在外部 Agent） |
| `context.llm_generate`、`event.request_llm`、`text_to_image`、`html_render` | ❌ 抛出明确错误 |
| 平台适配器、WebUI 扩展 | ❌ |

唤醒规则与 AstrBot 一致：带前缀（默认使用本项目的 `commandPrefixes`，即 `/` `#`）、@机器人、或私聊。管理员（`owners`）视为 AstrBot 管理员。

## 实现

- `astrbot_shim/astrbot/` —— `astrbot.api` 兼容包
- `astrbot_shim/host.py` —— 宿主进程：加载插件、分发事件、解析命令参数、执行 llm_tool
- `src/plugins/astrbot.ts` —— Node 侧：启动子进程、转发消息、把发送请求转为桥接调用
- `astrbot_shim/examples/helloworld/` —— 兼容性示例，`test/astrbot.test.ts` 覆盖

遇到不兼容的 API，欢迎提 Issue 并附上插件链接；补齐方式通常只需在 `astrbot_shim/astrbot/` 中增加对应实现。
