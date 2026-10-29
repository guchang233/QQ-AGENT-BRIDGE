<script setup lang="ts">
import { h, onMounted, onUnmounted, ref, computed } from 'vue';
import { NDataTable, NTag, NSpace, NButton, NInput, NSelect, NCode, NSwitch, type DataTableColumns } from 'naive-ui';
import { api, onPush, fmtFull, TIER_LABEL, TIER_TYPE } from '../api';

const rows = ref<any[]>([]);
const q = ref('');
const okFilter = ref<'all' | 'ok' | 'fail'>('all');
const live = ref(true);

async function load() { rows.value = await api('/api/audit?limit=500'); }
async function more() {
  if (!rows.value.length) return;
  const older = await api(`/api/audit?limit=300&before=${rows.value[rows.value.length - 1].id}`);
  rows.value.push(...older);
}

const off = onPush((t, d) => {
  if (t !== 'audit' || !live.value) return;
  rows.value.unshift({ id: d.id, ts: d.ts, agent: d.agent, tool: d.tool, tier: d.tier, ok: d.ok ? 1 : 0, ms: d.ms, params: d.params, result: d.error ?? '' });
});
onMounted(load);
onUnmounted(off);

const shown = computed(() => rows.value.filter((r) => (okFilter.value === 'all' || (okFilter.value === 'ok') === !!r.ok)
  && (!q.value || `${r.agent} ${r.tool} ${r.params} ${r.result}`.includes(q.value))));

const cols: DataTableColumns<any> = [
  { type: 'expand', renderExpand: (r) => h('div', [h('div', { style: 'font-size:12px;opacity:.6' }, '参数'), h(NCode, { code: pretty(r.params), language: 'json', wordWrap: true }), h('div', { style: 'font-size:12px;opacity:.6;margin-top:6px' }, '结果'), h(NCode, { code: pretty(r.result), language: 'json', wordWrap: true })]) },
  { title: '时间', key: 'ts', width: 170, render: (r) => fmtFull(r.ts) },
  { title: '调用方', key: 'agent', width: 140 },
  { title: '工具', key: 'tool', width: 200, render: (r) => h('code', r.tool) },
  { title: '等级', key: 'tier', width: 70, render: (r) => h(NTag, { size: 'small', type: TIER_TYPE[r.tier] }, { default: () => TIER_LABEL[r.tier] ?? r.tier }) },
  { title: '结果', key: 'ok', width: 70, render: (r) => h(NTag, { size: 'small', type: r.ok ? 'success' : 'error' }, { default: () => (r.ok ? '成功' : '失败') }) },
  { title: '耗时', key: 'ms', width: 80, render: (r) => `${r.ms}ms` },
  { title: '摘要', key: 'params', ellipsis: { tooltip: true }, render: (r) => (r.ok ? String(r.params).slice(0, 200) : String(r.result).slice(0, 200)) },
];
function pretty(s: string) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return String(s ?? ''); } }
</script>

<template>
  <n-space vertical>
    <n-space align="center">
      <n-input v-model:value="q" placeholder="筛选调用方/工具/内容" clearable style="width: 260px" />
      <n-select v-model:value="okFilter" style="width: 110px" :options="[{ label: '全部', value: 'all' }, { label: '成功', value: 'ok' }, { label: '失败', value: 'fail' }]" />
      <n-button @click="load">刷新</n-button>
      <span style="font-size: 13px">实时</span><n-switch v-model:value="live" size="small" />
    </n-space>
    <n-data-table :columns="cols" :data="shown" size="small" :row-key="(r: any) => r.id" :max-height="'calc(100vh - 220px)'" virtual-scroll />
    <n-button size="small" @click="more">加载更早</n-button>
  </n-space>
</template>
