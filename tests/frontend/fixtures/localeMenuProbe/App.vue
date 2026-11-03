<script setup lang="ts">
import { ref } from 'vue';
import {
    ElButton,
    ElDropdown,
    ElDropdownItem,
    ElDropdownMenu,
    ElMenu,
    ElMenuItem,
    ElOption,
    ElSelect
} from '@ozwasyd/element-plus';
import '@ozwasyd/element-plus/dist/index.css';
import '@ozwasyd/element-plus/dist/el-fsus-theme.css';
import Consumer from './Consumer.vue';
const consumerMode = new URLSearchParams(globalThis.location.search).has('consumer');

const dropdown = ref<InstanceType<typeof ElDropdown>>();
const visible = ref(false);
const pending = ref('');
const error = ref(false);
const disabled = ref(false);
const commands = ref<string[]>([]);
const visibility = ref<boolean[]>([]);
const selection = ref('en');
const selectPending = ref('');
const selectVisible = ref(false);
const alternativeVisible = ref(false);

function activate(command: string): void {
    commands.value.push(command);
    if (command === 'link') {
        window.location.assign('#linked-locale');
        return;
    }
    pending.value = command;
}

function visibilityChanged(value: boolean): void {
    visible.value = value;
    visibility.value.push(value);
}
</script>

<template>
    <Consumer v-if="consumerMode" />
    <main v-else>
        <h1>Locale menu public API probe</h1>
        <ElButton data-probe="outside">Outside target</ElButton>
        <ElButton data-probe="manual-open" @click="dropdown?.handleOpen()">Public open</ElButton>
        <ElButton data-probe="manual-close" @click="dropdown?.handleClose()">Public close</ElButton>
        <ElButton data-probe="fail" @click="error = true">Reject transaction</ElButton>
        <ElButton data-probe="disable" @click="disabled = !disabled">Toggle disabled</ElButton>
        <ElDropdown
            ref="dropdown"
            trigger="click"
            :hide-on-click="false"
            :disabled="disabled"
            @command="activate"
            @visible-change="visibilityChanged"
        >
            <ElButton data-probe="trigger" :disabled="disabled">
                <span aria-hidden="true">◎</span>
                <span>en</span>
                <span v-if="pending" data-probe="trigger-pending">Pending</span>
            </ElButton>
            <template #dropdown>
                <ElDropdownMenu data-probe="menu">
                    <ElDropdownItem
                        data-probe="english"
                        command="en"
                        :checked="true"
                    >English</ElDropdownItem>
                    <ElDropdownItem
                        data-probe="japanese"
                        command="ja"
                        :checked="false"
                    >日本語 <span v-if="pending === 'ja'" data-probe="item-pending">Pending</span></ElDropdownItem>
                    <ElDropdownItem data-probe="link-item" command="link">
                        <a data-probe="link" href="#linked-locale">Deutsch</a>
                    </ElDropdownItem>
                    <ElDropdownItem data-probe="disabled-item" command="disabled" disabled>Disabled</ElDropdownItem>
                    <ElDropdownItem
                        v-if="error"
                        data-probe="retry"
                        command="retry"
                        :disabled="disabled"
                    >Retry <span role="alert">Resource loading failed</span></ElDropdownItem>
                </ElDropdownMenu>
            </template>
        </ElDropdown>
        <output data-probe="state">{{ JSON.stringify({ visible, pending, commands, visibility }) }}</output>
        <h2>Select alternative</h2>
        <ElSelect
            :model-value="selection"
            aria-label="Select alternative"
            @update:model-value="selectPending = $event"
            @visible-change="selectVisible = $event"
        >
            <ElOption value="en" label="English" />
            <ElOption value="ja" label="日本語" />
            <template #footer><span data-probe="select-retry">Retry resource transaction</span></template>
        </ElSelect>
        <output data-probe="select-state">{{ JSON.stringify({ selection, selectPending, selectVisible }) }}</output>
        <h2>Menu alternative</h2>
        <ElDropdown trigger="click" :hide-on-click="false" @visible-change="alternativeVisible = $event">
            <ElButton data-probe="alternative-trigger">Menu alternative</ElButton>
            <template #dropdown>
                <ElMenu default-active="en" data-probe="alternative-menu">
                    <ElMenuItem index="en" role="menuitemradio" aria-checked="true" data-probe="menu-alternative">English</ElMenuItem>
                    <ElMenuItem index="ja" data-probe="menu-alternative-next">日本語</ElMenuItem>
                </ElMenu>
            </template>
        </ElDropdown>
        <output data-probe="alternative-state">{{ JSON.stringify({ alternativeVisible }) }}</output>
    </main>
</template>
