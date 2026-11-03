<script setup lang="ts">
import { ref } from 'vue';
import { NCard, NForm, NFormItem, NInput, NButton, NText, useMessage } from 'naive-ui';
import { api, state, checkSession } from '../api';

const msg = useMessage();
const password = ref('');
const password2 = ref('');
const loading = ref(false);

async function login() {
  loading.value = true;
  try { await api('/api/login', { body: { password: password.value } }); await checkSession(); } catch (e: any) { msg.error(e.message); } finally { loading.value = false; }
}

/** 首次使用：先设密码（后面的步骤会读写 token、装 DSH 预设，要先确认是机器主人在操作），接着进入设置向导 */
async function create() {
  if (password.value.length < 6) return msg.error('密码至少 6 位');
  if (password.value !== password2.value) return msg.error('两次输入的密码不一样');
  loading.value = true;
  try { await api('/api/setup', { body: { password: password.value } }); await checkSession(); } catch (e: any) { msg.error(e.message); } finally { loading.value = false; }
}
</script>

<template>
  <div class="wrap">
    <n-card v-if="!state.setupRequired" title="🐧 QQ-Agent Bridge" class="box">
      <n-form @submit.prevent="login">
        <n-form-item label="控制台密码">
          <n-input v-model:value="password" type="password" show-password-on="click" placeholder="请输入密码" autofocus @keyup.enter="login" />
        </n-form-item>
        <n-button type="primary" block :loading="loading" @click="login">登录</n-button>
      </n-form>
      <n-text depth="3" class="foot">忘记密码：在终端运行 <code>qab password 新密码</code></n-text>
    </n-card>

    <n-card v-else title="🐧 欢迎使用 QQ-Agent Bridge" class="box">
      <p class="lead">先给控制台设一个密码。接下来会带你连上 QQ、接入 AI，大约两三分钟。</p>
      <n-form label-placement="top" @submit.prevent="create">
        <n-form-item label="控制台密码（至少 6 位）"><n-input v-model:value="password" type="password" show-password-on="click" autofocus /></n-form-item>
        <n-form-item label="再输一遍"><n-input v-model:value="password2" type="password" show-password-on="click" @keyup.enter="create" /></n-form-item>
        <n-button type="primary" block :loading="loading" @click="create">下一步</n-button>
      </n-form>
      <n-text depth="3" class="foot">之后登录控制台都用这个密码。忘了可以在终端运行 <code>qab password 新密码</code> 重设。</n-text>
    </n-card>
  </div>
</template>

<style scoped>
.wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; background: linear-gradient(135deg, rgba(18,183,245,.12), rgba(18,183,245,0)); }
.box { width: 100%; max-width: 400px; }
.lead { margin: 0 0 14px; font-size: 13px; line-height: 1.6; opacity: .8; }
.foot { display: block; margin-top: 12px; font-size: 12px; }
</style>
