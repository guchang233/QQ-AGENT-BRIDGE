import { definePlugin, z, parseConv, convKey } from '../../sdk.ts';
import { MemoryEngine, KINDS, KIND_LABEL, type MemoryView, type MemoryKind } from './engine.ts';

/**
 * 记忆系统：遗忘曲线（可开关）、间隔重复强化、相似记忆合并、全文索引 + 可选向量语义检索。
 * 详见 engine.ts 顶部注释。
 */
export default definePlugin({
  name: 'memory',
  displayName: '记忆',
  version: '1.0.0',
  description: '长期记忆：遗忘曲线、强化、合并去重、全文/语义索引',
  config: {
    forgetting: { type: 'bool', default: true, description: '启用遗忘曲线（关闭后所有记忆永久保持）', group: '遗忘曲线' },
    baseStabilityDays: { type: 'float', default: 3, description: '基础稳定度（天）：重要度 3 的记忆约 12 天后保持率降到 37%', group: '遗忘曲线' },
    growth: { type: 'float', default: 1.5, description: '强化系数：越接近遗忘时被回忆，稳定度增长越多', group: '遗忘曲线' },
    forgetThreshold: { type: 'float', default: 0.05, description: '保持率低于此值视为遗忘（不再参与回忆，定期归档）', group: '遗忘曲线' },
    sweepCron: { type: 'string', default: '30 4 * * *', description: '整理（归档已遗忘记忆）的 cron 时间', group: '遗忘曲线' },
    dedupThreshold: { type: 'float', default: 0.75, description: '相似度高于此值的新记忆合并到旧记忆', group: '检索' },
    wRelevance: { type: 'float', default: 0.6, description: '排序权重：相关度', group: '检索' },
    wRetention: { type: 'float', default: 0.25, description: '排序权重：保持率', group: '检索' },
    wImportance: { type: 'float', default: 0.15, description: '排序权重：重要度', group: '检索' },
    embedEnabled: { type: 'bool', default: false, description: '启用向量语义检索（需 OpenAI 兼容 embeddings 接口）', group: '语义检索' },
    embedBaseUrl: { type: 'string', default: 'https://api.openai.com/v1', group: '语义检索' },
    embedApiKey: { type: 'secret', default: '', group: '语义检索' },
    embedModel: { type: 'string', default: 'text-embedding-3-small', group: '语义检索' },
    membersCanRemember: { type: 'bool', default: false, description: '允许普通群友用 /记住 写入记忆（否则仅主人）', group: '命令' },
  },
  setup(ctx) {
    const c = ctx.config;
    const engine = new MemoryEngine(ctx.db, {
      forgetting: c.forgetting, baseStabilityDays: c.baseStabilityDays, growth: c.growth, forgetThreshold: c.forgetThreshold,
      dedupThreshold: c.dedupThreshold, wRelevance: c.wRelevance, wRetention: c.wRetention, wImportance: c.wImportance,
    });

    // 旧版 qq_memory 键值表迁移（一次性）
    if (!ctx.kv.get('migratedLegacy', false)) {
      try {
        const old = ctx.db.prepare('SELECT * FROM memory').all() as any[];
        for (const r of old) engine.remember({ content: `${r.key}：${r.value}`, scope: r.scope, source: 'legacy' });
        if (old.length) ctx.logger.info(`已迁移 ${old.length} 条旧记忆`);
      } catch { /* 无旧表 */ }
      ctx.kv.set('migratedLegacy', true);
    }

    // ------------------------------------------------------------ 向量
    async function embed(text: string): Promise<Float32Array | null> {
      if (!c.embedEnabled || !c.embedApiKey) return null;
      try {
        const res = await fetch(`${c.embedBaseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST', headers: { authorization: `Bearer ${c.embedApiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: c.embedModel, input: text }), signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j: any = await res.json();
        return Float32Array.from(j.data[0].embedding);
      } catch (e: any) { ctx.logger.warn(`向量化失败：${e.message}`); return null; }
    }

    const fmt = (m: MemoryView) => {
      const bits = [`#${m.id}`, `[${KIND_LABEL[m.kind] ?? m.kind}]`, m.scope !== 'global' ? `@${m.scope}` : '', m.subject ? `关于${m.subject}` : '', m.content,
        m.tags ? `#${m.tags.split(',').join(' #')}` : '', `｜重要${m.importance}`, c.forgetting && !m.pinned ? `保持${Math.round(m.retention * 100)}%` : m.pinned ? '📌' : ''];
      return bits.filter(Boolean).join(' ');
    };

    // ------------------------------------------------------------ 对外服务
    const service = {
      engine,
      async remember(input: Parameters<MemoryEngine['remember']>[0]) {
        const r = engine.remember(input);
        if (!input.embedding && c.embedEnabled) embed(input.content).then((v) => v && engine.setEmbedding(r.id, v)).catch(() => {});
        return r;
      },
      async recall(q: Parameters<MemoryEngine['recall']>[0]) {
        const queryEmbedding = q.query && c.embedEnabled ? await embed(q.query) : null;
        return engine.recall({ ...q, queryEmbedding });
      },
      format: fmt,
    };
    ctx.provide(service);

    if (c.sweepCron && c.forgetting) ctx.schedule(c.sweepCron, () => { const n = engine.sweep(); if (n) ctx.logger.info(`记忆整理：归档 ${n} 条已遗忘记忆`); });

    // ------------------------------------------------------------ Agent 工具
    const scopeDesc = '范围：global（全局）、group:<群号>（某群）、private:<QQ>（某私聊）';
    ctx.tool({
      name: 'qq_memory_remember', title: '记住', tier: 'send',
      description: `写入一条长期记忆。用一句完整的话描述（谁/什么/何时），并标注类型与重要度（1 琐碎 ~ 5 非常重要）。与已有记忆高度相似时会自动合并并强化。${scopeDesc}；subject 为相关人的 QQ。`,
      input: {
        content: z.string().min(2).max(1000),
        scope: z.string().default('global'),
        subject: z.union([z.string(), z.number()]).transform(String).optional().describe('相关人 QQ 号'),
        kind: z.enum(KINDS as [MemoryKind, ...MemoryKind[]]).default('fact').describe('fact 事实 / preference 偏好 / event 事件 / relation 关系 / task 待办 / note 笔记'),
        tags: z.array(z.string()).default([]),
        importance: z.number().int().min(1).max(5).default(3),
        pinned: z.boolean().default(false).describe('钉住：永不遗忘'),
      },
      handler: async (a) => {
        const r = await service.remember({ ...a, source: 'agent' });
        return r.merged ? `已合并到已有记忆 #${r.id} 并强化` : `已记住 #${r.id}`;
      },
    });

    ctx.tool({
      name: 'qq_memory_recall', title: '回忆', tier: 'read', readOnly: true,
      description: '检索记忆（按相关度、保持率、重要度综合排序）。被回忆到的记忆会被强化。不确定时可只给 subject 或 scope 浏览。',
      input: {
        query: z.string().default(''),
        scope: z.string().optional(),
        subject: z.union([z.string(), z.number()]).transform(String).optional(),
        kind: z.enum(KINDS as [MemoryKind, ...MemoryKind[]]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
        includeForgotten: z.boolean().default(false).describe('包括保持率很低（已遗忘）的记忆'),
      },
      handler: async (a) => {
        const list = await service.recall(a);
        return list.length ? `【记忆资料】\n${list.map(fmt).join('\n')}` : '没有相关记忆';
      },
    });

    ctx.tool({
      name: 'qq_memory_context', title: '会话相关记忆', tier: 'read', readOnly: true,
      description: '一次取回与某个会话相关的记忆：该会话范围的记忆 + 最近发言者的个人记忆 + 全局要点。适合开始回复前调用。',
      input: { conv: z.string(), recentSpeakers: z.number().int().min(0).max(20).default(6), limit: z.number().int().min(1).max(50).default(15) },
      handler: async ({ conv, recentSpeakers, limit }) => {
        const key = convKey(parseConv(conv));
        const speakers = [...new Set(ctx.store.recent(key, 40).filter((m) => !m.isSelf).reverse().map((m) => m.senderId))].slice(0, recentSpeakers);
        const seen = new Set<number>(); const out: string[] = [];
        const add = (title: string, list: MemoryView[]) => { const l = list.filter((m) => !seen.has(m.id)); l.forEach((m) => seen.add(m.id)); if (l.length) out.push(`## ${title}\n${l.map(fmt).join('\n')}`); };
        add(`本会话 ${key}`, engine.recall({ scope: key, limit }));
        for (const s of speakers) add(`关于 ${ctx.qq.nameOf(key, s) ?? s}(${s})`, engine.recall({ subject: s, limit: 5 }));
        add('全局', engine.recall({ scope: 'global', limit: 5 }).filter((m) => m.importance >= 4 || m.pinned));
        return out.length ? `【记忆资料，仅供参考】\n${out.join('\n\n')}` : '暂无相关记忆';
      },
    });

    ctx.tool({
      name: 'qq_memory_update', title: '修改记忆', tier: 'send',
      description: '修正一条记忆的内容/标签/重要度/是否钉住；forget=true 归档（遗忘），purge=true 彻底删除。',
      input: {
        id: z.number().int(), content: z.string().optional(), tags: z.array(z.string()).optional(), importance: z.number().int().min(1).max(5).optional(),
        pinned: z.boolean().optional(), forget: z.boolean().default(false), purge: z.boolean().default(false),
      },
      handler: (a) => {
        if (a.purge) return engine.purge(a.id) ? `已删除 #${a.id}` : '不存在';
        if (a.forget) return engine.archive(a.id) ? `已归档 #${a.id}` : '不存在';
        engine.update(a.id, { content: a.content, tags: a.tags?.join(','), importance: a.importance, pinned: a.pinned === undefined ? undefined : a.pinned ? 1 : 0 });
        return `已更新 #${a.id}`;
      },
    });

    ctx.tool({
      name: 'qq_memory_index', title: '记忆索引', tier: 'read', readOnly: true,
      description: '查看记忆库的索引概览：各范围/各人的记忆数量、类型分布、常用标签、即将遗忘的数量。用于决定接下来回忆什么。',
      input: { scope: z.string().optional() },
      handler: ({ scope }) => {
        const o = engine.overview(scope);
        return [
          `共 ${o.total} 条（归档 ${o.archived}，即将遗忘 ${o.fading}）｜遗忘曲线：${c.forgetting ? '开' : '关'}`,
          `按范围：${o.byScope.map((r: any) => `${r.scope}(${r.n})`).join(' ') || '—'}`,
          `按人：${o.bySubject.map((r: any) => `${r.subject}@${r.scope}(${r.n})`).join(' ') || '—'}`,
          `按类型：${o.byKind.map((r: any) => `${KIND_LABEL[r.kind as MemoryKind] ?? r.kind}(${r.n})`).join(' ') || '—'}`,
          `常用标签：${o.tags.map(([t, n]) => `${t}(${n})`).join(' ') || '—'}`,
        ].join('\n');
      },
    });

    // ------------------------------------------------------------ 命令
    ctx.command(['记住'], async (e) => {
      if (!e.isOwner && !c.membersCanRemember) return e.reply('只有主人可以让我记东西哦');
      if (!e.argText) return e.reply('用法：/记住 <内容>');
      const r = await service.remember({ content: e.argText, scope: e.conv, subject: e.senderId, kind: 'note', source: `user:${e.senderId}` });
      await e.reply(r.merged ? `记得的，已加深印象（#${r.id}）` : `好的，记住了（#${r.id}）`);
    }, { desc: '让机器人记住一件事', usage: '<内容>' });

    ctx.command(['回忆'], async (e) => {
      const list = await service.recall({ query: e.argText, scopes: [e.conv, 'global'], limit: 8 });
      await e.reply(list.length ? list.map(fmt).join('\n') : '想不起来了…');
    }, { desc: '检索记忆', usage: '[关键词]' });

    ctx.command(['忘记'], async (e) => {
      const id = Number(e.args[0]);
      if (!id) return e.reply('用法：/忘记 <记忆ID>');
      await e.reply(engine.archive(id) ? `已忘记 #${id}` : '没有这条记忆');
    }, { desc: '归档一条记忆', usage: '<ID>', ownerOnly: true });

    // ------------------------------------------------------------ 控制台接口
    ctx.route('GET', 'list', ({ query }) => engine.list({ scope: query.scope || undefined, subject: query.subject || undefined, q: query.q || undefined, archived: query.archived === '1', limit: Number(query.limit ?? 300) }));
    ctx.route('GET', 'overview', ({ query }) => ({ ...engine.overview(query.scope || undefined), forgetting: c.forgetting }));
    ctx.route('GET', 'recall', async ({ query }) => service.recall({ query: query.q, scope: query.scope || undefined, limit: 30, includeForgotten: true }));
    ctx.route('POST', 'items', async ({ body }) => service.remember({ ...body, source: 'console' }));
    ctx.route('PUT', 'items/:id', ({ params, body }) => { engine.update(Number(params.id), body); return { ok: true }; });
    ctx.route('POST', 'items/:id/archive', ({ params, body }) => ({ ok: engine.archive(Number(params.id), body?.archived !== false) }));
    ctx.route('DELETE', 'items/:id', ({ params }) => ({ ok: engine.purge(Number(params.id)) }));
    ctx.route('POST', 'sweep', () => ({ archived: engine.sweep() }));
    ctx.route('POST', 'rebuild', () => { engine.rebuildIndex(); return { ok: true }; });
  },
});
