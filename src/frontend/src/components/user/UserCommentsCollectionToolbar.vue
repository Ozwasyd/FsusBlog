<template>
  <section class="user-comments-collection-toolbar" aria-label="评论筛选">
    <slot />
  </section>
</template>

<style scoped>
.user-comments-collection-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(8rem, 12rem) auto;
  gap: 0.75rem;
  align-items: center;
  margin-bottom: 2rem;
  border-block: 1px solid var(--fsusblog-panel-border);
  padding: 1rem 0;
}

@media (max-width: 640px) {
  .user-comments-collection-toolbar {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
