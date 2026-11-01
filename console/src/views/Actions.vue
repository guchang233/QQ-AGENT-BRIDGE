<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NInput, NSelect, NList, NListItem, NTag, NScrollbar, NCard, NButton, NSpace, NCode, NAlert, NForm, NFormItem, NText, NEmpty, useMessage } from 'naive-ui';
import { api, TIER_LABEL, TIER_TYPE, isNarrow } from '../api';

const msg = useMessage();
const actions = ref<any[]>([]);
const categories = ref<string[]>([]);
const q = ref('');
const cat = ref<string | null>(null);
const sel = ref<any>(null);
const params = ref<Record<string, string>>({});
const extra = ref('');
const result = ref('');
const running = ref(false);

onMounted(async () => { const r = await api('/api/actions'); actions.value = r.actions; categories.value = r.categories; });
const shown = computed(() => actions.value.filter((a) => (!cat.value || a.category === cat.value) && (!q.value || a.name.includes(q.value) || a.summary.includes(q.value))));

function pick(a: any) { sel.value = a; params.value = Object.fromEntries(a.params.map((p: string) => [p, ''])); extra.value = ''; result.value = ''; }

function coerce(v: string): unknown {
  const s = v.trim();
  if (s === '') return undefined;
  if (/^-?\d+$/.test(s) && s.length < 16) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^[[{]/.test(s)) { try { return JSON.parse(s); } catch { /* 原样 */ } }
  return s;
}

async function run() {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params.value)) { const c = coerce(v); if (c !== undefined) body[k] = c; }
  if (extra.value.trim()) { try { Object.assign(body, JSON.parse(extra.value)); } catch { return msg.error('附加参数 JSON 格式错误'); } }
  running.value = true;
  try { const r = await api(`/api/actions/${sel.value.name}`, { body }); result.value = JSON.stringify(r.data, null, 2) ?? 'null'; }
  catch (e: any) { result.value = `错误：${e.message}`; }
  finally { running.value = false; }
}
</script>

<template>
  <div class="wrap">
    <div class="left">
      <n-space vertical :size="8">
        <n-input v-model:value="q" placeholder="搜索动作" clearable size="small" />
        <n-select v-model:value="cat" clearable size="small" placeholder="全部分类" :options="categories.map((c) => ({ label: c, value: c }))" />
      </n-space>
      <n-scrollbar style="max-height: calc(100vh - 200px); margin-top: 8px">
        <n-list hoverable clickable>
          <n-list-item v-for="a in shown" :key="a.name" :class="{ act: sel?.name === a.name }" @click="pick(a)">
            <div><code>{{ a.name }}</code> <n-tag size="tiny" :type="TIER_TYPE[a.tier]" :bordered="false">{{ TIER_LABEL[a.tier] }}</n-tag></div>
            <div style="font-size: 12px; opacity: .6">{{ a.summary || '—' }}</div>
          </n-list-item>
        </n-list>
      </n-scrollbar>
    </div>
    <div class="right">
      <n-empty v-if="!sel" description="从左侧选择一个 OneBot 动作，填写参数后直接调用（以人类身份执行，记录到审计日志）" style="margin-top: 60px" />
      <n-card v-else :title="sel.name" size="small">
        <template #header-extra><n-tag :type="TIER_TYPE[sel.tier]">{{ TIER_LABEL[sel.tier] }}</n-tag></template>
        <n-text depth="3">{{ sel.summary }} · 分类：{{ sel.category }}</n-text>
        <n-alert v-if="sel.tier === 'danger'" type="warning" style="margin: 8px 0" :show-icon="false">高危动作：请确认参数后再执行。</n-alert>
        <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="140" style="margin-top: 12px">
          <n-form-item v-for="p in sel.params" :key="p" :label="p"><n-input v-model:value="params[p]" placeholder="数字/true/false/JSON 自动识别，留空不传" /></n-form-item>
          <n-form-item label="附加参数 (JSON)"><n-input v-model:value="extra" type="textarea" :autosize="{ minRows: 1, maxRows: 6 }" placeholder='{"key": "value"}' /></n-form-item>
        </n-form>
        <n-button type="primary" :loading="running" @click="run">执行</n-button>
        <n-code v-if="result" :code="result" language="json" style="margin-top: 12px; max-height: 50vh; overflow: auto; font-size: 12px" />
      </n-card>
    </div>
  </div>
</template>

<style scoped>
.wrap { display: flex; gap: 12px; }
.left { width: 300px; flex-shrink: 0; }
.right { flex: 1; min-width: 0; }
.act { background: rgba(18,183,245,.12); }
@media (max-width: 760px) { .wrap { flex-direction: column; } .left { width: 100%; } }
</style>
