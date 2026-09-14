export const localeDomainIdentity = Object.freeze({ locale: 'en-US', domain: 'common' } as const);

import type { LocaleSchema } from '../keys';
import type { common as zhCNCommon } from '../zh-CN/common';

export const common = {
    actions: {
        save: 'Save',
        cancel: 'Cancel',
        confirm: 'Confirm',
        retry: 'Retry',
        delete: 'Delete',
        refresh: 'Refresh',
        publish: 'Publish',
        close: 'Close',
        backHome: 'Home'
    },
    time: {
        unknown: 'Unknown time',
        invalid: 'Invalid time',
        justNow: 'Just now'
    },
    routeTitles: {
        home: 'Home',
        article: 'Article',
        archive: 'Archive',
        about: 'About',
        privacy: 'Privacy policy',
        guidelines: 'Site guidelines',
        copyright: 'Copyright',
        search: 'Search results',
        login: 'Log in',
        register: 'Register',
        recover: 'Recover access',
        account: 'Identity center',
        messages: 'Messages',
        dashboard: 'Dashboard',
        writeArticle: 'Write',
        moderateComments: 'Comment moderation',
        settings: 'Settings',
        forbidden: 'Access denied',
        notFound: 'Page not found'
    },
    loading: {
        status: 'Loading',
        statusWithSite: 'Loading {siteTitle}'
    }
} as const satisfies LocaleSchema<typeof zhCNCommon>;
