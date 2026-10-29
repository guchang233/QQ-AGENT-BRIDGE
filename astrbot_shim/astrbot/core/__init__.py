import logging
import sys

logger = logging.getLogger("astrbot")
if not logger.handlers:
    _h = logging.StreamHandler(sys.stderr)
    _h.setFormatter(logging.Formatter("%(levelname)s [%(name)s] %(message)s"))
    logger.addHandler(_h)
    logger.setLevel(logging.INFO)

from astrbot.core.config import AstrBotConfig  # noqa: E402

__all__ = ["logger", "AstrBotConfig"]
