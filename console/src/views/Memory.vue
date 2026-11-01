<script setup lang="ts">
import PageHint from '../components/PageHint.vue';
import { h, onMounted, ref } from 'vue';
import {
  NDataTable, NInput, NSpace, NButton, NPopconfirm, NText, NProgress, NTag, NCard, NGrid, NGi, NStatistic, NModal, NForm, NFormItem,
  NInputNumber, NSelect, NSwitch, NAlert, NRadioGroup, NRadioButton, useMessage, type DataTableColumns,
} from 'naive-ui';
import { api, fmtFull, isNarrow } from '../api';

const msg = useMessage();
const rows = ref<any[]>([]);
const ov = ref<any>(null);
const scope = ref('');
const q = ref('');
const mode = ref<'list' | 'recall' | 'archived'>('list');
const unavailable = ref('');
const showAdd = ref(false);
const draft = ref({ content: '', scope: 'global', subject: '', kind: 'fact', tags: '', importance: 3, pinned: false });
const KIND: Record<string, string> = { fact: '事实', preference: '偏好', event: '事件', relation: '关系', task: '待办', note: '笔记' };

async function load() {
  try {
    ov.value = await api(`/api/p/memory/overview`);
    const qs = `scope=${encodeURIComponent(scope.value)}&q=${encodeURIComponent(q.value)}`;
    rows.value = mode.value === 'recall' ? await api(`/api/p/memory/recall?${qs}`) : await api(`/api/p/memory/list?${qs}&archived=${mode.value === 'archived' ? 1 : 0}`);
    unavailable.value = '';
  } catch (e: any) { unavailable.value = e.status === 404 ? '记忆插件未启用（在「插件」页开启 memory）' : e.message; }
}
async function act(path: string, method: string, body?: unknown) { await api(`/api/p/memory/${path}`, { method, body }); load(); }
async function add() {
  await api('/api/p/memory/items', { body: { ...draft.value, tags: draft.value.tags.split(/[,，\s]+/).filter(Boolean) } });
  showAdd.value = false; draft.value.content = ''; msg.success('已写入'); load();
}

const cols: DataTableColumns<any> = [
  { title: '#', key: 'id', width: 60 },
  { title: '内容', key: 'content', render: (r) => h('div', [
    h('div', { style: 'white-space:pre-wrap' }, r.content),
    h('div', { style: 'font-size:12px;opacity:.6;margin-top:2px' }, [r.scope, r.subject ? ` · 关于 ${r.subject}` : '', r.tags ? ` · #${r.tags.split(',').join(' #')}` : ''].join('')),
  ]) },
  { title: '类型', key: 'kind', width: 70, render: (r) => h(NTag, { size: 'small', bordered: false }, { default: () => KIND[r.kind] ?? r.kind }) },
  { title: '重要', key: 'importance', width: 60, render: (r) => '★'.repeat(r.importance) },
  { title: '保持率', key: 'retention', width: 150, render: (r) => (r.pinned ? h(NTag, { size: 'small', type: 'info' }, { default: () => '📌 钉住' })
    : h(NProgress, { type: 'line', percentage: Math.round(r.retention * 100), status: r.forgotten ? 'error' : r.retention < 0.3 ? 'warning' : 'success', indicatorPlacement: 'inside', height: 14 })) },
  { title: '稳定度', key: 'stability', width: 80, render: (r) => `${r.stability.toFixed(1)} 天` },
  { title: '回忆', key: 'access_count', width: 60 },
  { title: '最近访问', key: 'last_access', width: 160, render: (r) => fmtFull(r.last_access) },
  { title: '', key: 'op', width: 190, render: (r) => h(NSpace, { size: 4 }, { default: () => [
    h(NButton, { size: 'tiny', onClick: () => act(`items/${r.id}`, 'PUT', { pinned: r.pinned ? 0 : 1 }) }, { default: () => (r.pinned ? '取消钉住' : '钉住') }),
    h(NButton, { size: 'tiny', onClick: () => act(`items/${r.id}/archive`, 'POST', { archived: !r.archived }) }, { default: () => (r.archived ? '恢复' : '归档') }),
    h(NPopconfirm, { onPositiveClick: () => act(`items/${r.id}`, 'DELETE') }, { trigger: () => h(NButton, { size: 'tiny', type: 'error', ghost: true }, { default: () => '删除' }), default: () => '彻底删除？' }),
  ] }) },
];
onMounted(load);
</script>

<template>
  <div class="page">
    <n-alert v-if="unavailable" type="warning">{{ unavailable }}</n-alert>
    <div v-if="ov" class="ministats">
      <span><b>{{ ov.total }}</b> 条记忆</span>
      <span><b>{{ ov.fading }}</b> 即将遗忘</span>
      <span><b>{{ ov.archived }}</b> 已归档</span>
      <span><b>{{ ov.bySubject.length }}</b> 涉及人数</span>
      <span>遗忘曲线<b>{{ ov.forgetting ? '开启' : '关闭' }}</b></span>
    </div>
    <PageHint text="保持率越低越接近遗忘，被回忆时会回升。">
      保持率 R = e^(−Δt/S)：越久没被回忆越低；每次被回忆，稳定度 S 会增长（越接近遗忘时复习增长越多）。遗忘参数在「插件 → 记忆 → 配置」中调整。
    </PageHint>
    <div class="toolbar">
      <n-radio-group v-model:value="mode" size="small" @update:value="load">
        <n-radio-button value="list">全部</n-radio-button>
        <n-radio-button value="recall">模拟回忆</n-radio-button>
        <n-radio-button value="archived">已归档</n-radio-button>
      </n-radio-group>
      <n-input v-model:value="scope" size="small" placeholder="范围（group:123 / global）" clearable style="width: 180px" />
      <n-input v-model:value="q" size="small" :placeholder="mode === 'recall' ? '回忆关键词（按综合得分排序）' : '关键词'" clearable style="width: 200px" @keyup.enter="load" />
      <n-button size="small" @click="load">查询</n-button>
      <span class="grow" />
      <n-button size="small" quaternary @click="act('sweep', 'POST')">立即整理</n-button>
      <n-button size="small" quaternary @click="act('rebuild', 'POST').then(() => msg.success('索引已重建'))">重建索引</n-button>
      <n-button size="small" type="primary" @click="showAdd = true">写入记忆</n-button>
    </div>
    <n-data-table :columns="cols" :data="rows" size="small" :row-key="(r: any) => r.id" :max-height="'calc(100vh - 215px)'" :scroll-x="820" />

    <n-modal v-model:show="showAdd" preset="card" title="写入记忆" style="max-width: 520px">
      <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="70">
        <n-form-item label="内容"><n-input v-model:value="draft.content" type="textarea" :autosize="{ minRows: 2 }" /></n-form-item>
        <n-form-item label="范围"><n-input v-model:value="draft.scope" placeholder="global / group:123 / private:456" /></n-form-item>
        <n-form-item label="相关人"><n-input v-model:value="draft.subject" placeholder="QQ 号（可空）" /></n-form-item>
        <n-form-item label="类型"><n-select v-model:value="draft.kind" :options="Object.entries(KIND).map(([value, label]) => ({ value, label }))" /></n-form-item>
        <n-form-item label="标签"><n-input v-model:value="draft.tags" placeholder="逗号分隔" /></n-form-item>
        <n-form-item label="重要度"><n-input-number v-model:value="draft.importance" :min="1" :max="5" /></n-form-item>
        <n-form-item label="钉住"><n-switch v-model:value="draft.pinned" /></n-form-item>
      </n-form>
      <template #footer><n-space justify="end"><n-button @click="showAdd = false">取消</n-button><n-button type="primary" :disabled="!draft.content.trim()" @click="add">写入</n-button></n-space></template>
    </n-modal>
  </div>
</template>

<style scoped>
.ministats { display: flex; flex-wrap: wrap; gap: 2px 18px; font-size: 12px; }
.ministats span { opacity: .75; }
.ministats b { margin: 0 3px; font-size: 15px; font-weight: 600; }
</style>
