<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { NCard, NSpace, NButton, NSwitch, NTag, NEmpty, NAlert, NModal, NForm, NFormItem, NInput, NInputNumber, NDynamicTags, NSelect, NText, NCode, useMessage } from 'naive-ui';
import { api, onPush } from '../api';

const msg = useMessage();
const list = ref<any[]>([]);
const editing = ref<any>(null);
const form = ref<Record<string, any>>({});
const rawJson = ref('');

async function load() { list.value = await api('/api/plugins'); }
async function op(name: string, o: string) {
  try { await api(`/api/plugins/${name}/${o}`, { method: 'POST' }); msg.success('完成'); load(); } catch (e: any) { msg.error(e.message); }
}
function edit(p: any) {
  editing.value = p;
  form.value = structuredClone(p.config ?? {});
  rawJson.value = JSON.stringify(p.config ?? {}, null, 2);
}
async function saveCfg() {
  let cfg = form.value;
  if (!editing.value.schema) { try { cfg = JSON.parse(rawJson.value); } catch { return msg.error('JSON 格式错误'); } }
  try { await api(`/api/plugins/${editing.value.name}/config`, { method: 'PUT', body: cfg }); msg.success('已保存并重载'); editing.value = null; load(); } catch (e: any) { msg.error(e.message); }
}
const off = onPush((t) => { if (t === 'plugins') load(); });
onMounted(load);
onUnmounted(off);
</script>

<template>
  <n-space vertical :size="12">
    <n-space justify="space-between" align="center">
      <n-text depth="3" style="font-size: 13px">插件放在 <code>plugins/&lt;名称&gt;/</code>（plugin.json + index.ts），修改代码后点「重载」即可生效。开发指南见 docs/plugins.md。</n-text>
      <n-button size="small" @click="op('_', 'rescan')">重新扫描</n-button>
    </n-space>
    <n-empty v-if="!list.length" description="没有插件" />
    <n-card v-for="p in list" :key="p.name" size="small">
      <template #header>
        <n-space align="center">
          <span>{{ p.displayName }}</span>
          <n-tag size="small" :bordered="false">{{ p.name }}</n-tag>
          <n-tag v-if="p.version" size="small" :bordered="false">v{{ p.version }}</n-tag>
          <n-tag v-if="p.kind === 'astrbot'" size="small" type="info">AstrBot</n-tag>
          <n-tag size="small" :type="p.loaded ? 'success' : p.error ? 'error' : 'default'">{{ p.loaded ? '运行中' : p.error ? '加载失败' : '已停用' }}</n-tag>
        </n-space>
      </template>
      <template #header-extra>
        <n-space align="center">
          <n-switch :value="p.enabled" @update:value="(v: boolean) => op(p.name, v ? 'enable' : 'disable')" />
          <n-button size="small" :disabled="!p.enabled" @click="op(p.name, 'reload')">重载</n-button>
          <n-button size="small" @click="edit(p)">配置</n-button>
        </n-space>
      </template>
      <div style="font-size: 13px; opacity: .8">{{ p.description }}</div>
      <n-alert v-if="p.error" type="error" style="margin-top: 8px" :show-icon="false">{{ p.error }}</n-alert>
      <n-space style="margin-top: 8px; font-size: 12px; opacity: .75" :size="16">
        <span v-if="p.commands.length">命令：<code v-for="c in p.commands" :key="c.names[0]" :title="c.desc" style="margin-right: 6px">/{{ c.names.join(' /') }}</code></span>
        <span v-if="p.tools.length">Agent 工具：<code v-for="t in p.tools" :key="t" style="margin-right: 6px">{{ t }}</code></span>
        <span>处理器 {{ p.handlers }}</span><span v-if="p.crons">定时任务 {{ p.crons }}</span><span>触发 {{ p.calls }} 次</span>
      </n-space>
      <div v-if="p.lastError" style="font-size: 12px; color: #d03050; margin-top: 4px">最近错误：{{ p.lastError }}</div>
    </n-card>

    <n-modal :show="!!editing" preset="card" :title="`配置：${editing?.displayName}`" style="max-width: 560px" @update:show="(v: boolean) => !v && (editing = null)">
      <n-form v-if="editing?.schema" label-placement="top">
        <n-form-item v-for="(s, k) in editing.schema" :key="k" :label="s.description || k">
          <n-switch v-if="s.type === 'bool'" v-model:value="form[k]" />
          <n-input-number v-else-if="s.type === 'int' || s.type === 'float'" v-model:value="form[k]" :step="s.type === 'float' ? 0.1 : 1" />
          <n-dynamic-tags v-else-if="s.type === 'list'" v-model:value="form[k]" />
          <n-select v-else-if="s.options" v-model:value="form[k]" :options="s.options.map((o: any) => ({ label: String(o), value: o }))" />
          <n-input v-else v-model:value="form[k]" :type="s.type === 'text' ? 'textarea' : 'text'" />
          <template v-if="s.hint" #feedback>{{ s.hint }}</template>
        </n-form-item>
      </n-form>
      <template v-else>
        <n-text depth="3" style="font-size: 12px">该插件未提供 config.schema.json，直接编辑 JSON：</n-text>
        <n-input v-model:value="rawJson" type="textarea" :autosize="{ minRows: 6, maxRows: 20 }" style="font-family: monospace" />
      </template>
      <template #footer><n-space justify="end"><n-button @click="editing = null">取消</n-button><n-button type="primary" @click="saveCfg">保存</n-button></n-space></template>
    </n-modal>
  </n-space>
</template>
