from astrbot.api.event import filter, AstrMessageEvent, MessageEventResult
from astrbot.api.star import Context, Star, register, StarTools
from astrbot.api import logger, AstrBotConfig
import astrbot.api.message_components as Comp


@register("helloworld", "qab", "AstrBot 示例插件", "1.0.0")
class HelloWorld(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config

    async def initialize(self):
        logger.info(f"helloworld 初始化，数据目录 {StarTools.get_data_dir('helloworld')}")

    @filter.command("hi")
    async def hi(self, event: AstrMessageEvent, name: str = "朋友"):
        """打招呼"""
        for _ in range(self.config.get("times", 1)):
            yield event.plain_result(f"{self.config['greeting']}, {name}! 我是 {event.get_self_id()}")

    @filter.command("add")
    async def add(self, event: AstrMessageEvent, a: int, b: int):
        """加法"""
        yield event.plain_result(f"{a} + {b} = {a + b}")

    @filter.command_group("math")
    def math(self):
        pass

    @math.command("mul")
    async def mul(self, event: AstrMessageEvent, a: int, b: int):
        yield event.plain_result(str(a * b))

    @filter.regex(r"^ping$")
    async def ping(self, event: AstrMessageEvent):
        chain = [Comp.At(qq=event.get_sender_id()), Comp.Plain(" pong"), Comp.Face(id=14)]
        yield event.chain_result(chain)
        event.stop_event()

    @filter.event_message_type(filter.EventMessageType.PRIVATE_MESSAGE)
    async def on_private(self, event: AstrMessageEvent):
        if event.message_str == "群信息":
            info = await event.bot.api.call_action("get_group_list")
            await event.send(event.plain_result(f"我加了 {len(info)} 个群"))

    @filter.llm_tool(name="get_weather")
    async def get_weather(self, event: AstrMessageEvent, location: str):
        """查询天气。

        Args:
            location(string): 城市名
        """
        return f"{location} 今天晴，25 度"
