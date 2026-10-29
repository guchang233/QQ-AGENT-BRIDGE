"""AstrBot 消息组件的轻量实现（不依赖 pydantic），与 OneBot v11 段互转。"""
from __future__ import annotations

import base64
import enum
import os
from typing import Any


class ComponentType(str, enum.Enum):
    Plain = "Plain"
    Image = "Image"
    Record = "Record"
    Video = "Video"
    File = "File"
    Face = "Face"
    At = "At"
    AtAll = "AtAll"
    Reply = "Reply"
    Poke = "Poke"
    Node = "Node"
    Nodes = "Nodes"
    Forward = "Forward"
    Json = "Json"
    Unknown = "Unknown"


class BaseMessageComponent:
    type: ComponentType = ComponentType.Unknown

    def __init__(self, **kwargs: Any):
        for k, v in kwargs.items():
            setattr(self, k, v)

    def toDict(self) -> dict:
        return {"type": self.type.value.lower(), "data": {k: v for k, v in self.__dict__.items() if not k.startswith("_")}}

    def to_onebot(self) -> dict | None:
        return self.toDict()

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}({', '.join(f'{k}={v!r}' for k, v in self.__dict__.items())})"


class Plain(BaseMessageComponent):
    type = ComponentType.Plain

    def __init__(self, text: str = "", convert: bool = True, **kw: Any):
        super().__init__(text=text, **kw)

    def to_onebot(self):
        return {"type": "text", "data": {"text": self.text}}


def _file_value(file: str | None, url: str | None = None, path: str | None = None) -> str:
    v = file or url or path or ""
    if v.startswith(("http://", "https://", "base64://", "file://")):
        return v
    if v and os.path.exists(v):
        return "file:///" + os.path.abspath(v).replace("\\", "/")
    return v


class Image(BaseMessageComponent):
    type = ComponentType.Image

    def __init__(self, file: str | None = "", url: str | None = "", path: str | None = "", **kw: Any):
        super().__init__(file=file or "", url=url or "", path=path or "", **kw)

    @staticmethod
    def fromURL(url: str, **kw):
        return Image(file=url, url=url, **kw)

    @staticmethod
    def fromFileSystem(path: str, **kw):
        return Image(file=path, path=path, **kw)

    @staticmethod
    def fromBase64(b64: str, **kw):
        return Image(file=f"base64://{b64}", **kw)

    @staticmethod
    def fromBytes(data: bytes, **kw):
        return Image(file="base64://" + base64.b64encode(data).decode(), **kw)

    async def convert_to_file_path(self) -> str:
        return self.path or self.file

    async def convert_to_base64(self) -> str:
        f = self.file or ""
        if f.startswith("base64://"):
            return f[9:]
        p = self.path or (f[8:] if f.startswith("file:///") else f)
        with open(p, "rb") as fh:
            return base64.b64encode(fh.read()).decode()

    def to_onebot(self):
        d = {"file": _file_value(self.file, self.url, self.path)}
        if getattr(self, "summary", None):
            d["summary"] = self.summary
        return {"type": "image", "data": d}


class Record(BaseMessageComponent):
    type = ComponentType.Record

    def __init__(self, file: str | None = "", url: str | None = "", path: str | None = "", **kw: Any):
        super().__init__(file=file or "", url=url or "", path=path or "", **kw)

    @staticmethod
    def fromFileSystem(path: str, **kw):
        return Record(file=path, path=path, **kw)

    @staticmethod
    def fromURL(url: str, **kw):
        return Record(file=url, url=url, **kw)

    def to_onebot(self):
        return {"type": "record", "data": {"file": _file_value(self.file, self.url, self.path)}}


class Video(BaseMessageComponent):
    type = ComponentType.Video

    def __init__(self, file: str = "", path: str | None = "", **kw: Any):
        super().__init__(file=file, path=path or "", **kw)

    @staticmethod
    def fromFileSystem(path: str, **kw):
        return Video(file=path, path=path, **kw)

    @staticmethod
    def fromURL(url: str, **kw):
        return Video(file=url, **kw)

    def to_onebot(self):
        return {"type": "video", "data": {"file": _file_value(self.file, None, self.path)}}


class File(BaseMessageComponent):
    type = ComponentType.File

    def __init__(self, name: str = "", file: str = "", url: str = "", **kw: Any):
        super().__init__(name=name, file=file, url=url, **kw)

    def to_onebot(self):
        return {"type": "__upload", "data": {"file": self.file or self.url, "name": self.name}}


class Face(BaseMessageComponent):
    type = ComponentType.Face

    def __init__(self, id: int | str = 0, **kw: Any):
        super().__init__(id=id, **kw)

    def to_onebot(self):
        return {"type": "face", "data": {"id": str(self.id)}}


class At(BaseMessageComponent):
    type = ComponentType.At

    def __init__(self, qq: int | str = "", name: str = "", **kw: Any):
        super().__init__(qq=qq, name=name, **kw)

    def to_onebot(self):
        return {"type": "at", "data": {"qq": str(self.qq)}}


class AtAll(At):
    type = ComponentType.AtAll

    def __init__(self, **kw: Any):
        super().__init__(qq="all", **kw)


class Reply(BaseMessageComponent):
    type = ComponentType.Reply

    def __init__(self, id: int | str = "", sender_id: int | str = "", chain: list | None = None, **kw: Any):
        super().__init__(id=id, sender_id=sender_id, chain=chain or [], **kw)

    def to_onebot(self):
        return {"type": "reply", "data": {"id": str(self.id)}}


class Poke(BaseMessageComponent):
    type = ComponentType.Poke

    def __init__(self, type: str = "", id: int | str = "", qq: int | str = "", **kw: Any):
        super().__init__(poke_type=type, id=id, qq=qq, **kw)

    def to_onebot(self):
        return {"type": "__poke", "data": {"qq": str(self.qq or self.id)}}


class Node(BaseMessageComponent):
    type = ComponentType.Node

    def __init__(self, content: list | None = None, uin: str | int = "0", name: str = "", **kw: Any):
        super().__init__(content=content or [], uin=uin, name=name, **kw)

    def to_onebot(self):
        return {"type": "node", "data": {"uin": str(self.uin), "name": self.name, "content": [c.to_onebot() for c in self.content if isinstance(c, BaseMessageComponent)]}}


class Nodes(BaseMessageComponent):
    type = ComponentType.Nodes

    def __init__(self, nodes: list | None = None, **kw: Any):
        super().__init__(nodes=nodes or [], **kw)

    def to_onebot(self):
        return {"type": "__forward", "data": {"nodes": [n.to_onebot() for n in self.nodes]}}


class Forward(BaseMessageComponent):
    type = ComponentType.Forward

    def __init__(self, id: str = "", **kw: Any):
        super().__init__(id=id, **kw)

    def to_onebot(self):
        return {"type": "forward", "data": {"id": self.id}}


class Json(BaseMessageComponent):
    type = ComponentType.Json

    def __init__(self, data: Any = "", **kw: Any):
        super().__init__(data=data, **kw)

    def to_onebot(self):
        import json
        return {"type": "json", "data": {"data": self.data if isinstance(self.data, str) else json.dumps(self.data, ensure_ascii=False)}}


class Unknown(BaseMessageComponent):
    type = ComponentType.Unknown

    def __init__(self, text: str = "", **kw: Any):
        super().__init__(text=text, **kw)

    def to_onebot(self):
        return None


def from_onebot(seg: dict) -> BaseMessageComponent:
    t, d = seg.get("type"), seg.get("data") or {}
    if t == "text":
        return Plain(d.get("text", ""))
    if t == "image":
        return Image(file=d.get("file", ""), url=d.get("url", ""), summary=d.get("summary", ""))
    if t == "record":
        return Record(file=d.get("file", ""), url=d.get("url", ""))
    if t == "video":
        return Video(file=d.get("file", ""))
    if t == "file":
        return File(name=d.get("name", ""), file=d.get("file", ""), url=d.get("url", ""))
    if t == "face":
        return Face(id=d.get("id", 0))
    if t == "at":
        return AtAll() if str(d.get("qq")) == "all" else At(qq=d.get("qq", ""), name=d.get("name", ""))
    if t == "reply":
        return Reply(id=d.get("id", ""))
    if t == "poke":
        return Poke()
    if t == "forward":
        return Forward(id=d.get("id", ""))
    if t == "json":
        return Json(data=d.get("data", ""))
    return Unknown(text=f"[{t}]")


ComponentTypes = {
    "plain": Plain, "text": Plain, "image": Image, "record": Record, "video": Video, "file": File, "face": Face,
    "at": At, "reply": Reply, "poke": Poke, "node": Node, "nodes": Nodes, "forward": Forward, "json": Json,
}

__all__ = [
    "ComponentType", "BaseMessageComponent", "Plain", "Image", "Record", "Video", "File", "Face", "At", "AtAll",
    "Reply", "Poke", "Node", "Nodes", "Forward", "Json", "Unknown", "ComponentTypes", "from_onebot",
]
