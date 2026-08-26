<template>
    <div class="authoring-canvas-view">
        <AuthoringCanvasWorkspace
            :canvas-id="canvasId"
            :user-id="userStore.userId"
            :site-id="siteStore.siteId"
        />
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useSiteStore } from '@/store/site';
import { useUserStore } from '@/store/user';
import AuthoringCanvasWorkspace from '@/components/admin/canvas/AuthoringCanvasWorkspace.vue';

const route = useRoute();
const userStore = useUserStore();
const siteStore = useSiteStore();

const canvasId = computed(() => {
    const idParam = route.params.id;
    return typeof idParam === 'string' ? idParam : undefined;
});
</script>

<style scoped>
.authoring-canvas-view {
    width: 100%;
    height: 100%;
    min-height: calc(100vh - 64px);
    display: flex;
    flex-direction: column;
}
</style>
