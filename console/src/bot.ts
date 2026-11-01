import { computed, ref } from 'vue';
import { useDialog, useMessage } from 'naive-ui';
import { api, state } from './api';

export type BotState = 'offline' | 'connecting' | 'sending' | 'thinking' | 'receiving' | 'idle';

/** 机器人当前状态与启动/停止（启动和停止都要确认）。仪表盘和顶栏共用。 */
export function useBot() {
  const dialog = useDialog();
  const msg = useMessage();
  const busy = ref(false);
  const s = computed<any>(() => state.status ?? {});

  const pulse = computed<{ state: BotState; conv: string; convName: string }>(() => {
    if (s.value.pulse) return s.value.pulse;
    // 后端较旧、不返回 pulse 时，按连接状态判断，不能一律显示离线
    const online = s.value.connection === 'open';
    return { state: online ? 'idle' : s.value.running ? 'connecting' : 'offline', conv: '', convName: '' };
  });

  const view = computed(() => {
    const where = pulse.value.convName || pulse.value.conv;
    switch (pulse.value.state) {
      case 'sending': return { label: '消息发送中', sub: where ? `发给 ${where}` : '' };
      case 'thinking': return { label: 'AI 处理中', sub: where ? `正在处理 ${where}` : '' };
      case 'receiving': return { label: '消息接收中', sub: where ? `来自 ${where}` : '' };
      case 'idle': return { label: '空闲', sub: s.value.self ? `${s.value.self.nickname}（${s.value.self.userId}）在线` : '在线，等待消息' };
      case 'connecting': return { label: '连接中', sub: s.value.lastError || `正在连接 ${s.value.endpoint?.ws ?? 'QQ 协议端'}` };
      default: return { label: '离线中', sub: s.value.lastError ? `上次断开：${s.value.lastError}` : '点击启动机器人' };
    }
  });

  async function setBot(action: 'start' | 'stop') {
    busy.value = true;
    try {
      const r = await api(`/api/bot/${action}`, { method: 'POST' });
      state.status = { ...state.status, ...r };
      if (action === 'start' && r.connection !== 'open') msg.error(`启动失败：${r.lastError || '连不上 QQ 协议端'}。请确认 SnowLuma 已启动并登录 QQ`);
    } catch (e: any) { msg.error(e.message); } finally { busy.value = false; }
  }
  const askStart = () => dialog.warning({ title: '启动机器人？', content: '将连接 QQ 协议端，机器人开始收消息，并按仿真设置自动回复。', positiveText: '启动', negativeText: '取消', onPositiveClick: () => setBot('start') });
  const askStop = () => dialog.warning({ title: '停止机器人？', content: '将断开 QQ 协议端，机器人不再收发消息。控制台可继续使用。', positiveText: '停止', negativeText: '取消', onPositiveClick: () => setBot('stop') });

  return { pulse, view, busy, askStart, askStop };
}
