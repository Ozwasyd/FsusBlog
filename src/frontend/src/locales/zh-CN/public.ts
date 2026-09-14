export const localeDomainIdentity = Object.freeze({ locale: 'zh-CN', domain: 'public' } as const);

export const publicMessages = {
    shell: {
        skipToMain: '跳到主要内容',
        navigation: '站点导航',
        primaryNavigation: '主导航',
        mobileMenu: '菜单',
        mobileUtilities: '显示与账号',
        search: '搜索',
        searchCancel: '取消',
        searchAria: '搜索内容',
        searchPlaceholder: '搜索文章、标签或关键词',
        searchPlaceholderShortcut: '搜索文章、标签或关键词 (Ctrl+K)',
        login: '登录',
        account: '账户',
        dashboard: '控制板',
        home: '首页',
        archive: '归档',
        about: '关于',
        light: '浅色',
        dark: '深色',
        system: '跟随系统',
        lightShort: '浅',
        darkShort: '深',
        systemShort: '系统'
    },
    footer: {
        rssAria: '打开 RSS 订阅',
        licensePrefix: '除特别注明外，内容采用',
        licenseSuffix: '许可。',
        licenseAria: '打开内容许可协议',
        policiesAria: '站点政策',
        privacy: '隐私',
        guidelines: '守则',
        copyright: '版权',
        recordsAria: '站点备案',
        policeBadgeAlt: '公安备案',
        icpAria: '打开工信部备案系统',
        policeAria: '打开公安备案平台',
        backToTop: '回到顶部',
        backToTopAria: '回到页面顶部',
        ownerSeparator: '。',
        allRightsReserved: '保留所有权利。'
    },
    home: {
        loading: '正在加载文章',
        emptyTitle: '暂无公开文章',
        emptyDescription: '发布后的文章会显示在这里。',
        errorTitle: '文章列表暂不可用',
        retry: '重新加载'
    },
    archive: {
        title: '归档',
        publishedCount: {
            kind: 'plural',
            forms: {
                other: '已发布 {count} 篇'
            }
        },
        yearNavigation: '年份快速导航',
        emptyDescription: '发布后的内容会显示在这里。'
    },
    filter: {
        scope: '范围：文章、标签、关键词',
        result: '结果：{state}',
        sort: '排序',
        sortAria: '搜索排序',
        relevance: '相关',
        latest: '最新',
        hot: '热度',
        previous: '上一页',
        next: '下一页',
        searching: '正在检索',
        unavailable: '搜索目标不可用',
        backHome: '回到主页'
    }
} as const;
