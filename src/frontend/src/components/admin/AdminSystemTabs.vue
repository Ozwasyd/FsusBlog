<template>
    <FsusUiSectionNav
        :items="sectionNavItems"
        :aria-label="ariaLabel"
        :density="density"
        @click.capture="handleSectionNavClick"
    />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter, type RouteRecordName } from 'vue-router';

import { FsusUiSectionNav } from '@/fsusui';

export interface AdminSystemTab {
    label: string;
    name: RouteRecordName;
    disabled?: boolean;
}

const props = withDefaults(defineProps<{
    items: readonly AdminSystemTab[];
    ariaLabel?: string;
    density?: 'default' | 'compact';
}>(), {
    ariaLabel: '系统栏目',
    density: 'default'
});

const route = useRoute();
const router = useRouter();

const sectionNavItems = computed(() =>
    props.items.map((item) => ({
        key: String(item.name),
        label: item.label,
        href: router.resolve({ name: item.name }).href,
        current: route.name === item.name,
        disabled: item.disabled
    }))
);

const isPlainPrimaryClick = (event: MouseEvent): boolean =>
    event.button === 0
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.altKey;

const handleSectionNavClick = (event: MouseEvent): void =>
{
    if (!isPlainPrimaryClick(event) || event.defaultPrevented)
    {
        return;
    }

    const target = event.target instanceof Element
        ? event.target.closest<HTMLAnchorElement>('a[href]')
        : null;
    if (!target)
    {
        return;
    }

    const rawHref = target.getAttribute('href');
    if (!rawHref)
    {
        return;
    }

    const destination = new URL(rawHref, window.location.href);
    if (destination.origin !== window.location.origin)
    {
        return;
    }

    const nextLocation = `${destination.pathname}${destination.search}${destination.hash}`;
    event.preventDefault();

    if (nextLocation === route.fullPath)
    {
        return;
    }

    void router.push(nextLocation).catch(() => undefined);
};
</script>
