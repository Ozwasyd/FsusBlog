export const localeDomainIdentity = Object.freeze({ locale: 'zh-Hant', domain: 'public' } as const);

import type { LocaleSchema } from '../keys';
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public';

export const publicMessages = {
    shell: {
        skipToMain: '跳到主要內容',
        navigation: '站點導覽',
        primaryNavigation: '主導覽',
        mobileMenu: '選單',
        mobileUtilities: '顯示與帳號',
        search: '搜尋',
        searchCancel: '取消',
        searchAria: '搜尋內容',
        searchPlaceholder: '搜尋文章、標籤或關鍵字',
        searchPlaceholderShortcut: '搜尋文章、標籤或關鍵字 (Ctrl+K)',
        login: '登入',
        account: '帳戶',
        dashboard: '控制板',
        home: '首頁',
        archive: '歸檔',
        about: '關於',
        light: '淺色',
        dark: '深色',
        system: '跟隨系統',
        lightShort: '淺',
        darkShort: '深',
        systemShort: '系統'
    },
    footer: {
        rssAria: '開啟 RSS 訂閱',
        licensePrefix: '除特別註明外，內容採用',
        licenseSuffix: '授權。',
        licenseAria: '開啟內容授權協議',
        policiesAria: '站點政策',
        privacy: '隱私',
        guidelines: '守則',
        copyright: '版權',
        recordsAria: '站點備案',
        policeBadgeAlt: '公安備案',
        icpAria: '開啟工信部備案系統',
        policeAria: '開啟公安備案平台',
        backToTop: '回到頂部',
        backToTopAria: '回到頁面頂部',
        ownerSeparator: '。',
        allRightsReserved: '保留所有權利。'
    },
    home: {
        loading: '正在載入文章',
        emptyTitle: '暫無公開文章',
        emptyDescription: '發佈後的文章會顯示在這裡。',
        errorTitle: '文章列表暫不可用',
        retry: '重新載入'
    },
    archive: {
        title: '歸檔',
        publishedCount: {
            kind: 'plural',
            forms: {
                other: '已發佈 {count} 篇'
            }
        },
        yearNavigation: '年份快速導覽',
        emptyDescription: '發佈後的內容會顯示在這裡。'
    },
    filter: {
        scope: '範圍：文章、標籤、關鍵字',
        result: '結果：{state}',
        sort: '排序',
        sortAria: '搜尋排序',
        relevance: '相關',
        latest: '最新',
        hot: '熱度',
        previous: '上一頁',
        next: '下一頁',
        searching: '正在檢索',
        unavailable: '搜尋目標不可用',
        backHome: '回到主頁'
    }
} as const satisfies LocaleSchema<typeof zhCNPublicMessages>;
