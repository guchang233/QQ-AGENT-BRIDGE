from astrbot.core.platform.astr_message_event import AstrMessageEvent


class AiocqhttpMessageEvent(AstrMessageEvent):
    """本桥接所有事件都是 aiocqhttp 事件；isinstance 检查恒为真（见 host.py 中的类替换）。"""
