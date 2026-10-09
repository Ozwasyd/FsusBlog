<template>
  <ElDropdown trigger="click" :hide-on-click="false">
    <ElButton data-test="trigger">Open menu</ElButton>
    <template #dropdown>
      <ElDropdownMenu data-test="menu">
        <ElDropdownItem data-test="item" @keydown.esc.stop.prevent>
          Cancel Escape
        </ElDropdownItem>
      </ElDropdownMenu>
    </template>
  </ElDropdown>
  <button data-test="outside">Outside</button>
</template>
<script setup>
import {
  ElButton, ElDropdown, ElDropdownMenu, ElDropdownItem
} from '@ozwasyd/element-plus'
</script>
