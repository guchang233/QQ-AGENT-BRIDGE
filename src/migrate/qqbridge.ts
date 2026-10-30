import fs from 'node:fs';
import path from 'node:path';
import type { Bridge } from '../bridge.ts';
import { HOME } from '../config.ts';
import { oneLine } from '../bridge.ts';

/**
 * 从 qq-bridge 一键迁移。只读取 qq-bridge 目录，不修改它；可重复执行（幂等：已存在的不重复导入）。
 *
 * 映射：
 *  config.json   → 会话范围 / 管理员 / DSH 驱动参数 / 发送节奏 / 自定义价目 / 仿真插件参数（socialV2.*）
 *  roles/*.md    → roles/（格式兼容，〔二代〕标签自动处理）
 *  state/current-role.json → 仿真默认人格
 *  state/sessions.json     → 启用仿真的会话
 *  state/social-v2.json    → 各会话唤醒配置、话题/想法/成员印象（→ 记忆）
 *  state/stickers.json     → 表情包备注/理解/标签/使用次数（缺失的按 URL 下载）
 *  state/token-usage.jsonl → Token 用量历史（含基线，避免重复计数）
 *  state/slang.json        → 暂存，供下一期黑话学习使用
 */
export interface MigrateOptions { config: boolean; roles: boolean; social: boolean; stickers: boolean; memory: boolean; usage: boolean; slang: boolean }
export interface MigrateReport { ok: boolean; items: { what: string; detail: string }[]; warnings: string[] }

const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

export function detectQqBridge(dir: string) {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (!has('config.json') && !has('state')) return null;
  const st = (f: string) => path.join(dir, 'state', f);
  const usageLines = has('state/token-usage.jsonl') ? fs.readFileSync(st('token-usage.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
  return {
    dir,
    config: has('config.json'),
    roles: has('roles') ? fs.readdirSync(path.join(dir, 'roles')).filter((f) => f.endsWith('.md') && !/^readme/i.test(f)) : [],
    sessions: Object.keys(readJson(st('sessions.json'))?.sessions ?? {}),
    stickers: (readJson(st('stickers.json')) ?? []).length,
    slang: (readJson(st('slang.json')) ?? []).length,
    usageLines,
    currentRole: readJson(st('current-role.json'))?.role ?? null,
  };
}

/** 猜测 qq-bridge 的位置（本项目同级目录）。 */
export function guessQqBridgeDir(): string {
  for (const d of [...new Set([path.resolve(HOME, '..', 'qq-bridge'), path.resolve(HOME, '..', '..', 'qq-bridge'), path.resolve(process.cwd(), 'qq-bridge'), path.resolve(process.cwd(), '..', 'qq-bridge')])]) if (detectQqBridge(d)) return d;
  return '';
}

export async function migrateQqBridge(bridge: Bridge, dir: string, opt: MigrateOptions): Promise<MigrateReport> {
  const items: MigrateReport['items'] = [];
  const warnings: string[] = [];
  const info = detectQqBridge(dir);
  if (!info) return { ok: false, items, warnings: [`${dir} 看起来不是 qq-bridge 目录（缺少 config.json / state）`] };
  const st = (f: string) => path.join(dir, 'state', f);
  const qb = readJson(path.join(dir, 'config.json')) ?? {};
  const host = bridge.pluginHost;
  const s2 = qb.socialV2 ?? {};

  // ---------------------------------------------------------------- 主配置
  if (opt.config && info.config) {
    const cfg = structuredClone(bridge.config);
    const ids = (a: unknown) => (Array.isArray(a) ? a.map(String) : []);
    const ag = ids(qb.allow?.groups); const ap = ids(qb.allow?.private);
    if (ag.length || ap.length) {
      cfg.access.groups = [...new Set([...cfg.access.groups, ...ag])];
      cfg.access.private = [...new Set([...cfg.access.private, ...ap])];
      if (!qb.allowAllWhenEmpty) cfg.access.mode = 'allowlist';
    }
    cfg.access.denyGroups = [...new Set([...cfg.access.denyGroups, ...ids(qb.deny?.groups)])];
    cfg.access.denyPrivate = [...new Set([...cfg.access.denyPrivate, ...ids(qb.deny?.private)])];
    if (qb.ownerQQ && String(qb.ownerQQ) !== bridge.self?.userId) cfg.owners = [...new Set([...cfg.owners, String(qb.ownerQQ)])];
    else if (qb.ownerQQ) warnings.push(`qq-bridge 的 ownerQQ（${qb.ownerQQ}）就是机器人自己的账号，未导入为管理员；请在设置中填写你自己的 QQ`);
    const d = qb.dsh ?? {};
    Object.assign(cfg.drivers.dsh, {
      baseUrl: d.baseUrl || cfg.drivers.dsh.baseUrl, provider: d.provider || cfg.drivers.dsh.provider, model: d.model || cfg.drivers.dsh.model,
      reasoningEffort: ['off', 'low', 'high', 'max'].includes(d.reasoningEffort) ? d.reasoningEffort : cfg.drivers.dsh.reasoningEffort,
      authToken: d.authToken || '', allowRemote: !!d.allowRemote,
      // 复用 qq-bridge 的 DSH 工作区：会话仍挂在原来的「QQ 聊天」分组下
      workspacePath: qb.sessionCwd ? String(qb.sessionCwd) : path.join(dir, 'state', 'agents'),
      workspaceTitle: qb.workspaceTitle || 'QQ 聊天',
    });
    const send = s2.send ?? {};
    if (send.maxSendPerMinute) cfg.limits.convPerMinute = Number(send.maxSendPerMinute);
    if (send.maxSendPerHour) cfg.limits.sendPerHour = Math.max(cfg.limits.sendPerHour, Number(send.maxSendPerHour));
    if (send.maxMessageChars) cfg.limits.maxMessageChars = Number(send.maxMessageChars);
    if (send.gapBaseMs !== undefined) cfg.limits.gapBaseMs = Number(send.gapBaseMs);
    if (send.gapPerCharMs !== undefined) cfg.limits.gapPerCharMs = Number(send.gapPerCharMs);
    if (send.maxGapMs) cfg.limits.gapMaxMs = Number(send.maxGapMs);
    const models: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(qb.pricing?.models ?? {})) if (v?.off) models[k] = { label: v.label, ...v.off };
    if (Object.keys(models).length) cfg.usage.prices = { ...cfg.usage.prices, models: { ...(cfg.usage.prices as any).models, ...models } };
    bridge.updateConfig(cfg);
    items.push({ what: '主配置', detail: `会话白名单 ${ag.length} 群 / ${ap.length} 私聊，DSH 模型 ${cfg.drivers.dsh.model}，自定义价目 ${Object.keys(models).length} 个` });
  }

  // ---------------------------------------------------------------- 人格卡
  if (opt.roles && info.roles.length) {
    const target = path.join(HOME, 'roles');
    fs.mkdirSync(target, { recursive: true });
    let n = 0; const skipped: string[] = [];
    for (const f of info.roles) {
      const to = path.join(target, f);
      if (fs.existsSync(to)) { skipped.push(f); continue; }
      fs.copyFileSync(path.join(dir, 'roles', f), to); n++;
    }
    items.push({ what: '人格卡', detail: `导入 ${n} 个${skipped.length ? `，已存在跳过：${skipped.join('、')}` : ''}` });
  }

  // ---------------------------------------------------------------- 仿真参数与会话
  if (opt.social && host?.plugins.has('social')) {
    const w = s2.wake ?? {};
    const p = s2.proactive ?? {};
    const ctx = s2.context ?? {};
    const cur = host.plugins.get('social')!.config;
    const patch: Record<string, unknown> = {
      convs: [...new Set([...(cur.convs ?? []), ...info.sessions])],
      ...(info.currentRole ? { defaultRole: info.currentRole } : {}),
      ...(qb.role?.maxInjectChars ? { roleMaxChars: Math.min(20000, Math.max(1000, Number(qb.role.maxInjectChars))) } : {}),
      ...(w.defaultMode ? { defaultMode: w.defaultMode === 'active' ? 'active' : 'diving' } : {}),
      ...(Array.isArray(w.recommendedKeywords) ? { keywords: w.recommendedKeywords } : {}),
      ...(w.recommendedProbability !== undefined ? { probability: Number(w.recommendedProbability) } : {}),
      ...(w.recommendedAtMention !== undefined ? { atMention: !!w.recommendedAtMention } : {}),
      ...(w.recommendedNameMention !== undefined ? { nameMention: !!w.recommendedNameMention } : {}),
      ...(w.recommendedQuestion !== undefined ? { question: !!w.recommendedQuestion } : {}),
      ...(w.recommendedPoke !== undefined ? { poke: !!w.recommendedPoke } : {}),
      ...(w.batchWindowMs ? { batchWindowSec: Math.round(Number(w.batchWindowMs) / 1000) } : {}),
      ...(w.maxWakePerMinute ? { maxWakePerMinute: Number(w.maxWakePerMinute) } : {}),
      ...(w.maxWakePerHour ? { maxWakePerHour: Number(w.maxWakePerHour) } : {}),
      ...(w.noActionLimit ? { noActionLimit: Number(w.noActionLimit) } : {}),
      ...(w.recommendedSleepMinMs ? { sleepMinMinutes: Math.round(Number(w.recommendedSleepMinMs) / 60_000) } : {}),
      ...(w.recommendedSleepMaxMs ? { sleepMaxMinutes: Math.round(Number(w.recommendedSleepMaxMs) / 60_000) } : {}),
      ...(s2.autoReplyCheckMs ? { replyCheckSec: Math.round(Number(s2.autoReplyCheckMs) / 1000) } : {}),
      ...(p.enabled !== undefined ? { proactive: !!p.enabled } : {}),
      ...(p.idleThresholdMs ? { proactiveIdleMinutes: Math.round(Number(p.idleThresholdMs) / 60_000) } : {}),
      ...(p.checkIntervalMinMs && p.checkIntervalMaxMs ? { proactiveCheckMinutes: Math.round((Number(p.checkIntervalMinMs) + Number(p.checkIntervalMaxMs)) / 2 / 60_000) } : {}),
      ...(p.probability !== undefined ? { proactiveProbability: Number(p.probability) } : {}),
      ...(ctx.wakeMessageLimit ? { wakeMessageLimit: Number(ctx.wakeMessageLimit) } : {}),
      ...(ctx.wakeMaxChars ? { wakeMaxChars: Number(ctx.wakeMaxChars) } : {}),
    };
    // 各会话的唤醒状态（Agent 自己设置过的配置）
    const convs = readJson(st('social-v2.json'))?.conversations ?? {};
    let states = 0;
    for (const [conv, v] of Object.entries<any>(convs)) {
      const wc = v?.wakeConfig;
      if (!wc) continue;
      const t = wc.triggers ?? {};
      const sleeping = wc.sleepUntil && wc.sleepUntil > Date.now();
      bridge.store.kvSet('plugin:social', `state:${conv}`, {
        conv, mode: t.anyMessage ? 'active' : sleeping ? 'sleeping' : 'diving', sleepUntil: sleeping ? wc.sleepUntil : 0,
        triggers: { atMention: t.atMention !== false, nameMention: t.nameMention !== false, question: t.question !== false, poke: t.poke !== false,
          keywords: Array.isArray(t.keywords) ? t.keywords : [], speakerIds: (t.speakerIds ?? []).map(String), probability: Number(t.probability ?? 0.05) },
        confirmedBy: wc.confirmedBy === 'default' ? 'default' : 'agent',
        lastAiSendAt: v.lastAiReplyAt ?? 0, lastIncomingAt: v.lastIncomingAt ?? 0, wakeTimes: [], noActionCount: 0, roleVersion: '', wakes: 0, lastReason: '', pending: null,
        replyCheckAt: 0, proactiveAt: 0, lastWakeAt: 0,
      });
      states++;
    }
    host.saveConfig('social', { ...cur, ...patch });
    await host.reload('social').catch((e) => warnings.push(`重载仿真插件失败：${e.message}`));
    items.push({ what: '仿真', detail: `启用会话 ${info.sessions.join('、') || '无'}；唤醒/节奏/主动发言参数已映射；导入 ${states} 个会话的唤醒状态${info.currentRole ? `；默认人格 ${info.currentRole}` : ''}` });
  } else if (opt.social) warnings.push('仿真插件未加载，跳过仿真参数迁移');

  // ---------------------------------------------------------------- 记忆
  if (opt.memory) {
    const memory = host?.services.get('memory') as any;
    if (!memory) warnings.push('记忆插件未启用，跳过记忆迁移');
    else {
      const convs = readJson(st('social-v2.json'))?.conversations ?? {};
      let n = 0;
      for (const [conv, v] of Object.entries<any>(convs)) {
        for (const t of v?.activeTopics ?? []) {
          const text = t.topic ?? t.title ?? t.summary ?? t.content;
          if (text) { await memory.remember({ content: `话题：${text}${t.pendingQuestion ? `（待回答：${t.pendingQuestion}）` : ''}`, scope: conv, kind: 'event', source: 'qq-bridge' }); n++; }
        }
        for (const t of v?.pendingThoughts ?? []) {
          const text = t.thought ?? t.content ?? t.text;
          if (text) { await memory.remember({ content: `想说：${text}${t.motivation ? `（${t.motivation}）` : ''}`, scope: conv, kind: 'note', importance: 2, source: 'qq-bridge' }); n++; }
        }
        const imp = v?.memberImpressions ?? {};
        for (const [target, x] of Object.entries<any>(Array.isArray(imp) ? Object.fromEntries(imp.map((i: any) => [i.target, i])) : imp)) {
          const traits = Array.isArray(x?.traits) ? x.traits.join('、') : x?.traits ?? x?.impression ?? '';
          if (traits) { await memory.remember({ content: `对 ${x?.name ?? target} 的印象：${traits}`, scope: conv, subject: String(x?.target ?? target).replace(/\D/g, '') || undefined, kind: 'relation', importance: 3, source: 'qq-bridge' }); n++; }
        }
      }
      items.push({ what: '记忆', detail: `导入 ${n} 条（话题/想法/成员印象）` });
    }
  }

  // ---------------------------------------------------------------- 表情包
  if (opt.stickers && info.stickers) {
    const list: any[] = readJson(st('stickers.json')) ?? [];
    let updated = 0, added = 0, failed = 0;
    for (const s of list) {
      const emojiId = String(s.resId ?? s.id ?? '');
      const remark = oneLine(s.desc ?? '', 40);
      const note = oneLine([s.localNote, s.usage].filter(Boolean).join('；'), 200);
      const tags = oneLine((s.tags ?? []).join(','), 120);
      const ex = bridge.store.db.prepare("SELECT * FROM stickers WHERE emoji_id <> '' AND (emoji_id = ? OR url = ?)").get(emojiId, s.url ?? '') as any;
      if (ex) {
        bridge.store.updateSticker(ex.id, { remark: ex.remark || remark, note: ex.note || note, tags: ex.tags || tags });
        if (s.useCount > ex.uses) bridge.store.db.prepare('UPDATE stickers SET uses = ? WHERE id = ?').run(Number(s.useCount), ex.id);
        updated++;
      } else if (s.url) {
        try { await bridge.collectSticker(s.url, remark, tags, 'qq', { note, emoji_id: emojiId, url: s.url }); added++; } catch { failed++; }
      }
    }
    items.push({ what: '表情包', detail: `更新 ${updated} 张的备注/理解，新增 ${added} 张${failed ? `，${failed} 张下载失败（链接可能已过期）` : ''}` });
  }

  // ---------------------------------------------------------------- Token 用量
  if (opt.usage && info.usageLines) {
    const lines = fs.readFileSync(st('token-usage.jsonl'), 'utf8').split('\n').filter(Boolean);
    const baseSeq = new Map<string, number>();
    const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
    for (const r of rows) if (r.k === 'base') baseSeq.set(r.sid, Math.max(baseSeq.get(r.sid) ?? 0, Number(r.seq ?? 0)));
    let n = 0;
    for (const r of rows) {
      const b = r.b ?? {};
      const isBase = r.k === 'base';
      if (!isBase && Number(r.seq ?? 0) <= (baseSeq.get(r.sid) ?? -1)) continue; // 已包含在基线里
      if (isBase && !(b.cacheMiss || b.cacheHit || b.output)) continue;
      const ok = bridge.usage.record({
        driver: 'dsh', conv: r.key ?? '', session: r.sid ?? '', turn: isBase ? -1 : Number(r.turn ?? 0), step: isBase ? 0 : Number(r.step ?? 0),
        retry: Number(r.retry ?? 0), seq: Number(r.seq ?? 0), model: r.model ?? '', provider: r.provider ?? '', ts: Number(r.t ?? Date.now()),
        cacheMiss: Number(b.cacheMiss ?? 0), cacheHit: Number(b.cacheHit ?? 0), cacheWrite: Number(b.cacheWrite ?? 0), output: Number(b.output ?? 0), reasoning: Number(b.reasoning ?? 0),
      });
      if (ok) n++;
    }
    items.push({ what: 'Token 用量', detail: `导入 ${n} 条记录（已按当前价目计费）` });
  }

  // ---------------------------------------------------------------- 黑话（下一期使用）
  if (opt.slang && info.slang) {
    const list: any[] = readJson(st('slang.json')) ?? [];
    bridge.store.kvSet('slang', 'imported', list.map((x) => ({ ...x, evidence: undefined })));
    items.push({ what: '黑话', detail: `暂存 ${list.length} 条（黑话学习功能上线后自动启用）` });
  }

  return { ok: true, items, warnings };
}
