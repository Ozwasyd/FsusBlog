<template>
  <div
    class="fsus-comments-empty"
    data-fsus-surface="reading"
    :aria-label="messages.article.comments.emptyTitle"
  >
    <p class="fsus-comments-empty__text" role="status" aria-live="polite">
      {{ message }}
    </p>
    <router-link
      v-if="!isLoggedIn"
      class="fsus-comments-empty__btn"
      :to="loginRoute"
    >
      {{ messages.article.comments.loginCta }}
    </router-link>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18nText } from '@/composables/useI18nText'

const props = defineProps<{
  isLoggedIn: boolean
  redirectPath: string
  message: string
}>()

const { messages } = useI18nText()

const loginRoute = computed(() => ({
  path: '/login',
  query: { redirect: props.redirectPath }
}))
</script>

<style scoped>
.fsus-comments-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding-block: 0;
  background-color: transparent;
  box-shadow: none;
  text-align: center;
}

.fsus-comments-empty__text {
  margin: 0;
  color: var(--fsusblog-text-quiet);
  font-family: 'Google Sans', 'Noto Sans CJK', sans-serif;
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
}

.fsus-comments-empty__btn {
  display: inline-flex;
  min-height: 44px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  padding-inline: 16px;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: 6px;
  background-color: transparent;
  box-shadow: none;
  color: var(--fsusblog-text-primary);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition:
    color var(--blog-motion-control) var(--blog-motion-ease),
    border-color var(--blog-motion-control) var(--blog-motion-ease);
}

.fsus-comments-empty__btn:visited {
  color: var(--fsusblog-text-primary);
}

.fsus-comments-empty__btn:hover {
  border-color: var(--fsusblog-color-primary);
  background-color: transparent;
  color: var(--fsusblog-color-primary);
}

.fsus-comments-empty__btn:focus-visible {
  background-color: transparent;
  box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring) !important;
  outline: none !important;
}
</style>
