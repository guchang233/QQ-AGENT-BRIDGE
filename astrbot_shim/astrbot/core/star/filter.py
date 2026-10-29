"""@filter.* 装饰器。多个装饰器叠加在同一函数上时为"与"关系；装饰器返回原函数。"""
from __future__ import annotations

import enum
import re
from typing import Any, Callable

from astrbot.core import runtime


class EventMessageType(enum.Flag):
    GROUP_MESSAGE = 1
    PRIVATE_MESSAGE = 2
    OTHER_MESSAGE = 4
    ALL = 7


class PermissionType(enum.Flag):
    ADMIN = enum.auto()
    MEMBER = enum.auto()
    GROUP_ADMIN = enum.auto()
    SHARED_GROUP_ADMIN = enum.auto()


class PlatformAdapterType(enum.Flag):
    AIOCQHTTP = enum.auto()
    QQOFFICIAL = enum.auto()
    TELEGRAM = enum.auto()
    WECOM = enum.auto()
    LARK = enum.auto()
    DINGTALK = enum.auto()
    DISCORD = enum.auto()
    SLACK = enum.auto()
    KOOK = enum.auto()
    WEBCHAT = enum.auto()
    ALL = AIOCQHTTP | QQOFFICIAL | TELEGRAM | WECOM | LARK | DINGTALK | DISCORD | SLACK | KOOK | WEBCHAT


class CustomFilter:
    def filter(self, event: Any, cfg: Any) -> bool:
        return True


class _CommandGroup:
    def __init__(self, path: list[str]):
        self.path = path

    def command(self, name: str, alias: set | None = None, priority: int = 0, **kw: Any):
        return command(name, alias=alias, priority=priority, _group=self.path, **kw)

    def group(self, name: str, alias: set | None = None, **kw: Any) -> "_CommandGroup":
        g = _CommandGroup(self.path + [name])

        def deco(func: Callable) -> Callable:
            func.__astrbot_group__ = g  # type: ignore[attr-defined]
            return func
        # 兼容 @parent.group("sub") 作为装饰器的用法
        g.__call__ = deco  # type: ignore[method-assign]
        return g

    def __call__(self, func: Callable) -> Callable:
        return func

    def custom_filter(self, *a: Any, **kw: Any):
        return lambda f: f


def command(command_name: str | None = None, sub_command: str | None = None, alias: set | None = None, priority: int = 0, desc: str = "", _group: list | None = None, **kw: Any):
    def deco(func: Callable) -> Callable:
        m = runtime.handler_meta(func)
        m.kind = "command"
        m.command = command_name or func.__name__
        m.aliases = set(alias or [])
        m.group_path = list(_group or [])
        m.priority = priority
        m.desc = desc or (func.__doc__ or "").strip().split("\n")[0]
        return func
    return deco


def command_group(command_group_name: str | None = None, sub_command: str | None = None, alias: set | None = None, **kw: Any):
    """@filter.command_group("math") def math(self): pass   →   @math.command("add") ..."""
    def deco(func: Callable) -> _CommandGroup:
        return _CommandGroup([command_group_name or func.__name__])
    return deco


def regex(pattern: str | re.Pattern, flags: int = 0, priority: int = 0, **kw: Any):
    def deco(func: Callable) -> Callable:
        m = runtime.handler_meta(func)
        if m.kind == "message":
            m.kind = "regex"
        m.regex = re.compile(pattern, flags) if isinstance(pattern, str) else pattern
        m.priority = max(m.priority, priority)
        return func
    return deco


def event_message_type(t: EventMessageType, priority: int = 0, **kw: Any):
    def deco(func: Callable) -> Callable:
        m = runtime.handler_meta(func)
        m.message_types = t.value
        m.priority = max(m.priority, priority)
        return func
    return deco


def permission_type(t: PermissionType, raise_error: bool = True, **kw: Any):
    def deco(func: Callable) -> Callable:
        m = runtime.handler_meta(func)
        if t & PermissionType.ADMIN:
            m.admin_only = True
        return func
    return deco


def platform_adapter_type(t: PlatformAdapterType, **kw: Any):
    def deco(func: Callable) -> Callable:
        runtime.handler_meta(func)  # 本桥接只有 QQ(aiocqhttp)，不再过滤
        return func
    return deco


def custom_filter(cf: Any, *a: Any, **kw: Any):
    def deco(func: Callable) -> Callable:
        m = runtime.handler_meta(func)
        m.__dict__.setdefault("custom_filters", []).append(cf)
        return func
    return deco


def llm_tool(name: str | None = None, **kw: Any):
    def deco(func: Callable) -> Callable:
        m = runtime.handler_meta(func)
        m.kind = "llm_tool"
        m.tool_name = name or func.__name__
        return func
    return deco


def _hook(hook_name: str):
    def factory(*a: Any, **kw: Any):
        def deco(func: Callable) -> Callable:
            m = runtime.handler_meta(func)
            m.kind = "hook"
            m.hook = hook_name
            return func
        return deco
    return factory


on_astrbot_loaded = _hook("on_astrbot_loaded")
on_platform_loaded = _hook("on_platform_loaded")
on_llm_request = _hook("on_llm_request")
on_llm_response = _hook("on_llm_response")
on_decorating_result = _hook("on_decorating_result")
after_message_sent = _hook("after_message_sent")
on_plugin_loaded = _hook("on_plugin_loaded")
on_plugin_unloaded = _hook("on_plugin_unloaded")
on_plugin_error = _hook("on_plugin_error")
on_waiting_llm_request = _hook("on_waiting_llm_request")
on_using_llm_tool = _hook("on_using_llm_tool")
on_llm_tool_respond = _hook("on_llm_tool_respond")
on_agent_begin = _hook("on_agent_begin")
on_agent_done = _hook("on_agent_done")
