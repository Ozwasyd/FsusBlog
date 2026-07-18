<script setup lang="ts">
defineProps<{
    /** Requires a verified MFA challenge before the action can continue. */
    needsMfa?: boolean
}>()
</script>
