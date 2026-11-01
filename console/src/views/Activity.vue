<script setup lang="ts">
import PageHint from '../components/PageHint.vue';
import { onMounted, onUnmounted, ref } from 'vue';
import { NCard, NSpace, NSelect, NButton, NSwitch, NText } from 'naive-ui';
import { api, onPush } from '../api';
import ActivityList from '../components/ActivityList.vue';

const items = ref<any[]>([]);
const conv = ref<string | null>(null);
const kind = ref<string | null>(null);
const live = ref(true);
const convOptions = ref<{ label: string; value: string }[]>([]);

async function load() {
  const qs = new URLSearchParams({ limit: '200', ...(conv.value ? { conv: conv.value } : {}), ...(kind.value ? { kind: kind.value } : {}) });
  items.value = await api(`/api/activity?${qs}`);
  convOptions.value = (await api('/api/conversations')).map((c: any) => ({ label: `${c.name || c.conv}（${c.conv}）`, value: c.conv }));
}
async function more() {
  if (!items.value.length) return;
  const qs = new URLSearchParams({ limit: '200', before: String(items.value[items.value.length - 1].id), ...(conv.value ? { conv: conv.value } : {}), ...(kind.value ? { kind: kind.value } : {}) });
  items.value.push(...(await api(`/api/activity?${qs}`)));
}
const off = onPush((t, d) => {
  if (t !== 'activity' || !live.value) return;
  if (conv.value && d.conv !== conv.value) return;
  if (kind.value && d.kind !== kind.value) return;
  items.value.unshift(d);
  if (items.value.length > 500) items.value.length = 500;
});
onMounted(load);
onUnmounted(off);
</script>

<template>
  <div class="page">
    <PageHint text="机器人的每一步：触发唤醒 → 送达 DSH → 思考 → 发出消息。">
      想看 DSH 的完整推理过程，可以在 DSH 里打开工作区「QQ 聊天」，每个 QQ 会话对应一个同名会话。
    </PageHint>
    <div class="toolbar">
      <n-select v-model:value="conv" clearable filterable placeholder="全部会话" :options="convOptions" style="width: 240px" size="small" @update:value="load" />
      <n-select v-model:value="kind" clearable placeholder="全部类型" size="small" style="width: 140px" @update:value="load"
        :options="[{ label: '触发', value: 'trigger' }, { label: '送达', value: 'wake' }, { label: '回合', value: 'turn' }, { label: '发出的消息', value: 'sent' }, { label: '错误', value: 'error' }, { label: '信息', value: 'info' }]" />
      <n-button size="small" @click="load">刷新</n-button>
      <span class="hint">实时</span><n-switch v-model:value="live" size="small" />
    </div>
    <n-card size="small"><ActivityList :items="items" /></n-card>
    <n-button size="small" quaternary @click="more">加载更早</n-button>
  </div>
</template>
