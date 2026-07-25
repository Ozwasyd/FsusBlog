import type { DeepStringShape } from '../keys';
import type { errors as zhCNErrors } from '../zh-CN/errors';

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: 'Access denied',
        description: 'This account does not have access to this area.',
        homeCta: 'Home',
        reLoginCta: 'Use another account'
    },
    notFound: {
        codePrefix: '404',
        title: 'Page not found',
        description: 'The resource moved, was removed, or does not exist.',
        homeCta: 'Home',
        searchCta: 'Search posts',
        archiveCta: 'Archive'
    }
} as const satisfies DeepStringShape<typeof zhCNErrors>;
