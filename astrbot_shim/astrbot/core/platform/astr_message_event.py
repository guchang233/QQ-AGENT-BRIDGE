from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any

from astrbot.core import runtime
from astrbot.core.message.components import BaseMessageComponent, Plain, Image, At, AtAll, from_onebot
from astrbot.core.message.message_event_result import MessageChain, MessageEventResult


class MessageType(str, enum.Enum):
    GROUP_MESSAGE = "GroupMessage"
    FRIEND_MESSAGE = "FriendMessage"
    OTHER_MESSAGE = "OtherMessage"


@dataclass
class MessageMember:
    user_id: str = ""
    nickname: str = ""


@dataclass
class AstrBotMessage:
    type: MessageType = MessageType.FRIEND_MESSAGE
    self_id: str = ""
    session_id: str = ""
    message_id: str = ""
    group_id: str = ""
    sender: MessageMember = field(default_factory=MessageMember)
    message: list = field(default_factory=list)
    message_str: str = ""
    raw_message: Any = None
    timestamp: int = 0


@dataclass
class PlatformMetadata:
    name: str = "aiocqhttp"
    description: str = "QQ-Agent Bridge (OneBot v11)"
    id: str = "qab"


class _BotApi:
    async def call_action(self, action: str, **params: Any) -> Any:
        return await runtime.rpc("call_action", action=action, params=params)


class _Bot:
    """模拟 aiocqhttp.CQHttp：event.bot.api.call_action(...) / await event.bot.send_group_msg(...)"""

    def __init__(self):
        self.api = _BotApi()

    async def call_action(self, action: str, **params: Any) -> Any:
        return await self.api.call_action(action, **params)

    def __getattr__(self, action: str):
        async def _call(**params: Any):
            return await self.api.call_action(action, **params)
        return _call


class AstrMessageEvent:
    def __init__(self, message_str: str, message_obj: AstrBotMessage, platform_meta: PlatformMetadata | None = None, session_id: str = "", conv: str = ""):
        self.message_str = message_str
        self.message_obj = message_obj
        self.platform_meta = platform_meta or PlatformMetadata()
        self.session_id = session_id
        self.conv = conv
        self.role = "member"
        self.is_wake = False
        self.is_at_or_wake_command = False
        self.call_llm = False
        self._extras: dict[str, Any] = {}
        self._result: MessageEventResult | None = None
        self._stopped = False
        self._outbox: list[list[dict]] | None = None  # 非空时把发送内容收集起来（llm_tool 调用场景）
        self.bot = _Bot()

    # ------------------------------------------------------------ 基本信息
    @property
    def unified_msg_origin(self) -> str:
        return f"{self.platform_meta.id}:{self.message_obj.type.value}:{self.session_id}"

    def get_platform_name(self) -> str: return self.platform_meta.name
    def get_platform_id(self) -> str: return self.platform_meta.id
    def get_message_str(self) -> str: return self.message_str
    def get_messages(self) -> list: return self.message_obj.message
    def get_message_type(self) -> MessageType: return self.message_obj.type
    def get_session_id(self) -> str: return self.session_id
    def get_group_id(self) -> str: return self.message_obj.group_id or ""
    def get_self_id(self) -> str: return self.message_obj.self_id
    def get_sender_id(self) -> str: return self.message_obj.sender.user_id
    def get_sender_name(self) -> str: return self.message_obj.sender.nickname
    def is_private_chat(self) -> bool: return self.message_obj.type == MessageType.FRIEND_MESSAGE
    def is_wake_up(self) -> bool: return self.is_wake
    def is_admin(self) -> bool: return self.role == "admin"
    def get_message_outline(self) -> str: return self.message_str

    def set_extra(self, key: str, value: Any) -> None: self._extras[key] = value
    def get_extra(self, key: str | None = None, default: Any = None) -> Any:
        return self._extras if key is None else self._extras.get(key, default)
    def clear_extra(self) -> None: self._extras.clear()

    # ------------------------------------------------------------ 结果
    def set_result(self, result: MessageEventResult | str) -> None:
        if isinstance(result, str):
            result = MessageEventResult().message(result)
        self._result = result

    def get_result(self) -> MessageEventResult | None: return self._result
    def clear_result(self) -> None: self._result = None
    def stop_event(self) -> None: self._stopped = True
    def continue_event(self) -> None: self._stopped = False
    def is_stopped(self) -> bool: return self._stopped
    def should_call_llm(self, call: bool) -> None: self.call_llm = call

    def make_result(self) -> MessageEventResult: return MessageEventResult()
    def plain_result(self, text: str) -> MessageEventResult: return MessageEventResult().message(text)

    def image_result(self, url_or_path: str) -> MessageEventResult:
        if url_or_path.startswith("http"):
            return MessageEventResult().url_image(url_or_path)
        return MessageEventResult().file_image(url_or_path)

    def chain_result(self, chain: list) -> MessageEventResult:
        r = MessageEventResult()
        r.chain = list(chain)
        return r

    # ------------------------------------------------------------ 发送
    async def send(self, message: MessageChain | list | str) -> None:
        segs = to_segments(message)
        if not segs:
            return
        if self._outbox is not None:
            self._outbox.append(segs)
            return
        await runtime.rpc("send", conv=self.conv, segments=segs)

    async def react(self, emoji: str) -> None:
        await runtime.rpc("react", message_id=self.message_obj.message_id, emoji=emoji)

    async def send_typing(self) -> None:
        return None

    async def get_group(self, group_id: str | None = None, **kw: Any):
        gid = group_id or self.get_group_id()
        if not gid:
            return None
        return await runtime.rpc("call_action", action="get_group_info", params={"group_id": int(gid)})

    def request_llm(self, *a: Any, **kw: Any):
        raise NotImplementedError("QQ-Agent Bridge 的 AstrBot 兼容层不内置 LLM：请让 Agent 通过 MCP 调用插件工具")


def to_segments(message: Any) -> list[dict]:
    if message is None:
        return []
    if isinstance(message, str):
        return [{"type": "text", "data": {"text": message}}]
    chain = message.chain if isinstance(message, MessageChain) else message
    out = []
    for c in chain:
        if isinstance(c, str):
            out.append({"type": "text", "data": {"text": c}})
        elif isinstance(c, BaseMessageComponent):
            seg = c.to_onebot()
            if seg:
                out.append(seg)
    return out


def build_event(e: dict) -> AstrMessageEvent:
    is_group = bool(e.get("isGroup"))
    comps = [from_onebot(s) for s in e.get("segments", [])]
    obj = AstrBotMessage(
        type=MessageType.GROUP_MESSAGE if is_group else MessageType.FRIEND_MESSAGE,
        self_id=str(runtime.settings.get("self_id", "")),
        session_id=str(e.get("groupId") if is_group else e.get("senderId")),
        message_id=str(e.get("msgId", "")),
        group_id=str(e.get("groupId") or ""),
        sender=MessageMember(user_id=str(e.get("senderId", "")), nickname=e.get("senderName", "")),
        message=comps,
        message_str=e.get("text", ""),
        raw_message=e.get("raw"),
        timestamp=int((e.get("ts") or 0) / 1000),
    )
    ev = AstrMessageEvent(e.get("text", ""), obj, session_id=obj.session_id, conv=e.get("conv", ""))
    if str(e.get("senderId")) in [str(x) for x in runtime.settings.get("admins", [])]:
        ev.role = "admin"
    return ev


__all__ = ["AstrMessageEvent", "AstrBotMessage", "MessageType", "MessageMember", "PlatformMetadata", "build_event", "to_segments"]
