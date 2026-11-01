<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NDynamicTags, NInput, NInputNumber, NSelect, NSwitch, NText, useMessage, useThemeVars } from 'naive-ui';
import { api } from '../api';

/** 插件配置页：由 definePlugin 的 config 声明自动生成，所有插件都用这一套。 */
const props = defineProps<{ plugin: any }>();
const emit = defineEmits<{ saved: [] }>();
const msg = useMessage();
const theme = useThemeVars();

const form = ref<Record<string, any>>({});
const rawJson = ref('');
const baseline = ref('');
const saving = ref(false);

function reset() {
  form.value = JSON.parse(JSON.stringify(props.plugin.config ?? {}));
  rawJson.value = JSON.stringify(props.plugin.config ?? {}, null, 2);
  baseline.value = snapshot();
}
const hasSchema = computed(() => Object.keys(props.plugin.schema ?? {}).length > 0);
const snapshot = () => (hasSchema.value ? JSON.stringify(form.value) : rawJson.value);
const dirty = computed(() => snapshot() !== baseline.value);
watch(() => props.plugin.name, reset, { immediate: true });

/** 按 group 字段分组 */
const groups = computed(() => {
  const out = new Map<string, [string, any][]>();
  for (const [k, s] of Object.entries<any>(props.plugin.schema ?? {})) {
    const g = s.group ?? '';
    out.set(g, [...(out.get(g) ?? []), [k, s]]);
  }
  return [...out];
});
/** 这些类型需要整行宽度，其余放在说明右边 */
const wide = (s: any) => s.type === 'list' || s.type === 'text' || s.type === 'json';

async function save() {
  let cfg: Record<string, any> = form.value;
  if (!hasSchema.value) { try { cfg = JSON.parse(rawJson.value); } catch { return msg.error('JSON 格式错误'); } }
  const out = { ...cfg };
  for (const [k, s] of Object.entries<any>(props.plugin.schema ?? {})) {
    if (s.type === 'json' && typeof out[k] === 'string') { try { out[k] = JSON.parse(out[k]); } catch { return msg.error(`${s.description || k} 不是合法 JSON`); } }
  }
  saving.value = true;
  try {
    await api(`/api/plugins/${props.plugin.name}/config`, { method: 'PUT', body: out });
    msg.success('已保存');
    baseline.value = snapshot();
    emit('saved');
  } catch (e: any) { msg.error(e.message); } finally { saving.value = false; }
}
</script>

<template>
  <div class="config">
    <template v-if="hasSchema">
      <section v-for="[g, fields] in groups" :key="g" class="group">
        <h3 v-if="g">{{ g }}</h3>
        <div class="rows">
          <div v-for="[k, s] in fields" :key="k" class="row" :class="{ wide: wide(s) }">
            <label class="label">{{ s.description || k }}<span v-if="s.hint" class="hint">{{ s.hint }}</span></label>
            <div class="control">
              <n-switch v-if="s.type === 'bool'" v-model:value="form[k]" />
              <n-input-number v-else-if="s.type === 'int' || s.type === 'float'" v-model:value="form[k]" size="small" :step="s.type === 'float' ? 0.05 : 1" :min="s.min" :max="s.max" style="width: 150px" />
              <n-dynamic-tags v-else-if="s.type === 'list'" v-model:value="form[k]" size="small" />
              <n-select v-else-if="s.type === 'select' || s.options" v-model:value="form[k]" size="small" :options="(s.options ?? []).map((o: any) => ({ label: String(o), value: o }))" style="width: 220px" />
              <n-input v-else-if="s.type === 'secret'" v-model:value="form[k]" size="small" type="password" show-password-on="click" style="width: 280px" />
              <n-input v-else-if="s.type === 'json'" :value="typeof form[k] === 'string' ? form[k] : JSON.stringify(form[k], null, 2)" type="textarea" :autosize="{ minRows: 3, maxRows: 14 }" style="font-family: monospace" @update:value="(v: string) => (form[k] = v)" />
              <n-input v-else-if="s.type === 'text'" v-model:value="form[k]" type="textarea" :autosize="{ minRows: 2, maxRows: 8 }" />
              <n-input v-else v-model:value="form[k]" size="small" style="width: 280px" />
            </div>
          </div>
        </div>
      </section>
    </template>
    <template v-else>
      <n-text depth="3" style="font-size: 12px">该插件没有声明配置项，可以直接编辑 JSON：</n-text>
      <n-input v-model:value="rawJson" type="textarea" :autosize="{ minRows: 6, maxRows: 20 }" style="font-family: monospace; margin-top: 6px" />
    </template>

    <div class="savebar" :style="{ background: theme.bodyColor }">
      <n-text :depth="dirty ? 1 : 3" style="flex: 1; font-size: 12px">{{ dirty ? '有未保存的修改' : '所有修改已保存' }}</n-text>
      <n-button size="small" :disabled="!dirty" @click="reset">放弃修改</n-button>
      <n-button size="small" type="primary" :disabled="!dirty" :loading="saving" @click="save">保存并生效</n-button>
    </div>
  </div>
</template>

<style scoped>
.config { max-width: 820px; }
.group { margin-bottom: 18px; }
.group h3 { margin: 0 0 6px 2px; font-size: 12px; font-weight: 500; opacity: .6; }
.rows { border: 1px solid rgba(128,128,128,.16); border-radius: 10px; overflow: hidden; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 12px; border-bottom: 1px solid rgba(128,128,128,.1); }
.row:last-child { border-bottom: 0; }
.row.wide { flex-direction: column; align-items: stretch; gap: 6px; }
.label { flex: 1; min-width: 0; font-size: 13px; line-height: 1.5; }
.label .hint { display: block; }
.control { flex: none; display: flex; justify-content: flex-end; min-width: 0; }
.row.wide .control { justify-content: flex-start; }
.savebar { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 8px 0; border-top: 1px solid rgba(128,128,128,.2); }
@media (max-width: 640px) {
  .row { flex-direction: column; align-items: stretch; gap: 6px; }
  .control { justify-content: flex-start; }
}
</style>
