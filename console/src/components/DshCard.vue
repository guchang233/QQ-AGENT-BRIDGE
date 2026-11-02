<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue';
import { NCard, NSpace, NButton, NTag, NAlert, NForm, NFormItem, NInput, NInputNumber, NSelect, NSwitch, NText, NPopconfirm, useMessage } from 'naive-ui';
import { api, onPush, isNarrow } from '../api';
import PageHint from './PageHint.vue';

const msg = useMessage();
const info = ref<any>(null);
const form = ref<any>({});
const busy = ref('');
const result = ref<{ steps: string[]; warnings: string[]; restartRequired?: boolean } | null>(null);
const test = ref<any>(null);

async function load() {
  info.value = await api('/api/drivers');
  form.value = { ...info.value.dsh.config };
  loadModels();
}

// 模型目录：从 DSH 读取实际可用的服务商和模型，只能从中选择
const catalog = ref<any>(null);
const loadingModels = ref(false);
async function loadModels() {
  loadingModels.value = true;
  try { catalog.value = await api('/api/drivers/dsh/models'); } catch (e: any) { catalog.value = { ok: false, error: e.message }; } finally { loadingModels.value = false; }
}
const providers = computed<any[]>(() => (catalog.value?.ok ? catalog.value.providers : []));
const providerOptions = computed(() => providers.value.map((p) => ({ label: p.name === p.id ? p.id : `${p.name}（${p.id}）`, value: p.id })));
const curProvider = computed(() => providers.value.find((p) => p.id === form.value.provider));
const modelOptions = computed(() => (curProvider.value?.models ?? []).map((m: any) => ({ label: m.name === m.id ? m.id : `${m.name}（${m.id}）`, value: m.id })));
const curModel = computed(() => curProvider.value?.models.find((m: any) => m.id === form.value.model));
const effortOptions = computed(() => (curModel.value?.efforts?.length ? curModel.value.efforts : ['off', 'low', 'high', 'max']).map((v: string) => ({ label: v, value: v })));
/** 当前配置在 DSH 里不存在（保存前提示） */
const invalidModel = computed(() => catalog.value?.ok && form.value.model && !curModel.value);
function pickProvider(id: string) {
  form.value.provider = id;
  const p = providers.value.find((x) => x.id === id);
  if (p && !p.models.some((m: any) => m.id === form.value.model)) pickModel(p.models[0]?.id ?? '');
}
function pickModel(id: string) {
  form.value.model = id;
  const m = curProvider.value?.models.find((x: any) => x.id === id);
  if (m?.efforts?.length && !m.efforts.includes(form.value.reasoningEffort)) form.value.reasoningEffort = m.defaultEffort ?? m.efforts[0];
}
const status = computed(() => info.value?.drivers?.find((d: any) => d.id === 'dsh'));
const setup = computed(() => info.value?.dsh?.setup);
const stateTag = computed(() => ({ ready: ['success', '已连接'], connecting: ['warning', '连接中'], error: ['error', '异常'], disabled: ['default', '未启用'] } as any)[status.value?.state ?? 'disabled']);

async function install() {
  busy.value = 'install';
  try { result.value = await api('/api/drivers/dsh/install', { method: 'POST' }); msg.success('已写入 DSH 配置'); await load(); }
  catch (e: any) { msg.error(e.message); } finally { busy.value = ''; }
}
async function uninstall() {
  busy.value = 'uninstall';
  try { const r = await api('/api/drivers/dsh/uninstall', { method: 'POST' }); result.value = { steps: r.steps, warnings: [] }; await load(); }
  catch (e: any) { msg.error(e.message); } finally { busy.value = ''; }
}
async function doTest() {
  busy.value = 'test';
  try { test.value = await api('/api/drivers/dsh/test', { method: 'POST' }); } finally { busy.value = ''; }
}
async function save() {
  try { await api('/api/drivers/dsh/config', { method: 'PUT', body: form.value }); msg.success('已保存，驱动已重连'); await load(); } catch (e: any) { msg.error(e.message); }
}
const off = onPush((t) => { if (t === 'driver') load(); });
onMounted(load);
onUnmounted(off);
</script>

<template>
  <n-card v-if="info" title="DeepSeek Harness（主动驱动）" size="small">
    <template #header-extra>
      <n-space align="center">
        <n-tag :type="stateTag[0]" size="small">{{ stateTag[1] }}</n-tag>
        <n-text depth="3" style="font-size: 12px">{{ status?.detail }}</n-text>
      </n-space>
    </template>
    <PageHint text="把 QQ 新消息推给 DSH，AI 通过 QQ 工具自主回复（配合「仿真与人格」插件使用）。">
      每个 QQ 会话对应一个 DSH 会话，只开放 QQ 工具，DSH 的命令行和文件工具全部屏蔽。profile：{{ setup.profile }}（{{ setup.profileDir }}）
    </PageHint>
    <div class="toolbar" style="margin-top: 6px">
      <n-tag size="small" :bordered="false" :type="setup.mcpRegistered ? 'success' : 'default'">MCP 服务{{ setup.mcpRegistered ? '已注册' : '未注册' }}</n-tag>
      <n-tag size="small" :bordered="false" :type="setup.bundleRegistered && setup.bundleLinked ? 'success' : 'default'">QQ 预设{{ setup.bundleRegistered && setup.bundleLinked ? '已安装' : '未安装' }}</n-tag>
      <n-tag size="small" :bordered="false" :type="setup.tokenReady ? 'success' : 'default'">会话令牌{{ setup.tokenReady ? '就绪' : '未创建' }}</n-tag>
      <span class="hint">地址 <code>{{ info.dsh.config.baseUrl }}</code></span>
    </div>

    <n-alert v-if="setup.mcpProblem" type="warning" :show-icon="false" style="margin-top: 8px; font-size: 13px">{{ setup.mcpProblem }}</n-alert>
    <n-alert v-if="setup.qqBridgeDetected" type="info" :show-icon="false" style="margin-top: 8px; font-size: 13px">
      检测到 qq-bridge 的 DSH 配置。一键接入只会添加本项目自己的区块（MCP「qq」、预设「qab-qq」），不会改动 qq-bridge 的任何条目，两者可以共存。
    </n-alert>

    <n-space style="margin-top: 8px" :size="6">
      <n-popconfirm @positive-click="install">
        <template #trigger><n-button size="small" type="primary" :loading="busy === 'install'">{{ setup.mcpRegistered ? '重新接入（更新预设）' : '一键接入 DSH' }}</n-button></template>
        将在 {{ setup.profileDir }} 的 cordis.patch.yml 中注册 MCP（会先备份，并清理重复或残缺的旧注册），并通过 DSH 自己的插件管理器安装预设 bundle。<br />
        DSH 使用的令牌会恢复为「会话隔离」：AI 每次只能操作被唤醒的那个会话。继续？
      </n-popconfirm>
      <n-button size="small" :loading="busy === 'test'" @click="doTest">测试连接</n-button>
      <n-popconfirm v-if="setup.mcpRegistered || setup.bundleRegistered" @positive-click="uninstall">
        <template #trigger><n-button size="small" quaternary type="error" :loading="busy === 'uninstall'">移除接入</n-button></template>
        从 DSH 中移除本项目的 MCP 与预设（不影响 qq-bridge）。继续？
      </n-popconfirm>
    </n-space>

    <n-alert v-if="test" :type="test.ok ? (test.hasPreset ? 'success' : 'warning') : 'error'" style="margin-top: 10px" :show-icon="false">
      <template v-if="test.ok">连接正常。DSH 预设：{{ test.presets.join('、') }}。{{ test.hasPreset ? '已找到 qab-qq 预设，可以开始使用。' : '还没有 qab-qq 预设：请点「一键接入」后重启 DSH。' }}</template>
      <template v-else>{{ test.error }}</template>
    </n-alert>
    <n-alert v-if="result" type="success" style="margin-top: 10px" :show-icon="false" closable @close="result = null">
      <div v-for="s in result.steps" :key="s">✓ {{ s }}</div>
      <div v-for="w in result.warnings" :key="w" style="color: #f0a020">! {{ w }}</div>
      <div v-if="result.restartRequired" style="margin-top: 6px"><b>请重启 DSH 使配置生效</b>，然后点「测试连接」确认。</div>
      <div v-else-if="result.restartRequired === false" style="margin-top: 6px">DSH 已即时加载，无需重启。可以去「插件 → 仿真与人格」启用会话了。</div>
    </n-alert>

    <div class="sec">模型与连接</div>
    <n-form class="form-2" :label-placement="isNarrow ? 'top' : 'left'" label-width="72" size="small">
      <template v-if="catalog?.ok">
        <n-form-item label="服务商"><n-select :value="form.provider" :options="providerOptions" :loading="loadingModels" @update:value="pickProvider" /></n-form-item>
        <n-form-item label="模型"><n-select :value="form.model" :options="modelOptions" filterable :loading="loadingModels" @update:value="pickModel" /></n-form-item>
      </template>
      <template v-else>
        <n-form-item label="服务商"><n-input v-model:value="form.provider" placeholder="deepseek-official" /></n-form-item>
        <n-form-item label="模型"><n-input v-model:value="form.model" placeholder="deepseek-flash" /></n-form-item>
      </template>
      <n-form-item label="思考强度"><n-select v-model:value="form.reasoningEffort" :options="effortOptions" /></n-form-item>
      <n-form-item label="预设"><n-input v-model:value="form.preset" /></n-form-item>
      <n-form-item label="卡住判定"><n-input-number v-model:value="form.stallMinutes" :min="1" :max="120" style="width: 110px"><template #suffix>分钟</template></n-input-number><span class="switch-hint">一轮这么久没有任何进展就自动结束</span></n-form-item>
      <n-form-item label="工具审批"><n-select v-model:value="form.approvals" :options="[{ label: '一律拒绝（推荐）', value: 'reject' }, { label: '交给控制台审批', value: 'console' }]" /></n-form-item>
      <n-form-item label="地址"><n-input v-model:value="form.baseUrl" /></n-form-item>
      <n-form-item label="自动发现"><n-switch v-model:value="form.autoDiscover" /><span class="switch-hint">自动找本机 DSH 端口</span></n-form-item>
      <n-form-item label="启用驱动"><n-switch v-model:value="form.enabled" /></n-form-item>
    </n-form>
    <n-alert v-if="invalidModel" type="warning" :show-icon="false" style="margin-bottom: 8px; font-size: 13px">
      当前配置的 {{ form.provider }}/{{ form.model }} 在 DSH 里不存在，实际会用 DSH 的默认模型。请从下拉框重新选择后保存。
    </n-alert>
    <n-text v-else-if="catalog && !catalog.ok" depth="3" style="display: block; margin-bottom: 8px; font-size: 12px">
      读不到 DSH 的模型列表（{{ catalog.error }}），只能手动填写。DSH 启动后<a style="cursor: pointer" @click="loadModels">重新读取</a>。
    </n-text>
    <n-button size="small" type="primary" @click="save">保存</n-button>
  </n-card>
</template>

<style scoped>
.sec { margin: 12px 0 6px; font-size: 13px; font-weight: 600; }
</style>
