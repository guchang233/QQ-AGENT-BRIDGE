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
      const { DshDriver } = await import('./drivers/dsh/driver.ts');
      bridge.registerDriver(new DshDriver(bridge));
      const plugins = new PluginHost(bridge);
      const { Updater } = await import('./update/index.ts');
      const updater = bridge.updater = new Updater(bridge);
      await startWeb(bridge, plugins);
      await bridge.start();
      for (const d of bridge.drivers.values()) await d.start().catch((e: any) => console.error(`驱动 ${d.label} 启动失败：`, e.message));
      await plugins.loadAll();
      if (bridge.config.plugins.astrbot.enabled) {
        const { AstrBotHost } = await import('./plugins/astrbot.ts');
        await new AstrBotHost(bridge, plugins).start().catch((e: any) => console.error('AstrBot 兼容层启动失败：', e.message));
      }
      if (!bridge.config.server.consolePassword) console.log(`\n首次使用：打开 http://127.0.0.1:${bridge.config.server.port} 完成设置向导\n`);
      const shutdown = async () => { updater.stop(); await bridge.stop(); process.exit(0); };
      updater.on('restart', () => { console.log('更新已下载，正在重启…'); void shutdown(); });
      updater.start();
      if (updater.state.lastUpdate) console.log(`已从 v${updater.state.lastUpdate.from} 更新到 v${updater.state.lastUpdate.to}`);
      if (updater.state.lastFailure) console.warn(`上次更新失败：${updater.state.lastFailure}`);
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
    case 'update': {
      const { loadConfig } = await import('./config.ts');
      const { Bridge } = await import('./bridge.ts');
      const { Updater } = await import('./update/index.ts');
      loadConfig();
      const u = new Updater(new Bridge());
      const st = await u.check().catch((e: any) => { console.error(`检查更新失败：${e.message}`); process.exit(1); });
      console.log(`当前 v${st.current}，最新 v${st.latest}${st.hasUpdate ? '（有新版本）' : '（已是最新）'}`);
      if (st.hasUpdate && rest[0] === 'install') {
        await u.install();
        console.log(`v${st.latest} 已下载，重新启动（qab start / start.bat）即可完成更新`);
      } else if (st.hasUpdate) console.log(st.installType === 'package' ? '运行 qab update install 下载更新' : st.hint);
      process.exit(0);
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
    case 'migrate': {
      const { Bridge } = await import('./bridge.ts');
      const { PluginHost } = await import('./plugins/host.ts');
      const { migrateQqBridge, guessQqBridgeDir } = await import('./migrate/qqbridge.ts');
      if (rest[0] !== 'qq-bridge') { console.error('用法：qab migrate qq-bridge [qq-bridge 目录]（请先停止守护进程）'); process.exit(1); }
      const dir = rest[1] && !rest[1].startsWith('--') ? rest[1] : guessQqBridgeDir();
      if (!dir) { console.error('没找到 qq-bridge 目录，请作为参数传入'); process.exit(1); }
      const bridge = new Bridge();
      const host = new PluginHost(bridge);
      await host.loadAll();
      const r = await migrateQqBridge(bridge, dir, { config: true, roles: true, social: true, stickers: true, memory: true, usage: true, slang: true });
      for (const i of r.items) console.log(`✓ ${i.what}：${i.detail}`);
      for (const w of r.warnings) console.log(`! ${w}`);
      await bridge.stop();
      process.exit(r.ok ? 0 : 1);
    }
    case 'dsh': {
      const { Bridge } = await import('./bridge.ts');
      const { installDsh, uninstallDsh, dshSetupStatus } = await import('./drivers/dsh/setup.ts');
      const bridge = new Bridge();
      if (rest[0] === 'install') { const r = await installDsh(bridge); r.steps.forEach((x) => console.log(`✓ ${x}`)); r.warnings.forEach((x) => console.log(`! ${x}`)); if (r.restartRequired) console.log('请重启 DSH 使配置生效'); }
      else if (rest[0] === 'uninstall') (await uninstallDsh(bridge)).forEach((x) => console.log(`✓ ${x}`));
      else console.log(JSON.stringify(dshSetupStatus(bridge), null, 2));
      await bridge.stop();
      process.exit(0);
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
  qab update [install]    检查 / 下载新版本（发布包安装方式，重启后生效）
  qab token               显示 MCP 接入方式与 token
  qab password <pwd>      重设控制台密码
  qab dsh [install|uninstall]  接入 / 移除 DeepSeek Harness（不带参数显示状态）
  qab migrate qq-bridge [目录]  从 qq-bridge 迁移（人格/配置/表情包/记忆/用量）
  qab plugin new <名称>   从模板创建插件（--template basic|command|agent-tool|service）
  qab plugin install <git地址> [--astrbot]  从 git 仓库安装插件`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
