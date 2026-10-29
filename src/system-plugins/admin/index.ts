import { definePlugin } from '../../sdk.ts';

/** 基础管理：帮助菜单、状态、插件开关（主人）、只读开关（主人）。 */
export default definePlugin({
  name: 'admin',
  displayName: '基础管理',
  version: '1.0.0',
  description: '/help 帮助菜单、/状态、主人在 QQ 里管理插件与只读模式',
  config: {
    helpHeader: { type: 'string', default: '可用命令（前缀 / 或 #；群里 @我 时可省略）：', description: '帮助菜单标题' },
  },
  setup(ctx) {
    const host = () => ctx.bridge.pluginHost;

    ctx.command(['help', '帮助', '菜单'], async (e) => {
      const cmds = ctx.listCommands();
      const byPlugin = new Map<string, string[]>();
      for (const c of cmds) {
        const l = byPlugin.get(c.plugin) ?? [];
        l.push(`/${c.names[0]}${c.usage ? ` ${c.usage}` : ''}  ${c.desc}`);
        byPlugin.set(c.plugin, l);
      }
      const list = host()?.list() ?? [];
      const title = (n: string) => list.find((p) => p.name === n)?.displayName ?? n;
      await e.reply(`${ctx.config.helpHeader}\n${[...byPlugin].map(([p, l]) => `【${title(p)}】\n${l.join('\n')}`).join('\n')}`);
    }, { desc: '查看命令列表', priority: 100 });

    ctx.command(['状态', 'status'], async (e) => {
      const s = ctx.bridge.status();
      const st = ctx.store.stats(Date.now() - 86400_000);
      await e.reply(`连接：${s.connection}｜运行 ${Math.round(s.uptimeSec / 60)} 分钟\n24h 收 ${st.recv} / 发 ${st.sent}｜Agent 调用 ${st.toolCalls} 次\n群 ${s.groups} / 好友 ${s.friends}｜只读：${s.readOnly ? '是' : '否'}`);
    }, { desc: '查看运行状态' });

    ctx.command(['插件'], async (e) => {
      const h = host();
      if (!h) return e.reply('插件宿主不可用');
      const [op, name] = e.args;
      if (!op || op === '列表') {
        return e.reply(h.list().map((p) => `${p.loaded ? '🟢' : p.error ? '🔴' : '⚪'} ${p.name}（${p.displayName}）${p.system ? '' : ' [用户]'}`).join('\n'));
      }
      if (!name || !h.plugins.has(name)) return e.reply('用法：/插件 [列表|开|关|重载] <插件名>');
      if (op === '开') await h.setEnabled(name, true);
      else if (op === '关') await h.setEnabled(name, false);
      else if (op === '重载') await h.reload(name);
      else return e.reply('未知操作');
      await e.reply(`已${op} ${name}`);
    }, { desc: '管理插件', usage: '[列表|开|关|重载] <名称>', ownerOnly: true });

    ctx.command(['只读'], async (e) => {
      const cfg = structuredClone(ctx.bridge.config);
      cfg.access.readOnly = e.args[0] ? ['开', 'on', '1', 'true'].includes(e.args[0]) : !cfg.access.readOnly;
      ctx.bridge.updateConfig(cfg);
      await e.reply(`只读模式已${cfg.access.readOnly ? '开启（Agent 不能发消息）' : '关闭'}`);
    }, { desc: '切换 Agent 只读模式', usage: '[开|关]', ownerOnly: true });
  },
});
