import { definePlugin } from '../../sdk.ts';

/** 关键词自动回复。 */
export default definePlugin({
  name: 'keyword-reply',
  displayName: '关键词回复',
  version: '1.0.0',
  description: '消息包含关键词时自动回复',
  defaultEnabled: false,
  config: {
    rules: { type: 'list', default: ['早安=>早上好呀[face:太阳]', '晚安=>晚安，好梦[face:月亮]'], description: '规则：关键词=>回复（回复支持内联标记；关键词以 re: 开头表示正则）' },
    exact: { type: 'bool', default: false, description: '整句完全匹配（否则包含即触发）' },
    cooldownSec: { type: 'int', default: 30, description: '同一会话同一规则的冷却秒数' },
    groupsOnly: { type: 'bool', default: false, description: '仅群聊生效' },
  },
  setup(ctx) {
    const rules = ctx.config.rules
      .map((line) => line.split('=>'))
      .filter((p) => p.length >= 2 && p[0].trim())
      .map(([k, ...v]) => {
        const key = k.trim();
        const re = key.startsWith('re:') ? new RegExp(key.slice(3)) : null;
        return { key, re, reply: v.join('=>').trim() };
      });
    const last = new Map<string, number>();
    ctx.onMessage(async (e) => {
      if (ctx.config.groupsOnly && !e.isGroup) return;
      const t = e.text.trim();
      const hit = rules.find((r) => (r.re ? r.re.test(t) : ctx.config.exact ? t === r.key : t.includes(r.key)));
      if (!hit) return;
      const k = `${e.conv}|${hit.key}`;
      if (Date.now() - (last.get(k) ?? 0) < ctx.config.cooldownSec * 1000) return;
      last.set(k, Date.now());
      await e.send(hit.reply);
    }, { priority: -10 });
  },
});
