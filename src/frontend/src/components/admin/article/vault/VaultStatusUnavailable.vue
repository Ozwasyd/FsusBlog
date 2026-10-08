<template>
    <details aria-label="Vault 状态与命令可用性">
        <summary>Vault：状态未知</summary>
        <p role="status">当前 verified status、IPC/lease 与 command transport 尚不可用。</p>
        <p>服务端文章编辑、保存、发布和恢复仍可使用。Vault 本地变更是否已同步尚未验证。</p>
        <ul aria-label="尚不可用的 Vault 命令">
            <li>同步现在 / 仅拉取计划 / 仅推送计划：等待 canonical planner transport。</li>
            <li>暂停 / 恢复 / 重连：等待 machine-allowed IPC/lease commands。</li>
            <li>连接设置 / 解绑：等待 exact lifecycle 与 revoke receipts。</li>
            <li>Conflict / recovery：等待现有目标与 exact receipt reader。</li>
        </ul>
    </details>
</template>

<script setup lang="ts">
// This disclosure is the missing-capability boundary, not a connection/status receipt.
</script>
