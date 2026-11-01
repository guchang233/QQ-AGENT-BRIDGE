<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue';
import { NCard, NSpace, NButton, NTag, NAlert, NForm, NFormItem, NInput, NSelect, NSwitch, NText, NList, NListItem, NPopconfirm, useMessage } from 'naive-ui';
import { api, onPush, isNarrow } from '../api';

const msg = useMessage();
const info = ref<any>(null);
const form = ref<any>({});
const busy = ref('');
const result = ref<{ steps: string[]; warnings: string[]; restartRequired?: boolean } | null>(null);
const test = ref<any>(null);

async function load() {
  info.value = await api('/api/drivers');
  form.value = { ...info.value.dsh.config };
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
    <n-text depth="3" style="font-size: 13px">
      桥接把 QQ 新消息推给 DSH 的会话，DSH 的 AI 通过本项目的 MCP 工具自主回复（配合「仿真」页使用）。
      每个 QQ 会话对应一个 DSH 会话，只开放 QQ 工具，DSH 的命令行/文件工具全部屏蔽。
    </n-text>

    <n-list style="margin-top: 8px" size="small">
      <n-list-item>
        <n-space align="center">DSH 地址 <code>{{ info.dsh.config.baseUrl }}</code>
          <n-tag v-if="info.dsh.config.autoDiscover" size="tiny" :bordered="false">桌面版随机端口自动发现</n-tag></n-space>
      </n-list-item>
      <n-list-item>
        <n-space align="center">接入状态：
          <n-tag size="small" :type="setup.mcpRegistered ? 'success' : 'default'">MCP 服务{{ setup.mcpRegistered ? '已注册' : '未注册' }}</n-tag>
          <n-tag size="small" :type="setup.bundleRegistered && setup.bundleLinked ? 'success' : 'default'">QQ 预设{{ setup.bundleRegistered && setup.bundleLinked ? '已安装' : '未安装' }}</n-tag>
          <n-tag size="small" :type="setup.tokenReady ? 'success' : 'default'">会话令牌{{ setup.tokenReady ? '就绪' : '未创建' }}</n-tag>
          <n-text depth="3" style="font-size: 12px">profile：{{ setup.profile }}（{{ setup.profileDir }}）</n-text>
        </n-space>
      </n-list-item>
    </n-list>

    <n-alert v-if="setup.qqBridgeDetected" type="info" :show-icon="false" style="margin-top: 8px; font-size: 13px">
      检测到 qq-bridge 的 DSH 配置。一键接入只会添加本项目自己的区块（MCP「qq」、预设「qab-qq」），不会改动 qq-bridge 的任何条目，两者可以共存。
    </n-alert>

    <n-space style="margin-top: 10px">
      <n-popconfirm @positive-click="install">
        <template #trigger><n-button type="primary" :loading="busy === 'install'">{{ setup.mcpRegistered ? '重新接入（更新预设）' : '一键接入 DSH' }}</n-button></template>
        将在 {{ setup.profileDir }} 的 cordis.patch.yml 中注册 MCP（会先备份），并通过 DSH 自己的插件管理器安装预设 bundle。继续？
      </n-popconfirm>
      <n-button :loading="busy === 'test'" @click="doTest">测试连接</n-button>
      <n-popconfirm v-if="setup.mcpRegistered || setup.bundleRegistered" @positive-click="uninstall">
        <template #trigger><n-button type="error" ghost :loading="busy === 'uninstall'">移除接入</n-button></template>
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
      <div v-else-if="result.restartRequired === false" style="margin-top: 6px">DSH 已即时加载，无需重启。可以去「仿真与人格」页启用会话了。</div>
    </n-alert>

    <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="110" size="small" style="margin-top: 14px; max-width: 620px">
      <n-form-item label="模型">
        <n-input v-model:value="form.model" placeholder="deepseek-flash" style="width: 200px" />
        <n-input v-model:value="form.provider" placeholder="provider" style="width: 180px; margin-left: 8px" />
      </n-form-item>
      <n-form-item label="思考强度">
        <n-select v-model:value="form.reasoningEffort" :options="['off', 'low', 'high', 'max'].map((v) => ({ label: v, value: v }))" style="width: 140px" />
      </n-form-item>
      <n-form-item label="预设"><n-input v-model:value="form.preset" style="width: 200px" /></n-form-item>
      <n-form-item label="工具审批">
        <n-select v-model:value="form.approvals" :options="[{ label: '一律拒绝（推荐）', value: 'reject' }, { label: '交给控制台审批', value: 'console' }]" style="width: 200px" />
      </n-form-item>
      <n-form-item label="地址">
        <n-input v-model:value="form.baseUrl" style="width: 260px" />
        <n-switch v-model:value="form.autoDiscover" style="margin-left: 10px" /><n-text depth="3" style="margin-left: 6px; font-size: 12px">自动发现本机端口</n-text>
      </n-form-item>
      <n-form-item label="启用驱动"><n-switch v-model:value="form.enabled" /></n-form-item>
      <n-button size="small" type="primary" @click="save">保存</n-button>
    </n-form>
  </n-card>
</template>
