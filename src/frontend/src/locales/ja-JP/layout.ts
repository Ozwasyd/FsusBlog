export const localeDomainIdentity = Object.freeze({ locale: 'ja-JP', domain: 'layout' } as const)

import type { LocaleSchema } from '../keys'
import type { layout as zhCNLayout } from '../zh-CN/layout'

export const layout = {
    siteHeader: {
        ariaLabel: 'サイトナビゲーション',
        navAriaLabel: 'メインナビゲーション',
        mobileNavMenuLabel: 'メニュー',
        mobileUtilityAriaLabel: '表示とアカウント',
        searchTriggerLabel: '検索',
        searchCancelLabel: 'キャンセル',
        searchAriaLabel: 'コンテンツを検索',
        searchPlaceholder: '記事、タグ、キーワードを検索',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: 'エンジニアリング記録、パフォーマンス実験、UI システム、FsusBlog の構築過程。',
        fallbackKeywords: '.NET, フロントエンドパフォーマンス, システム設計, UI システム, 技術ブログ, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: '人気記事',
        leadEyebrow: '注目記事',
        feedEyebrow: '最新記事',
        leadLoadingLabel: '注目記事を読み込み中',
        feedLoadingLabel: '記事一覧を読み込み中',
        ariaReadFull: '全文を読む：{title}',
        viewCount: {
            kind: 'plural',
            forms: {
                other: '{count} 回表示'
            }
        }
    },
    themeMode: {
        label: 'テーマモード'
    }
} as const satisfies LocaleSchema<typeof zhCNLayout>
