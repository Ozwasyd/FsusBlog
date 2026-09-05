<template>
    <div
        class="account-navigation-panel"
        :data-variant="variant"
    >
        <nav
            class="account-global-module-nav"
            :aria-label="t('admin.shell.primaryModules', { area: localizedAreaLabel })"
        >
            <h2
                v-if="headingId"
                :id="headingId"
                class="account-sidebar-index-label"
            >
                {{ t('admin.shell.navigation', { area: localizedAreaLabel }) }}
            </h2>
            <ul
                class="account-global-module-list"
                role="list"
            >
                <li
                    v-for="group in groups"
                    :key="group.key"
                >
                    <RouterLink
                        :to="group.to"
                        class="account-module-link"
                        :class="{ 'account-module-link-active': isAccountNavGroupActive(group, route.path) }"
                        :aria-current="isAccountNavGroupActive(group, route.path) ? 'location' : undefined"
                        @click="$emit('navigate')"
                    >
                        <span class="account-module-link__label">{{ group.label }}</span>
                        <span
                            v-if="group.helper"
                            class="account-module-link__helper"
                        >{{ group.helper }}</span>
                    </RouterLink>
                </li>
            </ul>
        </nav>

        <section
            v-if="currentGroup && currentGroup.items.length > 1"
            class="account-local-navigation"
            :aria-labelledby="localNavigationTitleId"
        >
            <h2
                :id="localNavigationTitleId"
                class="account-local-navigation__title"
            >
                {{ t('admin.shell.localNavigation', { group: currentGroup.label }) }}
            </h2>
            <nav :aria-label="t('admin.shell.localNavigationAria', { group: currentGroup.label })">
                <ul
                    class="account-local-navigation__list"
                    role="list"
                >
                    <li
                        v-for="item in currentGroup.items"
                        :key="item.to"
                    >
                        <RouterLink
                            :to="item.to"
                            class="account-local-navigation__link"
                            :class="{ 'account-local-navigation__link--active': isAccountNavItemActive(item, route.path) }"
                            :aria-current="isAccountNavItemActive(item, route.path) ? 'page' : undefined"
                            @click="$emit('navigate')"
                        >
                            <span>{{ item.label }}</span>
                            <span
                                v-if="item.helper"
                                class="account-local-navigation__helper"
                            >{{ item.helper }}</span>
                        </RouterLink>
                    </li>
                </ul>
            </nav>
        </section>

        <section
            v-if="variant === 'mobile'"
            class="account-mobile-utilities"
            :aria-label="messages.admin.shell.navigation"
        >
            <div class="account-mobile-utilities__links">
                <RouterLink
                    to="/"
                    class="account-module-link account-mobile-utilities__home-link"
                    @click="$emit('navigate')"
                >
                    <span class="account-module-link__label">{{ messages.admin.shell.mainSite }}</span>
                </RouterLink>
            </div>
            <div class="account-mobile-utilities__controls">
                <LocaleSelectorRuntimeAdapter compact />
                <ThemeModeToggle
                    variant="menu-button"
                    :labels="themeModeLabels"
                />
            </div>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import LocaleSelectorRuntimeAdapter from '@/components/i18n/LocaleSelectorRuntimeAdapter.vue';
import { FSUSBLOG_THEME_MODE_LABELS } from '@/components/ui/themeModeLabels';
import ThemeModeToggle from '@/components/ui/ThemeModeToggle.vue';
import { useI18nText } from '@/composables/useI18nText';
import {
    isAccountNavGroupActive,
    isAccountNavItemActive,
    type AccountNavGroup
} from '@/layouts/accountNav';

const props = withDefaults(defineProps<{
    areaLabel: string;
    groups: readonly AccountNavGroup[];
    headingId?: string;
    variant?: 'desktop' | 'mobile';
}>(), {
    headingId: '',
    variant: 'desktop'
});

defineEmits<(e: 'navigate') => void>();

const route = useRoute();
const { messages, t } = useI18nText();
const themeModeLabels = FSUSBLOG_THEME_MODE_LABELS;
const localizedAreaLabel = computed(() =>
{
    const area = props.groups[0]?.area;
    return area ? messages.value.admin.areas[area] : props.areaLabel;
});
const currentGroup = computed(() => (
    [...props.groups].reverse().find((group) => isAccountNavGroupActive(group, route.path))
    ?? props.groups[0]
    ?? null
));
const localNavigationTitleId = computed(() => (
    `account-${props.variant}-local-navigation-title`
));
</script>

<style scoped>
.account-navigation-panel,
.account-global-module-nav,
.account-local-navigation
 {
    min-width: 0;
}

.account-sidebar-index-label,
.account-local-navigation__title
 {
    margin: 0;
    color: var(--fsusblog-text-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.4;
    text-transform: uppercase;
}

.account-global-module-list,
.account-local-navigation__list
 {
    display: grid;
    gap: var(--fsus-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
}

.account-sidebar-index-label + .account-global-module-list
 {
    margin-top: var(--fsus-space-4);
}

.account-module-link,
.account-local-navigation__link
 {
    position: relative;
    display: grid;
    min-height: 2.75rem;
    min-width: 0;
    align-content: center;
    border-radius: var(--fsus-radius-control-small);
    color: var(--fsusblog-text-secondary);
    outline: none;
    transition:
        background var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        color var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-module-link
 {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--fsus-space-2);
    padding: var(--fsus-space-1) var(--fsus-space-2) var(--fsus-space-1) var(--fsus-space-4);
}

.account-module-link::before,
.account-local-navigation__link::before
 {
    position: absolute;
    top: 50%;
    left: 0;
    width: 2px;
    height: 0;
    background: var(--fsusblog-color-primary);
    content: '';
    opacity: 0;
    transform: translateY(-50%);
    transition:
        height var(--fsus-motion-control-fast) var(--fsus-motion-standard),
        opacity var(--fsus-motion-control-fast) var(--fsus-motion-standard);
}

.account-module-link:hover,
.account-module-link:focus-visible,
.account-module-link-active,
.account-local-navigation__link:hover,
.account-local-navigation__link:focus-visible,
.account-local-navigation__link--active
 {
    background: var(--fsusblog-page-bg-soft);
    color: var(--fsusblog-text-primary);
}

.account-module-link:focus-visible,
.account-local-navigation__link:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
}

@media (forced-colors: active)
 {
    .account-module-link:focus-visible,
    .account-local-navigation__link:focus-visible
 {
        outline: 2px solid Highlight;
        outline-offset: -2px;
    }
}

.account-module-link-active::before,
.account-local-navigation__link--active::before
 {
    height: 1.25rem;
    opacity: 1;
}

.account-module-link__label
 {
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
}

.account-local-navigation__link > span:first-child
 {
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
}

.account-module-link-active .account-module-link__label,
.account-local-navigation__link--active > span:first-child
 {
    font-weight: 700;
}

.account-module-link__helper,
.account-local-navigation__helper
 {
    color: var(--fsusblog-text-tertiary);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.45;
    white-space: nowrap;
}

.account-local-navigation
 {
    margin-top: var(--fsus-space-6);
    border-top: 1px solid var(--fsusblog-panel-border);
    padding-top: var(--fsus-space-4);
}

.account-local-navigation__title
 {
    margin-bottom: var(--fsus-space-2);
}

.account-local-navigation__link
 {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--fsus-space-2);
    padding: var(--fsus-space-1) var(--fsus-space-2) var(--fsus-space-1) var(--fsus-space-8);
}

.account-navigation-panel[data-variant="desktop"] .account-local-navigation__link
 {
    min-height: 2.5rem;
}

.account-mobile-utilities
 {
    margin-top: var(--fsus-space-6);
    border-top: 1px solid var(--fsusblog-panel-border);
    padding-top: var(--fsus-space-4);
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-3);
}

.account-mobile-utilities__controls
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fsus-space-2);
    padding-inline: var(--fsus-space-2);
}

</style>
