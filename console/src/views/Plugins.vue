<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NIcon, NInput, NRadioButton, NRadioGroup, NSwitch, useMessage } from 'naive-ui';
import { api, onPush } from '../api';
import { CATEGORIES, colorOf, metaOf } from '../pluginRegistry';

const msg = useMessage();
const router = useRouter();
const list = ref<any[]>([]);
const tab = ref<'system' | 'user' | 'astrbot'>('system');
const q = ref('');
const busy = ref(new Set<string>());

async function load() { list.value = await api('/api/plugins'); }
async function rescan() {
  try { await api('/api/plugins/_/rescan', { method: 'POST' }); msg.success('扫描完成'); load(); } catch (e: any) { msg.error(e.message); }
}
async function toggle(p: any, on: boolean) {
  const before = p.enabled;
  p.enabled = on; // 先反馈，失败再回退
  busy.value = new Set(busy.value).add(p.name);
  try { await api(`/api/plugins/${p.name}/${on ? 'enable' : 'disable'}`, { method: 'POST' }); }
  catch (e: any) { p.enabled = before; msg.error(`${p.displayName}：${e.message}`); }
  finally {
    const next = new Set(busy.value); next.delete(p.name); busy.value = next;
    load();
  }
}
const open = (p: any) => router.push(`/plugins/${p.name}`);

const inTab = (p: any, t: string) => (t === 'astrbot' ? p.kind === 'astrbot' : p.kind !== 'astrbot' && (t === 'system') === p.system);
const count = (t: string) => list.value.filter((p) => inTab(p, t)).length;
// 按分类固定排列：开关之后卡片留在原位，不会跳走
const groups = computed(() => {
  const k = q.value.trim().toLowerCase();
  const shown = list.value.filter((p) => inTab(p, tab.value) && (!k || `${p.displayName}${p.name}${p.description}`.toLowerCase().includes(k)));
  return CATEGORIES.map((c) => ({ ...c, items: shown.filter((p) => metaOf(p.name).category === c.key) })).filter((g) => g.items.length);
});

const off = onPush((t) => { if (t === 'plugins') load(); });
onMounted(load);
onUnmounted(off);
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <n-radio-group v-model:value="tab" size="small">
        <n-radio-button value="system">系统插件 {{ count('system') }}</n-radio-button>
        <n-radio-button value="user">我的插件 {{ count('user') }}</n-radio-button>
        <n-radio-button value="astrbot">AstrBot {{ count('astrbot') }}</n-radio-button>
      </n-radio-group>
      <n-input v-model:value="q" size="small" placeholder="搜索插件" clearable style="width: 180px" />
      <span class="grow" />
      <n-button size="small" quaternary @click="rescan">重新扫描</n-button>
    </div>
    <div v-if="tab === 'user'" class="hint">插件放在 <code>plugins/</code> 目录，保存即热重载。新建：<code>qab plugin new 名字</code>；开发指南见 <code>docs/plugins.md</code>。</div>
    <div v-if="tab === 'astrbot'" class="hint">AstrBot 插件放在 <code>astrbot_plugins/</code>，需在「设置 → 媒体与插件」开启兼容层并重启。</div>
    <div v-if="!groups.length" class="empty hint">{{ q ? '没有找到匹配的插件' : '这里还没有插件' }}</div>

    <section v-for="g in groups" :key="g.key" class="group">
      <h3>{{ g.label }}</h3>
      <div class="cards">
        <article v-for="p in g.items" :key="p.name" class="card" :class="{ off: !p.enabled, bad: p.error }" role="button" tabindex="0" @click="open(p)" @keydown.enter="open(p)">
          <span class="tile" :style="{ '--c': colorOf(p.name) }"><n-icon :component="metaOf(p.name).icon" :size="20" /></span>
          <div class="body">
            <div class="name">{{ p.displayName }}</div>
            <div class="desc">{{ p.error || p.description }}</div>
          </div>
          <div class="side" @click.stop @keydown.enter.stop>
            <n-switch size="small" :value="p.enabled" :loading="busy.has(p.name)" :aria-label="`${p.enabled ? '停用' : '启用'}${p.displayName}`" @update:value="(v: boolean) => toggle(p, v)" />
            <n-button text size="tiny" class="cfg" @click="open(p)">配置</n-button>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.grow { flex: 1; }
.empty { padding: 32px 0; text-align: center; }
.group { margin-top: 6px; }
.group h3 { margin: 0 0 8px 2px; font-size: 12px; font-weight: 500; opacity: .6; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.card { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 12px; border: 1px solid rgba(128,128,128,.16); border-radius: 10px; background: rgba(128,128,128,.04); cursor: pointer; transition: border-color .15s, background .15s; }
.card:hover { border-color: rgba(18,183,245,.5); background: rgba(18,183,245,.06); }
.card:focus-visible { outline: 2px solid #12b7f5; outline-offset: 2px; }
.tile { flex: none; display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; color: var(--c); background: color-mix(in srgb, var(--c) 15%, transparent); transition: opacity .15s, filter .15s; }
.card.off .tile { filter: grayscale(1); opacity: .55; }
.body { flex: 1; min-width: 0; }
.name { font-size: 13.5px; font-weight: 600; line-height: 1.4; }
.card.off .name { opacity: .7; }
.desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 1px; font-size: 12px; line-height: 1.45; opacity: .6; }
.card.bad .desc { color: #d03050; opacity: 1; }
.side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.cfg { opacity: .6; font-size: 12px; }
.card:hover .cfg { opacity: 1; }
@media (max-width: 640px) { .cards { grid-template-columns: minmax(0, 1fr); } }
@media (prefers-reduced-motion: reduce) { .card, .tile { transition: none; } }
</style>
