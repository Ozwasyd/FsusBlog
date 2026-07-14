<template>
  <div
    class="fsus-comments-empty"
    data-fsus-surface="reading"
    aria-label="评论空状态"
  >
    <p class="fsus-comments-empty__text" role="status" aria-live="polite">
      {{ message }}
    </p>
    <router-link
      v-if="!isLoggedIn"
      class="fsus-comments-empty__btn"
      :to="loginRoute"
    >
      登录以参与讨论
    </router-link>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  isLoggedIn: boolean
  redirectPath: string
  message: string
}>()

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
  padding-block: 32px;
  background-color: transparent;
  box-shadow: none;
  text-align: center;
}

.fsus-comments-empty__text {
  margin: 0;
  color: #A1A1AA;
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
  border: 1px solid #E4E4E7;
  border-radius: 6px;
  background-color: transparent;
  box-shadow: none;
  color: #0F0F11;
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition:
    color var(--blog-motion-control) var(--blog-motion-ease),
    border-color var(--blog-motion-control) var(--blog-motion-ease);
}

.fsus-comments-empty__btn:visited {
  color: #0F0F11;
}

.fsus-comments-empty__btn:hover {
  border-color: #2A599C;
  background-color: transparent;
  color: #2A599C;
}

.fsus-comments-empty__btn:focus-visible {
  outline: 2px solid #2A599C !important;
  outline-offset: 2px !important;
  background-color: transparent;
  box-shadow: none;
}
</style>
