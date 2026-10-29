from astrbot.core.star.star import register as register_star
from astrbot.core.star import filter as _f

register_command = _f.command
register_regex = _f.regex
register_llm_tool = _f.llm_tool
