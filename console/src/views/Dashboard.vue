<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NCard, NButton, NSpace, NAvatar, NTag, useMessage } from 'naive-ui';
import { api, state, onPush, avatarOf, fmtTime, fmtFull } from '../api';
import { useBot } from '../bot';
import ActivityList from '../components/ActivityList.vue';

const msg = useMessage();
const router = useRouter();
const { pulse, view, busy, askStart, askStop } = useBot();
const convs = ref<any[]>([]);
const requests = ref<any[]>([]);
const acts = ref<any[]>([]);
const s = computed(() => state.status ?? {});

async function load() {
  const [st, c, r] = await Promise.all([api('/api/status'), api('/api/conversations'), api('/api/requests')]);
  state.status = st; convs.value = c.filter((x: any) => x.unread > 0).slice(0, 8); requests.value = r;
  acts.value = await api('/api/activity?limit=30');
}
async function reconnect() { try { await api('/api/reconnect', { method: 'POST' }); msg.success('已重新探测'); load(); } catch (e: any) { msg.error(e.message); } }
async function refreshContacts() { await api('/api/contacts/refresh', { method: 'POST' }); msg.success('已刷新'); load(); }
async function handleReq(flag: string, approve: boolean) { await api(`/api/requests/${flag}`, { body: { approve } }); msg.success(approve ? '已同意' : '已拒绝'); load(); }

let timer: any;
const off = onPush((t, d) => {
  if (t === 'activity') { acts.value.unshift(d); acts.value.length = Math.min(acts.value.length, 30); }
  if (t === 'message' || t === 'request') { clearTimeout(timer); timer = setTimeout(load, 800); }
});
onMounted(load);
onUnmounted(() => { off(); clearTimeout(timer); });
const uptime = computed(() => { const u = s.value.uptimeSec ?? 0; return u > 86400 ? `${Math.floor(u / 86400)} 天` : u > 3600 ? `${Math.floor(u / 3600)} 小时` : `${Math.floor(u / 60)} 分钟`; });
const offline = computed(() => pulse.value.state === 'offline');
</script>

<template>
  <div class="page">
    <section class="overview" :class="`st-${pulse.state}`">
      <div class="status" :class="{ clickable: offline }" :role="offline ? 'button' : 'status'" :tabindex="offline ? 0 : undefined"
        @click="offline && askStart()" @keydown.enter="offline && askStart()">
        <span class="bot-dot" />
        <div class="min0">
          <div class="label">{{ view.label }}</div>
          <div class="sub">{{ view.sub }}</div>
        </div>
        <n-button v-if="offline" size="small" type="primary" @click.stop="askStart">启动</n-button>
        <n-button v-else size="tiny" quaternary :loading="busy" @click.stop="askStop">停止</n-button>
      </div>
      <div class="ministats">
        <div class="mini"><b>{{ s.stats24h?.recv ?? 0 }}</b><span>24h 收到</span></div>
        <div class="mini"><b>{{ s.stats24h?.sent ?? 0 }}</b><span>24h 发出</span></div>
        <div class="mini"><b>{{ s.stats24h?.toolCalls ?? 0 }}</b><span>Agent 调用</span></div>
        <div class="mini" :class="{ bad: s.stats24h?.toolFailed }"><b>{{ s.stats24h?.toolFailed ?? 0 }}</b><span>调用失败</span></div>
        <div class="mini"><b>{{ s.mcpSessions?.length ?? 0 }}</b><span>MCP 会话</span></div>
      </div>
    </section>

    <div class="dash">
      <n-card title="最近动态" size="small">
        <template #header-extra><n-button size="tiny" quaternary @click="router.push('/activity')">全部</n-button></template>
        <div class="scroll"><ActivityList :items="acts" compact /></div>
      </n-card>

      <div class="side">
        <n-card v-if="requests.length" :title="`待处理请求 ${requests.length}`" size="small" class="attention">
          <div v-for="r in requests" :key="r.flag" class="req">
            <div class="min0">
              <div class="line">{{ r.kind === 'friend' ? `好友申请：${r.userId}` : `${r.subType === 'invite' ? '邀请入群' : '加群申请'}：${r.userId} → ${r.groupId}` }}</div>
              <div class="hint line">{{ r.comment || '（无附言）' }}</div>
            </div>
            <n-space :size="4" :wrap="false"><n-button size="tiny" @click="handleReq(r.flag, false)">拒绝</n-button><n-button size="tiny" type="primary" @click="handleReq(r.flag, true)">同意</n-button></n-space>
          </div>
        </n-card>

        <n-card :title="convs.length ? `未读会话 ${convs.length}` : '未读会话'" size="small">
          <div v-if="!convs.length" class="hint">没有未读消息</div>
          <div v-for="c in convs" :key="c.conv" class="conv" role="button" tabindex="0" @click="router.push(`/chat/${c.conv}`)" @keydown.enter="router.push(`/chat/${c.conv}`)">
            <n-avatar round :size="26" :src="avatarOf(c.conv, 40)" />
            <div class="min0">
              <div class="line name">{{ c.name || c.conv }}</div>
              <div class="line hint">{{ c.lastSender }}：{{ c.lastText }}</div>
            </div>
            <span class="hint">{{ fmtTime(c.lastTs) }}</span>
            <n-tag size="tiny" :type="c.mentions ? 'error' : 'info'" round :bordered="false">{{ c.mentions ? `@我 ${c.mentions}` : c.unread }}</n-tag>
          </div>
        </n-card>

        <n-card title="运行信息" size="small">
          <template #header-extra>
            <n-space :size="2"><n-button size="tiny" quaternary @click="reconnect">重新探测</n-button><n-button size="tiny" quaternary @click="refreshContacts">刷新联系人</n-button></n-space>
          </template>
          <dl class="kv">
            <dt>账号</dt><dd>{{ s.self ? `${s.self.nickname}（${s.self.userId}）` : '—' }}</dd>
            <dt>群 / 好友</dt><dd>{{ s.groups ?? 0 }} / {{ s.friends ?? 0 }}</dd>
            <dt>已运行</dt><dd>{{ uptime }}</dd>
            <dt>最后事件</dt><dd>{{ s.lastEventAt ? fmtFull(s.lastEventAt) : '—' }}</dd>
            <dt>协议端</dt><dd><code>{{ s.endpoint?.ws }}</code></dd>
            <dt>MCP</dt><dd><code>{{ s.mcpUrl }}</code></dd>
          </dl>
        </n-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overview { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; padding: 10px 14px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--c) 40%, transparent); background: color-mix(in srgb, var(--c) 8%, transparent); }
.status { flex: 1 1 280px; min-width: 0; display: flex; align-items: center; gap: 10px; border-radius: 6px; }
.status.clickable { cursor: pointer; }
.status.clickable:hover .label { text-decoration: underline; }
.status.clickable:focus-visible { outline: 2px solid var(--c); outline-offset: 4px; }
.min0 { flex: 1; min-width: 0; }
.label { font-size: 17px; font-weight: 600; line-height: 1.3; }
.sub { font-size: 12px; opacity: .7; overflow-wrap: anywhere; }
.ministats { display: flex; flex-wrap: wrap; gap: 4px 22px; }
.mini { display: flex; flex-direction: column; align-items: flex-start; font-variant-numeric: tabular-nums; }
.mini b { font-size: 17px; font-weight: 600; line-height: 1.25; }
.mini span { font-size: 11px; opacity: .6; }
.mini.bad b { color: #d03050; }
.dash { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(300px, 1fr); gap: 10px; align-items: start; }
.side { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.scroll { max-height: calc(100vh - 215px); overflow: auto; }
.attention { border-color: #f0a020; }
.req { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.conv { display: flex; align-items: center; gap: 8px; padding: 4px; margin: 0 -4px; border-radius: 6px; cursor: pointer; }
.conv:hover { background: rgba(128,128,128,.1); }
.conv:focus-visible { outline: 2px solid #12b7f5; }
.line { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.name { font-size: 13px; }
.conv .hint { flex: none; }
.conv .min0 .hint { display: block; }
@media (max-width: 860px) { .dash { grid-template-columns: minmax(0, 1fr); } .scroll { max-height: 320px; } }
</style>
