<template>
  <div class="user-comments-empty-state" role="status" aria-live="polite">
    <p class="user-comments-empty-state__title">暂无评论记录</p>
    <p class="user-comments-empty-state__description">
      你在文章下发表的评论会显示在这里，便于回看和删除不再保留的内容。
    </p>
  </div>
</template>

<style scoped>
.user-comments-empty-state {
  margin-top: 2rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding: 2rem 0;
}

.user-comments-empty-state__title {
  margin: 0;
  color: var(--fsusblog-text-primary);
  font-size: 0.9375rem;
  font-weight: 700;
  line-height: 1.5;
}

.user-comments-empty-state__description {
  margin: 0.35rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.7;
}
</style>
