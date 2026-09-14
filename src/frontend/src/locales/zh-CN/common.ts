export const localeDomainIdentity = Object.freeze({ locale: 'zh-CN', domain: 'common' } as const);

export const common = {
    actions: {
        save: '保存',
        cancel: '取消',
        confirm: '确认',
        retry: '重试',
        delete: '删除',
        refresh: '刷新',
        publish: '发布',
        close: '关闭',
        backHome: '回到主页'
    },
    time: {
        unknown: '时间未知',
        invalid: '时间格式错误',
        justNow: '刚刚'
    },
    routeTitles: {
        home: '首页',
        article: '文章详情',
        archive: '归档',
        about: '关于',
        privacy: '隐私政策',
        guidelines: '用户守则',
        copyright: '版权声明',
        search: '搜索结果',
        login: '登录',
        register: '注册',
        recover: '恢复访问',
        account: '身份中心',
        messages: '我的消息',
        dashboard: '仪表盘',
        writeArticle: '写文章',
        moderateComments: '评论审核',
        settings: '系统设置',
        forbidden: '无权访问',
        notFound: '页面不存在'
    },
    loading: {
        status: '正在加载',
        statusWithSite: '正在加载 {siteTitle}'
    }
} as const;
