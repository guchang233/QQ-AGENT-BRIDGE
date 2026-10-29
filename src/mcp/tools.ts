import fs from 'node:fs';
import { z } from 'zod';
import type { Bridge } from '../bridge.ts';
import type { Caller } from '../policy.ts';
import type { Tier } from '../config.ts';
import { parseConv, convKey, normalizeMessage, type Segment } from '../message/segments.ts';
import { renderSegments, fmtTime, fmtSize } from '../message/render.ts';
import { searchActions, ACTIONS } from '../onebot/catalog.ts';

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { [k: string]: unknown; content: ToolContent[]; isError?: boolean }

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** 注册门槛（token 至少拥有此等级才会看到该工具） */
  tier: Tier;
  /** 实际执行等级（可按参数动态决定，如通用动作） */
  runTier?: (args: any) => Tier;
  input: z.ZodRawShape;
  readOnly?: boolean;
  /** 已自行鉴权/审计（如 send、callAction），外层不再包一层 invoke */
  selfAudited?: boolean;
  handler: (ctx: { bridge: Bridge; caller: Caller }, args: any) => Promise<ToolResult | string | object>;
}

const conv = z.string().describe('会话 ID：group:<群号> 或 private:<QQ号>');
const msgId = z.union([z.string(), z.number()]).transform(String).describe('消息 ID（消息行开头 # 后的数字）');
const qq = z.union([z.string(), z.number()]).transform(String);
const groupId = qq.describe('群号');

export const DSL_HELP = `消息支持内联标记：[at:QQ号] [at:all] [face:表情名或ID] [image:本地路径|URL|#图片引用] [image:路径|sticker]（以表情形式发图）
[sticker:表情包ID或备注] [record:音频路径] [video:路径] [file:路径|name=文件名] [reply:消息ID] [dice] [rps] [music:qq,歌曲ID] [share:URL|title=标题]
用 \\[ 输出字面方括号。`;

const json = (v: unknown) => JSON.stringify(v, null, 1);

function msgLine(bridge: Bridge, m: Parameters<Bridge['formatLine']>[0]) { return bridge.formatLine(m); }

function groupByConv(bridge: Bridge, ms: Parameters<Bridge['formatLines']>[0]): string {
  const map = new Map<string, typeof ms>();
  for (const m of ms) { const l = map.get(m.conv) ?? []; l.push(m); map.set(m.conv, l); }
  return [...map].map(([c, list]) => `== ${c} ${bridge.convName(c)} ==\n${bridge.formatLines(list)}`).join('\n\n');
}

function findConvOfMessage(bridge: Bridge, id: string): string {
  const m = bridge.store.getMessage(id);
  if (!m) throw new Error(`本地找不到消息 #${id}，请同时提供 conv 参数`);
  return m.conv;
}

async function resolveFaceId(bridge: Bridge, emoji: string): Promise<string> {
  const id = bridge.faces.resolve(emoji);
  if (id !== undefined) return String(id);
  const cp = [...emoji][0]?.codePointAt(0);
  if (cp && cp > 0x2000) return String(cp); // emoji 字符：用 Unicode 码点作为 emoji_id
  throw new Error(`未知表情「${emoji}」，可用 qq_search_face 查询`);
}

export function buildTools(): ToolDef[] {
  const T: ToolDef[] = [];
  const add = (t: ToolDef) => T.push(t);

  // ------------------------------------------------------------------ 状态与会话
  add({
    name: 'qq_status', title: 'QQ 桥接状态', tier: 'read', readOnly: true,
    description: '查看连接状态、登录账号、未读概况和当前权限。开始工作前先调用一次。',
    input: {},
    handler: async ({ bridge, caller }) => {
      const s = bridge.status();
      const convs = bridge.store.conversations().filter((c) => c.unread > 0);
      return [
        `连接：${s.connection}${s.lastError ? `（${s.lastError}）` : ''}  账号：${s.self ? `${s.self.nickname}(${s.self.userId})` : '未知'}`,
        `群 ${s.groups} 个，好友 ${s.friends} 个；只读模式：${s.readOnly ? '是' : '否'}`,
        `你的身份：${caller.name}，权限：${caller.token?.tiers.join(',') ?? '全部'}`,
        `未读：${convs.length ? convs.slice(0, 15).map((c) => `${c.conv}(${c.name || '?'}) ${c.unread}条${c.mentions ? `/@我${c.mentions}` : ''}`).join('；') : '无'}`,
        `提示：用 qq_wait_messages 等待新消息，qq_send 发消息。会话 ID 形如 group:123 / private:456。`,
      ].join('\n');
    },
  });

  add({
    name: 'qq_list_conversations', title: '会话列表', tier: 'read', readOnly: true,
    description: '列出最近会话（群聊/私聊），含未读数与最后一条消息。',
    input: { limit: z.number().int().min(1).max(200).default(30), unreadOnly: z.boolean().default(false) },
    handler: async ({ bridge }, a) => {
      const list = bridge.store.conversations().filter((c) => (!a.unreadOnly || c.unread > 0) && bridge.policy.convAllowed(parseConv(c.conv))).slice(0, a.limit);
      if (!list.length) return '暂无会话';
      return list.map((c) => `${c.conv} ${c.name || bridge.convName(c.conv)}｜未读${c.unread}${c.mentions ? `(@我${c.mentions})` : ''}｜${c.lastTs ? fmtTime(c.lastTs) : '-'} ${c.lastSender ? `${c.lastSender}: ` : ''}${c.lastText.slice(0, 60)}`).join('\n');
    },
  });

  add({
    name: 'qq_get_unread', title: '获取未读消息', tier: 'read', readOnly: true,
    description: '获取未读消息（可限定会话），默认读取后标记为已读。',
    input: { conv: conv.optional(), limit: z.number().int().min(1).max(200).default(50), markRead: z.boolean().default(true) },
    handler: async ({ bridge }, a) => {
      const c = a.conv ? convKey(parseConv(a.conv)) : null;
      const ms = bridge.store.unread(c, a.limit).filter((m) => bridge.policy.convAllowed(parseConv(m.conv)));
      if (a.markRead) for (const m of ms) bridge.store.markRead(m.conv, m.seq);
      return ms.length ? groupByConv(bridge, ms) : '没有未读消息';
    },
  });

  add({
    name: 'qq_wait_messages', title: '等待新消息', tier: 'read', readOnly: true,
    description: '阻塞等待新消息到来（长轮询）。有新消息后再等 quietSec 秒无人说话才返回（等对方说完），最长等待 timeoutSec 秒。适合"潜水/值守"循环：wait → 判断 → 回复 → wait。',
    input: {
      conv: conv.optional().describe('只等某个会话；不填则等所有允许的会话'),
      timeoutSec: z.number().min(1).max(1800).default(120),
      quietSec: z.number().min(0).max(120).default(4),
      mentionOnly: z.boolean().default(false).describe('只在 @我、回复我、私聊、戳我 时返回'),
      markRead: z.boolean().default(true),
    },
    handler: async ({ bridge }, a) => {
      const ms = await bridge.waitForMessages({ conv: a.conv, timeoutMs: a.timeoutSec * 1000, quietMs: a.quietSec * 1000, mentionOnly: a.mentionOnly });
      if (a.markRead) for (const m of ms) bridge.store.markRead(m.conv, m.seq);
      return ms.length ? `收到 ${ms.length} 条新消息：\n${groupByConv(bridge, ms)}` : `等待 ${a.timeoutSec}s 无新消息`;
    },
  });

  add({
    name: 'qq_get_history', title: '聊天记录', tier: 'read', readOnly: true,
    description: '查看会话最近的聊天记录。本地记录不足时会自动从 QQ 服务器补拉。',
    input: { conv, limit: z.number().int().min(1).max(200).default(30), beforeTs: z.number().optional().describe('翻页：只看此时间戳(毫秒)之前'), fromServer: z.boolean().default(false).describe('强制从服务器拉取') },
    handler: async ({ bridge, caller }, a) => {
      const c = parseConv(a.conv);
      bridge.policy.assertConv(caller, c);
      let ms = bridge.store.recent(convKey(c), a.limit, a.beforeTs);
      if (a.fromServer || (ms.length < Math.min(a.limit, 10) && !a.beforeTs)) {
        try { await bridge.backfill(a.conv, Math.max(a.limit, 20)); } catch (e: any) { if (!ms.length) throw e; }
        ms = bridge.store.recent(convKey(c), a.limit, a.beforeTs);
      }
      return ms.length ? `${convKey(c)} ${bridge.convName(convKey(c))} 最近 ${ms.length} 条：\n${bridge.formatLines(ms)}` : '没有记录';
    },
  });

  add({
    name: 'qq_search_messages', title: '搜索聊天记录', tier: 'read', readOnly: true,
    description: '在本地已收录的聊天记录中按关键词搜索。',
    input: { query: z.string().min(1), conv: conv.optional(), limit: z.number().int().min(1).max(200).default(30) },
    handler: async ({ bridge }, a) => {
      const ms = bridge.store.search(a.query, a.conv ? convKey(parseConv(a.conv)) : undefined, a.limit).filter((m) => bridge.policy.convAllowed(parseConv(m.conv)));
      return ms.length ? groupByConv(bridge, ms) : '无匹配';
    },
  });

  add({
    name: 'qq_get_message', title: '消息详情', tier: 'read', readOnly: true,
    description: '查看单条消息的详细内容（含原始消息段），可展开被回复的消息。',
    input: { messageId: msgId },
    handler: async ({ bridge }, a) => {
      let m = bridge.store.getMessage(a.messageId);
      if (!m) {
        const r: any = await bridge.bot.call('get_msg', { message_id: Number(a.messageId) });
        m = (await bridge.ingestMessage({ ...r, post_type: 'message' }, true)) ?? bridge.store.getMessage(a.messageId);
      }
      if (!m) return '找不到该消息';
      const out = [msgLine(bridge, m), `会话：${m.conv}`, `消息段：${json(m.segments)}`];
      const reply = m.segments.find((s) => s.type === 'reply');
      if (reply) { const r = bridge.store.getMessage(String(reply.data.id)); if (r) out.push(`被回复的消息：${msgLine(bridge, r)}`); }
      return out.join('\n');
    },
  });

  add({
    name: 'qq_mark_read', title: '标记已读', tier: 'read',
    description: '把会话（或全部会话）标记为已读。',
    input: { conv: conv.optional().describe('不填 = 全部') },
    handler: async ({ bridge }, a) => {
      if (a.conv) bridge.store.markRead(convKey(parseConv(a.conv))); else bridge.store.markAllRead();
      return '已标记为已读';
    },
  });

  // ------------------------------------------------------------------ 发送
  add({
    name: 'qq_send', title: '发送消息', tier: 'send', selfAudited: true,
    description: `向群或好友发送一条消息。\n${DSL_HELP}\n需要分多条发送时用 qq_send_burst。`,
    input: {
      conv, message: z.string().min(1).describe('消息内容（支持内联标记）'),
      replyTo: msgId.optional().describe('回复某条消息'),
      atUser: qq.optional().describe('在开头 @ 某人（仅群聊）'),
    },
    handler: async ({ bridge, caller }, a) => {
      const r = await bridge.send(caller, a.conv, a.message, { replyTo: a.replyTo, atSender: a.atUser });
      return `已发送到 ${r.conv}，消息 ID：${r.messageIds.join(', ')}`;
    },
  });

  add({
    name: 'qq_send_burst', title: '分条发送', tier: 'send', selfAudited: true,
    description: '像真人一样把多句话分成多条依次发送，条间自动按字数插入打字延迟。每条支持内联标记。',
    input: { conv, messages: z.array(z.string().min(1)).min(1).max(10), replyTo: msgId.optional().describe('第一条回复某消息') },
    handler: async ({ bridge, caller }, a) => {
      const r = await bridge.send(caller, a.conv, a.messages.join('\n---\n'), { burst: true, replyTo: a.replyTo });
      return `已分 ${r.parts} 条发送到 ${r.conv}，消息 ID：${r.messageIds.join(', ')}`;
    },
  });

  add({
    name: 'qq_reply', title: '回复消息', tier: 'send', selfAudited: true,
    description: '引用回复某条消息（自动定位会话）。',
    input: { messageId: msgId, message: z.string().min(1), at: z.boolean().default(false).describe('群聊中同时 @ 对方') },
    handler: async ({ bridge, caller }, a) => {
      const m = bridge.store.getMessage(a.messageId);
      if (!m) throw new Error(`本地找不到消息 #${a.messageId}，请改用 qq_send 并传 conv + replyTo`);
      const r = await bridge.send(caller, m.conv, a.message, { replyTo: a.messageId, atSender: a.at ? m.senderId : undefined });
      return `已回复，消息 ID：${r.messageIds.join(', ')}`;
    },
  });

  add({
    name: 'qq_send_forward', title: '发送合并转发', tier: 'send',
    description: '发送一条合并转发消息（聊天记录卡片），可以伪造多条节点，每个节点可指定显示的昵称与 QQ。',
    input: {
      conv,
      nodes: z.array(z.object({ name: z.string().default('匿名'), userId: qq.optional(), content: z.string().min(1).describe('支持内联标记'), messageId: msgId.optional().describe('改为引用已有消息') })).min(1).max(100),
    },
    handler: async ({ bridge, caller }, a) => {
      const c = parseConv(a.conv);
      bridge.policy.assertConv(caller, c);
      const nodes: Segment[] = [];
      for (const n of a.nodes) {
        if (n.messageId) { nodes.push({ type: 'node', data: { id: n.messageId } }); continue; }
        const { segments } = await bridge.buildSegments(n.content);
        nodes.push({ type: 'node', data: { name: n.name, uin: n.userId ?? bridge.self?.userId ?? '10000', user_id: n.userId ?? bridge.self?.userId, nickname: n.name, content: segments } });
      }
      const r: any = c.type === 'group'
        ? await bridge.bot.call('send_group_forward_msg', { group_id: Number(c.id), messages: nodes })
        : await bridge.bot.call('send_private_forward_msg', { user_id: Number(c.id), messages: nodes });
      return `已发送合并转发，消息 ID：${r?.message_id ?? '?'}${r?.forward_id ? `，转发 ID：${r.forward_id}` : ''}`;
    },
  });

  add({
    name: 'qq_get_forward', title: '查看合并转发', tier: 'read', readOnly: true,
    description: '展开合并转发消息内容（[合并转发#ID] 中的 ID）。',
    input: { id: z.string() },
    handler: async ({ bridge }, a) => {
      const r: any = await bridge.bot.call('get_forward_msg', { id: a.id, message_id: a.id });
      const list: any[] = r?.messages ?? r?.message ?? (Array.isArray(r) ? r : []);
      if (!list.length) return '合并转发为空或已过期';
      return list.map((n: any, i: number) => {
        const d = n.data ?? n;
        const segs = normalizeMessage(d.content ?? d.message ?? []);
        const name = d.nickname ?? d.name ?? d.sender?.nickname ?? '?';
        return `${i + 1}. ${name}(${d.user_id ?? d.uin ?? d.sender?.user_id ?? '?'}): ${renderSegments(segs, { faceName: (id) => bridge.faces.nameOf(id) })}`;
      }).join('\n');
    },
  });

  add({
    name: 'qq_recall', title: '撤回消息', tier: 'send',
    description: '撤回消息（自己 2 分钟内的消息；作为群管理员可撤回他人消息）。',
    input: { messageId: msgId },
    handler: async ({ bridge }, a) => {
      await bridge.bot.call('delete_msg', { message_id: Number(a.messageId) });
      const m = bridge.store.getMessage(a.messageId);
      if (m) bridge.store.markRecalled(m.conv, a.messageId);
      return `已撤回 #${a.messageId}`;
    },
  });

  add({
    name: 'qq_forward_message', title: '转发单条消息', tier: 'send',
    description: '把一条已有消息原样转发到另一个会话。',
    input: { messageId: msgId, to: conv },
    handler: async ({ bridge, caller }, a) => {
      const c = parseConv(a.to);
      bridge.policy.assertConv(caller, c);
      await bridge.bot.call(c.type === 'group' ? 'forward_group_single_msg' : 'forward_friend_single_msg', c.type === 'group' ? { message_id: Number(a.messageId), group_id: Number(c.id) } : { message_id: Number(a.messageId), user_id: Number(c.id) });
      return `已转发到 ${convKey(c)}`;
    },
  });

  add({
    name: 'qq_set_typing', title: '显示"正在输入"', tier: 'send',
    description: '在私聊中向对方显示"对方正在输入…"。',
    input: { userId: qq },
    handler: async ({ bridge }, a) => { await bridge.bot.call('set_input_status', { user_id: Number(a.userId), event_type: 1 }); return '已设置'; },
  });

  // ------------------------------------------------------------------ 联系人
  add({
    name: 'qq_list_groups', title: '群列表', tier: 'read', readOnly: true,
    description: '列出已加入的群。',
    input: { refresh: z.boolean().default(false), query: z.string().optional() },
    handler: async ({ bridge }, a) => {
      if (a.refresh || !bridge.groups.size) await bridge.refreshContacts();
      const list = [...bridge.groups.values()].filter((g) => !a.query || g.name.includes(a.query) || g.id.includes(a.query));
      return list.map((g) => `group:${g.id} ${g.name}${g.memberCount ? `（${g.memberCount}人）` : ''}${bridge.policy.convAllowed({ type: 'group', id: g.id }) ? '' : ' [未允许]'}`).join('\n') || '无';
    },
  });

  add({
    name: 'qq_list_friends', title: '好友列表', tier: 'read', readOnly: true,
    description: '列出好友。',
    input: { refresh: z.boolean().default(false), query: z.string().optional() },
    handler: async ({ bridge }, a) => {
      if (a.refresh || !bridge.friends.size) await bridge.refreshContacts();
      const list = [...bridge.friends.values()].filter((f) => !a.query || f.nickname.includes(a.query) || f.remark.includes(a.query) || f.id.includes(a.query));
      return list.map((f) => `private:${f.id} ${f.remark ? `${f.remark}（${f.nickname}）` : f.nickname}`).join('\n') || '无';
    },
  });

  add({
    name: 'qq_list_members', title: '群成员', tier: 'read', readOnly: true,
    description: '列出群成员（可按名字/QQ 过滤），含群名片、角色、头衔。',
    input: { groupId, query: z.string().optional(), limit: z.number().int().min(1).max(3000).default(100) },
    handler: async ({ bridge, caller }, a) => {
      bridge.policy.assertConv(caller, { type: 'group', id: a.groupId });
      const list: any[] = await bridge.bot.call('get_group_member_list', { group_id: Number(a.groupId) });
      const role: Record<string, string> = { owner: '群主', admin: '管理员', member: '' };
      for (const m of list) bridge.store.setName(`g:${a.groupId}:${m.user_id}`, m.card || m.nickname);
      const f = list.filter((m) => !a.query || String(m.user_id).includes(a.query) || (m.card ?? '').includes(a.query) || (m.nickname ?? '').includes(a.query));
      return `共 ${list.length} 人${a.query ? `，匹配 ${f.length}` : ''}：\n${f.slice(0, a.limit).map((m) => `${m.user_id} ${m.card || m.nickname}${m.card && m.nickname !== m.card ? `（${m.nickname}）` : ''}${role[m.role] ? ` [${role[m.role]}]` : ''}${m.title ? ` 头衔:${m.title}` : ''}`).join('\n')}`;
    },
  });

  add({
    name: 'qq_get_user', title: '用户资料', tier: 'read', readOnly: true,
    description: '查询 QQ 用户资料；提供 groupId 时同时返回其群成员信息。',
    input: { userId: qq, groupId: groupId.optional() },
    handler: async ({ bridge }, a) => {
      const [info, member] = await Promise.allSettled([
        bridge.bot.call('get_stranger_info', { user_id: Number(a.userId) }),
        a.groupId ? bridge.bot.call('get_group_member_info', { group_id: Number(a.groupId), user_id: Number(a.userId) }) : Promise.resolve(null),
      ]);
      return json({ profile: info.status === 'fulfilled' ? info.value : info.reason?.message, member: member.status === 'fulfilled' ? member.value : member.reason?.message });
    },
  });

  add({
    name: 'qq_get_group', title: '群资料', tier: 'read', readOnly: true,
    description: '查询群信息（名称、人数、群主等）。',
    input: { groupId },
    handler: async ({ bridge }, a) => {
      const [info, detail] = await Promise.allSettled([
        bridge.bot.call('get_group_info', { group_id: Number(a.groupId) }),
        bridge.bot.call('get_group_detail_info', { group_id: Number(a.groupId) }),
      ]);
      return json({ info: info.status === 'fulfilled' ? info.value : undefined, detail: detail.status === 'fulfilled' ? detail.value : undefined });
    },
  });

  // ------------------------------------------------------------------ 媒体
  add({
    name: 'qq_get_image', title: '查看图片', tier: 'read', readOnly: true,
    description: '查看消息中的图片（[图片#xxxx] 里的 xxxx），返回图片内容供你直接观看；也可传 messageId 获取该消息全部图片。',
    input: { ref: z.string().optional().describe('图片引用，如 a1b2c3d4'), messageId: msgId.optional() },
    handler: async ({ bridge }, a) => {
      const refs: string[] = [];
      if (a.ref) refs.push(a.ref.replace(/^#/, ''));
      if (a.messageId) {
        const m = bridge.store.getMessage(a.messageId);
        if (!m) throw new Error('找不到该消息');
        for (const s of m.segments) if (s.type === 'image') refs.push(bridge.media.register(s, m.conv, m.msgId));
      }
      if (!refs.length) throw new Error('需要 ref 或 messageId');
      const content: ToolContent[] = [];
      for (const ref of refs.slice(0, 6)) {
        const r = await bridge.media.fetch(ref);
        if (r.buf.length <= bridge.config.media.maxInlineImageBytes && r.mime.startsWith('image/')) {
          content.push({ type: 'image', data: r.buf.toString('base64'), mimeType: r.mime === 'image/bmp' ? 'image/png' : r.mime });
          content.push({ type: 'text', text: `#${ref} ${r.mime} ${fmtSize(r.buf.length)} 本地：${r.path}` });
        } else content.push({ type: 'text', text: `#${ref} 过大（${fmtSize(r.buf.length)}），本地路径：${r.path}` });
      }
      return { content };
    },
  });

  add({
    name: 'qq_send_image', title: '发送图片', tier: 'send', selfAudited: true,
    description: '发送图片。source 可以是本地路径、URL、base64 或收到过的图片引用（#xxxx）。asSticker=true 时以表情形式（小图）发送。',
    input: { conv, source: z.string(), caption: z.string().optional().describe('附带文字'), asSticker: z.boolean().default(false), replyTo: msgId.optional() },
    handler: async ({ bridge, caller }, a) => {
      const img: Segment = { type: 'image', data: { file: await bridge.media.toOneBotFile(a.source) } };
      if (a.asSticker) Object.assign(img.data, { sub_type: 1, summary: '[动画表情]' });
      const segs: Segment[] = a.caption ? [{ type: 'text', data: { text: a.caption } }, img] : [img];
      const r = await bridge.send(caller, a.conv, segs, { replyTo: a.replyTo });
      return `图片已发送，消息 ID：${r.messageIds.join(', ')}`;
    },
  });

  add({
    name: 'qq_send_voice', title: '发送语音', tier: 'send', selfAudited: true,
    description: '发送语音消息。source 为音频文件路径/URL（mp3/wav/silk/amr 等，由协议端转码）。',
    input: { conv, source: z.string() },
    handler: async ({ bridge, caller }, a) => {
      const r = await bridge.send(caller, a.conv, [{ type: 'record', data: { file: await bridge.media.toOneBotFile(a.source) } }]);
      return `语音已发送，消息 ID：${r.messageIds.join(', ')}`;
    },
  });

  add({
    name: 'qq_send_video', title: '发送视频', tier: 'send', selfAudited: true,
    description: '发送视频消息（mp4）。',
    input: { conv, source: z.string() },
    handler: async ({ bridge, caller }, a) => {
      const r = await bridge.send(caller, a.conv, [{ type: 'video', data: { file: await bridge.media.toOneBotFile(a.source) } }]);
      return `视频已发送，消息 ID：${r.messageIds.join(', ')}`;
    },
  });

  add({
    name: 'qq_send_file', title: '发送文件', tier: 'send',
    description: '上传本地文件到群文件或私聊。',
    input: { conv, path: z.string(), name: z.string().optional(), folderId: z.string().optional().describe('群文件夹 ID') },
    handler: async ({ bridge, caller }, a) => {
      const c = parseConv(a.conv);
      bridge.policy.assertConv(caller, c);
      bridge.policy.checkSendRate(caller, convKey(c));
      await bridge.uploadFile(c, a.path, a.name);
      bridge.policy.recordSend(caller, convKey(c));
      return '文件已上传';
    },
  });

  add({
    name: 'qq_download_media', title: '下载媒体到本地', tier: 'read', readOnly: true,
    description: '把收到的图片/语音/视频/文件（#引用）下载到本地并返回路径；群文件可传 groupId+fileId。',
    input: { ref: z.string().optional(), groupId: groupId.optional(), fileId: z.string().optional() },
    handler: async ({ bridge }, a) => {
      if (a.ref) {
        const row = bridge.media.get(a.ref);
        if (row?.kind === 'file' && !row.url) {
          const m = bridge.store.getMessage(row.msg_id, row.conv);
          const seg = m?.segments.find((s) => s.type === 'file');
          const c = parseConv(row.conv);
          const r: any = c.type === 'group'
            ? await bridge.bot.call('get_group_file_url', { group_id: Number(c.id), file_id: seg?.data.file_id ?? row.file_id, busid: seg?.data.busid })
            : await bridge.bot.call('get_private_file_url', { user_id: Number(c.id), file_id: seg?.data.file_id ?? row.file_id, file_hash: seg?.data.file_hash });
          if (r?.url) bridge.store.putMedia({ ref: row.ref, kind: 'file', url: r.url });
        }
        const r = await bridge.media.fetch(a.ref);
        return `已下载：${r.path}（${r.mime}，${fmtSize(r.buf.length)}）`;
      }
      if (a.groupId && a.fileId) {
        const r: any = await bridge.bot.call('get_group_file_url', { group_id: Number(a.groupId), file_id: a.fileId });
        return `下载链接：${r?.url}`;
      }
      throw new Error('需要 ref，或 groupId + fileId');
    },
  });

  add({
    name: 'qq_ocr', title: '图片文字识别', tier: 'read', readOnly: true,
    description: '识别图片中的文字（QQ 自带 OCR）。',
    input: { image: z.string().describe('图片引用 #xxxx 或 URL') },
    handler: async ({ bridge }, a) => {
      let image = a.image;
      const row = bridge.media.get(a.image);
      if (row) image = row.url || row.file;
      const r: any = await bridge.bot.call('ocr_image', { image });
      const texts = r?.texts ?? r;
      return Array.isArray(texts) ? texts.map((t: any) => t.text ?? t).join('\n') : json(r);
    },
  });

  // ------------------------------------------------------------------ 表情
  add({
    name: 'qq_search_face', title: '搜索 QQ 表情', tier: 'read', readOnly: true,
    description: '按名字搜索 QQ 系统小黄脸表情，得到可用于 [face:名字] 的表情。',
    input: { query: z.string().default('') },
    handler: async ({ bridge }, a) => bridge.faces.search(a.query, 60).map((f) => `${f.id}:${f.name}`).join('  ') || '无匹配',
  });

  add({
    name: 'qq_react', title: '表情回应', tier: 'send',
    description: '给消息贴一个表情回应（贴表情）。emoji 可以是 QQ 表情名/ID，或 emoji 字符如 👍。',
    input: { messageId: msgId, emoji: z.string(), remove: z.boolean().default(false) },
    handler: async ({ bridge }, a) => {
      const emojiId = await resolveFaceId(bridge, a.emoji);
      await bridge.bot.call('set_msg_emoji_like', { message_id: Number(a.messageId), emoji_id: emojiId, set: !a.remove });
      return `已${a.remove ? '取消' : ''}回应 ${a.emoji}`;
    },
  });

  add({
    name: 'qq_poke', title: '戳一戳', tier: 'send',
    description: '戳一戳某人（群里或私聊）。',
    input: { conv, userId: qq.optional().describe('群聊中要戳的人；私聊可省略') },
    handler: async ({ bridge, caller }, a) => {
      const c = parseConv(a.conv);
      bridge.policy.assertConv(caller, c);
      bridge.policy.checkSendRate(caller, convKey(c));
      const target = a.userId ?? (c.type === 'private' ? c.id : undefined);
      if (!target) throw new Error('群聊中需要 userId');
      await bridge.bot.call('send_poke', c.type === 'group' ? { group_id: Number(c.id), user_id: Number(target) } : { user_id: Number(target) });
      bridge.policy.recordSend(caller, convKey(c));
      return `已戳 ${target}`;
    },
  });

  // ------------------------------------------------------------------ QQ 空间
  add({
    name: 'qq_qzone_feeds', title: 'QQ空间好友动态', tier: 'read', readOnly: true,
    description: '查看 QQ 空间好友动态（说说流）。',
    input: { count: z.number().int().min(1).max(50).default(10), page: z.number().int().min(1).default(1) },
    handler: async ({ bridge }, a) => json(await bridge.bot.call('get_qzone_feeds', { count: a.count, page_num: a.page })),
  });

  add({
    name: 'qq_qzone_list', title: '某人的说说', tier: 'read', readOnly: true,
    description: '列出某人（默认自己）QQ 空间的说说。',
    input: { userId: qq.optional(), num: z.number().int().min(1).max(40).default(10), pos: z.number().int().min(0).default(0) },
    handler: async ({ bridge }, a) => json(await bridge.bot.call('get_qzone_msg_list', { target_uin: a.userId ? Number(a.userId) : undefined, num: a.num, pos: a.pos })),
  });

  add({
    name: 'qq_qzone_post', title: '发说说', tier: 'send',
    description: '在 QQ 空间发表说说，可带图片（路径/URL/#图片引用）。',
    input: {
      content: z.string().min(1),
      images: z.array(z.string()).max(9).default([]),
      visibility: z.enum(['public', 'friends', 'self']).default('public').describe('public 所有人 / friends 好友 / self 仅自己'),
    },
    handler: async ({ bridge }, a) => {
      const images = [];
      for (const src of a.images) images.push(await bridge.media.toOneBotFile(src));
      const ugc = { public: 1, friends: 4, self: 64 }[a.visibility as 'public'];
      const r: any = await bridge.bot.call('send_qzone_msg', { content: a.content, images, ugc_right: ugc }, 120_000);
      return `说说已发表${r?.tid ? `，tid=${r.tid}` : ''}`;
    },
  });

  add({
    name: 'qq_qzone_like', title: '赞说说', tier: 'send',
    description: '给一条说说点赞或取消赞。',
    input: { tid: z.string(), userId: qq.describe('说说作者 QQ'), abstime: z.number().optional(), unlike: z.boolean().default(false) },
    handler: async ({ bridge }, a) => {
      await bridge.bot.call(a.unlike ? 'unlike_qzone' : 'like_qzone', { tid: a.tid, target_uin: Number(a.userId), abstime: a.abstime });
      return a.unlike ? '已取消赞' : '已点赞';
    },
  });

  add({
    name: 'qq_qzone_comment', title: '评论说说', tier: 'send',
    description: '评论一条说说，可带图。',
    input: { tid: z.string(), userId: qq.describe('说说作者 QQ'), content: z.string().min(1), images: z.array(z.string()).max(1).default([]) },
    handler: async ({ bridge }, a) => {
      const images = [];
      for (const src of a.images) images.push(await bridge.media.toOneBotFile(src));
      await bridge.bot.call('comment_qzone', { tid: a.tid, target_uin: Number(a.userId), content: a.content, images }, 60_000);
      return '已评论';
    },
  });

  add({
    name: 'qq_qzone_delete', title: '删除说说', tier: 'send',
    description: '删除自己的一条说说。',
    input: { tid: z.string() },
    handler: async ({ bridge }, a) => { await bridge.bot.call('delete_qzone_msg', { tid: a.tid }); return '已删除'; },
  });

  // ------------------------------------------------------------------ 群管理
  const assertG = (bridge: Bridge, caller: Caller, g: string) => bridge.policy.assertConv(caller, { type: 'group', id: g });

  add({
    name: 'qq_group_ban', title: '禁言', tier: 'manage',
    description: '禁言群成员（minutes=0 解除）；userId 省略且 all=true 时为全员禁言开关。',
    input: { groupId, userId: qq.optional(), minutes: z.number().min(0).max(43200).default(10), all: z.boolean().optional().describe('全员禁言：true 开启 / false 关闭') },
    handler: async ({ bridge, caller }, a) => {
      assertG(bridge, caller, a.groupId);
      if (a.all !== undefined) { await bridge.bot.call('set_group_whole_ban', { group_id: Number(a.groupId), enable: a.all }); return `全员禁言已${a.all ? '开启' : '关闭'}`; }
      if (!a.userId) throw new Error('需要 userId');
      await bridge.bot.call('set_group_ban', { group_id: Number(a.groupId), user_id: Number(a.userId), duration: Math.round(a.minutes * 60) });
      return a.minutes ? `已禁言 ${a.userId} ${a.minutes} 分钟` : `已解除 ${a.userId} 的禁言`;
    },
  });

  add({
    name: 'qq_group_kick', title: '踢人', tier: 'danger',
    description: '将成员移出群聊（高危操作，默认需人工审批）。',
    input: { groupId, userId: qq, rejectAddRequest: z.boolean().default(false) },
    handler: async ({ bridge, caller }, a) => {
      assertG(bridge, caller, a.groupId);
      await bridge.bot.call('set_group_kick', { group_id: Number(a.groupId), user_id: Number(a.userId), reject_add_request: a.rejectAddRequest });
      return `已将 ${a.userId} 移出群`;
    },
  });

  add({
    name: 'qq_group_member_set', title: '设置成员名片/头衔/管理员', tier: 'manage',
    description: '修改群成员的群名片、专属头衔（需群主）或管理员身份（需群主）。',
    input: { groupId, userId: qq, card: z.string().optional(), title: z.string().optional(), admin: z.boolean().optional() },
    handler: async ({ bridge, caller }, a) => {
      assertG(bridge, caller, a.groupId);
      const g = Number(a.groupId), u = Number(a.userId); const done: string[] = [];
      if (a.card !== undefined) { await bridge.bot.call('set_group_card', { group_id: g, user_id: u, card: a.card }); done.push('名片'); }
      if (a.title !== undefined) { await bridge.bot.call('set_group_special_title', { group_id: g, user_id: u, special_title: a.title }); done.push('头衔'); }
      if (a.admin !== undefined) { await bridge.bot.call('set_group_admin', { group_id: g, user_id: u, enable: a.admin }); done.push('管理员'); }
      return done.length ? `已设置：${done.join('、')}` : '未指定要修改的项';
    },
  });

  add({
    name: 'qq_group_settings', title: '群设置', tier: 'manage',
    description: '修改群名、群头像（图片来源）、群备注。',
    input: { groupId, name: z.string().optional(), avatar: z.string().optional(), remark: z.string().optional() },
    handler: async ({ bridge, caller }, a) => {
      assertG(bridge, caller, a.groupId);
      const g = Number(a.groupId); const done: string[] = [];
      if (a.name) { await bridge.bot.call('set_group_name', { group_id: g, group_name: a.name }); done.push('群名'); }
      if (a.avatar) { await bridge.bot.call('set_group_portrait', { group_id: g, file: await bridge.media.toOneBotFile(a.avatar) }); done.push('群头像'); }
      if (a.remark !== undefined) { await bridge.bot.call('set_group_remark', { group_id: g, remark: a.remark }); done.push('群备注'); }
      return done.length ? `已修改：${done.join('、')}` : '未指定要修改的项';
    },
  });

  add({
    name: 'qq_group_essence', title: '精华消息', tier: 'read',
    runTier: (a) => (a.action === 'list' ? 'read' : 'manage'),
    description: '精华消息：list 列出 / set 设为精华 / remove 移除。',
    input: { action: z.enum(['list', 'set', 'remove']), groupId: groupId.optional(), messageId: msgId.optional() },
    handler: async ({ bridge, caller }, a) => {
      if (a.action === 'list') {
        if (!a.groupId) throw new Error('需要 groupId');
        assertG(bridge, caller, a.groupId);
        const r: any[] = await bridge.bot.call('get_essence_msg_list', { group_id: Number(a.groupId) });
        return (r ?? []).map((e: any) => `#${e.message_id} ${e.sender_nick}(${e.sender_id}): ${renderSegments(normalizeMessage(e.content), { faceName: (id) => bridge.faces.nameOf(id) })}`).join('\n') || '无精华消息';
      }
      if (!a.messageId) throw new Error('需要 messageId');
      await bridge.bot.call(a.action === 'set' ? 'set_essence_msg' : 'delete_essence_msg', { message_id: Number(a.messageId) });
      return a.action === 'set' ? '已设为精华' : '已移除精华';
    },
  });

  add({
    name: 'qq_group_notice', title: '群公告', tier: 'read',
    runTier: (a) => (a.action === 'list' ? 'read' : 'manage'),
    description: '群公告：list 查看 / send 发布（可带图、置顶）/ delete 删除。',
    input: { action: z.enum(['list', 'send', 'delete']), groupId, content: z.string().optional(), image: z.string().optional(), pinned: z.boolean().default(false), noticeId: z.string().optional() },
    handler: async ({ bridge, caller }, a) => {
      assertG(bridge, caller, a.groupId);
      const g = Number(a.groupId);
      if (a.action === 'list') return json(await bridge.bot.call('_get_group_notice', { group_id: g }));
      if (a.action === 'delete') { await bridge.bot.call('_del_group_notice', { group_id: g, notice_id: a.noticeId, fid: a.noticeId }); return '已删除公告'; }
      if (!a.content) throw new Error('需要 content');
      await bridge.bot.call('_send_group_notice', { group_id: g, content: a.content, image: a.image ? await bridge.media.toOneBotFile(a.image) : undefined, pinned: a.pinned ? 1 : 0 });
      return '公告已发布';
    },
  });

  add({
    name: 'qq_group_files', title: '群文件', tier: 'read', readOnly: true,
    description: '浏览群文件（根目录或指定文件夹），返回文件 ID 可用于 qq_download_media。',
    input: { groupId, folderId: z.string().optional() },
    handler: async ({ bridge, caller }, a) => {
      assertG(bridge, caller, a.groupId);
      const r: any = a.folderId
        ? await bridge.bot.call('get_group_files_by_folder', { group_id: Number(a.groupId), folder_id: a.folderId })
        : await bridge.bot.call('get_group_root_files', { group_id: Number(a.groupId) });
      const folders = (r?.folders ?? []).map((f: any) => `📁 ${f.folder_name} (folderId=${f.folder_id}，${f.total_file_count ?? '?'} 个文件)`);
      const files = (r?.files ?? []).map((f: any) => `📄 ${f.file_name} ${fmtSize(Number(f.file_size))} 上传者 ${f.uploader_name ?? f.uploader} (fileId=${f.file_id})`);
      return [...folders, ...files].join('\n') || '空';
    },
  });

  add({
    name: 'qq_requests', title: '好友/加群请求', tier: 'read',
    runTier: (a) => (a.action === 'list' ? 'read' : 'manage'),
    description: '查看并处理收到的好友申请、加群申请/邀请。',
    input: { action: z.enum(['list', 'approve', 'reject']).default('list'), flag: z.string().optional(), reason: z.string().optional(), remark: z.string().optional() },
    handler: async ({ bridge }, a) => {
      if (a.action === 'list') {
        const list = [...bridge.requests.values()];
        return list.map((r) => `flag=${r.flag} ${r.kind === 'friend' ? '好友申请' : r.subType === 'invite' ? '邀请入群' : '加群申请'} 来自 ${r.userId}${r.groupId ? ` 群 ${r.groupId}` : ''}：${r.comment}`).join('\n') || '没有待处理请求';
      }
      const r = a.flag ? bridge.requests.get(a.flag) : undefined;
      if (!r) throw new Error('找不到该请求 flag');
      const approve = a.action === 'approve';
      if (r.kind === 'friend') await bridge.bot.call('set_friend_add_request', { flag: r.flag, approve, remark: a.remark });
      else await bridge.bot.call('set_group_add_request', { flag: r.flag, sub_type: r.subType, type: r.subType, approve, reason: a.reason });
      bridge.requests.delete(r.flag);
      return approve ? '已同意' : '已拒绝';
    },
  });

  // ------------------------------------------------------------------ 个人
  add({
    name: 'qq_profile', title: '个人资料与状态', tier: 'manage',
    description: '修改个性签名、在线状态（online/away/busy/invisible/dnd）、自定义状态文字。',
    input: { signature: z.string().optional(), status: z.enum(['online', 'away', 'busy', 'invisible', 'dnd', 'qme']).optional(), customStatus: z.string().optional().describe('自定义在线状态文字') },
    handler: async ({ bridge }, a) => {
      const done: string[] = [];
      if (a.signature !== undefined) { await bridge.bot.call('set_self_longnick', { longNick: a.signature, long_nick: a.signature }); done.push('签名'); }
      if (a.status) {
        const code = { online: 10, qme: 60, away: 30, busy: 50, dnd: 70, invisible: 40 }[a.status as 'online'];
        await bridge.bot.call('set_online_status', { status: code, ext_status: 0, battery_status: 0 }); done.push('在线状态');
      }
      if (a.customStatus) { await bridge.bot.call('set_diy_online_status', { face_id: 0, wording: a.customStatus }); done.push('自定义状态'); }
      return done.length ? `已修改：${done.join('、')}` : '未指定要修改的项';
    },
  });

  add({
    name: 'qq_set_avatar', title: '修改头像', tier: 'danger',
    description: '修改本账号 QQ 头像（高危，默认需审批）。',
    input: { source: z.string() },
    handler: async ({ bridge }, a) => { await bridge.bot.call('set_qq_avatar', { file: await bridge.media.toOneBotFile(a.source) }); return '头像已修改'; },
  });

  add({
    name: 'qq_send_like', title: '名片点赞', tier: 'send',
    description: '给某人的资料卡点赞。',
    input: { userId: qq, times: z.number().int().min(1).max(20).default(10) },
    handler: async ({ bridge }, a) => { await bridge.bot.call('send_like', { user_id: Number(a.userId), times: a.times }); return `已点赞 ${a.times} 次`; },
  });

  // ------------------------------------------------------------------ 记忆
  // ------------------------------------------------------------------ 通用兜底
  add({
    name: 'qq_list_actions', title: '搜索 OneBot 动作', tier: 'read', readOnly: true,
    description: `搜索协议端支持的全部 ${ACTIONS.length} 个底层动作（含权限等级与参数），配合 qq_call_action 使用以覆盖专用工具之外的功能（群相册、群待办、闪传、AI 语音等）。`,
    input: { query: z.string().default(''), category: z.string().optional() },
    handler: async (_c, a) => {
      const list = searchActions(a.query, a.category, 80);
      return list.map((x) => `${x.name} [${x.tier}/${x.category}] ${x.summary}${x.params.length ? ` 参数:${x.params.join(',')}` : ''}`).join('\n') || '无匹配';
    },
  });

  add({
    name: 'qq_call_action', title: '调用 OneBot 动作', tier: 'read', selfAudited: true,
    description: '直接调用任意 OneBot 动作（受该动作权限等级约束）。先用 qq_list_actions 查参数。',
    input: { action: z.string(), params: z.record(z.string(), z.any()).default({}) },
    handler: async ({ bridge, caller }, a) => json(await bridge.callAction(caller, a.action, a.params)),
  });

  return T;
}
