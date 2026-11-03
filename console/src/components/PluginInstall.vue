<script setup lang="ts">
import { ref } from 'vue';
import { NAlert, NButton, NInput, NModal, NSpace, NTag, useMessage } from 'naive-ui';
import { api } from '../api';

const emit = defineEmits<{ installed: [name: string] }>();
const show = defineModel<boolean>('show', { default: false });
const msg = useMessage();
const url = ref('');
const busy = ref(false);
const info = ref<any>(null);
const fileInput = ref<HTMLInputElement>();

const PERM: Record<string, [string, string]> = {
  send: ['发消息', '可以在群里和私聊里发消息、回复、贴表情'],
  onebot: ['调用 OneBot 动作', '可以直接调用 QQ 协议动作，例如禁言、撤回、查资料'],
  history: ['读取聊天记录', '可以读取最近的聊天记录和记忆'],
  memory: ['写入记忆', '可以往记忆里写内容（标记为未核实）'],
  'agent-tools': ['给 AI 注册工具', 'AI 可以调用它提供的工具'],
  http: ['注册控制台接口', '在控制台里提供自己的接口'],
};

function reset() { info.value = null; url.value = ''; if (fileInput.value) fileInput.value.value = ''; }
async function check(body: () => Promise<any>) {
  busy.value = true;
  try { info.value = await body(); } catch (e: any) { msg.error(e.message); } finally { busy.value = false; }
}
function pick(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (!f) return;
  check(async () => {
    const fd = new FormData();
    fd.append('file', f);
    const res = await fetch('/api/plugins/package', { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data;
  });
}
const fromUrl = () => check(() => api('/api/plugins/package-url', { body: { url: url.value.trim() } }));
async function install() {
  busy.value = true;
  try {
    const r = await api(`/api/plugins/package/${info.value.id}/install`, { method: 'POST' });
    if (r.error) msg.warning(`已安装，但没能启动：${r.error}`); else msg.success(`已安装 ${info.value.manifest.displayName ?? r.name}`);
    emit('installed', r.name);
    show.value = false;
    reset();
  } catch (e: any) { msg.error(e.message); } finally { busy.value = false; }
}
</script>

<template>
  <n-modal v-model:show="show" preset="card" title="安装插件" style="width: min(560px, calc(100vw - 32px))" @after-leave="reset">
    <template v-if="!info">
      <div class="hint">插件包是一个 zip，里面有 plugin.json 和入口文件。开发者可以用 <code>qab plugin pack 目录</code> 打包。</div>
      <n-space vertical :size="10" style="margin-top: 12px">
        <div>
          <input ref="fileInput" type="file" accept=".zip,application/zip" hidden @change="pick" />
          <n-button :loading="busy" @click="fileInput?.click()">选择 zip 文件…</n-button>
        </div>
        <div class="row">
          <n-input v-model:value="url" placeholder="或者填插件包地址（https://…/xxx.zip）" :disabled="busy" @keydown.enter="url.trim() && fromUrl()" />
          <n-button :disabled="!url.trim()" :loading="busy" @click="fromUrl">读取</n-button>
        </div>
      </n-space>
    </template>
    <template v-else>
      <div class="name">{{ info.manifest.displayName || info.manifest.name }} <span class="ver">v{{ info.manifest.version || '?' }}</span></div>
      <div v-if="info.manifest.description" class="hint">{{ info.manifest.description }}</div>
      <div v-if="info.manifest.author" class="hint">作者：{{ info.manifest.author }}</div>
      <n-alert v-if="info.installed !== null" type="info" :show-icon="false" class="gap">已安装 v{{ info.installed || '?' }}，安装后会替换旧版代码（旧版会备份），插件的数据和设置保留。</n-alert>
      <div class="gap"><b>需要的权限</b></div>
      <div v-if="!info.manifest.permissions?.length" class="hint">不需要任何权限。</div>
      <div v-for="p in info.manifest.permissions ?? []" :key="p" class="perm">
        <n-tag size="small" :bordered="false">{{ PERM[p]?.[0] ?? p }}</n-tag>
        <span class="hint">{{ PERM[p]?.[1] ?? '未知权限，会被忽略' }}</span>
      </div>
      <n-alert v-for="w in info.warnings" :key="w" type="warning" :show-icon="false" class="gap">{{ w }}</n-alert>
      <n-alert v-if="info.problems.length" type="error" :show-icon="false" class="gap">
        不能安装：
        <div v-for="p in info.problems" :key="p">· {{ p }}</div>
      </n-alert>
      <div class="hint gap">插件和 QAB 运行在同一个进程里。只安装你信任的来源。</div>
      <n-space justify="end" class="gap">
        <n-button @click="reset">换一个</n-button>
        <n-button type="primary" :disabled="info.problems.length > 0" :loading="busy" @click="install">安装并启用</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.row { display: flex; gap: 8px; }
.name { font-size: 15px; font-weight: 600; }
.ver { font-size: 12px; font-weight: 400; opacity: .55; }
.gap { margin-top: 10px; }
.perm { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; }
</style>
