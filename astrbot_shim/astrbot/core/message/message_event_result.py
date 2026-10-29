from __future__ import annotations

import enum
from dataclasses import dataclass, field

from astrbot.core.message.components import Plain, Image, At, AtAll, BaseMessageComponent


@dataclass
class MessageChain:
    chain: list = field(default_factory=list)
    use_t2i_: bool | None = None

    def message(self, message: str) -> "MessageChain":
        self.chain.append(Plain(message))
        return self

    def at(self, name: str, qq: str | int) -> "MessageChain":
        self.chain.append(At(name=name, qq=qq))
        return self

    def at_all(self) -> "MessageChain":
        self.chain.append(AtAll())
        return self

    def url_image(self, url: str) -> "MessageChain":
        self.chain.append(Image.fromURL(url))
        return self

    def file_image(self, path: str) -> "MessageChain":
        self.chain.append(Image.fromFileSystem(path))
        return self

    def base64_image(self, b64: str) -> "MessageChain":
        self.chain.append(Image.fromBase64(b64))
        return self

    def use_t2i(self, use: bool) -> "MessageChain":
        self.use_t2i_ = use
        return self

    def get_plain_text(self) -> str:
        return " ".join(c.text for c in self.chain if isinstance(c, Plain))

    def squash_plain(self) -> "MessageChain":
        out: list[BaseMessageComponent] = []
        for c in self.chain:
            if isinstance(c, Plain) and out and isinstance(out[-1], Plain):
                out[-1] = Plain(out[-1].text + c.text)
            else:
                out.append(c)
        self.chain = out
        return self


class EventResultType(enum.Enum):
    CONTINUE = enum.auto()
    STOP = enum.auto()


class ResultContentType(enum.Enum):
    LLM_RESULT = enum.auto()
    GENERAL_RESULT = enum.auto()
    STREAMING_RESULT = enum.auto()


@dataclass
class MessageEventResult(MessageChain):
    result_type: EventResultType = EventResultType.CONTINUE
    result_content_type: ResultContentType = ResultContentType.GENERAL_RESULT

    def stop_event(self) -> "MessageEventResult":
        self.result_type = EventResultType.STOP
        return self

    def continue_event(self) -> "MessageEventResult":
        self.result_type = EventResultType.CONTINUE
        return self

    def is_stopped(self) -> bool:
        return self.result_type == EventResultType.STOP

    def set_result_content_type(self, typ: ResultContentType) -> "MessageEventResult":
        self.result_content_type = typ
        return self

    def is_llm_result(self) -> bool:
        return self.result_content_type == ResultContentType.LLM_RESULT


CommandResult = MessageEventResult
