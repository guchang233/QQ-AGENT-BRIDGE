"""
AstrBot 插件宿主进程（由 QQ-Agent Bridge 启动）。

协议：stdin/stdout 每行一个 JSON。
  Node → Py: init / event / tool_call / rpc_result / shutdown
  Py → Node: ready / event_done / tool_result / rpc(send|call_action|react)
插件的 print() 被重定向到 stderr，不会污染协议通道。
"""
from __future__ import annotations

import asyncio
import importlib
import inspect
import json
import os
import re
import sys
import threading
import traceback
import types
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
_proto_out = sys.stdout
sys.stdout = sys.stderr  # 插件 print 走 stderr

from astrbot.core import runtime, logger  # noqa: E402
from astrbot.core.config import AstrBotConfig  # noqa: E402
from astrbot.core.star.star import Context  # noqa: E402
from astrbot.core.message.message_event_result import MessageEventResult, MessageChain  # noqa: E402
from astrbot.core.platform.astr_message_event import build_event, AstrMessageEvent, to_segments  # noqa: E402
from astrbot.core.platform.sources.aiocqhttp import aiocqhttp_message_event as _aio  # noqa: E402

# 本桥接的所有事件都来自 QQ，让 isinstance(event, AiocqhttpMessageEvent) 恒为真
_aio.AiocqhttpMessageEvent = AstrMessageEvent  # type: ignore[misc]

runtime.write = lambda msg: (_proto_out.write(json.dumps(msg, ensure_ascii=False) + "\n"), _proto_out.flush())  # type: ignore[assignment]

PLUGINS: dict[str, dict] = {}   # dir -> info
CONTEXT: Context | None = None


class GreedyStr(str):
    """AstrBot 的 GreedyStr：吞掉剩余所有参数。"""


# ---------------------------------------------------------------- 加载
def parse_metadata(p: Path) -> dict:
    meta: dict[str, Any] = {}
    for name in ("metadata.yaml", "metadata.yml"):
        f = p / name
        if f.exists():
            for line in f.read_text("utf-8", errors="ignore").splitlines():
                m = re.match(r"^([A-Za-z_]+)\s*:\s*(.*)$", line)
                if m:
                    meta[m.group(1)] = m.group(2).strip().strip("'\"")
    if "desc" not in meta and "description" in meta:
        meta["desc"] = meta["description"]
    return meta


def tool_schema(func) -> tuple[str, dict]:
    """从 docstring 的 Args: 段解析 llm_tool 参数：name(type): 描述"""
    doc = inspect.getdoc(func) or ""
    desc_lines, params, in_args = [], {}, False
    for line in doc.splitlines():
        s = line.strip()
        if re.match(r"^(Args|Arguments|参数)\s*[:：]", s):
            in_args = True
            continue
        if in_args:
            m = re.match(r"^(\w+)\s*\(\s*(\w+)\s*\)\s*[:：]\s*(.*)$", s)
            if m:
                params[m.group(1)] = {"type": m.group(2).lower(), "description": m.group(3)}
                continue
            if s and not s.startswith(("-", "*")) and not re.match(r"^\w+\s*\(", s):
                in_args = False
        if not in_args and s:
            desc_lines.append(s)
    sig = inspect.signature(func)
    required = [n for n, p in list(sig.parameters.items())[2:] if p.default is inspect._empty and n in params]
    return " ".join(desc_lines), {"properties": params, "required": required}


def load_plugin(d: Path, data_dir: Path) -> dict:
    name = d.name
    info: dict[str, Any] = {"dir": name, "name": name, "error": None, "commands": [], "tools": [], "schema": None}
    meta = parse_metadata(d)
    info.update({k: meta.get(k, "") for k in ("display_name", "desc", "version", "author", "repo")})
    main = d / "main.py" if (d / "main.py").exists() else d / f"{name}.py"
    if not main.exists():
        info["error"] = "缺少 main.py"
        return info
    safe = re.sub(r"\W", "_", name)
    pkg_name = f"astrbot_plugin__{safe}"
    pkg = types.ModuleType(pkg_name)
    pkg.__path__ = [str(d)]  # type: ignore[attr-defined]
    sys.modules[pkg_name] = pkg
    if str(d) not in sys.path:
        sys.path.append(str(d))
    mod_name = f"{pkg_name}.{main.stem}"
    try:
        before = len(runtime.handlers)
        module = importlib.import_module(mod_name)
        cls = runtime.star_classes.get(mod_name)
        if cls is None:
            cands = [v for v in vars(module).values() if inspect.isclass(v) and v.__module__ == mod_name and (v.__name__.lower().endswith("plugin") or v.__name__ == "Main")]
            cls = cands[0] if cands else None
        if cls is None:
            raise RuntimeError("未找到插件类（继承 Star 的类）")
        sm = runtime.star_map.setdefault(mod_name, runtime.StarMetadata(module=mod_name))
        sm.name = meta.get("name") or sm.name or name
        sm.desc = meta.get("desc") or sm.desc
        sm.version = meta.get("version") or sm.version
        sm.author = meta.get("author") or sm.author
        sm.dir = str(d)
        info.update({"name": sm.name, "desc": sm.desc, "version": sm.version, "author": sm.author})

        cfg = None
        schema_file = d / "_conf_schema.json"
        if schema_file.exists():
            schema = json.loads(schema_file.read_text("utf-8"))
            info["schema"] = schema
            cfg_path = data_dir / "plugins" / f"astrbot-{name}" / "config.json"
            saved = json.loads(cfg_path.read_text("utf-8")) if cfg_path.exists() else {}
            cfg = AstrBotConfig(saved, cfg_path, schema)
            cfg.save_config()
            info["config"] = dict(cfg)
        try:
            inst = cls(context=CONTEXT, config=cfg) if cfg is not None else cls(context=CONTEXT)
        except TypeError:
            inst = cls(context=CONTEXT)
        sm.instance, sm.star_cls, sm.config = inst, cls, cfg
        own = [h for h in runtime.handlers[before:] if h.module.startswith(pkg_name)] or [h for h in runtime.handlers if h.module == mod_name]
        for h in own:
            h.__dict__["bound"] = h.func.__get__(inst, cls) if "self" in inspect.signature(h.func).parameters else h.func
            h.__dict__["plugin"] = name
            if h.kind == "command":
                info["commands"].append({"names": [" ".join(h.group_path + [h.command])] + [" ".join(h.group_path + [a]) for a in h.aliases], "desc": h.desc})
            if h.kind == "llm_tool":
                desc, params = tool_schema(h.func)
                info["tools"].append({"name": h.tool_name, "description": desc or h.tool_name, "params": params})
        info["_module"] = mod_name
        info["_instance"] = inst
    except Exception as e:  # noqa: BLE001
        info["error"] = f"{type(e).__name__}: {e}"
        logger.error(f"加载 AstrBot 插件 {name} 失败：\n{traceback.format_exc()}")
    return info


# ---------------------------------------------------------------- 分发
def convert_arg(val: str, param: inspect.Parameter) -> Any:
    ann = param.annotation
    typ = ann if ann is not inspect._empty and isinstance(ann, type) else (type(param.default) if param.default is not inspect._empty and param.default is not None else str)
    if typ is bool:
        if val.lower() in ("true", "yes", "1", "是", "开"):
            return True
        if val.lower() in ("false", "no", "0", "否", "关"):
            return False
        raise ValueError(f"无法把「{val}」转换为布尔值")
    if typ in (int, float):
        return typ(val)
    return val


def match_command(h, text: str) -> list[str] | None:
    names = [" ".join(h.group_path + [h.command])] + [" ".join(h.group_path + [a]) for a in h.aliases]
    for n in sorted(names, key=len, reverse=True):
        if text == n:
            return []
        if text.startswith(n + " "):
            return text[len(n) + 1:].split()
    return None


async def emit_result(ev: AstrMessageEvent, r: Any) -> None:
    if r is None:
        return
    if isinstance(r, MessageEventResult):
        ev.set_result(r)
        await ev.send(r)
        if r.is_stopped():
            ev.stop_event()
    elif isinstance(r, (MessageChain, list, str)):
        await ev.send(r)
    ev.clear_result()


async def invoke(func, ev: AstrMessageEvent, kwargs: dict) -> None:
    r = func(ev, **kwargs)
    if inspect.isasyncgen(r):
        async for item in r:
            await emit_result(ev, item)
    elif inspect.isawaitable(r):
        await emit_result(ev, await r)
    else:
        await emit_result(ev, r)


async def dispatch(e: dict) -> bool:
    ev = build_event(e)
    text = (e.get("text") or "").strip()
    for p in runtime.settings.get("wake_prefix", ["/"]):
        if p and text.startswith(p):
            text = text[len(p):].strip()
            ev.is_wake = True
            break
    if e.get("mentioned") or not e.get("isGroup"):
        ev.is_wake = True
    ev.is_at_or_wake_command = ev.is_wake
    ev.message_str = text
    ev.message_obj.message_str = text
    mtype = 1 if e.get("isGroup") else 2

    for h in sorted([h for h in runtime.handlers if "bound" in h.__dict__ and h.kind in ("command", "regex", "message")], key=lambda x: -x.priority):
        if not PLUGINS.get(h.__dict__["plugin"], {}).get("_instance"):
            continue
        if h.message_types is not None and not (h.message_types & mtype):
            continue
        if h.admin_only and not ev.is_admin():
            continue
        if any(not cf().filter(ev, None) if isinstance(cf, type) else not cf.filter(ev, None) for cf in h.__dict__.get("custom_filters", [])):
            continue
        kwargs: dict[str, Any] = {}
        if h.kind == "command":
            if not ev.is_at_or_wake_command:
                continue
            args = match_command(h, text)
            if args is None:
                continue
            params = list(inspect.signature(h.func).parameters.values())[2:]
            try:
                for i, p in enumerate(params):
                    if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
                        break
                    greedy = p.annotation is GreedyStr or getattr(p.annotation, "__name__", "") == "GreedyStr" or (i == len(params) - 1 and p.annotation is str and len(args) > len(params))
                    if greedy:
                        kwargs[p.name] = " ".join(args[i:])
                        break
                    if i < len(args):
                        kwargs[p.name] = convert_arg(args[i], p)
                    elif p.default is inspect._empty:
                        usage = " ".join(f"<{x.name}>" for x in params)
                        await ev.send(f"参数不足。用法：/{' '.join(h.group_path + [h.command])} {usage}")
                        return True
            except ValueError as err:
                await ev.send(f"参数错误：{err}")
                return True
        elif h.kind == "regex":
            if not h.regex or not h.regex.search(text):
                continue
        try:
            await invoke(h.__dict__["bound"], ev, kwargs)
        except Exception as err:  # noqa: BLE001
            logger.error(f"插件 {h.__dict__['plugin']} 处理出错：{err}\n{traceback.format_exc()}")
        if ev.is_stopped():
            return True
    return False


async def call_tool(plugin: str, name: str, args: dict) -> str:
    h = next((h for h in runtime.handlers if h.kind == "llm_tool" and h.__dict__.get("plugin") == plugin and h.tool_name == name), None)
    if not h:
        raise RuntimeError(f"工具 {name} 不存在")
    conv = args.pop("__conv", "")
    is_group = conv.startswith("group:")
    ev = build_event({"conv": conv, "isGroup": is_group, "groupId": conv[6:] if is_group else "", "senderId": conv[8:] if conv.startswith("private:") else "", "text": "", "segments": []})
    ev._outbox = []
    r = h.__dict__["bound"](ev, **args)
    out: list[str] = []
    if inspect.isasyncgen(r):
        async for item in r:
            out.append(_text_of(item))
    else:
        v = await r if inspect.isawaitable(r) else r
        if v is not None:
            out.append(_text_of(v))
    out += [" ".join(s["data"].get("text", f"[{s['type']}]") for s in segs) for segs in ev._outbox]
    return "\n".join(x for x in out if x) or "（工具已执行，无文本输出）"


def _text_of(v: Any) -> str:
    if isinstance(v, str):
        return v
    segs = to_segments(v)
    return "".join(s["data"].get("text", f"[{s['type']}]") for s in segs)


# ---------------------------------------------------------------- 主循环
async def main() -> None:
    global CONTEXT
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if line:
                loop.call_soon_threadsafe(queue.put_nowait, line)
        loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=reader, daemon=True).start()

    async def handle(msg: dict) -> None:
        t = msg.get("type")
        try:
            if t == "event":
                stopped = await dispatch(msg["event"])
                runtime.write({"type": "event_done", "id": msg["id"], "stopped": stopped})
            elif t == "tool_call":
                res = await call_tool(msg["plugin"], msg["name"], dict(msg.get("args") or {}))
                runtime.write({"type": "tool_result", "id": msg["id"], "result": res})
        except Exception as err:  # noqa: BLE001
            logger.error(traceback.format_exc())
            if t == "event":
                runtime.write({"type": "event_done", "id": msg["id"], "stopped": False, "error": str(err)})
            elif t == "tool_call":
                runtime.write({"type": "tool_result", "id": msg["id"], "error": str(err)})

    while True:
        line = await queue.get()
        if line is None:
            break
        msg = json.loads(line)
        t = msg.get("type")
        if t == "rpc_result":
            runtime.resolve_rpc(msg)
        elif t == "init":
            runtime.settings.update(msg["settings"])
            CONTEXT = Context()
            data_dir = Path(runtime.settings["data_dir"])
            root = Path(msg["plugins_dir"])
            root.mkdir(parents=True, exist_ok=True)
            for d in sorted(root.iterdir()):
                if d.is_dir() and not d.name.startswith((".", "_")) and d.name not in msg.get("disabled", []):
                    PLUGINS[d.name] = load_plugin(d, data_dir)
            for info in PLUGINS.values():
                inst = info.get("_instance")
                if inst is not None and hasattr(inst, "initialize"):
                    try:
                        await inst.initialize()
                    except Exception as err:  # noqa: BLE001
                        info["error"] = f"initialize 失败：{err}"
            runtime.write({"type": "ready", "plugins": [{k: v for k, v in i.items() if not k.startswith("_")} for i in PLUGINS.values()]})
        elif t == "shutdown":
            for info in PLUGINS.values():
                inst = info.get("_instance")
                if inst is not None:
                    try:
                        await inst.terminate()
                    except Exception:  # noqa: BLE001
                        pass
            break
        else:
            asyncio.create_task(handle(msg))


if __name__ == "__main__":
    asyncio.run(main())
