<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NGrid, NGi, NCard, NStatistic, NAlert, NButton, NSpace, NList, NListItem, NThing, NAvatar, NTag, NEmpty, NDescriptions, NDescriptionsItem, useMessage } from 'naive-ui';
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
    <n-alert v-if="s.connection !== 'open'" type="error" title="未连接到 QQ 协议端">
      {{ s.lastError || '正在尝试连接…' }}（{{ s.endpoint?.ws }}）。请确认 SnowLuma 已启动并登录 QQ。
      <template #action><n-button size="small" @click="reconnect">重新探测</n-button></template>
    </n-alert>

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
