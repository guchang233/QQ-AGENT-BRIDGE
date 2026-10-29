<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import { NDataTable, NInput, NSpace, NButton, NPopconfirm, NText, type DataTableColumns } from 'naive-ui';
import { api, fmtFull } from '../api';

const rows = ref<any[]>([]);
const scope = ref('');
const q = ref('');
async function load() { rows.value = await api(`/api/memory?scope=${encodeURIComponent(scope.value)}&q=${encodeURIComponent(q.value)}`); }
async function del(r: any) { await api(`/api/memory?scope=${encodeURIComponent(r.scope)}&key=${encodeURIComponent(r.key)}`, { method: 'DELETE' }); load(); }
const cols: DataTableColumns<any> = [
  { title: '范围', key: 'scope', width: 160 },
  { title: '键', key: 'key', width: 180 },
  { title: '内容', key: 'value', render: (r) => h('div', { style: 'white-space:pre-wrap' }, r.value) },
  { title: '更新时间', key: 'ts', width: 170, render: (r) => fmtFull(r.ts) },
  { title: '', key: 'op', width: 70, render: (r) => h(NPopconfirm, { onPositiveClick: () => del(r) }, { trigger: () => h(NButton, { size: 'tiny', type: 'error', ghost: true }, { default: () => '删除' }), default: () => '确定删除？' }) },
];
onMounted(load);
</script>

<template>
  <n-space vertical>
    <n-text depth="3" style="font-size: 13px">Agent 通过 qq_memory 工具写入的长期记忆（群友特点、约定、待办等）。</n-text>
    <n-space>
      <n-input v-model:value="scope" placeholder="范围（如 group:123）" clearable style="width: 200px" />
      <n-input v-model:value="q" placeholder="关键词" clearable style="width: 200px" @keyup.enter="load" />
      <n-button @click="load">查询</n-button>
    </n-space>
    <n-data-table :columns="cols" :data="rows" size="small" :row-key="(r: any) => r.scope + r.key" />
  </n-space>
</template>
