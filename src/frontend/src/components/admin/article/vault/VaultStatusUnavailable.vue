<template>
    <details aria-label="Vault 状态与命令可用性">
        <summary>Vault：状态未知</summary>
        <p role="status">当前无法取得已验证的 Vault 状态与操作授权。</p>
        <p>服务端文章编辑、保存、发布和恢复仍可使用。Vault 本地变更是否已同步尚未验证。</p>
        <ul aria-label="尚不可用的 Vault 命令">
            <li>同步现在 / 仅拉取计划 / 仅推送计划：当前无法获取已验证同步计划。</li>
            <li>暂停 / 恢复 / 重连：尚未取得当前允许操作与授权回执。</li>
            <li>连接设置 / 解绑：尚未取得对应生命周期与撤销回执。</li>
            <li>Conflict / recovery：当前无法进入对应冲突与恢复记录。</li>
        </ul>
    </details>
</template>

<script setup lang="ts">
// This disclosure is the missing-capability boundary, not a connection/status receipt.
</script>
