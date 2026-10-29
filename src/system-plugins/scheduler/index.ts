import { Cron } from 'croner';
import { definePlugin, z, parseConv, convKey } from '../../sdk.ts';

interface Job { id: number; conv: string; message: string; kind: 'once' | 'cron'; at: number; cron: string; mention: string; creator: string; enabled: number; last_run: number; created: number }

/** 解析中文时间："10分钟后" "2小时后" "明天8点" "21:30" "周五 9:00"（简化）。返回毫秒时间戳。 */
export function parseWhen(s: string, now = new Date()): number | null {
  const t = s.trim();
  let m = /^(\d+(?:\.\d+)?)\s*(秒|分钟|分|小时|时|天)后?$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = { 秒: 1e3, 分钟: 6e4, 分: 6e4, 小时: 3.6e6, 时: 3.6e6, 天: 8.64e7 }[m[2] as '秒'];
    return now.getTime() + n * unit;
  }
  m = /^(今天|明天|后天)?\s*(上午|下午|晚上|早上)?\s*(\d{1,2})(?:[:：点](\d{1,2})?)?(?:分)?$/.exec(t);
  if (m) {
    const d = new Date(now);
    d.setDate(d.getDate() + ({ 今天: 0, 明天: 1, 后天: 2 }[m[1] as '今天'] ?? 0));
    let h = Number(m[3]);
    if ((m[2] === '下午' || m[2] === '晚上') && h < 12) h += 12;
    d.setHours(h, Number(m[4] ?? 0), 0, 0);
    if (!m[1] && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const iso = Date.parse(t);
  return Number.isFinite(iso) ? iso : null;
}

export default definePlugin({
  name: 'scheduler',
  displayName: '定时与提醒',
  version: '1.0.0',
  description: '定时消息、提醒、周期任务（Agent 与群友都可使用）',
  config: {
    membersCanUse: { type: 'bool', default: true, description: '允许普通成员使用 /提醒' },
    maxJobsPerUser: { type: 'int', default: 10, description: '每人最多同时存在的提醒数' },
  },
  setup(ctx) {
    ctx.migrate(`CREATE TABLE IF NOT EXISTS sched_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, message TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL DEFAULT 0,
      cron TEXT NOT NULL DEFAULT '', mention TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      last_run INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
    const db = ctx.db;
    const crons = new Map<number, Cron>();
    const caller = { kind: 'plugin' as const, name: 'plugin:scheduler' };

    async function fire(j: Job) {
      const text = `${j.mention ? `[at:${j.mention}] ` : ''}${j.message}`;
      try { await ctx.bridge.send(caller, j.conv, text); } catch (e: any) { ctx.logger.warn(`定时任务 #${j.id} 发送失败：${e.message}`); }
      db.prepare('UPDATE sched_jobs SET last_run = ? WHERE id = ?').run(Date.now(), j.id);
      if (j.kind === 'once') db.prepare('UPDATE sched_jobs SET enabled = 0 WHERE id = ?').run(j.id);
    }

    function arm(j: Job) {
      if (j.kind !== 'cron' || !j.enabled) return;
      crons.get(j.id)?.stop();
      crons.set(j.id, new Cron(j.cron, { protect: true }, () => fire(j)));
    }
    for (const j of db.prepare("SELECT * FROM sched_jobs WHERE enabled = 1 AND kind = 'cron'").all() as unknown as Job[]) arm(j);
    ctx.onUnload(() => { for (const c of crons.values()) c.stop(); });

    // 单次任务：每 10 秒检查一次（守护进程停机期间错过的，在 1 小时内补发）
    ctx.setInterval(() => {
      const now = Date.now();
      for (const j of db.prepare("SELECT * FROM sched_jobs WHERE enabled = 1 AND kind = 'once' AND at <= ?").all(now) as unknown as Job[]) {
        if (now - j.at > 3_600_000) { db.prepare('UPDATE sched_jobs SET enabled = 0 WHERE id = ?').run(j.id); continue; }
        void fire(j);
      }
    }, 10_000);

    function create(p: { conv: string; message: string; at?: number; cron?: string; mention?: string; creator: string }): Job {
      if (p.cron) new Cron(p.cron, { paused: true }).stop(); // 校验表达式
      if (!p.cron && (!p.at || p.at < Date.now() - 1000)) throw new Error('时间无效或已过去');
      const r = db.prepare('INSERT INTO sched_jobs (conv, message, kind, at, cron, mention, creator, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(convKey(parseConv(p.conv)), p.message, p.cron ? 'cron' : 'once', p.at ?? 0, p.cron ?? '', p.mention ?? '', p.creator, Date.now());
      const j = db.prepare('SELECT * FROM sched_jobs WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as Job;
      arm(j);
      return j;
    }
    function cancel(id: number) { crons.get(id)?.stop(); crons.delete(id); return db.prepare('UPDATE sched_jobs SET enabled = 0 WHERE id = ?').run(id).changes > 0; }
    const list = (conv?: string) => (conv
      ? db.prepare('SELECT * FROM sched_jobs WHERE enabled = 1 AND conv = ? ORDER BY id').all(convKey(parseConv(conv)))
      : db.prepare('SELECT * FROM sched_jobs WHERE enabled = 1 ORDER BY id').all()) as unknown as Job[];
    const desc = (j: Job) => `#${j.id} ${j.kind === 'cron' ? `周期[${j.cron}]` : new Date(j.at).toLocaleString('zh-CN', { hour12: false })} → ${j.conv}：${j.message}`;

    // ------------------------------------------------------------ 命令
    ctx.command(['提醒', 'remind'], async (e) => {
      if (!e.isOwner && !ctx.config.membersCanUse) return;
      const m = /^(\S+(?:\s*\d{1,2}[:：点]\d{0,2}分?)?)\s+([\s\S]+)$/.exec(e.argText);
      if (!m) return e.reply('用法：/提醒 10分钟后 喝水　或　/提醒 明天8点 开会');
      const at = parseWhen(m[1]);
      if (!at) return e.reply(`看不懂时间「${m[1]}」，试试：10分钟后 / 2小时后 / 明天8点 / 21:30`);
      const mine = list(e.conv).filter((j) => j.creator === e.senderId).length;
      if (mine >= ctx.config.maxJobsPerUser) return e.reply('你的提醒太多了，先用 /取消提醒 清理一下');
      const j = create({ conv: e.conv, message: `⏰ 提醒：${m[2]}`, at, mention: e.isGroup ? e.senderId : '', creator: e.senderId });
      await e.reply(`好的，会在 ${new Date(at).toLocaleString('zh-CN', { hour12: false })} 提醒你（#${j.id}）`);
    }, { desc: '设置提醒', usage: '<时间> <内容>' });

    ctx.command(['提醒列表'], async (e) => {
      const l = list(e.conv);
      await e.reply(l.length ? l.map(desc).join('\n') : '没有待执行的提醒');
    }, { desc: '查看本会话的提醒' });

    ctx.command(['取消提醒'], async (e) => {
      const id = Number(e.args[0]);
      const j = db.prepare('SELECT * FROM sched_jobs WHERE id = ?').get(id) as Job | undefined;
      if (!j || j.conv !== e.conv) return e.reply('没有这个提醒');
      if (j.creator !== e.senderId && !e.isOwner) return e.reply('只能取消自己设置的提醒');
      cancel(id);
      await e.reply(`已取消 #${id}`);
    }, { desc: '取消提醒', usage: '<ID>' });

    // ------------------------------------------------------------ Agent 工具
    ctx.tool({
      name: 'qq_schedule', title: '定时发送', tier: 'send',
      description: '安排一条定时消息（提醒、早安问候等）。三选一指定时间：at（ISO 时间或"10分钟后/明天8点"）、delayMinutes、cron（周期，如 "0 8 * * *" 每天 8 点）。消息支持内联标记。',
      input: {
        conv: z.string(), message: z.string().min(1),
        at: z.string().optional(), delayMinutes: z.number().positive().optional(), cron: z.string().optional(),
        mentionUser: z.union([z.string(), z.number()]).transform(String).optional().describe('发送时 @ 的人'),
      },
      handler: (a, caller) => {
        caller && ctx.bridge.policy.assertConv(caller, parseConv(a.conv));
        const at = a.delayMinutes ? Date.now() + a.delayMinutes * 60_000 : a.at ? parseWhen(a.at) ?? undefined : undefined;
        if (!a.cron && !at) throw new Error('需要 at / delayMinutes / cron 之一');
        const j = create({ conv: a.conv, message: a.message, at, cron: a.cron, mention: a.mentionUser, creator: `agent:${caller.name}` });
        return `已安排：${desc(j)}`;
      },
    });
    ctx.tool({
      name: 'qq_schedule_list', title: '定时任务列表', tier: 'read', readOnly: true,
      description: '列出待执行的定时消息。', input: { conv: z.string().optional() },
      handler: ({ conv }) => list(conv).map(desc).join('\n') || '没有定时任务',
    });
    ctx.tool({
      name: 'qq_schedule_cancel', title: '取消定时任务', tier: 'send',
      description: '取消一个定时消息。', input: { id: z.number().int() },
      handler: ({ id }) => (cancel(id) ? `已取消 #${id}` : '不存在'),
    });

    ctx.route('GET', 'jobs', () => list());
    ctx.route('DELETE', 'jobs/:id', ({ params }) => ({ ok: cancel(Number(params.id)) }));
    ctx.provide({ create, cancel, list, parseWhen });
  },
});
