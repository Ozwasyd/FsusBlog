export const localeDomainIdentity = Object.freeze({ locale: 'zh-Hant', domain: 'common' } as const)

import type { LocaleSchema } from '../keys'
import type { common as zhCNCommon } from '../zh-CN/common'

export const common = {
    actions: {
        save: '儲存',
        cancel: '取消',
        confirm: '確認',
        retry: '重試',
        delete: '刪除',
        refresh: '重新整理',
        publish: '發佈',
        close: '關閉',
        backHome: '回到主頁'
    },
    time: {
        unknown: '時間未知',
        invalid: '時間格式錯誤',
        justNow: '剛剛'
    },
    routeTitles: {
        home: '首頁',
        article: '文章詳情',
        archive: '歸檔',
        about: '關於',
        privacy: '隱私政策',
        guidelines: '使用者守則',
        copyright: '版權聲明',
        search: '搜尋結果',
        login: '登入',
        register: '註冊',
        recover: '恢復存取',
        account: '身份中心',
        messages: '我的訊息',
        dashboard: '儀表板',
        writeArticle: '寫文章',
        moderateComments: '評論審核',
        settings: '系統設定',
        forbidden: '無權存取',
        notFound: '頁面不存在'
    },
    loading: {
        status: '正在載入',
        statusWithSite: '正在載入 {siteTitle}'
    }
} as const satisfies LocaleSchema<typeof zhCNCommon>
