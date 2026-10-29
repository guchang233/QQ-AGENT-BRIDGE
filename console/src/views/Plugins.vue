<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  NCard, NSpace, NButton, NSwitch, NTag, NEmpty, NAlert, NModal, NForm, NFormItem, NInput, NInputNumber, NDynamicTags, NSelect, NText,
  NRadioGroup, NRadioButton, NDivider, useMessage,
} from 'naive-ui';
import { api, onPush } from '../api';

const msg = useMessage();
const list = ref<any[]>([]);
const tab = ref<'system' | 'user' | 'astrbot'>('system');
const editing = ref<any>(null);
const form = ref<Record<string, any>>({});
const rawJson = ref('');

async function load() { list.value = await api('/api/plugins'); }
async function op(name: string, o: string) {
  try { await api(`/api/plugins/${name}/${o}`, { method: 'POST' }); msg.success('完成'); load(); } catch (e: any) { msg.error(e.message); }
}
function edit(p: any) {
  editing.value = p;
  form.value = JSON.parse(JSON.stringify(p.config ?? {}));
  rawJson.value = JSON.stringify(p.config ?? {}, null, 2);
}
async function saveCfg() {
  let cfg = form.value;
  if (!editing.value.schema) { try { cfg = JSON.parse(rawJson.value); } catch { return msg.error('JSON 格式错误'); } }
  for (const [k, s] of Object.entries<any>(editing.value.schema ?? {})) if (s.type === 'json' && typeof cfg[k] === 'string') { try { cfg[k] = JSON.parse(cfg[k]); } catch { return msg.error(`${k} 不是合法 JSON`); } }
  try { await api(`/api/plugins/${editing.value.name}/config`, { method: 'PUT', body: cfg }); msg.success('已保存并重载'); editing.value = null; load(); } catch (e: any) { msg.error(e.message); }
}
/** 按 group 字段把配置项分组 */
const groups = computed(() => {
  const out = new Map<string, [string, any][]>();
  for (const [k, s] of Object.entries<any>(editing.value?.schema ?? {})) {
    const g = s.group ?? '';
    out.set(g, [...(out.get(g) ?? []), [k, s]]);
  }
  return [...out];
});
const shown = computed(() => list.value.filter((p) => (tab.value === 'astrbot' ? p.kind === 'astrbot' : p.kind !== 'astrbot' && (tab.value === 'system') === p.system)));
const count = (t: string) => list.value.filter((p) => (t === 'astrbot' ? p.kind === 'astrbot' : p.kind !== 'astrbot' && (t === 'system') === p.system)).length;
const off = onPush((t) => { if (t === 'plugins') load(); });
onMounted(load);
onUnmounted(off);
</script>

<template>
  <n-space vertical :size="12">
    <n-space justify="space-between" align="center">
      <n-radio-group v-model:value="tab" size="small">
        <n-radio-button value="system">系统插件 {{ count('system') }}</n-radio-button>
        <n-radio-button value="user">我的插件 {{ count('user') }}</n-radio-button>
        <n-radio-button value="astrbot">AstrBot {{ count('astrbot') }}</n-radio-button>
      </n-radio-group>
      <n-button size="small" @click="op('_', 'rescan')">重新扫描</n-button>
    </n-space>
    <n-alert v-if="tab === 'user'" type="info" :show-icon="false" style="font-size: 13px">
      用户插件放在 <code>plugins/</code> 目录（单文件 <code>foo.ts</code> 或目录 <code>foo/index.ts</code>），保存即热重载。
      新建：<code>qab plugin new 名字</code>；开发指南见 <code>docs/plugins.md</code>。
    </n-alert>
    <n-alert v-if="tab === 'astrbot'" type="info" :show-icon="false" style="font-size: 13px">
      AstrBot 插件放在 <code>astrbot_plugins/</code>，需在「设置 → 插件」开启兼容层并重启。支持常用的 Star / filter / 消息组件 / llm_tool / 配置。
    </n-alert>
    <n-empty v-if="!shown.length" description="没有插件" />
    <n-card v-for="p in shown" :key="p.name" size="small">
      <template #header>
        <n-space align="center" :size="6">
          <span>{{ p.displayName }}</span>
          <n-tag size="small" :bordered="false">{{ p.name }}</n-tag>
          <n-tag v-if="p.version" size="small" :bordered="false">v{{ String(p.version).replace(/^v/, '') }}</n-tag>
          <n-tag size="small" :type="p.loaded ? 'success' : p.error ? 'error' : 'default'">{{ p.loaded ? '运行中' : p.error ? '异常' : '未启用' }}</n-tag>
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
      <div class="meta">
        <span v-if="p.commands.length">命令：<code v-for="c in p.commands" :key="c.names[0]" :title="c.desc">/{{ c.names[0] }}</code></span>
        <span v-if="p.tools.length">Agent 工具：<code v-for="t in p.tools" :key="t">{{ t }}</code></span>
        <span v-if="p.depends?.length">依赖：{{ p.depends.join('、') }}</span>
        <span v-if="p.crons">定时任务 {{ p.crons }}</span>
        <span v-if="p.calls">触发 {{ p.calls }} 次</span>
      </div>
      <div v-if="p.lastError" style="font-size: 12px; color: #d03050; margin-top: 4px">最近错误：{{ p.lastError }}</div>
    </n-card>

    <n-modal :show="!!editing" preset="card" :title="`配置：${editing?.displayName}`" style="max-width: 620px" @update:show="(v: boolean) => !v && (editing = null)">
      <n-form v-if="editing?.schema" label-placement="top" style="max-height: 65vh; overflow: auto; padding-right: 6px">
        <template v-for="[g, fields] in groups" :key="g">
          <n-divider v-if="g" title-placement="left" style="margin: 8px 0">{{ g }}</n-divider>
          <n-form-item v-for="[k, s] in fields" :key="k" :label="s.description || k">
            <n-switch v-if="s.type === 'bool'" v-model:value="form[k]" />
            <n-input-number v-else-if="s.type === 'int' || s.type === 'float'" v-model:value="form[k]" :step="s.type === 'float' ? 0.05 : 1" :min="s.min" :max="s.max" style="width: 200px" />
            <n-dynamic-tags v-else-if="s.type === 'list'" v-model:value="form[k]" />
            <n-select v-else-if="s.type === 'select' || s.options" v-model:value="form[k]" :options="(s.options ?? []).map((o: any) => ({ label: String(o), value: o }))" />
            <n-input v-else-if="s.type === 'secret'" v-model:value="form[k]" type="password" show-password-on="click" />
            <n-input v-else-if="s.type === 'json'" :value="typeof form[k] === 'string' ? form[k] : JSON.stringify(form[k], null, 2)" type="textarea" style="font-family: monospace" @update:value="(v: string) => (form[k] = v)" />
            <n-input v-else v-model:value="form[k]" :type="s.type === 'text' ? 'textarea' : 'text'" :autosize="s.type === 'text' ? { minRows: 2, maxRows: 8 } : undefined" />
            <template v-if="s.hint" #feedback>{{ s.hint }}</template>
          </n-form-item>
        </template>
      </n-form>
      <template v-else>
        <n-text depth="3" style="font-size: 12px">该插件没有声明配置项，直接编辑 JSON：</n-text>
        <n-input v-model:value="rawJson" type="textarea" :autosize="{ minRows: 6, maxRows: 20 }" style="font-family: monospace" />
      </template>
      <template #footer><n-space justify="end"><n-button @click="editing = null">取消</n-button><n-button type="primary" @click="saveCfg">保存</n-button></n-space></template>
    </n-modal>
  </n-space>
</template>

<style scoped>
.meta { margin-top: 8px; font-size: 12px; opacity: .75; display: flex; flex-wrap: wrap; gap: 4px 16px; }
.meta code { margin-right: 6px; }
</style>
