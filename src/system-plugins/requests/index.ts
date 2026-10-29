import { definePlugin } from '../../sdk.ts';

/** 自动处理好友申请 / 加群申请 / 入群邀请（按规则），并通知主人。 */
export default definePlugin({
  name: 'requests',
  displayName: '请求自动处理',
  version: '1.0.0',
  description: '按规则自动同意/拒绝好友申请与加群请求，并私聊通知主人',
  defaultEnabled: false,
  config: {
    friend: { type: 'select', options: ['manual', 'approve', 'reject', 'keyword'], default: 'manual', description: '好友申请：manual 人工 / approve 全部同意 / reject 全部拒绝 / keyword 附言含关键词则同意' },
    friendKeywords: { type: 'list', default: [], description: '好友申请同意关键词' },
    groupJoin: { type: 'select', options: ['manual', 'approve', 'keyword'], default: 'manual', description: '他人申请加入我管理的群' },
    groupJoinKeywords: { type: 'list', default: [], description: '加群申请同意关键词' },
    groupInvite: { type: 'select', options: ['manual', 'owner', 'approve', 'reject'], default: 'owner', description: '被邀请入群：owner 仅主人邀请时同意' },
    notifyOwner: { type: 'bool', default: true, description: '私聊通知主人处理结果' },
  },
  setup(ctx) {
    const c = ctx.config;
    const hasKw = (text: string, kws: string[]) => kws.some((k) => k && text.includes(k));
    ctx.onRequest(async (r) => {
      let decision: boolean | null = null;
      if (r.kind === 'friend') {
        decision = c.friend === 'approve' ? true : c.friend === 'reject' ? false : c.friend === 'keyword' ? (hasKw(r.comment, c.friendKeywords) ? true : null) : null;
      } else if (r.subType === 'invite') {
        decision = c.groupInvite === 'approve' ? true : c.groupInvite === 'reject' ? false : c.groupInvite === 'owner' ? (ctx.bridge.config.owners.includes(r.userId) ? true : null) : null;
      } else {
        decision = c.groupJoin === 'approve' ? true : c.groupJoin === 'keyword' ? (hasKw(r.comment, c.groupJoinKeywords) ? true : null) : null;
      }
      const what = r.kind === 'friend' ? `好友申请 ${r.userId}` : `${r.subType === 'invite' ? '入群邀请' : '加群申请'} ${r.userId} → 群${r.groupId}`;
      if (decision !== null) {
        try {
          if (r.kind === 'friend') await ctx.qq.call('set_friend_add_request', { flag: r.flag, approve: decision });
          else await ctx.qq.call('set_group_add_request', { flag: r.flag, sub_type: r.subType, type: r.subType, approve: decision });
          ctx.bridge.requests.delete(r.flag);
        } catch (e: any) { ctx.logger.warn(`处理 ${what} 失败：${e.message}`); return; }
      }
      if (c.notifyOwner) {
        const msg = `${what}${r.comment ? `（附言：${r.comment}）` : ''}：${decision === null ? '等待人工处理（控制台仪表盘或 qq_requests）' : decision ? '已自动同意' : '已自动拒绝'}`;
        for (const o of ctx.bridge.config.owners) await ctx.qq.send(`private:${o}`, msg).catch(() => {});
      }
    });
  },
});
