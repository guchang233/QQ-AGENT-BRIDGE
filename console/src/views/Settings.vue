<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NCard, NForm, NFormItem, NInput, NInputNumber, NSwitch, NButton, NSpace, NDynamicTags, NRadioGroup, NRadio, NText, NAlert, NSpin, useMessage } from 'naive-ui';
import { api } from '../api';

const msg = useMessage();
const cfg = ref<any>(null);
const accounts = ref<string[]>([]);
const saving = ref(false);

async function load() { const r = await api('/api/config'); cfg.value = r.config; accounts.value = r.snowlumaAccounts; }
async function save() {
  saving.value = true;
  try { await api('/api/config', { method: 'PUT', body: cfg.value }); msg.success('已保存'); load(); }
  catch (e: any) { msg.error(e.message); } finally { saving.value = false; }
}
onMounted(load);
</script>

<template>
  <n-spin :show="!cfg">
    <n-space v-if="cfg" vertical :size="16" style="max-width: 760px">
      <n-card title="QQ 协议端（OneBot v11）" size="small">
        <n-form label-placement="left" label-width="140">
          <n-form-item label="自动发现"><n-switch v-model:value="cfg.onebot.autoDiscover" /><n-text depth="3" style="margin-left: 8px; font-size: 12px">从 SnowLuma 配置自动读取端口与 token，切换账号无需改配置</n-text></n-form-item>
          <n-form-item label="SnowLuma 目录"><n-input v-model:value="cfg.onebot.snowlumaHome" /></n-form-item>
          <n-form-item v-if="accounts.length" label="检测到账号"><n-text>{{ accounts.join('、') }}</n-text></n-form-item>
          <n-form-item label="WS 地址"><n-input v-model:value="cfg.onebot.wsUrl" /></n-form-item>
          <n-form-item label="HTTP 地址"><n-input v-model:value="cfg.onebot.httpUrl" /></n-form-item>
          <n-form-item label="WS Token"><n-input v-model:value="cfg.onebot.accessToken" type="password" show-password-on="click" /></n-form-item>
          <n-form-item label="HTTP Token"><n-input v-model:value="cfg.onebot.httpToken" type="password" show-password-on="click" placeholder="与 WS 相同可留空" /></n-form-item>
          <n-form-item label="动作超时 (ms)"><n-input-number v-model:value="cfg.onebot.actionTimeoutMs" :min="1000" :step="1000" /></n-form-item>
        </n-form>
      </n-card>

      <n-card title="会话范围" size="small">
        <n-form label-placement="left" label-width="140">
          <n-form-item label="模式">
            <n-radio-group v-model:value="cfg.access.mode"><n-radio value="all">全部（黑名单除外）</n-radio><n-radio value="allowlist">仅白名单</n-radio></n-radio-group>
          </n-form-item>
          <n-form-item label="白名单群"><n-dynamic-tags v-model:value="cfg.access.groups" /></n-form-item>
          <n-form-item label="白名单私聊"><n-dynamic-tags v-model:value="cfg.access.private" /></n-form-item>
          <n-form-item label="黑名单群"><n-dynamic-tags v-model:value="cfg.access.denyGroups" /></n-form-item>
          <n-form-item label="黑名单私聊"><n-dynamic-tags v-model:value="cfg.access.denyPrivate" /></n-form-item>
          <n-form-item label="管理员 QQ"><n-dynamic-tags v-model:value="cfg.owners" /></n-form-item>
          <n-form-item label="对管理员的称呼"><n-input v-model:value="cfg.ownerTitle" placeholder="管理员 / 主人 / 老板…" style="width: 200px" /></n-form-item>
        </n-form>
        <n-alert type="info" :show-icon="false" style="font-size: 12px">范围外的会话：Agent 看不到其消息也无法发送，插件也不会响应；人类在控制台中不受限制。</n-alert>
      </n-card>

      <n-card title="发送限制与节奏" size="small">
        <n-form label-placement="left" label-width="160">
          <n-form-item label="全局每分钟上限"><n-input-number v-model:value="cfg.limits.sendPerMinute" :min="1" /></n-form-item>
          <n-form-item label="全局每小时上限"><n-input-number v-model:value="cfg.limits.sendPerHour" :min="1" /></n-form-item>
          <n-form-item label="单会话每分钟上限"><n-input-number v-model:value="cfg.limits.convPerMinute" :min="1" /></n-form-item>
          <n-form-item label="单条最大字数"><n-input-number v-model:value="cfg.limits.maxMessageChars" :min="10" /></n-form-item>
          <n-form-item label="分条间隔：基础 (ms)"><n-input-number v-model:value="cfg.limits.gapBaseMs" :min="0" :step="100" /></n-form-item>
          <n-form-item label="分条间隔：每字 (ms)"><n-input-number v-model:value="cfg.limits.gapPerCharMs" :min="0" /></n-form-item>
          <n-form-item label="分条间隔：上限 (ms)"><n-input-number v-model:value="cfg.limits.gapMaxMs" :min="0" :step="500" /></n-form-item>
        </n-form>
        <n-text depth="3" style="font-size: 12px">以上限制只约束 Agent 与插件，避免刷屏导致账号风控。</n-text>
      </n-card>

      <n-card title="媒体" size="small">
        <n-form label-placement="left" label-width="160">
          <n-form-item label="Agent 可读取的目录"><n-dynamic-tags v-model:value="cfg.media.uploadRoots" /></n-form-item>
          <n-form-item label="内联图片上限 (字节)"><n-input-number v-model:value="cfg.media.maxInlineImageBytes" :min="10240" :step="102400" /></n-form-item>
          <n-form-item label="下载上限 (字节)"><n-input-number v-model:value="cfg.media.maxDownloadBytes" :min="102400" :step="1048576" /></n-form-item>
        </n-form>
        <n-text depth="3" style="font-size: 12px">「可读取目录」为空表示 Agent 可发送任意本地文件；建议限定到专门的素材目录。</n-text>
      </n-card>

      <n-card title="插件" size="small">
        <n-form label-placement="left" label-width="160">
          <n-form-item label="命令前缀"><n-dynamic-tags v-model:value="cfg.plugins.commandPrefixes" /></n-form-item>
          <n-form-item label="AstrBot 兼容层"><n-switch v-model:value="cfg.plugins.astrbot.enabled" /><n-text depth="3" style="margin-left: 8px; font-size: 12px">需重启生效</n-text></n-form-item>
          <n-form-item label="Python 路径"><n-input v-model:value="cfg.plugins.astrbot.python" /></n-form-item>
          <n-form-item label="AstrBot 插件目录"><n-input v-model:value="cfg.plugins.astrbot.dir" /></n-form-item>
        </n-form>
      </n-card>

      <n-card title="控制台" size="small">
        <n-form label-placement="left" label-width="140">
          <n-form-item label="监听地址"><n-input v-model:value="cfg.server.host" /></n-form-item>
          <n-form-item label="端口"><n-input-number v-model:value="cfg.server.port" :min="1" :max="65535" /></n-form-item>
          <n-form-item label="控制台密码"><n-input v-model:value="cfg.server.consolePassword" type="password" show-password-on="click" /></n-form-item>
        </n-form>
        <n-text depth="3" style="font-size: 12px">监听地址/端口修改后需重启。监听 0.0.0.0 将允许局域网访问，请设置强密码。</n-text>
      </n-card>

      <n-space><n-button type="primary" :loading="saving" @click="save">保存全部设置</n-button><n-button @click="load">放弃修改</n-button></n-space>
    </n-space>
  </n-spin>
</template>
