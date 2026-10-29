<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NCard, NSpace, NButton, NInput, NTag, NCheckboxGroup, NCheckbox, NSwitch, NDataTable, NPopconfirm, NTabs, NTabPane, NCode, NAlert,
  NRadioGroup, NRadioButton, NForm, NFormItem, NDynamicTags, NEmpty, NText, NModal, useMessage, type DataTableColumns,
} from 'naive-ui';
import { h } from 'vue';
import { api, state, refreshApprovals, TIER_LABEL, TIER_TYPE, fmtFull, fmtTime } from '../api';

const msg = useMessage();
const tokens = ref<any[]>([]);
const tools = ref<any[]>([]);
const config = ref<any>(null);
const showNew = ref(false);
const newTok = ref({ name: '', tiers: ['read', 'send'] as string[], groups: [] as string[], private: [] as string[] });
const reveal = ref<Record<string, boolean>>({});
const toolFilter = ref('');

const mcpUrl = computed(() => state.status?.mcpUrl ?? `${location.origin}/mcp`);
const root = computed(() => state.status?.root ?? '<qab 安装目录>');

async function load() {
  [tokens.value, tools.value] = await Promise.all([api('/api/tokens'), api('/api/tools')]);
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
  <n-space vertical :size="16">
    <n-card v-if="state.approvals.length" title="待审批" size="small" style="border-color: #f0a020">
      <div v-for="a in state.approvals" :key="a.id" class="appr">
        <div><n-tag size="small" :type="TIER_TYPE[a.tier]">{{ TIER_LABEL[a.tier] }}</n-tag> <b>{{ a.caller }}</b> → <code>{{ a.tool }}</code> <span class="sub">{{ fmtTime(a.ts) }}</span></div>
        <div class="sub2">{{ a.summary }}</div>
        <n-space><n-button size="small" @click="decide(a.id, false)">拒绝</n-button><n-button size="small" type="primary" @click="decide(a.id, true)">批准</n-button></n-space>
      </div>
    </n-card>

    <n-card title="接入方式" size="small">
      <n-text depth="3">MCP 地址：</n-text><code>{{ mcpUrl }}</code>
      <n-button size="tiny" quaternary @click="copy(mcpUrl)">复制</n-button>
      <n-alert type="info" style="margin-top: 8px" :show-icon="false">
        每个 token 代表一个 Agent 身份，可限制权限等级与可操作的会话。在下方 token 卡片中复制对应客户端的配置。
        当前在线会话：{{ state.status?.mcpSessions?.map((s: any) => s.caller).join('、') || '无' }}
      </n-alert>
    </n-card>

    <n-card title="Agent Token" size="small">
      <template #header-extra><n-button size="small" type="primary" @click="showNew = true">新建 Token</n-button></template>
      <n-empty v-if="!tokens.length" description="没有 token" />
      <n-card v-for="t in tokens" :key="t.token" size="small" embedded style="margin-bottom: 10px">
        <n-space align="center" justify="space-between">
          <n-space align="center">
            <b>{{ t.name }}</b>
            <n-switch size="small" :value="t.enabled" @update:value="(v: boolean) => updateToken(t, { enabled: v })" />
            <code style="font-size: 12px">{{ reveal[t.token] ? t.token : t.token.slice(0, 8) + '••••••••' }}</code>
            <n-button size="tiny" quaternary @click="reveal[t.token] = !reveal[t.token]">{{ reveal[t.token] ? '隐藏' : '显示' }}</n-button>
            <n-button size="tiny" quaternary @click="copy(t.token)">复制</n-button>
          </n-space>
          <n-popconfirm @positive-click="deleteToken(t)"><template #trigger><n-button size="tiny" type="error" ghost>删除</n-button></template>删除后使用该 token 的 Agent 将无法连接</n-popconfirm>
        </n-space>
        <n-space align="center" style="margin-top: 8px">
          <span class="sub">权限：</span>
          <n-checkbox-group :value="t.tiers" @update:value="(v: any) => updateToken(t, { tiers: v })">
            <n-checkbox v-for="(l, k) in TIER_LABEL" :key="k" :value="k" :label="l" />
          </n-checkbox-group>
        </n-space>
        <n-space align="center" style="margin-top: 6px">
          <span class="sub">限定群：</span><n-dynamic-tags size="small" :value="t.groups" @update:value="(v: any) => updateToken(t, { groups: v })" />
          <span class="sub">限定私聊：</span><n-dynamic-tags size="small" :value="t.private" @update:value="(v: any) => updateToken(t, { private: v })" />
          <span class="sub">（都为空 = 不额外限制）</span>
        </n-space>
        <n-tabs type="line" size="small" style="margin-top: 6px">
          <n-tab-pane name="claude" tab="Claude Code">
            <n-code :code="claudeHttp(t)" language="bash" word-wrap /><n-button size="tiny" @click="copy(claudeHttp(t))">复制命令</n-button>
          </n-tab-pane>
          <n-tab-pane name="json" tab="JSON（Cursor / Cline 等）">
            <n-code :code="jsonCfg(t)" language="json" /><n-button size="tiny" @click="copy(jsonCfg(t))">复制</n-button>
          </n-tab-pane>
          <n-tab-pane name="stdio" tab="stdio">
            <n-text depth="3" style="font-size: 12px">仅支持 stdio 的客户端使用；会自动代理到本守护进程，守护进程未运行时独立启动。</n-text>
            <n-code :code="stdioCfg(t)" language="json" /><n-button size="tiny" @click="copy(stdioCfg(t))">复制</n-button>
          </n-tab-pane>
        </n-tabs>
      </n-card>
    </n-card>

    <n-card v-if="config" title="权限策略" size="small">
      <n-form label-placement="left" label-width="80">
        <n-form-item v-for="(l, k) in TIER_LABEL" :key="k" :label="l">
          <n-radio-group v-model:value="config.agents.policy[k]" size="small">
            <n-radio-button value="allow">直接放行</n-radio-button>
            <n-radio-button value="approve">人工审批</n-radio-button>
            <n-radio-button value="deny">禁止</n-radio-button>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="全局只读"><n-switch v-model:value="config.access.readOnly" /><n-text depth="3" style="margin-left: 8px; font-size: 12px">开启后 Agent 只能读取，任何发送/管理都会被拒绝</n-text></n-form-item>
      </n-form>
      <n-button type="primary" size="small" @click="savePolicy">保存策略</n-button>
    </n-card>

    <n-card title="MCP 工具" size="small">
      <template #header-extra><n-input v-model:value="toolFilter" size="small" placeholder="筛选" clearable style="width: 180px" /></template>
      <n-text depth="3" style="font-size: 12px">关闭不需要的工具可以减少 Agent 的上下文占用；Agent 只会看到其 token 权限等级内的工具。插件注册的工具也会出现在这里。</n-text>
      <n-data-table :columns="toolCols" :data="filteredTools" size="small" :max-height="460" :row-key="(r: any) => r.name" style="margin-top: 8px" />
    </n-card>

    <n-modal v-model:show="showNew" preset="card" title="新建 Agent Token" style="max-width: 480px">
      <n-form label-placement="top">
        <n-form-item label="名称（审计日志中显示）"><n-input v-model:value="newTok.name" placeholder="例如 claude-code" /></n-form-item>
        <n-form-item label="权限等级">
          <n-checkbox-group v-model:value="newTok.tiers"><n-checkbox v-for="(l, k) in TIER_LABEL" :key="k" :value="k" :label="l" /></n-checkbox-group>
        </n-form-item>
        <n-form-item label="限定群号（可空）"><n-dynamic-tags v-model:value="newTok.groups" /></n-form-item>
        <n-form-item label="限定私聊 QQ（可空）"><n-dynamic-tags v-model:value="newTok.private" /></n-form-item>
      </n-form>
      <template #footer><n-space justify="end"><n-button @click="showNew = false">取消</n-button><n-button type="primary" @click="createToken">创建</n-button></n-space></template>
    </n-modal>
  </n-space>
</template>

<style scoped>
.sub { font-size: 12px; opacity: .6; }
.sub2 { font-size: 13px; margin: 4px 0 6px; opacity: .85; word-break: break-all; }
.appr { padding: 8px 0; border-bottom: 1px dashed rgba(128,128,128,.25); }
</style>
