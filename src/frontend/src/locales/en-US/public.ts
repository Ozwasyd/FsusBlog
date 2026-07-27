export const localeDomainIdentity = Object.freeze({ locale: 'en-US', domain: 'public' } as const)

import type { LocaleSchema } from '../keys';
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public';

export const publicMessages = {
    shell: {
        skipToMain: 'Skip to content',
        navigation: 'Site navigation',
        primaryNavigation: 'Primary navigation',
        mobileMenu: 'Menu',
        mobileUtilities: 'Display and account',
        search: 'Search',
        searchCancel: 'Cancel',
        searchAria: 'Search content',
        searchPlaceholder: 'Search posts, tags, or keywords',
        searchPlaceholderShortcut: 'Search posts, tags, or keywords (Ctrl+K)',
        login: 'Log in',
        account: 'Account',
        dashboard: 'Dashboard',
        home: 'Home',
        archive: 'Archive',
        about: 'About',
        light: 'Light',
        dark: 'Dark',
        system: 'System',
        lightShort: 'Light',
        darkShort: 'Dark',
        systemShort: 'System'
    },
    footer: {
        rssAria: 'Open RSS feed',
        licensePrefix: 'Unless noted otherwise, content is licensed under',
        licenseSuffix: '.',
        licenseAria: 'Open content license',
        policiesAria: 'Site policies',
        privacy: 'Privacy',
        guidelines: 'Guidelines',
        copyright: 'Copyright',
        recordsAria: 'Site registrations',
        policeBadgeAlt: 'Public security registration',
        icpAria: 'Open ICP registration service',
        policeAria: 'Open public security registration service',
        backToTop: 'Top',
        backToTopAria: 'Back to top',
        ownerSeparator: '. ',
        allRightsReserved: 'All rights reserved.'
    },
    home: {
        loading: 'Loading posts',
        emptyTitle: 'No public posts',
        emptyDescription: 'Published posts will appear here.',
        errorTitle: 'Posts are unavailable',
        retry: 'Reload'
    },
    archive: {
        title: 'Archive',
        publishedCount: {
            kind: 'plural',
            forms: {
                one: '{count} post published',
                other: '{count} posts published'
            }
        },
        yearNavigation: 'Browse by year',
        emptyDescription: 'Published posts will appear here.'
    },
    filter: {
        scope: 'Scope: posts, tags, and keywords',
        result: 'Results: {state}',
        sort: 'Sort',
        sortAria: 'Search result sorting',
        relevance: 'Relevance',
        latest: 'Latest',
        hot: 'Popular',
        previous: 'Previous',
        next: 'Next',
        searching: 'Searching',
        unavailable: 'Search target unavailable',
        backHome: 'Home'
    }
} as const satisfies LocaleSchema<typeof zhCNPublicMessages>;
