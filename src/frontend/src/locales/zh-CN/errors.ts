export const localeDomainIdentity = Object.freeze({ locale: 'zh-CN', domain: 'errors' } as const);

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: '访问被拒绝',
        description: '当前账户权限不足以访问此区域。',
        homeCta: '回到主页',
        reLoginCta: '重新登录'
    },
    notFound: {
        codePrefix: '404',
        title: '页面未找到',
        description: '资源已移动、删除或不存在。',
        homeCta: '回到主页',
        searchCta: '搜索文章',
        archiveCta: '查看归档'
    }
} as const;
