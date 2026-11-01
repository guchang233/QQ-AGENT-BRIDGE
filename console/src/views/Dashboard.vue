<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NGrid, NGi, NCard, NStatistic, NAlert, NButton, NSpace, NList, NListItem, NThing, NAvatar, NTag, NEmpty, NDescriptions, NDescriptionsItem, useMessage, useDialog } from 'naive-ui';
import { api, state, onPush, avatarOf, fmtTime, fmtFull } from '../api';
import ActivityList from '../components/ActivityList.vue';

const msg = useMessage();
const router = useRouter();
const convs = ref<any[]>([]);
const requests = ref<any[]>([]);
const acts = ref<any[]>([]);
const s = computed(() => state.status ?? {});

async function load() {
  const [st, c, r] = await Promise.all([api('/api/status'), api('/api/conversations'), api('/api/requests')]);
  state.status = st; convs.value = c.filter((x: any) => x.unread > 0).slice(0, 8); requests.value = r;
  acts.value = await api('/api/activity?limit=12');
}
const busy = ref(false);
const dialog = useDialog();
const pulse = computed(() => s.value.pulse ?? { state: 'offline', conv: '', convName: '' });
const view = computed(() => {
  const where = pulse.value.convName || pulse.value.conv;
  switch (pulse.value.state) {
    case 'sending': return { label: '消息发送中', sub: where ? `发给 ${where}` : '' };
    case 'thinking': return { label: 'AI 处理中', sub: where ? `正在处理 ${where}` : '' };
    case 'receiving': return { label: '消息接收中', sub: where ? `来自 ${where}` : '' };
    case 'idle': return { label: '空闲', sub: s.value.self ? `${s.value.self.nickname}（${s.value.self.userId}）在线，等待消息` : '在线，等待消息' };
    case 'connecting': return { label: '连接中', sub: s.value.lastError || `正在连接 ${s.value.endpoint?.ws ?? 'QQ 协议端'}` };
    default: return { label: '离线中', sub: s.value.lastError ? `上次断开：${s.value.lastError}。点击启动` : '点击启动机器人' };
  }
});
async function setBot(action: 'start' | 'stop') {
  busy.value = true;
  try { state.status = { ...state.status, ...(await api(`/api/bot/${action}`, { method: 'POST' })) }; }
  catch (e: any) { msg.error(e.message); } finally { busy.value = false; }
}
function askStart() {
  dialog.warning({ title: '启动机器人？', content: '将连接 QQ 协议端，机器人开始收消息，并按仿真设置自动回复。', positiveText: '启动', negativeText: '取消', onPositiveClick: () => setBot('start') });
}
function askStop() {
  dialog.warning({ title: '停止机器人？', content: '将断开 QQ 协议端，机器人不再收发消息。控制台可继续使用。', positiveText: '停止', negativeText: '取消', onPositiveClick: () => setBot('stop') });
}
async function reconnect() { try { await api('/api/reconnect', { method: 'POST' }); msg.success('已重新探测'); load(); } catch (e: any) { msg.error(e.message); } }
async function handleReq(flag: string, approve: boolean) { await api(`/api/requests/${flag}`, { body: { approve } }); msg.success(approve ? '已同意' : '已拒绝'); load(); }

let timer: any;
const off = onPush((t, d) => {
  if (t === 'activity') { acts.value.unshift(d); acts.value.length = Math.min(acts.value.length, 12); }
  if (t === 'message' || t === 'request') { clearTimeout(timer); timer = setTimeout(load, 800); }
});
onMounted(load);
onUnmounted(() => { off(); clearTimeout(timer); });
const uptime = computed(() => { const u = s.value.uptimeSec ?? 0; return u > 86400 ? `${Math.floor(u / 86400)} 天` : u > 3600 ? `${Math.floor(u / 3600)} 小时` : `${Math.floor(u / 60)} 分钟`; });
</script>

<template>
  <n-space vertical :size="16">
    <div class="bot-status" :class="[`is-${pulse.state}`, { clickable: pulse.state === 'offline' }]"
      :role="pulse.state === 'offline' ? 'button' : 'status'" :tabindex="pulse.state === 'offline' ? 0 : undefined"
      @click="pulse.state === 'offline' && askStart()" @keydown.enter="pulse.state === 'offline' && askStart()">
      <span class="dot" />
      <div class="text">
        <div class="label">{{ view.label }}</div>
        <div class="sub">{{ view.sub }}</div>
      </div>
      <n-button v-if="pulse.state !== 'offline'" size="small" quaternary :loading="busy" @click.stop="askStop">停止</n-button>
    </div>

    <n-grid cols="2 s:4" responsive="screen" :x-gap="12" :y-gap="12">
      <n-gi><n-card size="small"><n-statistic label="24h 收到消息" :value="s.stats24h?.recv ?? 0" /></n-card></n-gi>
      <n-gi><n-card size="small"><n-statistic label="24h 发出消息" :value="s.stats24h?.sent ?? 0" /></n-card></n-gi>
      <n-gi><n-card size="small"><n-statistic label="24h Agent 调用" :value="s.stats24h?.toolCalls ?? 0"><template #suffix><span style="font-size: 13px; opacity: .6">失败 {{ s.stats24h?.toolFailed ?? 0 }}</span></template></n-statistic></n-card></n-gi>
      <n-gi><n-card size="small"><n-statistic label="MCP 会话" :value="s.mcpSessions?.length ?? 0" /></n-card></n-gi>
    </n-grid>

    <n-grid cols="1 m:2" responsive="screen" :x-gap="12" :y-gap="12">
      <n-gi>
        <n-card title="最近动态" size="small" style="margin-bottom: 12px">
          <template #header-extra><n-button size="tiny" quaternary @click="router.push('/activity')">全部</n-button></template>
          <ActivityList :items="acts" compact />
        </n-card>
        <n-card title="未读会话" size="small">
          <n-empty v-if="!convs.length" description="没有未读消息" />
          <n-list v-else hoverable clickable>
            <n-list-item v-for="c in convs" :key="c.conv" @click="router.push(`/chat/${c.conv}`)">
              <n-thing>
                <template #avatar><n-avatar round :src="avatarOf(c.conv, 40)" /></template>
                <template #header>{{ c.name || c.conv }}</template>
                <template #header-extra><n-tag size="small" :type="c.mentions ? 'error' : 'info'" round>{{ c.mentions ? `@我 ${c.mentions}` : c.unread }}</n-tag></template>
                <template #description><span style="font-size: 12px; opacity: .7">{{ fmtTime(c.lastTs) }} {{ c.lastSender }}：{{ c.lastText.slice(0, 40) }}</span></template>
              </n-thing>
            </n-list-item>
          </n-list>
        </n-card>
      </n-gi>
      <n-gi>
        <n-space vertical :size="12">
          <n-card title="运行状态" size="small">
            <n-descriptions :column="1" label-placement="left" size="small">
              <n-descriptions-item label="账号">{{ s.self ? `${s.self.nickname}（${s.self.userId}）` : '—' }}</n-descriptions-item>
              <n-descriptions-item label="协议端">{{ s.endpoint?.ws }} · {{ s.endpoint?.http }}</n-descriptions-item>
              <n-descriptions-item label="最后事件">{{ s.lastEventAt ? fmtFull(s.lastEventAt) : '—' }}</n-descriptions-item>
              <n-descriptions-item label="群 / 好友">{{ s.groups }} / {{ s.friends }}</n-descriptions-item>
              <n-descriptions-item label="系统表情">{{ s.facesFromQQ ? '已从 QQ 同步' : '使用内置表' }}</n-descriptions-item>
              <n-descriptions-item label="已运行">{{ uptime }}</n-descriptions-item>
              <n-descriptions-item label="MCP 地址"><code>{{ s.mcpUrl }}</code></n-descriptions-item>
            </n-descriptions>
            <template #action><n-space><n-button size="small" @click="reconnect">重新探测</n-button><n-button size="small" @click="api('/api/contacts/refresh', { method: 'POST' }).then(load)">刷新联系人</n-button></n-space></template>
          </n-card>
          <n-card v-if="requests.length" title="好友 / 加群请求" size="small">
            <n-list>
              <n-list-item v-for="r in requests" :key="r.flag">
                <n-thing :title="r.kind === 'friend' ? `好友申请：${r.userId}` : `${r.subType === 'invite' ? '邀请入群' : '加群申请'}：${r.userId} → ${r.groupId}`" :description="r.comment || '（无附言）'" />
                <template #suffix><n-space><n-button size="tiny" @click="handleReq(r.flag, false)">拒绝</n-button><n-button size="tiny" type="primary" @click="handleReq(r.flag, true)">同意</n-button></n-space></template>
              </n-list-item>
            </n-list>
          </n-card>
        </n-space>
      </n-gi>
    </n-grid>
  </n-space>
</template>

<style scoped>
.bot-status { --c: #8a8f98; display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); background: color-mix(in srgb, var(--c) 10%, transparent); }
.bot-status.is-idle { --c: #18a058; }
.bot-status.is-receiving { --c: #2080f0; }
.bot-status.is-thinking { --c: #8a63d2; }
.bot-status.is-sending { --c: #0e9f9f; }
.bot-status.is-connecting { --c: #f0a020; }
.bot-status.clickable { cursor: pointer; }
.bot-status.clickable:hover { background: color-mix(in srgb, var(--c) 18%, transparent); }
.bot-status.clickable:focus-visible { outline: 2px solid var(--c); outline-offset: 2px; }
.dot { flex: none; width: 14px; height: 14px; border-radius: 50%; background: var(--c); }
.is-receiving .dot, .is-thinking .dot, .is-sending .dot, .is-connecting .dot { animation: pulse 1.1s ease-in-out infinite; }
.text { flex: 1; min-width: 0; }
.label { font-size: 20px; font-weight: 600; line-height: 1.3; }
.sub { font-size: 13px; opacity: .7; overflow-wrap: anywhere; }
@keyframes pulse { 50% { opacity: .3; transform: scale(.75); } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
</style>
