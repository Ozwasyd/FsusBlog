<template>
  <section
    v-if="visible"
    class="console-welcome-callout"
    data-console-welcome-callout="true"
    aria-labelledby="console-welcome-callout-title"
  >
    <div class="console-welcome-callout__copy">
      <p class="console-welcome-callout__eyebrow">CONSOLE / FEEDBACK</p>
      <h2 id="console-welcome-callout-title" class="console-welcome-callout__title">
        Welcome to FsusBlog.
      </h2>
      <p class="console-welcome-callout__body">
        {{ bodyText }}
      </p>
    </div>

    <nav
      v-if="links.length > 0"
      class="console-welcome-callout__links"
      aria-label="FsusBlog contribution links"
    >
      <a
        v-for="link in links"
        :key="link.key"
        class="console-welcome-callout__link"
        :href="link.href"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ link.label }}
      </a>
    </nav>

    <el-button
      circle
      :icon="Close"
      class="console-welcome-callout__dismiss"
      data-console-welcome-dismiss="true"
      aria-label="Dismiss welcome callout"
      @click="dismiss"
    />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Close } from '@/fsusui/icons'
import { useConsoleWelcomeCallout } from '@/composables/useConsoleWelcomeCallout'

const props = defineProps<{
  userKey?: string | number | null
}>()

const { dismiss, links, visible } = useConsoleWelcomeCallout({
  userKey: computed(() => props.userKey)
})

const bodyText = computed(() => (
  links.value.length > 0
    ? 'Found a console problem or have an improvement idea? Use these project links to report it or send a patch.'
    : 'Found a console problem or have an improvement idea? Contact the site owner to improve this deployment.'
))
</script>

<style scoped>
.console-welcome-callout {
  position: relative;
  display: grid;
  gap: 1.25rem;
  border-block: 1px solid var(--fsusblog-panel-border);
  background: var(--fsusblog-page-bg);
  padding: 1.5rem;
}

.console-welcome-callout__copy {
  min-width: 0;
  padding-right: 2.75rem;
}

.console-welcome-callout__eyebrow {
  margin: 0;
  color: var(--fsusblog-text-muted);
  font-size: 0.6875rem;
  font-weight: 900;
  letter-spacing: 0;
}

.console-welcome-callout__title {
  margin: 0.5rem 0 0;
  color: var(--fsusblog-text-primary);
  font-size: 1.25rem;
  font-weight: 800;
  line-height: 1.2;
}

.console-welcome-callout__body {
  max-width: 48rem;
  margin: 0.75rem 0 0;
  color: var(--fsusblog-text-tertiary);
  font-size: 0.8125rem;
  line-height: 1.7;
}

.console-welcome-callout__links {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.console-welcome-callout__link {
  display: inline-flex;
  min-height: 2.25rem;
  align-items: center;
  border: 1px solid var(--fsusblog-panel-border);
  border-radius: var(--fsus-radius-control-small);
  color: var(--fsusblog-text-primary);
  font-size: 0.75rem;
  font-weight: 800;
  padding: 0 0.875rem;
  transition:
    border-color var(--fsus-motion-control-fast) var(--fsus-motion-standard),
    color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.console-welcome-callout__link:hover,
.console-welcome-callout__link:focus-visible {
  border-color: color-mix(in srgb, var(--fsusblog-color-primary) 42%, var(--fsusblog-panel-border));
  color: var(--fsusblog-color-primary);
  outline: none;
}

.console-welcome-callout__dismiss {
  position: absolute;
  right: 1rem;
  top: 1rem;
}

@media (min-width: 768px) {
  .console-welcome-callout {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
  }
}
</style>
