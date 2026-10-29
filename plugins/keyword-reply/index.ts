import { definePlugin } from '../../src/plugins/api.ts';

export default definePlugin({
  setup(ctx) {
    const rules = (ctx.config.rules as string[] ?? [])
      .map((line) => line.split('=>'))
      .filter((p) => p.length >= 2 && p[0].trim())
      .map(([k, ...v]) => ({ key: k.trim(), reply: v.join('=>').trim() }));
    const last = new Map<string, number>();

    ctx.onMessage(async (e) => {
      if (ctx.config.groupsOnly && !e.isGroup) return;
      const t = e.text.trim();
      const hit = rules.find((r) => (ctx.config.exact ? t === r.key : t.includes(r.key)));
      if (!hit) return;
      const k = `${e.conv}|${hit.key}`;
      if (Date.now() - (last.get(k) ?? 0) < (ctx.config.cooldownSec ?? 30) * 1000) return;
      last.set(k, Date.now());
      await e.send(hit.reply);
    }, { priority: -10 });
  },
});
