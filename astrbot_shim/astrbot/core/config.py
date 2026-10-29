from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class AstrBotConfig(dict):
    """dict 子类：按 _conf_schema.json 填默认值，save_config() 写回文件。"""

    def __init__(self, data: dict | None = None, path: str | Path | None = None, schema: dict | None = None):
        super().__init__(data or {})
        self._path = Path(path) if path else None
        if schema:
            _fill_defaults(self, schema)

    def save_config(self, replace_config: dict | None = None) -> None:
        if replace_config is not None:
            self.clear()
            self.update(replace_config)
        if self._path:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(json.dumps(dict(self), ensure_ascii=False, indent=2), "utf-8")

    def __getattr__(self, item: str) -> Any:
        try:
            return self[item]
        except KeyError as e:
            raise AttributeError(item) from e


_TYPE_DEFAULT = {"string": "", "text": "", "int": 0, "float": 0.0, "bool": False, "list": [], "object": {}, "dict": {}, "template_list": []}


def _fill_defaults(target: dict, schema: dict) -> None:
    for key, spec in schema.items():
        if not isinstance(spec, dict):
            continue
        t = spec.get("type", "string")
        if t == "object" and isinstance(spec.get("items"), dict):
            sub = target.get(key) if isinstance(target.get(key), dict) else {}
            _fill_defaults(sub, spec["items"])
            target[key] = sub
        elif key not in target:
            d = spec.get("default", _TYPE_DEFAULT.get(t, None))
            target[key] = json.loads(json.dumps(d)) if isinstance(d, (dict, list)) else d
