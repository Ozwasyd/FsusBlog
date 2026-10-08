<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton } from '@ozwasyd/element-plus';
import LocaleSelector from '@/components/ui/LocaleSelector.vue';
import { LOCALE_CATALOG } from '@/locales/localeCatalog';

const active = ref('zh-CN');
const pending = ref<string | null>(null);
const failed = ref<string | null>(null);
const open = ref(false);
const disabled = ref(false);
const compact = ref(false);
const expanded = ref(false);
const direction = ref<'ltr' | 'rtl'>('ltr');
const requests = ref<string[]>([]);
const items = computed(() => LOCALE_CATALOG.filter((locale) => locale.status === 'enabled').map((locale) => ({
    code: locale.code, nativeName: locale.nativeName,
    englishName: expanded.value ? locale.englishName.repeat(4) : locale.englishName,
    direction: direction.value, selected: locale.code === active.value,
    href: locale.code === 'en-US' ? '#consumer-link' : undefined
})));
function select(code: string): void {
    requests.value.push(code);
    pending.value = code;
    failed.value = null;
}
function settle(success: boolean): void {
    if (success && pending.value) {
        active.value = pending.value;
        open.value = false;
    } else {
        failed.value = pending.value;
    }
    pending.value = null;
}
</script>
<template>
    <main :dir="direction" class="consumer">
        <h1>LocaleSelector consumer composition</h1>
        <div class="controls">
            <ElButton data-consumer="outside">Outside</ElButton>
            <ElButton data-consumer="success" @click="settle(true)">Commit</ElButton>
            <ElButton data-consumer="failure" @click="settle(false)">Reject</ElButton>
            <ElButton data-consumer="disabled" @click="disabled = !disabled">Disabled</ElButton>
            <ElButton data-consumer="compact" @click="compact = !compact">Compact</ElButton>
            <ElButton data-consumer="rtl" @click="direction = direction === 'ltr' ? 'rtl' : 'ltr'">RTL</ElButton>
            <ElButton data-consumer="expanded" @click="expanded = !expanded">Expand</ElButton>
        </div>
        <LocaleSelector :items="items" :active-locale="active" :pending-locale="pending" :retry-locale="failed"
            :error-message="failed ? `Rejected ${failed}` : null" :open="open" :disabled="disabled" :compact="compact"
            @open-change="open = $event" @select="select" @retry="select" />
        <output data-consumer="state">{{ JSON.stringify({ active, pending, failed, open, requests }) }}</output>
    </main>
</template>
<style scoped>
.consumer { padding: 1rem; }
.controls { display: flex; flex-wrap: wrap; }
h1 { overflow-wrap: anywhere; }
output { display: block; overflow-wrap: anywhere; }
</style>
