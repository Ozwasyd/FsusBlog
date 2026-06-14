<template>
  <div class="grow flex flex-col items-center justify-center py-24 sm:py-32">
    <PublicContentState
      :title="view.title"
      size="page"
    >
      <el-button :tag="RouterLink" :to="view.actionHref" type="primary">
        {{ view.actionText }}
      </el-button>
    </PublicContentState>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import PublicContentState from '@/components/public/PublicContentState.vue'
import type { ArticleDetailNotFoundStateViewContract } from '@/view-contracts/articleDetail';

defineProps<{
  view: ArticleDetailNotFoundStateViewContract;
}>();
</script>
