export const localeDomainIdentity = Object.freeze({ locale: 'en-US', domain: 'layout' } as const);

import type { LocaleSchema } from '../keys';
import type { layout as zhCNLayout } from '../zh-CN/layout';

export const layout = {
    siteHeader: {
        ariaLabel: 'Site navigation',
        navAriaLabel: 'Main navigation',
        mobileNavMenuLabel: 'Menu',
        mobileUtilityAriaLabel: 'Display and account',
        searchTriggerLabel: 'Search',
        searchCancelLabel: 'Cancel',
        searchAriaLabel: 'Search content',
        searchPlaceholder: 'Search posts, tags, or keywords',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: 'Engineering logs, performance benchmarks, UI design systems, and FsusBlog development.',
        fallbackKeywords: '.NET, Frontend performance, System design, UI systems, Tech blog, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: 'Popular posts',
        leadEyebrow: 'Featured',
        feedEyebrow: 'Latest posts',
        leadLoadingLabel: 'Loading featured post',
        feedLoadingLabel: 'Loading post list',
        ariaReadFull: 'Read full post: {title}',
        viewCount: {
            kind: 'plural',
            forms: {
                one: '{count} view',
                other: '{count} views'
            }
        }
    },
    themeMode: {
        label: 'Theme mode'
    }
} as const satisfies LocaleSchema<typeof zhCNLayout>;
