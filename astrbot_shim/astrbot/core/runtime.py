"""兼容层运行时：与 Node 守护进程的 JSON-RPC 通道、插件与处理器注册表。"""
from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass, field
from typing import Any, Callable

# ---------------------------------------------------------------- RPC 通道（stdout 只用于协议）
_pending: dict[int, asyncio.Future] = {}
_seq = 0


def write(msg: dict) -> None:
    sys.__stdout__.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()


async def rpc(method: str, **params: Any) -> Any:
    """调用 Node 侧方法：send / call_action / log。"""
    global _seq
    _seq += 1
    rid = _seq
    fut = asyncio.get_running_loop().create_future()
    _pending[rid] = fut
    write({"type": "rpc", "id": rid, "method": method, "params": params})
    return await asyncio.wait_for(fut, timeout=180)


def resolve_rpc(msg: dict) -> None:
    fut = _pending.pop(msg.get("id"), None)
    if fut and not fut.done():
        if msg.get("error"):
            fut.set_exception(RuntimeError(msg["error"]))
        else:
            fut.set_result(msg.get("result"))


# ---------------------------------------------------------------- 注册表
@dataclass
class HandlerMeta:
    func: Callable
    module: str
    kind: str = "message"            # command / regex / message / llm_tool / hook
    command: str | None = None
    aliases: set = field(default_factory=set)
    group_path: list = field(default_factory=list)   # 指令组前缀
    regex: Any = None
    message_types: int | None = None  # EventMessageType 位掩码
    admin_only: bool = False
    priority: int = 0
    hook: str | None = None
    tool_name: str | None = None
    desc: str = ""


@dataclass
class StarMetadata:
    name: str = ""
    author: str = ""
    desc: str = ""
    version: str = ""
    repo: str = ""
    module: str = ""
    dir: str = ""
    star_cls: Any = None
    instance: Any = None
    config: Any = None
    activated: bool = True


handlers: list[HandlerMeta] = []
star_map: dict[str, StarMetadata] = {}   # module -> metadata
star_classes: dict[str, Any] = {}        # module -> Star subclass（自动注册）


def handler_meta(func: Callable) -> HandlerMeta:
    """取得（或创建）函数对应的 HandlerMeta；多个装饰器叠加时共用一个。"""
    meta = getattr(func, "__astrbot_meta__", None)
    if meta is None:
        meta = HandlerMeta(func=func, module=func.__module__)
        try:
            setattr(func, "__astrbot_meta__", meta)
        except AttributeError:
            pass
        handlers.append(meta)
    return meta


# 全局配置（由 host 注入）
settings: dict[str, Any] = {"wake_prefix": ["/"], "admins": [], "self_id": "", "data_dir": "data"}
