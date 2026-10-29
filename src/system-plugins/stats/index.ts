import { definePlugin, z, parseConv, convKey } from '../../sdk.ts';

/** 群聊统计：发言排行、活跃时段、消息类型；可定时发日报。 */
export default definePlugin({
  name: 'stats',
  displayName: '群聊统计',
  version: '1.0.0',
  description: '发言排行、活跃时段、日报（基于本地记录）',
  config: {
    dailyReport: { type: 'bool', default: false, description: '每天定时在群里发日报' },
    reportCron: { type: 'string', default: '0 23 * * *', description: '日报时间（cron）' },
    reportGroups: { type: 'list', default: [], description: '发日报的群号' },
  },
  setup(ctx) {
    function compute(conv: string, sinceMs: number) {
      const key = convKey(parseConv(conv));
      const since = Date.now() - sinceMs;
      const rows = ctx.db.prepare('SELECT sender_id, sender_name, ts, segments, is_self FROM messages WHERE conv = ? AND ts >= ?').all(key, since) as any[];
      const people = new Map<string, { name: string; n: number }>();
      const hours = new Array(24).fill(0);
      const types: Record<string, number> = {};
      for (const r of rows) {
        if (r.is_self) continue;
        const p = people.get(r.sender_id) ?? { name: r.sender_name, n: 0 };
        p.n++; p.name = r.sender_name || p.name; people.set(r.sender_id, p);
        hours[new Date(r.ts).getHours()]++;
        for (const s of JSON.parse(r.segments)) types[s.type] = (types[s.type] ?? 0) + 1;
      }
      const top = [...people].sort((a, b) => b[1].n - a[1].n);
      const peak = hours.indexOf(Math.max(...hours));
      return { total: rows.filter((r) => !r.is_self).length, speakers: people.size, top, hours, peak, types };
    }

    function report(conv: string, sinceMs = 86400_000, title = '今日') {
      const s = compute(conv, sinceMs);
      if (!s.total) return `${title}还没有人说话～`;
      const medal = ['🥇', '🥈', '🥉'];
      const bar = (n: number) => '▇'.repeat(Math.max(1, Math.round((n / Math.max(...s.hours)) * 8)));
      const activeHours = s.hours.map((n, h) => [h, n] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return [
        `📊 ${title}群聊统计：${s.total} 条消息，${s.speakers} 人发言`,
        ...s.top.slice(0, 5).map(([id, p], i) => `${medal[i] ?? `${i + 1}.`} ${p.name}(${id})：${p.n} 条`),
        `🔥 最活跃时段：${activeHours.map(([h, n]) => `${h}点 ${bar(n)} ${n}`).join('  ')}`,
        `🖼 图片 ${s.types.image ?? 0}｜表情 ${(s.types.face ?? 0) + (s.types.mface ?? 0)}｜语音 ${s.types.record ?? 0}`,
      ].join('\n');
    }

    ctx.command(['统计', '日报'], async (e) => {
      const days = Number(e.args[0]) || 1;
      await e.reply(report(e.conv, days * 86400_000, days === 1 ? '今日' : `近 ${days} 天`));
    }, { desc: '群聊统计', usage: '[天数]', scope: 'group' });

    ctx.tool({
      name: 'qq_group_stats', title: '群聊统计', tier: 'read', readOnly: true,
      description: '统计一个会话近 N 天的发言排行、活跃时段与消息类型（基于本地记录）。',
      input: { conv: z.string(), days: z.number().min(0.1).max(90).default(1) },
      handler: ({ conv, days }) => {
        const s = compute(conv, days * 86400_000);
        return JSON.stringify({ total: s.total, speakers: s.speakers, top: s.top.slice(0, 15).map(([id, p]) => ({ id, name: p.name, messages: p.n })), hours: s.hours, peakHour: s.peak, types: s.types });
      },
    });

    if (ctx.config.dailyReport && ctx.config.reportGroups.length) {
      ctx.schedule(ctx.config.reportCron, async () => {
        for (const g of ctx.config.reportGroups) await ctx.qq.send(`group:${g}`, report(`group:${g}`)).catch((e) => ctx.logger.warn(e.message));
      });
    }
    ctx.route('GET', 'report', ({ query }) => compute(query.conv, Number(query.days ?? 1) * 86400_000));
  },
});
