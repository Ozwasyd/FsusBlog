<template>
  <div class="grow flex flex-col items-center justify-center py-24 sm:py-32">
    <el-empty
      :description="view.title"
      description-layout="narrow"
      description-width="18rem"
    >
      <el-button :tag="RouterLink" :to="view.actionHref" type="primary">
        {{ view.actionText }}
      </el-button>
    </el-empty>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import type { ArticleDetailNotFoundStateViewContract } from '@/view-contracts/articleDetail';

defineProps<{
  view: ArticleDetailNotFoundStateViewContract;
}>();
</script>
