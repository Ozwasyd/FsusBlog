import type { DeepStringShape } from '../keys'
import type { layout as zhCNLayout } from '../zh-CN/layout'

export const layout = {
    siteHeader: {
        ariaLabel: '站點導覽',
        navAriaLabel: '主導覽',
        mobileNavMenuLabel: '選單',
        mobileUtilityAriaLabel: '顯示與帳號',
        searchTriggerLabel: '搜尋',
        searchCancelLabel: '取消',
        searchAriaLabel: '搜尋內容',
        searchPlaceholder: '搜尋文章、標籤或關鍵字',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: '工程記錄、效能實驗、UI 系統與 FsusBlog 建置過程。',
        fallbackKeywords: '.NET, 前端效能, 系統設計, UI 系統, 技術部落格, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: '熱門文章',
        leadEyebrow: '本期推薦',
        feedEyebrow: '最新文章',
        leadLoadingLabel: '正在載入主推薦',
        feedLoadingLabel: '正在載入文章列表',
        ariaReadFull: '閱讀全文：{title}',
        viewsUnit: '次開啟'
    },
    themeMode: {
        label: '主題模式'
    }
} as const satisfies DeepStringShape<typeof zhCNLayout>
