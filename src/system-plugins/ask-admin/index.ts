import { definePlugin, z, parseConv, convKey } from '../../sdk.ts';

interface AskRow {
  id: number; ts: number; conv: string; requester: string; requester_name: string; kind: string; content: string; reason: string;
  memory: string; status: string; decided_by: string; decided_ts: number; admin_note: string;
}

/**
 * 请示管理员：Agent 拿不准时（群友要它记住关于自己的事、或做不确定该不该做的事），
 * 私聊管理员请示；管理员在 QQ 里回复「同意 / 拒绝 [编号] [理由]」即可，
 * 结果会写入记忆（如适用）并唤醒原会话的 AI 去告知对方。
 */
export default definePlugin({
  name: 'ask-admin',
  displayName: '请示管理员',
  version: '1.0.0',
  description: 'AI 拿不准时私聊请示管理员；管理员在 QQ 里回复「同意/拒绝」，结果自动写入记忆并通知 AI',
  softDepends: ['memory', 'social'],
  config: {
    maxPendingPerUser: { type: 'int', default: 2, description: '同一个人同时最多几条待处理请示' },
    maxPerConvHour: { type: 'int', default: 5, description: '每个会话每小时最多请示几次' },
    expireHours: { type: 'int', default: 24, description: '多少小时没答复就过期' },
  },
  setup(ctx) {
    const c = new Proxy({} as typeof ctx.config, { get: (_t, k) => (ctx.config as any)[k] });
    const bridge = ctx.bridge;
    const caller = { kind: 'plugin' as const, name: 'plugin:ask-admin' };
    ctx.migrate(`CREATE TABLE IF NOT EXISTS ask_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, conv TEXT NOT NULL, requester TEXT NOT NULL, requester_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL, content TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', memory TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT NOT NULL DEFAULT '', decided_ts INTEGER NOT NULL DEFAULT 0, admin_note TEXT NOT NULL DEFAULT '')`);
    const db = ctx.db;
    const owners = () => bridge.config.owners.map(String);
    const title = () => bridge.config.ownerTitle || '管理员';
    const KIND: Record<string, string> = { memory: '想让我记住', other: '想让我' };
    const get = (id: number) => db.prepare('SELECT * FROM ask_requests WHERE id = ?').get(id) as AskRow | undefined;
    const pending = () => db.prepare("SELECT * FROM ask_requests WHERE status = 'pending' ORDER BY id DESC").all() as unknown as AskRow[];
    const where = (conv: string) => `${conv.startsWith('group:') ? '群' : '私聊'}「${bridge.convName(conv) || conv}」`;

    async function notifyAdmins(text: string) {
      for (const o of owners()) await bridge.send(caller, `private:${o}`, text).catch((e) => ctx.logger.warn(`通知管理员 ${o} 失败：${e.message}`));
    }

    /** 处理答复：写记忆（如适用）→ 通知 AI → 回执给管理员 */
    async function decide(id: number, approve: boolean, by: string, note = '') {
      const r = get(id);
      if (!r) throw new Error(`没有请示 #${id}`);
      if (r.status !== 'pending') throw new Error(`请示 #${id} 已处理（${r.status}）`);
      db.prepare('UPDATE ask_requests SET status = ?, decided_by = ?, decided_ts = ?, admin_note = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', by, Date.now(), note, id);
      let extra = '';
      if (approve && r.kind === 'memory') {
        const memory = ctx.useOptional<any>('memory');
        if (memory) {
          const m = r.memory ? JSON.parse(r.memory) : {};
          // 管理员批准的规则类内容按「管理员规则」保存，普通内容按普通记忆保存
          const ruleLike = /(以后|今后|从现在起|每次)[^。！!？?]{0,12}(你|机器人)|你(必须|一定要|不许|不准|只能)|记住你是|设定|规则|称呼|叫我/.test(r.content);
          const res = ruleLike
            ? memory.engine.remember({ content: `${r.requester_name || r.requester}(${r.requester})：${r.content}`, scope: r.conv, subject: r.requester, kind: 'rule', importance: 5, pinned: true, source: `admin-approved:${by}` })
            : await memory.remember({ content: r.content, scope: r.conv, subject: m.subject ?? r.requester, kind: m.kind ?? 'fact', importance: Math.min(4, m.importance ?? 3), tags: m.tags ?? [], source: `admin-approved:${by}` });
          extra = ruleLike ? `，已作为该会话的${title()}规则 #${res.id} 保存` : `，已写入记忆 #${res.id}`;
        }
      }
      const social = ctx.useOptional<any>('social');
      const text = `${title()}${approve ? '同意' : '拒绝'}了 ${r.requester_name || r.requester}(${r.requester}) 的请求「${r.content}」${note ? `，${title()}说：${note}` : ''}${extra}。请自然地告诉对方结果（不用提"系统通知"这些字眼）。`;
      social?.addNote?.(r.conv, text);
      bridge.activity({ kind: 'info', conv: r.conv, actor: by, title: `请示 #${id} 已${approve ? '同意' : '拒绝'}`, detail: `${r.content}${note ? `（${note}）` : ''}` });
      return `已${approve ? '同意' : '拒绝'}请示 #${id}${extra}，AI 会去告诉对方`;
    }

    // ------------------------------------------------------------ Agent 工具
    ctx.tool({
      name: 'qq_ask_admin', title: '请示管理员', tier: 'send',
      description: '拿不准的事请示管理员：群友要你记住关于他的事（称呼、关系、身份、偏好等）、或要你做你不确定该不该做的事时使用。会私聊管理员，管理员答复后会唤醒你并在【系统通知】里告诉你结果。调用后跟对方说一声"我去问问"即可。日常闲聊、明显该拒绝的事不要请示。',
      input: {
        conv: z.string().describe('请求发生的会话'),
        requester: z.union([z.string(), z.number()]).transform(String).describe('提出请求的人的 QQ'),
        kind: z.enum(['memory', 'other']).describe('memory：想让你记住某事 / other：想让你做某事'),
        content: z.string().min(2).max(300).describe('对方的请求，一句话概括（memory 时写成要记住的那句话）'),
        reason: z.string().max(200).default('').describe('你为什么拿不准'),
        subject: z.union([z.string(), z.number()]).transform(String).optional().describe('memory：这条记忆关于谁（QQ），默认是提出请求的人'),
        importance: z.number().int().min(1).max(5).default(3),
      },
      handler: async (a, who) => {
        const conv = convKey(parseConv(a.conv));
        bridge.policy.assertConv(who, parseConv(conv));
        if (!owners().length) return { content: [{ type: 'text', text: `没有设置${title()}，无法请示。请自己判断。` }], isError: true };
        if (owners().includes(a.requester)) return { content: [{ type: 'text', text: `${a.requester} 就是${title()}，直接按他说的做即可，不需要请示。` }], isError: true };
        const mine = db.prepare("SELECT COUNT(*) n FROM ask_requests WHERE status = 'pending' AND requester = ?").get(a.requester) as any;
        if (Number(mine.n) >= c.maxPendingPerUser) return { content: [{ type: 'text', text: `${a.requester} 已有 ${mine.n} 条请示在等${title()}答复，先别再请示了。` }], isError: true };
        const recent = db.prepare('SELECT COUNT(*) n FROM ask_requests WHERE conv = ? AND ts > ?').get(conv, Date.now() - 3_600_000) as any;
        if (Number(recent.n) >= c.maxPerConvHour) return { content: [{ type: 'text', text: '这个会话本小时请示太多次了，这次请你自己判断。' }], isError: true };
        const name = bridge.nameOf(conv, a.requester) ?? '';
        const r = db.prepare('INSERT INTO ask_requests (ts, conv, requester, requester_name, kind, content, reason, memory) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(Date.now(), conv, a.requester, name, a.kind, a.content, a.reason, JSON.stringify({ subject: a.subject, importance: a.importance }));
        const id = Number(r.lastInsertRowid);
        await notifyAdmins(`【请示 #${id}】${where(conv)} 的 ${name || a.requester}(${a.requester}) ${KIND[a.kind]}：「${a.content}」${a.reason ? `\n（我拿不准：${a.reason}）` : ''}\n回复「同意 ${id}」或「拒绝 ${id} 理由」`);
        bridge.activity({ kind: 'info', conv, actor: 'AI', title: `请示${title()} #${id}`, detail: `${name || a.requester}：${a.content}` });
        return `已私聊请示${title()}（#${id}）。先跟对方说一声你去问问；${title()}答复后会唤醒你。`;
      },
    });

    // ------------------------------------------------------------ 管理员在 QQ 里答复
    const REPLY = /^(同意|批准|可以|行|准了|ok|OK|好的?|拒绝|不行|不同意|驳回|不准|不可以)\s*#?(\d+)?\s*[,，。:：]?\s*([\s\S]*)$/;
    ctx.onMessage(async (e) => {
      if (!e.isOwner || e.isGroup) return;
      const m = REPLY.exec(e.text.trim());
      if (!m) return;
      const list = pending();
      if (!list.length) return;
      const id = m[2] ? Number(m[2]) : list[0].id;
      if (!get(id)) return;
      e.consume(); // 不再唤醒仿真 AI
      const approve = !/拒绝|不行|不同意|驳回|不准|不可以/.test(m[1]);
      try { await e.reply(await decide(id, approve, e.senderId, m[3].trim())); } catch (err: any) { await e.reply(err.message); }
    }, { scope: 'private', priority: 900, ownerOnly: true });

    ctx.command(['请示'], async (e) => {
      const list = pending();
      await e.reply(list.length ? list.map((r) => `#${r.id} ${where(r.conv)} ${r.requester_name || r.requester}：${r.content}`).join('\n') + '\n回复「同意 编号」或「拒绝 编号 理由」' : '没有待处理的请示');
    }, { desc: '查看待处理的请示', ownerOnly: true });

    // 过期
    ctx.setInterval(() => {
      const cutoff = Date.now() - c.expireHours * 3_600_000;
      for (const r of db.prepare("SELECT * FROM ask_requests WHERE status = 'pending' AND ts < ?").all(cutoff) as unknown as AskRow[]) {
        db.prepare("UPDATE ask_requests SET status = 'expired' WHERE id = ?").run(r.id);
        ctx.useOptional<any>('social')?.addNote?.(r.conv, `关于 ${r.requester_name || r.requester} 的请求「${r.content}」，${title()}一直没有答复，已过期。如果对方再提起，就说还没问到结果。`, false);
      }
    }, 10 * 60_000);

    // 控制台
    ctx.route('GET', 'requests', ({ query }) => db.prepare(`SELECT * FROM ask_requests ${query.all ? '' : "WHERE status = 'pending'"} ORDER BY id DESC LIMIT 200`).all());
    ctx.route('POST', 'requests/:id', async ({ params, body }) => ({ message: await decide(Number(params.id), !!body?.approve, 'console', String(body?.note ?? '')) }));
    ctx.provide({ decide, pending });
  },
});
