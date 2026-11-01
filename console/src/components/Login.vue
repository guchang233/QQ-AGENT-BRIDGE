<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NCard, NForm, NFormItem, NInput, NButton, NAlert, NSteps, NStep, NSpace, NRadioGroup, NRadio, NDynamicTags, NSpin, NText, useMessage } from 'naive-ui';
import { api, state, checkSession, isNarrow } from '../api';

const msg = useMessage();
const password = ref('');
const loading = ref(false);

async function login() {
  loading.value = true;
  try { await api('/api/login', { body: { password: password.value } }); await checkSession(); } catch (e: any) { msg.error(e.message); } finally { loading.value = false; }
}

// ---- 设置向导 ----
const step = ref(1);
const disc = ref<any>(null);
const discovering = ref(false);
const form = ref({ password: '', password2: '', owners: [] as string[], snowlumaHome: '', wsUrl: '', httpUrl: '', accessToken: '', accessMode: 'all' as 'all' | 'allowlist' });

async function runDiscover() {
  discovering.value = true;
  try {
    const r = await api('/api/setup/discover');
    disc.value = r;
    form.value.snowlumaHome = r.snowlumaHome ?? '';
    if (r.discovery?.self?.user_id && !form.value.owners.length) form.value.owners = [];
  } catch (e: any) { msg.error(e.message); } finally { discovering.value = false; }
}

async function finish() {
  if (form.value.password.length < 6) return msg.error('密码至少 6 位');
  if (form.value.password !== form.value.password2) return msg.error('两次输入的密码不一致');
  loading.value = true;
  try {
    await api('/api/setup', { body: { ...form.value, password2: undefined } });
    msg.success('设置完成');
    await checkSession();
  } catch (e: any) { msg.error(e.message); } finally { loading.value = false; }
}

onMounted(() => { if (state.setupRequired) runDiscover(); });
</script>

<template>
  <div class="wrap">
    <n-card v-if="!state.setupRequired" title="🐧 QQ-Agent Bridge" style="max-width: 380px">
      <n-form @submit.prevent="login">
        <n-form-item label="控制台密码">
          <n-input v-model:value="password" type="password" show-password-on="click" placeholder="请输入密码" autofocus @keyup.enter="login" />
        </n-form-item>
        <n-button type="primary" block :loading="loading" @click="login">登录</n-button>
      </n-form>
      <n-text depth="3" style="font-size: 12px; display: block; margin-top: 12px">忘记密码：在终端运行 <code>qab password 新密码</code></n-text>
    </n-card>

    <n-card v-else title="🐧 欢迎使用 QQ-Agent Bridge — 首次设置" style="max-width: 640px">
      <n-steps :current="step" size="small" style="margin-bottom: 20px">
        <n-step title="连接 QQ" />
        <n-step title="基本设置" />
        <n-step title="控制台密码" />
      </n-steps>

      <div v-if="step === 1">
        <n-spin :show="discovering">
          <n-alert v-if="disc?.discovery?.ok" type="success" title="已找到 QQ 协议端">
            账号：{{ disc.discovery.self?.nickname }}（{{ disc.discovery.self?.user_id }}）<br />
            地址：{{ disc.discovery.httpUrl }} / {{ disc.discovery.wsUrl }}
          </n-alert>
          <n-alert v-else-if="disc" type="warning" title="暂未连接到 QQ 协议端">
            请确认 SnowLuma（或其它 OneBot v11 实现）已启动并登录 QQ。可以先跳过，稍后在「设置」中修改。
            <ul style="margin: 6px 0 0; padding-left: 18px; font-size: 12px">
              <li v-for="t in disc.discovery?.tried ?? []" :key="t.source">{{ t.source }} {{ t.url }}：{{ t.error }}</li>
            </ul>
          </n-alert>
        </n-spin>
        <n-form :label-placement="isNarrow ? 'top' : 'left'" label-width="110" style="margin-top: 16px">
          <n-form-item label="SnowLuma 目录"><n-input v-model:value="form.snowlumaHome" placeholder="例如 D:\AI\QQ\SnowLuma-v2.2.0-win-x64（自动读取端口和 token）" /></n-form-item>
          <n-form-item label="WS 地址"><n-input v-model:value="form.wsUrl" placeholder="留空自动发现，如 ws://127.0.0.1:3001" /></n-form-item>
          <n-form-item label="HTTP 地址"><n-input v-model:value="form.httpUrl" placeholder="留空自动发现，如 http://127.0.0.1:3000" /></n-form-item>
          <n-form-item label="Access Token"><n-input v-model:value="form.accessToken" type="password" show-password-on="click" placeholder="留空自动从 SnowLuma 配置读取" /></n-form-item>
        </n-form>
        <n-space justify="end">
          <n-button @click="runDiscover" :loading="discovering">重新探测</n-button>
          <n-button type="primary" @click="step = 2">下一步</n-button>
        </n-space>
      </div>

      <div v-else-if="step === 2">
        <n-form label-placement="top">
          <n-form-item label="管理员 QQ（拥有插件管理命令权限，可多个，回车添加）">
            <n-dynamic-tags v-model:value="form.owners" />
          </n-form-item>
          <n-form-item label="会话范围">
            <n-radio-group v-model:value="form.accessMode">
              <n-space vertical>
                <n-radio value="all">全部群聊和私聊（可在设置中加黑名单）</n-radio>
                <n-radio value="allowlist">仅白名单中的会话（更安全，需要到设置里添加群号/QQ）</n-radio>
              </n-space>
            </n-radio-group>
          </n-form-item>
        </n-form>
        <n-space justify="end"><n-button @click="step = 1">上一步</n-button><n-button type="primary" @click="step = 3">下一步</n-button></n-space>
      </div>

      <div v-else>
        <n-form label-placement="top">
          <n-form-item label="设置控制台密码（至少 6 位）"><n-input v-model:value="form.password" type="password" show-password-on="click" /></n-form-item>
          <n-form-item label="确认密码"><n-input v-model:value="form.password2" type="password" show-password-on="click" @keyup.enter="finish" /></n-form-item>
        </n-form>
        <n-space justify="end"><n-button @click="step = 2">上一步</n-button><n-button type="primary" :loading="loading" @click="finish">完成</n-button></n-space>
      </div>
    </n-card>
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; background: linear-gradient(135deg, rgba(18,183,245,.12), rgba(18,183,245,0)); }
</style>
