import { computed, ref, type Ref } from 'vue';
import { api } from './api';

/**
 * DSH 的模型目录：从 DSH 读实际可用的服务商和模型，只能从里面选。
 * DSH 卡片和设置向导共用。form 里有 provider / model / reasoningEffort。
 */
export function useDshModels(form: Ref<any>) {
  const catalog = ref<any>(null);
  const loading = ref(false);
  async function load() {
    loading.value = true;
    try { catalog.value = await api('/api/drivers/dsh/models'); } catch (e: any) { catalog.value = { ok: false, error: e.message }; } finally { loading.value = false; }
  }
  const providers = computed<any[]>(() => (catalog.value?.ok ? catalog.value.providers : []));
  const providerOptions = computed(() => providers.value.map((p) => ({ label: p.name === p.id ? p.id : `${p.name}（${p.id}）`, value: p.id })));
  const curProvider = computed(() => providers.value.find((p) => p.id === form.value.provider));
  const modelOptions = computed(() => (curProvider.value?.models ?? []).map((m: any) => ({ label: m.name === m.id ? m.id : `${m.name}（${m.id}）`, value: m.id })));
  const curModel = computed(() => curProvider.value?.models.find((m: any) => m.id === form.value.model));
  const effortOptions = computed(() => (curModel.value?.efforts?.length ? curModel.value.efforts : ['off', 'low', 'high', 'max']).map((v: string) => ({ label: v, value: v })));
  /** 当前配置在 DSH 里不存在 */
  const invalid = computed(() => catalog.value?.ok && form.value.model && !curModel.value);
  function pickModel(id: string) {
    form.value.model = id;
    const m = curProvider.value?.models.find((x: any) => x.id === id);
    if (m?.efforts?.length && !m.efforts.includes(form.value.reasoningEffort)) form.value.reasoningEffort = m.defaultEffort ?? m.efforts[0];
  }
  function pickProvider(id: string) {
    form.value.provider = id;
    const p = providers.value.find((x) => x.id === id);
    if (p && !p.models.some((m: any) => m.id === form.value.model)) pickModel(p.models[0]?.id ?? '');
  }
  return { catalog, loading, load, providerOptions, modelOptions, effortOptions, invalid, pickProvider, pickModel };
}
