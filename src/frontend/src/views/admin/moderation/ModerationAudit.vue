<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
    <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
      <div class="text-[11px] font-black normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核审计 / AUDIT</div>
      <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">审核系统事件索引</h2>
      <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">审计明细仍由通用审计日志承载，这里只保留审核系统动作入口。</p>
    </div>

    <div class="grid gap-px bg-[var(--fsusblog-panel-bg-soft)] md:grid-cols-2">
      <RouterLink
        v-for="event in events"
        :key="event.action"
        :to="{ name: 'ManageAuditLog', query: { action: event.action } }"
        class="bg-[var(--fsusblog-page-bg)] p-5 hover:bg-[var(--fsusblog-page-bg-soft)]"
      >
        <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ event.action }}</div>
        <p class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ event.detail }}</p>
      </RouterLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'

const events = [
  { action: 'dictionary_loaded', detail: '词库快照加载成功。' },
  { action: 'dictionary_reload_failed', detail: '词库 reload 失败但保留旧 snapshot。' },
  { action: 'dictionary_checksum_changed', detail: '词库 checksum 发生变化。' },
  { action: 'region_policy_loaded', detail: '地区策略加载成功。' },
  { action: 'region_policy_reload_failed', detail: '地区策略 reload 失败。' },
  { action: 'region_policy_replay_started', detail: '地区策略回放 preview 或执行开始。' },
  { action: 'region_policy_replay_completed', detail: '地区策略回放 preview 或执行完成。' },
  { action: 'model_moderation_scored', detail: '模型风险信号评分完成。' },
  { action: 'region_moderation_rejected', detail: '地区策略拒绝发布。' },
  { action: 'region_moderation_geo_blocked', detail: '地区策略产生 viewer geo block。' }
] as const
</script>
