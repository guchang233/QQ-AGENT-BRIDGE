# AstrBot 插件 API 速记（用于轻兼容层）

来源：AstrBot master 源码调研（部分签名经 WebFetch 摘要，标 [?] 为未完全确认）。

## 插件结构
- 目录含 `main.py`（或 `<dir>.py`），可选 `metadata.yaml`(name/display_name/desc/version/author/repo)、`_conf_schema.json`、`requirements.txt`。
- `@register(name, author, desc, version, repo=None)` 已弃用；`Star.__init_subclass__` 自动注册子类。
- 实例化：`cls(context=ctx, config=plugin_config)`，TypeError 时退回 `cls(context=ctx)`；之后 `await initialize()`，卸载 `await terminate()`。

## 导入路径
- `astrbot.api`: `logger`, `AstrBotConfig`, `llm_tool`
- `astrbot.api.event`: `filter`, `AstrMessageEvent`, `MessageEventResult`, `MessageChain`, `EventResultType`
- `astrbot.api.event.filter`: `EventMessageType`, `PermissionType`
- `astrbot.api.star`: `Context`, `Star`, `StarTools`, `register`
- `astrbot.api.message_components` (常 `as Comp`): Plain, Image, Record, Video, File, Face, At, AtAll, Reply, Poke, Node, Nodes, Forward, Json
- `astrbot.core.platform.sources.aiocqhttp.aiocqhttp_message_event.AiocqhttpMessageEvent`（`event.bot.api.call_action(action, **params)`）

## filter
- `command(name, alias=set(), priority=0)`；`command_group(name)` → 返回对象 `.command(sub)` `.group(sub)`。
- `event_message_type(EventMessageType.GROUP_MESSAGE=1|PRIVATE_MESSAGE=2|OTHER=4|ALL=7)`（Flag 位与）。
- `regex(pattern)`：`re.search` 于 `message_str.strip()`。
- `permission_type(PermissionType.ADMIN|MEMBER)`：ADMIN = 在 admins_id 中。
- `llm_tool(name)`：参数来自 docstring `Args:` 段，`name(string): 描述`，类型 string/number/object/boolean。
- 钩子：on_astrbot_loaded, on_llm_request(event, req), on_llm_response, on_decorating_result, after_message_sent（不能 yield）。
- 多个 filter 叠加为 AND；装饰器返回原函数。

## 命令解析
- 需唤醒：默认前缀 `/`（被剥离），@bot / 回复 bot 也算唤醒；私聊默认无需前缀。
- 消息 == `cmd` 或以 `cmd ` 开头（含别名、组前缀）；余下按空格切分映射到 `(self, event, ...)` 之后的参数；按注解/默认值类型转换（bool 接受 true/false/yes/no/1/0）；`GreedyStr` 吞余下全部。缺参/转换失败回错误提示。

## 处理器执行
- async generator：每个 yield 的 `MessageEventResult` → 发送。
- coroutine：返回值若为 MessageEventResult 则发送；纯 str 不发送。

## AstrMessageEvent
- 属性：message_str, message_obj(raw_message/self_id/sender/group_id/message), unified_msg_origin(`platform:MessageType:session`), is_wake
- 方法：get_message_str, get_messages, get_message_type, get_sender_id, get_sender_name, get_group_id(无则 "")，get_self_id, get_session_id, get_platform_name("aiocqhttp"), is_private_chat, is_admin, set_extra/get_extra,
  set_result, get_result, stop_event, continue_event, is_stopped, plain_result, image_result(http→url 否则路径), chain_result, async send(MessageChain), async react(emoji)
- MessageChain(chain=[])：.message(str) .at(name,qq) .at_all() .url_image .file_image .base64_image .get_plain_text()

## Context / StarTools / Config
- `await context.send_message(umo, chain)`；`context.get_config()`；`context.get_registered_star(name)`；`context.get_all_stars()`
- `StarTools.get_data_dir(name=None) -> Path`（data/plugin_data/<name>）
- `AstrBotConfig`：dict 子类 + `save_config()`，存于 `data/config/<dir>_config.json`，按 `_conf_schema.json` 填默认值（type: string|text|int|float|bool|object|list，default, description, hint, options, items）。
- `Star.put_kv_data/get_kv_data` [?]
