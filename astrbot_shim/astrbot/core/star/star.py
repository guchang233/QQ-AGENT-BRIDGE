from __future__ import annotations

import inspect
import json
import os
from pathlib import Path
from typing import Any

from astrbot.core import runtime
from astrbot.core.config import AstrBotConfig
from astrbot.core.message.message_event_result import MessageChain


class Context:
    """插件上下文的子集实现。"""

    def __init__(self):
        self._config = AstrBotConfig({"admins_id": runtime.settings.get("admins", []), "wake_prefix": runtime.settings.get("wake_prefix", ["/"])})

    async def send_message(self, session: Any, message_chain: MessageChain | list) -> bool:
        from astrbot.core.platform.astr_message_event import to_segments
        conv = _umo_to_conv(str(session))
        await runtime.rpc("send", conv=conv, segments=to_segments(message_chain))
        return True

    def get_config(self, umo: Any = None) -> AstrBotConfig:
        return self._config

    def get_registered_star(self, name: str):
        return next((m for m in runtime.star_map.values() if m.name == name), None)

    def get_all_stars(self) -> list:
        return list(runtime.star_map.values())

    def get_platform(self, *a: Any, **kw: Any):
        return None

    def get_platform_inst(self, *a: Any, **kw: Any):
        return None

    def get_using_provider(self, *a: Any, **kw: Any):
        return None

    async def get_using_provider_async(self, *a: Any, **kw: Any):
        return None

    async def llm_generate(self, *a: Any, **kw: Any):
        raise NotImplementedError("兼容层不内置 LLM，请改由 Agent 通过 MCP 调用")

    def add_llm_tools(self, *tools: Any) -> None:
        return None

    def register_task(self, coro: Any, desc: str = "") -> None:
        import asyncio
        asyncio.get_running_loop().create_task(coro)


def _umo_to_conv(umo: str) -> str:
    # unified_msg_origin: platform:GroupMessage:123 / platform:FriendMessage:456；也接受 group:123
    parts = umo.split(":")
    if len(parts) >= 3:
        kind, sid = parts[-2], parts[-1]
        return f"group:{sid}" if "Group" in kind else f"private:{sid}"
    return umo


class Star:
    """插件基类。子类化即自动注册（与 AstrBot ≥3.5.19 行为一致）。"""

    def __init__(self, context: Context, config: Any = None, **kw: Any):
        self.context = context
        if config is not None:
            self.config = config

    def __init_subclass__(cls, **kwargs: Any):
        super().__init_subclass__(**kwargs)
        runtime.star_classes[cls.__module__] = cls

    async def initialize(self) -> None:
        return None

    async def terminate(self) -> None:
        return None

    async def text_to_image(self, text: str, return_url: bool = True, **kw: Any) -> str:
        raise NotImplementedError("兼容层不支持文转图")

    async def html_render(self, tmpl: str, data: dict, return_url: bool = True, **kw: Any) -> str:
        raise NotImplementedError("兼容层不支持 HTML 渲染")

    # KV 存储（落在插件数据目录）
    def _kv_file(self) -> Path:
        return StarTools.get_data_dir(_meta_of(self).name) / "_kv.json"

    async def put_kv_data(self, key: str, value: Any) -> None:
        f = self._kv_file()
        d = json.loads(f.read_text("utf-8")) if f.exists() else {}
        d[key] = value
        f.write_text(json.dumps(d, ensure_ascii=False), "utf-8")

    async def get_kv_data(self, key: str, default: Any = None) -> Any:
        f = self._kv_file()
        return (json.loads(f.read_text("utf-8")) if f.exists() else {}).get(key, default)

    async def delete_kv_data(self, key: str) -> None:
        f = self._kv_file()
        if f.exists():
            d = json.loads(f.read_text("utf-8"))
            d.pop(key, None)
            f.write_text(json.dumps(d, ensure_ascii=False), "utf-8")


def _meta_of(obj: Any):
    mod = type(obj).__module__
    return runtime.star_map.get(mod) or runtime.StarMetadata(name=mod.split(".")[-2] if "." in mod else mod)


class StarTools:
    @classmethod
    def get_data_dir(cls, plugin_name: str | None = None) -> Path:
        if not plugin_name:
            frame = inspect.stack()[1]
            mod = frame.frame.f_globals.get("__name__", "")
            meta = runtime.star_map.get(mod) or next((m for k, m in runtime.star_map.items() if mod.startswith(k.rsplit(".", 1)[0])), None)
            plugin_name = meta.name if meta else "unknown"
        p = Path(runtime.settings.get("data_dir", "data")) / "plugin_data" / plugin_name
        p.mkdir(parents=True, exist_ok=True)
        return p

    @classmethod
    async def send_message(cls, session: Any, message_chain: Any) -> bool:
        return await Context().send_message(session, message_chain)


def register(name: str, author: str = "", desc: str = "", version: str = "", repo: str | None = None):
    """旧式 @register 装饰器：记录元数据（与 metadata.yaml 合并）。"""
    def deco(cls):
        runtime.star_classes[cls.__module__] = cls
        meta = runtime.star_map.setdefault(cls.__module__, runtime.StarMetadata(module=cls.__module__))
        meta.name = meta.name or name
        meta.author = meta.author or author
        meta.desc = meta.desc or desc
        meta.version = meta.version or version
        meta.repo = meta.repo or (repo or "")
        return cls
    return deco
