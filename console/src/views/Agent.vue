<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NCard, NSpace, NButton, NInput, NTag, NCheckboxGroup, NCheckbox, NSwitch, NDataTable, NPopconfirm, NTabs, NTabPane, NCode, NAlert,
  NRadioGroup, NRadioButton, NForm, NFormItem, NDynamicTags, NEmpty, NText, NModal, useMessage, type DataTableColumns,
} from 'naive-ui';
import { h } from 'vue';
import { api, state, refreshApprovals, TIER_LABEL, TIER_TYPE, fmtFull, fmtTime, isNarrow } from '../api';
import DshCard from '../components/DshCard.vue';
import MigrateCard from '../components/MigrateCard.vue';

const msg = useMessage();
const tokens = ref<any[]>([]);
const tools = ref<any[]>([]);
const config = ref<any>(null);
const showNew = ref(false);
const newTok = ref({ name: '', tiers: ['read', 'send'] as string[], groups: [] as string[], private: [] as string[] });
const reveal = ref<Record<string, boolean>>({});
const openCfg = ref<Record<string, boolean>>({});
const loaded = ref(false);
const toolFilter = ref('');

const mcpUrl = computed(() => state.status?.mcpUrl ?? `${location.origin}/mcp`);
const root = computed(() => state.status?.root ?? '<qab 安装目录>');

async function load() {
  [tokens.value, tools.value] = await Promise.all([api('/api/tokens'), api('/api/tools')]);
  loaded.value = true;
  config.value = (await api('/api/config')).config;
  state.status = await api('/api/status');
  refreshApprovals();
}

async function createToken() {
  const t = await api('/api/tokens', { body: newTok.value });
  msg.success(`已创建 ${t.name}`); showNew.value = false;
  newTok.value = { name: '', tiers: ['read', 'send'], groups: [], private: [] };
  load();
}
async function updateToken(t: any, patch: any) { await api(`/api/tokens/${t.token}`, { method: 'PUT', body: patch }); Object.assign(t, patch); msg.success('已保存'); }
async function deleteToken(t: any) { await api(`/api/tokens/${t.token}`, { method: 'DELETE' }); load(); }
function copy(text: string) { navigator.clipboard.writeText(text); msg.success('已复制'); }

async function savePolicy() {
  await api('/api/config', { method: 'PUT', body: config.value });
  msg.success('策略已保存');
}
async function toggleTool(name: string, enabled: boolean) {
  const set = new Set<string>(config.value.agents.disabledTools);
  enabled ? set.delete(name) : set.add(name);
  config.value.agents.disabledTools = [...set];
  await api('/api/config', { method: 'PUT', body: config.value });
  tools.value.find((t) => t.name === name).disabled = !enabled;
}
async function decide(id: string, approve: boolean) { await api(`/api/approvals/${id}`, { body: { approve } }); refreshApprovals(); }

const claudeHttp = (t: any) => `claude mcp add --transport http qq ${mcpUrl.value} --header "Authorization: Bearer ${t.token}"`;
const jsonCfg = (t: any) => JSON.stringify({ mcpServers: { qq: { type: 'http', url: mcpUrl.value, headers: { Authorization: `Bearer ${t.token}` } } } }, null, 2);
const stdioCfg = (t: any) => JSON.stringify({ mcpServers: { qq: { command: 'node', args: [`${root.value}/bin/qab.mjs`, 'mcp', '--token', t.token] } } }, null, 2);

const toolCols: DataTableColumns<any> = [
  { title: '启用', key: 'en', width: 64, render: (r) => h(NSwitch, { size: 'small', value: !r.disabled, onUpdateValue: (v: boolean) => toggleTool(r.name, v) }) },
  { title: '工具', key: 'name', width: 210, render: (r) => h('div', [h('code', r.name), h('div', { style: 'font-size:12px;opacity:.6' }, r.title)]) },
  { title: '等级', key: 'tier', width: 70, render: (r) => h(NTag, { size: 'small', type: TIER_TYPE[r.tier] }, { default: () => TIER_LABEL[r.tier] }) },
  { title: '说明', key: 'description', ellipsis: { tooltip: { style: { maxWidth: '480px', whiteSpace: 'pre-wrap' } } } },
];
const filteredTools = computed(() => tools.value.filter((t) => !toolFilter.value || t.name.includes(toolFilter.value) || t.title.includes(toolFilter.value) || t.description.includes(toolFilter.value)));

onMounted(load);
</script>

<template>
  <div class="page">
    <n-card v-if="state.approvals.length" :title="`待审批 ${state.approvals.length}`" size="small" style="border-color: #f0a020">
      <div v-for="a in state.approvals" :key="a.id" class="appr">
        <div class="min0">
          <div><n-tag size="tiny" :type="TIER_TYPE[a.tier]" :bordered="false">{{ TIER_LABEL[a.tier] }}</n-tag> <b>{{ a.caller }}</b> → <code>{{ a.tool }}</code> <span class="hint">{{ fmtTime(a.ts) }}</span></div>
          <div class="hint">{{ a.summary }}</div>
        </div>
        <n-space :size="4" :wrap="false"><n-button size="tiny" @click="decide(a.id, false)">拒绝</n-button><n-button size="tiny" type="primary" @click="decide(a.id, true)">批准</n-button></n-space>
      </div>
    </n-card>

    <n-tabs type="line" size="small" animated>
      <n-tab-pane name="dsh" tab="DeepSeek Harness"><DshCard /></n-tab-pane>

      <n-tab-pane name="mcp" tab="MCP 接入">
        <div class="page">
          <div class="toolbar">
            <span class="hint">MCP 地址</span><code>{{ mcpUrl }}</code><n-button size="tiny" quaternary @click="copy(mcpUrl)">复制</n-button>
            <span class="hint">在线：{{ state.status?.mcpSessions?.map((s: any) => s.caller).join('、') || '无' }}</span>
            <span class="grow" />
            <n-button size="small" type="primary" @click="showNew = true">新建 Token</n-button>
          </div>
          <n-card v-if="loaded && !tokens.length" size="small"><span class="hint">还没有 Token。Claude Code、Cursor 等客户端需要一个 Token 才能接入。</span></n-card>
          <n-card v-for="t in tokens" :key="t.token" size="small">
            <div class="toolbar">
              <n-switch size="small" :value="t.enabled" @update:value="(v: boolean) => updateToken(t, { enabled: v })" />
              <b>{{ t.name }}</b>
              <code class="hint">{{ reveal[t.token] ? t.token : t.token.slice(0, 8) + '••••••••' }}</code>
              <n-button size="tiny" quaternary @click="reveal[t.token] = !reveal[t.token]">{{ reveal[t.token] ? '隐藏' : '显示' }}</n-button>
              <n-button size="tiny" quaternary @click="copy(t.token)">复制</n-button>
              <span class="grow" />
              <n-button size="tiny" quaternary @click="openCfg[t.token] = !openCfg[t.token]">{{ openCfg[t.token] ? '收起' : '接入配置' }}</n-button>
              <n-popconfirm @positive-click="deleteToken(t)"><template #trigger><n-button size="tiny" quaternary type="error">删除</n-button></template>删除后使用该 token 的 Agent 将无法连接</n-popconfirm>
            </div>
            <div class="toolbar row2">
              <span class="hint">权限</span>
              <n-checkbox-group :value="t.tiers" @update:value="(v: any) => updateToken(t, { tiers: v })"><n-space :size="10"><n-checkbox v-for="(l, k) in TIER_LABEL" :key="k" size="small" :value="k" :label="l" /></n-space></n-checkbox-group>
            </div>
            <div class="toolbar row2">
              <span class="hint">限定群</span><n-dynamic-tags size="small" :value="t.groups" @update:value="(v: any) => updateToken(t, { groups: v })" />
              <span class="hint">限定私聊</span><n-dynamic-tags size="small" :value="t.private" @update:value="(v: any) => updateToken(t, { private: v })" />
            </div>
            <n-tabs v-if="openCfg[t.token]" type="line" size="small" style="margin-top: 6px">
              <n-tab-pane name="claude" tab="Claude Code"><n-code :code="claudeHttp(t)" language="bash" word-wrap /><n-button size="tiny" style="margin-top: 4px" @click="copy(claudeHttp(t))">复制命令</n-button></n-tab-pane>
              <n-tab-pane name="json" tab="JSON（Cursor / Cline 等）"><n-code :code="jsonCfg(t)" language="json" /><n-button size="tiny" style="margin-top: 4px" @click="copy(jsonCfg(t))">复制</n-button></n-tab-pane>
              <n-tab-pane name="stdio" tab="stdio"><p class="hint" style="margin: 0 0 4px">仅支持 stdio 的客户端使用；会代理到本守护进程，未运行时独立启动。</p><n-code :code="stdioCfg(t)" language="json" /><n-button size="tiny" style="margin-top: 4px" @click="copy(stdioCfg(t))">复制</n-button></n-tab-pane>
            </n-tabs>
          </n-card>
        </div>
      </n-tab-pane>

      <n-tab-pane name="policy" tab="权限与工具">
        <div class="page">
          <n-card v-if="config" title="权限策略" size="small">
            <template #header-extra><n-button type="primary" size="tiny" @click="savePolicy">保存策略</n-button></template>
            <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="80">
              <n-form-item v-for="(l, k) in TIER_LABEL" :key="k" :label="l">
                <n-radio-group v-model:value="config.agents.policy[k]" size="small">
                  <n-radio-button value="allow">直接放行</n-radio-button><n-radio-button value="approve">人工审批</n-radio-button><n-radio-button value="deny">禁止</n-radio-button>
                </n-radio-group>
              </n-form-item>
              <n-form-item label="全局只读"><n-switch v-model:value="config.access.readOnly" /><span class="switch-hint">开启后 Agent 只能读取，发送和管理都会被拒绝</span></n-form-item>
            </n-form>
          </n-card>
          <n-card :title="`MCP 工具 ${tools.length}`" size="small">
            <template #header-extra><n-input v-model:value="toolFilter" size="small" placeholder="筛选" clearable style="width: 160px" /></template>
            <p class="hint" style="margin: 0 0 6px">关闭用不到的工具，可以减少 Agent 的上下文占用。</p>
            <n-data-table :columns="toolCols" :data="filteredTools" size="small" :max-height="'calc(100vh - 300px)'" :scroll-x="640" :row-key="(r: any) => r.name" />
          </n-card>
        </div>
      </n-tab-pane>

      <n-tab-pane name="migrate" tab="迁移"><MigrateCard /></n-tab-pane>
    </n-tabs>

    <n-modal v-model:show="showNew" preset="card" title="新建 Agent Token" style="max-width: 480px">
      <n-form label-placement="top">
        <n-form-item label="名称（审计日志中显示）"><n-input v-model:value="newTok.name" placeholder="例如 claude-code" /></n-form-item>
        <n-form-item label="权限等级"><n-checkbox-group v-model:value="newTok.tiers"><n-checkbox v-for="(l, k) in TIER_LABEL" :key="k" :value="k" :label="l" /></n-checkbox-group></n-form-item>
        <n-form-item label="限定群号（可空）"><n-dynamic-tags v-model:value="newTok.groups" /></n-form-item>
        <n-form-item label="限定私聊 QQ（可空）"><n-dynamic-tags v-model:value="newTok.private" /></n-form-item>
      </n-form>
      <template #footer><n-space justify="end"><n-button @click="showNew = false">取消</n-button><n-button type="primary" @click="createToken">创建</n-button></n-space></template>
    </n-modal>
  </div>
</template>

<style scoped>
.min0 { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.appr { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.row2 { margin-top: 6px; }
</style>
