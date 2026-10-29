// 屏蔽 node:sqlite 的实验特性警告（必须在任何导入 sqlite 的模块之前）
const emitWarning = process.emitWarning;
process.emitWarning = ((w: any, ...rest: any[]) => {
  if (String(typeof w === 'string' ? w : w?.message).includes('SQLite')) return;
  return (emitWarning as any).call(process, w, ...rest);
}) as typeof process.emitWarning;

const [cmd = 'start', ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};

async function main() {
  switch (cmd) {
    case 'start': {
      const { Bridge } = await import('./bridge.ts');
      const { PluginHost } = await import('./plugins/host.ts');
      const { startWeb } = await import('./web/server.ts');
      const { loadConfig, CONFIG_PATH } = await import('./config.ts');
      const { created } = loadConfig();
      if (created) console.log(`已生成默认配置：${CONFIG_PATH}`);
      const bridge = new Bridge();
      const plugins = new PluginHost(bridge);
      await startWeb(bridge, plugins);
      await bridge.start();
      await plugins.loadAll();
      if (bridge.config.plugins.astrbot.enabled) {
        const { AstrBotHost } = await import('./plugins/astrbot.ts');
        await new AstrBotHost(bridge, plugins).start().catch((e: any) => console.error('AstrBot 兼容层启动失败：', e.message));
      }
      if (!bridge.config.server.consolePassword) console.log(`\n首次使用：打开 http://127.0.0.1:${bridge.config.server.port} 完成设置向导\n`);
      const shutdown = async () => { await bridge.stop(); process.exit(0); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'mcp': {
      const { runStdio } = await import('./mcp/stdio.ts');
      await runStdio({ token: flag('token'), url: flag('url'), standalone: flag('standalone') === 'true' });
      break;
    }
    case 'status':
    case 'discover': {
      const { loadConfig } = await import('./config.ts');
      const { discover } = await import('./onebot/discover.ts');
      const { config } = loadConfig();
      const ob = config.onebot;
      const r = await discover({ httpUrl: ob.httpUrl, wsUrl: ob.wsUrl, httpToken: ob.httpToken || ob.accessToken, wsToken: ob.accessToken, snowlumaHome: ob.snowlumaHome });
      console.log(`SnowLuma 目录：${ob.snowlumaHome || '（未找到）'}`);
      console.log(`账号配置：${r.accounts.map((a) => a.uin).join(', ') || '无'}`);
      for (const t of r.tried) console.log(`  ${t.error ? '✗' : '✓'} ${t.source} ${t.url}${t.error ? `  ${t.error}` : ''}`);
      console.log(r.ok ? `已连接：${r.self?.nickname}(${r.self?.user_id})  WS=${r.wsUrl}` : 'OneBot 不可用：请确认 SnowLuma 已启动并登录 QQ');
      process.exit(r.ok ? 0 : 1);
    }
    case 'token': {
      const { loadConfig, ROOT } = await import('./config.ts');
      const { config } = loadConfig();
      const t = config.agents.tokens.find((x) => x.enabled);
      const url = `http://127.0.0.1:${config.server.port}/mcp`;
      console.log(`MCP 地址：${url}\nToken（${t?.name}）：${t?.token}\n`);
      console.log('Claude Code（HTTP，推荐，需先 qab start）：');
      console.log(`  claude mcp add --transport http qq ${url} --header "Authorization: Bearer ${t?.token}"`);
      console.log('Claude Code（stdio，自动连接守护进程或独立运行）：');
      console.log(`  claude mcp add qq -- node "${ROOT.replace(/\\/g, '/')}/bin/qab.mjs" mcp`);
      break;
    }
    case 'password': {
      const { loadConfig, saveConfig } = await import('./config.ts');
      const { config } = loadConfig();
      if (!rest[0] || rest[0].length < 6) { console.error('用法：qab password <新密码（至少 6 位）>'); process.exit(1); }
      config.server.consolePassword = rest[0];
      saveConfig(config);
      console.log('控制台密码已更新（如守护进程正在运行，请重启）');
      break;
    }
    case 'plugin': {
      const { scaffoldPlugin, installPlugin } = await import('./plugins/scaffold.ts');
      if (rest[0] === 'new' && rest[1]) {
        const dir = scaffoldPlugin(rest[1], flag('template') ?? 'basic');
        console.log(`已创建插件：${dir}
守护进程运行中会自动热重载；也可在控制台「插件」页查看。开发文档：docs/plugins.md`);
      } else if (rest[0] === 'install' && rest[1]) {
        const dir = await installPlugin(rest[1], { astrbot: flag('astrbot') === 'true' });
        console.log(`已安装到 ${dir}${flag('astrbot') === 'true' ? '（AstrBot 插件，需开启兼容层）' : '，守护进程会自动加载'}`);
      } else {
        console.error(`用法：
  qab plugin new <名称> [--template basic|command|agent-tool|service]
  qab plugin install <git 仓库地址> [--astrbot]`);
        process.exit(1);
      }
      break;
    }
    default:
      console.log(`QQ-Agent Bridge
用法：
  qab start               启动守护进程（OneBot 连接 + Web 控制台 + MCP HTTP + 插件）
  qab mcp [--standalone]  stdio MCP 服务（默认代理到守护进程，连不上则独立运行）
  qab status              探测 SnowLuma / OneBot 连接
  qab token               显示 MCP 接入方式与 token
  qab password <pwd>      重设控制台密码
  qab plugin new <名称>   从模板创建插件（--template basic|command|agent-tool|service）
  qab plugin install <git地址> [--astrbot]  从 git 仓库安装插件`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
