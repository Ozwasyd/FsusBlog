export const localeDomainIdentity = Object.freeze({ locale: 'zh-CN', domain: 'layout' } as const)

export const layout = {
    siteHeader: {
        ariaLabel: '站点导航',
        navAriaLabel: '主导航',
        mobileNavMenuLabel: '菜单',
        mobileUtilityAriaLabel: '显示与账号',
        searchTriggerLabel: '搜索',
        searchCancelLabel: '取消',
        searchAriaLabel: '搜索内容',
        searchPlaceholder: '搜索文章、标签或关键词',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: '工程记录、性能实验、UI 系统与 FsusBlog 构建过程。',
        fallbackKeywords: '.NET, 前端性能, 系统设计, UI 系统, 技术博客, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: '热门文章',
        leadEyebrow: '本期推荐',
        feedEyebrow: '最新文章',
        leadLoadingLabel: '正在加载主推荐',
        feedLoadingLabel: '正在加载文章列表',
        ariaReadFull: '阅读全文：{title}',
        viewsUnit: '次打开'
    },
    themeMode: {
        label: '主题模式'
    }
} as const;
