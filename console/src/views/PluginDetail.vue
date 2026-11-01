<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NIcon, NSpin, NSwitch, NTab, NTabs, NTag, useMessage } from 'naive-ui';
import { ArrowBackOutline } from '@vicons/ionicons5';
import { api, onPush } from '../api';
import { colorOf, metaOf } from '../pluginRegistry';
import PluginConfig from '../components/PluginConfig.vue';

const msg = useMessage();
const route = useRoute();
const router = useRouter();
const plugin = ref<any>(null);
const missing = ref(false);
const busy = ref(false);

const name = computed(() => String(route.params.name));
const meta = computed(() => metaOf(name.value));
const pages = computed(() => meta.value.pages ?? []);
// 没有自带页面的插件直接进配置页
const tab = computed(() => String(route.params.tab || pages.value[0]?.key || 'config'));
const page = computed(() => pages.value.find((p) => p.key === tab.value));
const go = (t: string) => router.replace(`/plugins/${name.value}/${t}`);

async function load() {
  const list: any[] = await api('/api/plugins');
  plugin.value = list.find((p) => p.name === name.value) ?? null;
  missing.value = !plugin.value;
}
async function toggle(on: boolean) {
  busy.value = true;
  try { await api(`/api/plugins/${name.value}/${on ? 'enable' : 'disable'}`, { method: 'POST' }); msg.success(on ? '已启用' : '已停用'); }
  catch (e: any) { msg.error(e.message); }
  finally { busy.value = false; load(); }
}
async function reload() {
  busy.value = true;
  try { await api(`/api/plugins/${name.value}/reload`, { method: 'POST' }); msg.success('已重载'); }
  catch (e: any) { msg.error(e.message); }
  finally { busy.value = false; load(); }
}

const off = onPush((t) => { if (t === 'plugins') load(); });
onMounted(load);
onUnmounted(off);
watch(name, load);
</script>

<template>
  <div v-if="missing" class="page">
    <div class="hint">没有找到插件「{{ name }}」。</div>
    <div><n-button size="small" @click="router.push('/plugins')">返回插件列表</n-button></div>
  </div>
  <n-spin v-else-if="!plugin" />
  <div v-else class="page">
    <header class="head">
      <n-button quaternary circle size="small" aria-label="返回插件列表" title="返回插件列表" @click="router.push('/plugins')"><template #icon><n-icon :component="ArrowBackOutline" /></template></n-button>
      <span class="tile" :class="{ off: !plugin.enabled }" :style="{ '--c': colorOf(name) }"><n-icon :component="meta.icon" :size="20" /></span>
      <div class="title">
        <div class="name">{{ plugin.displayName }}
          <span v-if="plugin.version" class="ver">v{{ String(plugin.version).replace(/^v/, '') }}</span>
          <n-tag v-if="plugin.error" size="tiny" type="error" :bordered="false">异常</n-tag>
        </div>
        <div class="desc">{{ plugin.description }}</div>
      </div>
      <n-button size="small" quaternary :disabled="!plugin.enabled || busy" @click="reload">重载</n-button>
      <n-switch :value="plugin.enabled" :loading="busy" :aria-label="`${plugin.enabled ? '停用' : '启用'}${plugin.displayName}`" @update:value="toggle" />
    </header>

    <div v-if="plugin.error" class="error">{{ plugin.error }}</div>
    <div v-else-if="plugin.lastError" class="error">最近错误：{{ plugin.lastError }}</div>

    <n-tabs :value="tab" type="line" size="small" @update:value="go">
      <n-tab v-for="p in pages" :key="p.key" :name="p.key">{{ p.label }}</n-tab>
      <n-tab name="config">配置</n-tab>
      <n-tab name="info">详情</n-tab>
    </n-tabs>

    <template v-if="page">
      <div v-if="!plugin.loaded" class="off-note hint">插件未启用。打开右上角的开关后，这里才有内容。</div>
      <component :is="page.component" v-else :key="`${name}-${page.key}`" />
    </template>
    <PluginConfig v-else-if="tab === 'config'" :plugin="plugin" @saved="load" />
    <div v-else class="info">
      <dl class="kv">
        <dt>标识</dt><dd><code>{{ plugin.name }}</code></dd>
        <dt>状态</dt><dd>{{ plugin.loaded ? '运行中' : plugin.enabled ? '未加载' : '未启用' }}</dd>
        <template v-if="plugin.author"><dt>作者</dt><dd>{{ plugin.author }}</dd></template>
        <template v-if="plugin.calls"><dt>触发次数</dt><dd>{{ plugin.calls }}</dd></template>
        <template v-if="plugin.crons"><dt>定时任务</dt><dd>{{ plugin.crons }}</dd></template>
        <template v-if="plugin.depends?.length"><dt>依赖</dt><dd>{{ plugin.depends.join('、') }}</dd></template>
      </dl>
      <section v-if="plugin.commands.length"><h3>QQ 命令</h3>
        <div v-for="c in plugin.commands" :key="c.names[0]" class="line"><code>/{{ c.names.join(' /') }}{{ c.usage ? ` ${c.usage}` : '' }}</code><span class="hint">{{ c.desc }}</span></div>
      </section>
      <section v-if="plugin.tools.length"><h3>Agent 工具</h3>
        <code v-for="t in plugin.tools" :key="t" class="tool">{{ t }}</code>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tile { flex: none; display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); }
.tile.off { filter: grayscale(1); opacity: .55; }
.title { flex: 1; min-width: 0; }
.name { display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 600; }
.ver { font-size: 12px; font-weight: 400; opacity: .5; }
.desc { font-size: 12px; opacity: .65; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.error { padding: 6px 10px; border-radius: 6px; font-size: 12px; color: #d03050; background: rgba(208,48,80,.1); overflow-wrap: anywhere; }
.off-note { padding: 32px 0; text-align: center; }
.info { display: flex; flex-direction: column; gap: 14px; max-width: 760px; }
.info h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
.line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; padding: 2px 0; font-size: 12.5px; }
.tool { display: inline-block; margin: 0 8px 4px 0; font-size: 12px; }
@media (max-width: 640px) { .desc { white-space: normal; } }
</style>
