<template>
  <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]">
    <div class="border-b border-[var(--fsusblog-panel-border)] p-5">
      <div class="text-xs font-semibold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">审核审计</div>
      <h2 class="mt-2 text-xl font-bold text-[var(--fsusblog-text-primary)]">审核系统事件索引</h2>
      <p class="mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">审计明细仍由通用审计日志承载，这里只保留审核系统动作入口。</p>
    </div>

    <div class="grid gap-3 md:grid-cols-2">
      <RouterLink
        v-for="event in events"
        :key="event.action"
        :to="{ name: 'ManageAuditLog', query: { action: event.action } }"
        class="bg-[var(--fsusblog-page-bg)] p-5 hover:bg-[var(--fsusblog-page-bg-soft)]"
      >
        <div class="text-sm font-bold text-[var(--fsusblog-text-primary)]">{{ event.label }}</div>
        <p class="mt-2 text-[12px] leading-6 text-[var(--fsusblog-text-muted)]">{{ event.detail }}</p>
        <p class="mt-1 break-all text-[11px] leading-5 text-[var(--fsusblog-text-muted)]">动作代码：{{ event.action }}</p>
      </RouterLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router'

const events = [
  { action: 'dictionary_loaded', label: '词库已载入', detail: '词库快照加载成功。' },
  { action: 'dictionary_reload_failed', label: '词库重新载入失败', detail: '词库重新载入失败但保留旧快照。' },
  { action: 'dictionary_checksum_changed', label: '词库校验值变化', detail: '词库校验值发生变化。' },
  { action: 'region_policy_loaded', label: '地区策略已载入', detail: '地区策略加载成功。' },
  { action: 'region_policy_reload_failed', label: '地区策略重新载入失败', detail: '地区策略重新载入失败。' },
  { action: 'region_policy_replay_started', label: '地区策略回放开始', detail: '地区策略回放预览或执行开始。' },
  { action: 'region_policy_replay_completed', label: '地区策略回放完成', detail: '地区策略回放预览或执行完成。' },
  { action: 'model_moderation_scored', label: '模型风险评分完成', detail: '模型风险信号评分完成。' },
  { action: 'region_moderation_rejected', label: '地区策略拒绝发布', detail: '地区策略拒绝发布。' },
  { action: 'region_moderation_geo_blocked', label: '地区策略按地区拦截', detail: '地区策略产生访问地区拦截。' }
] as const
</script>
