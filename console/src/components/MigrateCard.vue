<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NCard, NSpace, NButton, NInput, NCheckbox, NAlert, NText, NPopconfirm, useMessage } from 'naive-ui';
import { api } from '../api';

const msg = useMessage();
const dir = ref('');
const det = ref<any>(null);
const opts = ref({ config: true, roles: true, social: true, stickers: true, memory: true, usage: true, slang: true });
const LABEL: Record<string, string> = { config: '主配置（白名单/管理员/DSH 模型/节奏/价目）', roles: '人格卡', social: '仿真参数与各会话唤醒状态', stickers: '表情包备注与理解', memory: '话题/想法/成员印象 → 记忆', usage: 'Token 用量历史', slang: '黑话（暂存）' };
const running = ref(false);
const report = ref<any>(null);

async function detect() {
  const r = await api(`/api/migrate/qq-bridge${dir.value ? `?dir=${encodeURIComponent(dir.value)}` : ''}`);
  dir.value = r.dir; det.value = r.detected;
}
async function run() {
  running.value = true;
  try { report.value = await api('/api/migrate/qq-bridge', { body: { dir: dir.value, options: opts.value } }); msg.success('迁移完成'); }
  catch (e: any) { msg.error(e.message); } finally { running.value = false; }
}
onMounted(detect);
</script>

<template>
  <n-card title="从 qq-bridge 迁移" size="small">
    <n-text depth="3" style="font-size: 13px">只读取 qq-bridge 的文件，不会修改它；可重复执行，已导入的内容不会重复。</n-text>
    <n-space align="center" style="margin-top: 8px">
      <n-input v-model:value="dir" placeholder="qq-bridge 目录，如 D:\AI\QQ\qq-bridge" style="width: 340px" />
      <n-button size="small" @click="detect">检测</n-button>
    </n-space>
    <n-alert v-if="det" type="info" :show-icon="false" style="margin-top: 8px; font-size: 13px">
      人格卡 {{ det.roles.length }} 个（{{ det.roles.join('、') }}）｜仿真会话 {{ det.sessions.join('、') || '无' }}｜表情包 {{ det.stickers }}｜黑话 {{ det.slang }}｜用量记录 {{ det.usageLines }} 条{{ det.currentRole ? `｜当前人格 ${det.currentRole}` : '' }}
    </n-alert>
    <n-alert v-else-if="dir" type="warning" :show-icon="false" style="margin-top: 8px">这个目录看起来不是 qq-bridge</n-alert>
    <n-space v-if="det" vertical :size="2" style="margin-top: 8px">
      <n-checkbox v-for="(l, k) in LABEL" :key="k" v-model:checked="(opts as any)[k]">{{ l }}</n-checkbox>
    </n-space>
    <n-popconfirm v-if="det" @positive-click="run">
      <template #trigger><n-button type="primary" size="small" :loading="running" style="margin-top: 10px">开始迁移</n-button></template>
      将把选中的内容导入本项目（会修改本项目的配置）。继续？
    </n-popconfirm>
    <n-alert v-if="report" :type="report.ok ? 'success' : 'error'" style="margin-top: 10px" :show-icon="false">
      <div v-for="i in report.items" :key="i.what">✓ {{ i.what }}：{{ i.detail }}</div>
      <div v-for="w in report.warnings" :key="w" style="color: #f0a020">! {{ w }}</div>
    </n-alert>
  </n-card>
</template>
