<script setup lang="ts">
import { h, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard, NSpace, NButton, NSwitch, NTag, NSelect, NDataTable, NAlert, NInput, NModal, NText, NCode, NPopconfirm, NEmpty, useMessage, type DataTableColumns,
} from 'naive-ui';
import { api, onPush, fmtTime } from '../api';

const msg = useMessage();
const router = useRouter();
const convs = ref<any[]>([]);
const roles = ref<any[]>([]);
const err = ref('');
const editing = ref<{ name: string; content: string; isNew?: boolean } | null>(null);
const preview = ref('');
const asks = ref<any[]>([]);
async function loadAsks() { try { asks.value = await api('/api/p/ask-admin/requests'); } catch { asks.value = []; } }
async function decideAsk(id: number, approve: boolean) {
  const note = approve ? '' : (window.prompt('拒绝理由（可空，会转告 AI）') ?? '');
  try { const r = await api(`/api/p/ask-admin/requests/${id}`, { body: { approve, note } }); msg.success(r.message); loadAsks(); } catch (e: any) { msg.error(e.message); }
}

async function load() {
  try {
    [convs.value, roles.value] = await Promise.all([api('/api/p/social/convs'), api('/api/p/social/roles')]);
    loadAsks();
    err.value = '';
  } catch (e: any) { err.value = e.status === 404 ? '「仿真与人格」插件未启用：请在「插件」页开启 social' : e.message; }
}
async function op(conv: string, o: string, body?: unknown) {
  try { await api(`/api/p/social/convs/${conv}/${o}`, { body: body ?? {} }); msg.success('完成'); setTimeout(load, 600); } catch (e: any) { msg.error(e.message); }
}
async function openRole(name: string) { const r = await api(`/api/p/social/roles/${encodeURIComponent(name)}`); editing.value = { name: r.name, content: r.content }; }
async function saveRole() {
  if (!editing.value) return;
  try { await api(`/api/p/social/roles/${encodeURIComponent(editing.value.name)}`, { method: 'PUT', body: { content: editing.value.content } }); msg.success('已保存（下次唤醒生效）'); editing.value = null; load(); }
  catch (e: any) { msg.error(e.message); }
}
async function delRole(name: string) { await api(`/api/p/social/roles/${encodeURIComponent(name)}`, { method: 'DELETE' }); load(); }
async function showPreview(conv: string) { preview.value = (await api(`/api/p/social/preview/${conv}`)).prompt; }

const MODE: Record<string, [string, any]> = { active: ['活跃', 'success'], diving: ['潜水', 'info'], sleeping: ['沉睡', 'default'] };
const cols: DataTableColumns<any> = [
  { title: '启用', key: 'enabled', width: 64, render: (r) => h(NSwitch, { size: 'small', value: r.enabled, onUpdateValue: (v: boolean) => op(r.conv, v ? 'enable' : 'disable') }) },
  { title: '会话', key: 'conv', render: (r) => h('div', [h('div', r.name || r.conv), h('div', { style: 'font-size:12px;opacity:.55' }, r.conv)]) },
  { title: '状态', key: 'mode', width: 170, render: (r) => h(NSpace, { size: 4 }, { default: () => [
    h(NTag, { size: 'small', type: MODE[r.mode]?.[1] }, { default: () => MODE[r.mode]?.[0] ?? r.mode }),
    r.busy ? h(NTag, { size: 'small', type: 'warning' }, { default: () => '思考中' }) : null,
    r.pending ? h(NTag, { size: 'small', bordered: false }, { default: () => `待唤醒:${r.pending.reason}` }) : null,
  ] }) },
  { title: '人格', key: 'role', width: 160, render: (r) => h(NSelect, { size: 'small', value: r.role, options: roles.value.map((x) => ({ label: x.name, value: x.name })), onUpdateValue: (v: string) => op(r.conv, 'role', { role: v }) }) },
  { title: '唤醒', key: 'wakes', width: 140, render: (r) => h('div', { style: 'font-size:12px' }, [`${r.wakes} 次`, r.lastWakeAt ? ` · ${fmtTime(r.lastWakeAt)}` : '', r.lastReason ? h('div', { style: 'opacity:.6' }, r.lastReason) : null]) },
  { title: '', key: 'ops', width: 300, render: (r) => h(NSpace, { size: 4 }, { default: () => [
    h(NButton, { size: 'tiny', disabled: !r.enabled, onClick: () => op(r.conv, 'wake') }, { default: () => '唤醒一次' }),
    h(NSelect, { size: 'tiny', style: 'width:84px', placeholder: '切换', value: null, options: [{ label: '活跃', value: 'active' }, { label: '潜水', value: 'diving' }, { label: '沉睡30分', value: 'sleeping' }], onUpdateValue: (v: string) => op(r.conv, 'mode', { mode: v, minutes: 30 }) }),
    h(NButton, { size: 'tiny', onClick: () => showPreview(r.conv) }, { default: () => '提示词预览' }),
    h(NPopconfirm, { onPositiveClick: () => op(r.conv, 'reset') }, { trigger: () => h(NButton, { size: 'tiny', type: 'warning', ghost: true }, { default: () => '重置上下文' }), default: () => '丢弃该会话的 AI 上下文并新建会话？' }),
  ] }) },
];

let t: any;
const off = onPush((type) => { if (type === 'message' || type === 'usage' || type === 'driver') { clearTimeout(t); t = setTimeout(load, 1500); } });
onMounted(load);
onUnmounted(() => { off(); clearTimeout(t); });
</script>

<template>
  <n-space vertical :size="14">
    <n-alert v-if="err" type="warning">{{ err }}</n-alert>
    <n-alert type="info" :show-icon="false" style="font-size: 13px">
      仿真 = 让 Agent 像真人群友一样自主聊天。被 @、叫名字、提问、命中关键词时唤醒；它会自己决定说不说、说几句、接下来潜水还是沉睡。
      需要先在「Agent 接入」页接入 DeepSeek Harness。唤醒参数（关键词、概率、主动发言等）在
      <a style="cursor: pointer; color: #12b7f5" @click="router.push('/plugins')">插件 → 仿真与人格 → 配置</a> 中调整。
      QQ 里管理员也可以发：/仿真 开|关|唤醒|重置、/人格 名字、进入角色扮演：名字。
    </n-alert>

    <n-card v-if="asks.length" title="待处理的请示" size="small" style="border-color: #f0a020">
      <div v-for="a in asks" :key="a.id" style="padding: 6px 0; border-bottom: 1px dashed rgba(128,128,128,.25)">
        <b>#{{ a.id }}</b> {{ a.conv }} · {{ a.requester_name || a.requester }}({{ a.requester }})：{{ a.content }}
        <div v-if="a.reason" style="font-size: 12px; opacity: .65">AI 拿不准的原因：{{ a.reason }}</div>
        <n-space style="margin-top: 4px"><n-button size="tiny" type="primary" @click="decideAsk(a.id, true)">同意</n-button><n-button size="tiny" @click="decideAsk(a.id, false)">拒绝</n-button></n-space>
      </div>
      <n-text depth="3" style="font-size: 12px">也可以直接在 QQ 私聊里回复机器人「同意 编号」或「拒绝 编号 理由」。</n-text>
    </n-card>

    <n-card title="会话" size="small">
      <n-data-table :columns="cols" :data="convs" size="small" :row-key="(r: any) => r.conv" />
    </n-card>

    <n-card title="人格卡" size="small">
      <template #header-extra><n-button size="small" type="primary" @click="editing = { name: '', content: '# 角色卡：\n\n## 一、你是谁\n\n## 二、说话风格\n\n## 三、性格与反应\n\n## 四、梗与背景（可选）\n\n## 五、回复示例\n', isNew: true }">新建</n-button></template>
      <n-text depth="3" style="font-size: 12px">人格卡只写「你是谁、怎么说话」，不要写工具用法。格式与 qq-bridge 的 roles/*.md 兼容（〔二代〕标签的章节会保留、〔一代〕的会去掉）。</n-text>
      <n-empty v-if="!roles.length" description="没有人格卡" />
      <n-space style="margin-top: 8px">
        <n-card v-for="r in roles" :key="r.name" size="small" embedded style="width: 220px">
          <b>{{ r.name }}</b>
          <div style="font-size: 12px; opacity: .6">注入 {{ r.injectChars }} 字 · {{ fmtTime(r.mtime) }}</div>
          <n-space style="margin-top: 6px" :size="4">
            <n-button size="tiny" @click="openRole(r.name)">编辑</n-button>
            <n-popconfirm @positive-click="delRole(r.name)"><template #trigger><n-button size="tiny" type="error" ghost>删除</n-button></template>删除人格卡「{{ r.name }}」？</n-popconfirm>
          </n-space>
        </n-card>
      </n-space>
    </n-card>

    <n-modal :show="!!editing" preset="card" :title="editing?.isNew ? '新建人格卡' : `编辑人格卡：${editing?.name}`" style="max-width: 760px" @update:show="(v: boolean) => !v && (editing = null)">
      <n-input v-if="editing?.isNew" v-model:value="editing!.name" placeholder="人格名（文件名）" style="margin-bottom: 8px" />
      <n-input v-if="editing" v-model:value="editing.content" type="textarea" :autosize="{ minRows: 16, maxRows: 30 }" style="font-family: monospace" />
      <template #footer><n-space justify="end"><n-button @click="editing = null">取消</n-button><n-button type="primary" :disabled="!editing?.name" @click="saveRole">保存</n-button></n-space></template>
    </n-modal>

    <n-modal :show="!!preview" preset="card" title="唤醒提示词预览（发给 Agent 的内容）" style="max-width: 820px" @update:show="(v: boolean) => !v && (preview = '')">
      <n-code :code="preview" word-wrap style="max-height: 65vh; overflow: auto; font-size: 12px" />
    </n-modal>
  </n-space>
</template>
