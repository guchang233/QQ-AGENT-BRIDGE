import { reactive } from 'vue';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data?.error !== '密码错误') { state.authed = false; state.setupRequired = data?.error === 'setup_required'; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export async function upload(file: File): Promise<{ path: string; mime: string; size: number; name: string }> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? '上传失败');
  return data;
}

export interface Msg {
  seq: number; msgId: string; conv: string; senderId: string; senderName: string; isSelf: boolean; ts: number;
  segments: { type: string; data: any }[]; text: string; mentioned: boolean; recalled: boolean;
}

export const state = reactive({
  authed: false,
  setupRequired: false,
  checked: false,
  status: null as any,
  approvals: [] as any[],
  wsOpen: false,
});

type Listener = (type: string, data: any) => void;
const listeners = new Set<Listener>();
export function onPush(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); }

let ws: WebSocket | undefined;
let retry = 0;
export function connectWs() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/console`);
  ws.onopen = () => { state.wsOpen = true; retry = 0; refreshApprovals(); };
  ws.onclose = (e) => {
    state.wsOpen = false;
    if (e.code === 4401) { state.authed = false; return; }
    if (state.authed) setTimeout(connectWs, Math.min(10000, 1000 * 2 ** retry++));
  };
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === 'status') state.status = { ...(state.status ?? {}), ...data };
    if (type === 'approval') refreshApprovals();
    for (const l of listeners) l(type, data);
  };
}

export async function refreshApprovals() {
  try { state.approvals = await api('/api/approvals'); } catch { /* ignore */ }
}

export async function checkSession() {
  const s = await api<{ authed: boolean; setupRequired: boolean }>('/api/session');
  state.authed = s.authed; state.setupRequired = s.setupRequired; state.checked = true;
  if (s.authed) { connectWs(); state.status = await api('/api/status'); }
}

export function avatarOf(conv: string, size = 100) {
  const [type, id] = conv.split(':');
  return type === 'group' ? `https://p.qlogo.cn/gh/${id}/${id}/${size}` : `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=${size}`;
}
export const userAvatar = (qq: string) => `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`;

export function fmtTime(ts: number) {
  const d = new Date(ts); const now = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
export function fmtFull(ts: number) { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }
export function fmtSize(n: number) { return n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`; }

export const TIER_LABEL: Record<string, string> = { read: '读取', send: '发送', manage: '管理', danger: '高危' };
export const TIER_TYPE: Record<string, 'default' | 'info' | 'warning' | 'error'> = { read: 'default', send: 'info', manage: 'warning', danger: 'error' };
