import { definePlugin } from '../../sdk.ts';

/** 刷屏防护：同一人短时间内消息过多或连续重复 → 警告 / 禁言 / 撤回（需机器人是管理员）。 */
export default definePlugin({
  name: 'guard',
  displayName: '刷屏防护',
  version: '1.0.0',
  description: '检测刷屏与重复消息，自动警告、撤回或禁言',
  defaultEnabled: false,
  config: {
    windowSec: { type: 'int', default: 10, description: '统计窗口（秒）' },
    maxMessages: { type: 'int', default: 8, description: '窗口内最多消息数' },
    maxRepeats: { type: 'int', default: 4, description: '连续重复相同内容的上限' },
    action: { type: 'select', options: ['warn', 'recall', 'ban'], default: 'warn', description: '触发后：warn 警告 / recall 撤回 / ban 禁言' },
    banMinutes: { type: 'int', default: 10, description: '禁言时长（分钟）' },
    groups: { type: 'list', default: [], description: '生效的群（留空 = 所有允许的群）' },
    whitelist: { type: 'list', default: [], description: '豁免的 QQ' },
  },
  setup(ctx) {
    const hist = new Map<string, { ts: number[]; last: string; repeat: number; punishedAt: number }>();
    ctx.onMessage(async (e) => {
      if (!e.isGroup || e.isOwner || ctx.config.whitelist.includes(e.senderId)) return;
      if (ctx.config.groups.length && !ctx.config.groups.includes(e.groupId!)) return;
      const key = `${e.conv}|${e.senderId}`;
      const h = hist.get(key) ?? { ts: [], last: '', repeat: 0, punishedAt: 0 };
      const now = Date.now();
      h.ts = h.ts.filter((t) => now - t < ctx.config.windowSec * 1000);
      h.ts.push(now);
      h.repeat = e.rendered === h.last ? h.repeat + 1 : 1;
      h.last = e.rendered;
      hist.set(key, h);
      const flood = h.ts.length > ctx.config.maxMessages;
      const repeat = h.repeat > ctx.config.maxRepeats;
      if (!flood && !repeat) return;
      e.stop(); // 后续插件不再处理刷屏消息
      if (now - h.punishedAt < 60_000) return;
      h.punishedAt = now;
      const why = flood ? '发言过于频繁' : '重复刷屏';
      try {
        if (ctx.config.action === 'ban') {
          await ctx.qq.call('set_group_ban', { group_id: Number(e.groupId), user_id: Number(e.senderId), duration: ctx.config.banMinutes * 60 });
          await e.send(`[at:${e.senderId}] ${why}，禁言 ${ctx.config.banMinutes} 分钟`);
        } else if (ctx.config.action === 'recall') {
          await ctx.qq.call('delete_msg', { message_id: Number(e.msgId) });
          await e.send(`[at:${e.senderId}] ${why}，消息已撤回`);
        } else await e.send(`[at:${e.senderId}] ${why}，请注意哦`);
      } catch (err: any) { ctx.logger.warn(`处置失败（机器人可能不是管理员）：${err.message}`); }
    }, { priority: 1000, scope: 'group' });
    ctx.setInterval(() => { const now = Date.now(); for (const [k, h] of hist) if (now - (h.ts.at(-1) ?? 0) > 600_000) hist.delete(k); }, 300_000);
  },
});
