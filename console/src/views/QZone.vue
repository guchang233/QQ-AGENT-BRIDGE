<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { NCard, NInput, NButton, NSpace, NSelect, NList, NListItem, NThing, NAvatar, NImage, NImageGroup, NEmpty, NRadioGroup, NRadioButton, NCollapse, NCollapseItem, NCode, NSpin, useMessage } from 'naive-ui';
import { api, upload, userAvatar, fmtFull } from '../api';

const msg = useMessage();
const content = ref('');
const images = ref<{ path: string; name: string }[]>([]);
const visibility = ref(1);
const posting = ref(false);
const feeds = ref<any[]>([]);
const raw = ref<any>(null);
const loading = ref(false);
const tab = ref('feeds');
const target = ref<string>('');
const commentText = ref<Record<string, string>>({});

async function post() {
  if (!content.value.trim()) return msg.warning('写点什么吧');
  posting.value = true;
  try {
    const imgs = images.value.map((i) => i.path);
    const r = await api('/api/actions/send_qzone_msg', { body: { content: content.value, images: imgs.map((p) => `file:///${p.replace(/\\/g, '/')}`), ugc_right: visibility.value } });
    msg.success(`已发表${r.data?.tid ? `（tid ${r.data.tid}）` : ''}`);
    content.value = ''; images.value = [];
    load();
  } catch (e: any) { msg.error(e.message); } finally { posting.value = false; }
}

function pick() {
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = 'image/*';
  input.onchange = async () => { for (const f of Array.from(input.files ?? [])) { const r = await upload(f); images.value.push({ path: r.path, name: f.name }); } };
  input.click();
}

/** QQ 空间接口的返回结构因端点不同而异，这里做宽松提取。 */
function extract(d: any): any[] {
  const arr = d?.feeds ?? d?.list ?? d?.msglist ?? d?.data ?? (Array.isArray(d) ? d : []);
  return (Array.isArray(arr) ? arr : []).map((f: any) => ({
    tid: f.tid ?? f.feed_id ?? f.id ?? f.key ?? '',
    uin: String(f.uin ?? f.target_uin ?? f.opuin ?? f.author?.uin ?? ''),
    nick: f.nickname ?? f.name ?? f.nick ?? f.author?.nickname ?? '',
    content: f.content ?? f.con ?? f.summary ?? f.text ?? '',
    time: (f.created_time ?? f.abstime ?? f.time ?? f.createTime ?? 0) * (String(f.created_time ?? f.abstime ?? f.time ?? '').length <= 10 ? 1000 : 1),
    abstime: f.abstime ?? f.created_time,
    pics: (f.pics ?? f.pic ?? f.images ?? []).map((p: any) => (typeof p === 'string' ? p : p.url ?? p.url1 ?? p.url2 ?? p.smallurl ?? '')).filter(Boolean),
    likes: f.like_count ?? f.likeNum ?? f.likes ?? undefined,
    comments: f.comment_count ?? f.cmtnum ?? f.commentlist?.length ?? undefined,
    raw: f,
  }));
}

async function load() {
  loading.value = true;
  try {
    const r = tab.value === 'feeds'
      ? await api('/api/actions/get_qzone_feeds', { body: { count: 20, page_num: 1 } })
      : await api('/api/actions/get_qzone_msg_list', { body: { target_uin: target.value ? Number(target.value) : undefined, num: 20, pos: 0 } });
    raw.value = r.data; feeds.value = extract(r.data);
  } catch (e: any) { msg.error(e.message); feeds.value = []; } finally { loading.value = false; }
}

async function like(f: any) { try { await api('/api/actions/like_qzone', { body: { tid: f.tid, target_uin: Number(f.uin), abstime: f.abstime } }); msg.success('已点赞'); } catch (e: any) { msg.error(e.message); } }
async function comment(f: any) {
  const t = commentText.value[f.tid]?.trim(); if (!t) return;
  try { await api('/api/actions/comment_qzone', { body: { tid: f.tid, target_uin: Number(f.uin), content: t } }); msg.success('已评论'); commentText.value[f.tid] = ''; } catch (e: any) { msg.error(e.message); }
}
async function del(f: any) { try { await api('/api/actions/delete_qzone_msg', { body: { tid: f.tid } }); msg.success('已删除'); load(); } catch (e: any) { msg.error(e.message); } }

onMounted(load);
</script>

<template>
  <n-space vertical :size="16" style="max-width: 820px">
    <n-card title="发说说" size="small">
      <n-input v-model:value="content" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" placeholder="分享新鲜事…" />
      <n-space style="margin-top: 8px" align="center">
        <n-button size="small" @click="pick">添加图片（{{ images.length }}/9）</n-button>
        <span v-for="(i, k) in images" :key="i.path" style="font-size: 12px">{{ i.name }} <a style="cursor: pointer" @click="images.splice(k, 1)">✕</a></span>
      </n-space>
      <template #action>
        <n-space justify="end">
          <n-select v-model:value="visibility" size="small" style="width: 140px" :options="[{ label: '所有人可见', value: 1 }, { label: '好友可见', value: 4 }, { label: '仅自己可见', value: 64 }]" />
          <n-button type="primary" size="small" :loading="posting" @click="post">发表</n-button>
        </n-space>
      </template>
    </n-card>

    <n-card size="small">
      <n-space align="center" justify="space-between" style="margin-bottom: 8px">
        <n-space align="center">
          <n-radio-group v-model:value="tab" size="small" @update:value="load">
            <n-radio-button value="feeds">好友动态</n-radio-button>
            <n-radio-button value="list">说说列表</n-radio-button>
          </n-radio-group>
          <template v-if="tab === 'list'">
            <n-input v-model:value="target" size="small" placeholder="QQ 号（留空 = 我自己）" style="width: 200px" @keyup.enter="load" />
            <n-button size="small" @click="load">查看</n-button>
          </template>
        </n-space>
        <n-button size="small" :loading="loading" @click="load">刷新</n-button>
      </n-space>
      <n-spin :show="loading">
        <n-empty v-if="!feeds.length" description="没有动态（或接口返回了非常规结构，见下方原始数据）" style="margin: 24px 0" />
        <n-list>
          <n-list-item v-for="f in feeds" :key="f.tid">
            <n-thing>
              <template #avatar><n-avatar round :src="userAvatar(f.uin)" /></template>
              <template #header>{{ f.nick || f.uin }}</template>
              <template #description><span style="font-size: 12px; opacity: .6">{{ f.time ? fmtFull(f.time) : '' }} · tid {{ f.tid }}</span></template>
              <div style="white-space: pre-wrap">{{ f.content }}</div>
              <n-image-group v-if="f.pics.length"><n-space style="margin-top: 6px"><n-image v-for="p in f.pics" :key="p" :src="p" width="110" height="110" object-fit="cover" style="border-radius: 6px" /></n-space></n-image-group>
              <template #action>
                <n-space align="center">
                  <n-button size="tiny" @click="like(f)">👍 赞{{ f.likes !== undefined ? ` ${f.likes}` : '' }}</n-button>
                  <n-input v-model:value="commentText[f.tid]" size="tiny" placeholder="写评论…" style="width: 220px" @keyup.enter="comment(f)" />
                  <n-button size="tiny" @click="comment(f)">评论</n-button>
                  <n-button v-if="tab === 'list' && !target" size="tiny" type="error" ghost @click="del(f)">删除</n-button>
                </n-space>
              </template>
            </n-thing>
          </n-list-item>
        </n-list>
      </n-spin>
      <n-collapse v-if="raw" style="margin-top: 8px"><n-collapse-item title="原始数据" name="raw"><n-code :code="JSON.stringify(raw, null, 2)" language="json" style="max-height: 300px; overflow: auto; font-size: 12px" /></n-collapse-item></n-collapse>
    </n-card>
  </n-space>
</template>
