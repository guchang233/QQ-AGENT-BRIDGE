import { z } from 'zod';
import { definePlugin } from '../../src/plugins/api.ts';

export default definePlugin({
  setup(ctx) {
    // 命令：/echo 内容   （被 @ 或私聊时也可以不带前缀）
    ctx.command(['echo', '复述'], async (e) => {
      if (!e.argText) return e.reply('用法：/echo 要复述的话');
      await e.reply(e.argText);
      e.stop();
    }, { desc: '复述一句话' });

    // 命令：/help 列出所有插件命令
    ctx.command(['help', '帮助'], async (e) => {
      const cmds = ctx.listCommands().map((c) => `/${c.names[0]}  ${c.desc}`);
      await e.reply(cmds.length ? `可用命令：\n${cmds.join('\n')}` : '暂无命令');
      e.stop();
    }, { desc: '查看命令列表' });

    // 正则：掷骰子 "roll 2d6"
    ctx.onRegex(/^roll\s+(\d{1,2})d(\d{1,3})$/i, async (e) => {
      const [n, s] = [Number(e.match![1]), Number(e.match![2])];
      const rolls = Array.from({ length: Math.min(n, 20) }, () => 1 + Math.floor(Math.random() * s));
      await e.reply(`🎲 ${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`);
    });

    // 被戳时回戳（每人 60 秒冷却）
    const cd = new Map<string, number>();
    ctx.onNotice('poke', async (ev) => {
      if (String(ev.target_id) !== ctx.qq.selfId) return;
      const who = String(ev.user_id);
      if (Date.now() - (cd.get(who) ?? 0) < 60_000) return;
      cd.set(who, Date.now());
      await ctx.qq.call('send_poke', ev.group_id ? { group_id: ev.group_id, user_id: ev.user_id } : { user_id: ev.user_id });
    });

    // 给 Agent 的工具：会出现在 MCP 工具列表中，名为 example_roll_dice
    ctx.tool({
      name: 'roll_dice',
      description: '掷一个 N 面骰子，返回点数',
      tier: 'read',
      input: { sides: z.number().int().min(2).max(1000).default(6) },
      handler: ({ sides }) => `掷出了 ${1 + Math.floor(Math.random() * sides)} 点（${sides} 面）`,
    });

    ctx.logger.info('示例插件已就绪');
  },
});
