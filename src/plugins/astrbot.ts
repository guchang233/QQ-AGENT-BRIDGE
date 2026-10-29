import type { Bridge } from '../bridge.ts';
import type { PluginHost } from './host.ts';

/** AstrBot 插件轻兼容层（阶段 6 实现）。 */
export class AstrBotHost {
  constructor(private bridge: Bridge, private host: PluginHost) {}
  async start() { throw new Error('尚未实现'); }
}
