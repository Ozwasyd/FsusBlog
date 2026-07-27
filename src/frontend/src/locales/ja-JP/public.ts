export const localeDomainIdentity = Object.freeze({ locale: 'ja-JP', domain: 'public' } as const)

import type { LocaleSchema } from '../keys'
import type { publicMessages as zhCNPublicMessages } from '../zh-CN/public'

export const publicMessages = {
    shell: {
        skipToMain: 'メインコンテンツへ',
        navigation: 'サイトナビゲーション',
        primaryNavigation: 'メインナビゲーション',
        mobileMenu: 'メニュー',
        mobileUtilities: '表示とアカウント',
        search: '検索',
        searchCancel: 'キャンセル',
        searchAria: 'コンテンツを検索',
        searchPlaceholder: '記事、タグ、キーワードを検索',
        searchPlaceholderShortcut: '記事、タグ、キーワードを検索 (Ctrl+K)',
        login: 'ログイン',
        account: 'アカウント',
        dashboard: 'ダッシュボード',
        home: 'ホーム',
        archive: 'アーカイブ',
        about: '概要',
        light: 'ライト',
        dark: 'ダーク',
        system: 'システム設定に従う',
        lightShort: 'ライト',
        darkShort: 'ダーク',
        systemShort: 'システム'
    },
    footer: {
        rssAria: 'RSS フィードを開く',
        licensePrefix: '特に明記されていない限り、コンテンツは',
        licenseSuffix: 'の下で提供されます。',
        licenseAria: 'コンテンツライセンスを開く',
        policiesAria: 'サイトポリシー',
        privacy: 'プライバシー',
        guidelines: '利用規約',
        copyright: '著作権',
        recordsAria: 'サイト登録情報',
        policeBadgeAlt: '公安登録',
        icpAria: 'ICP 登録システムを開く',
        policeAria: '公安登録プラットフォームを開く',
        backToTop: 'トップへ',
        backToTopAria: 'ページの先頭に戻る',
        ownerSeparator: '。',
        allRightsReserved: '無断転載を禁じます。'
    },
    home: {
        loading: '記事を読み込み中',
        emptyTitle: '公開記事はありません',
        emptyDescription: '公開された記事はここに表示されます。',
        errorTitle: '記事一覧は現在利用できません',
        retry: '再読み込み'
    },
    archive: {
        title: 'アーカイブ',
        publishedCount: {
            kind: 'plural',
            forms: {
                other: '{count} 件の記事を公開'
            }
        },
        yearNavigation: '年別クイックナビゲーション',
        emptyDescription: '公開されたコンテンツはここに表示されます。'
    },
    filter: {
        scope: '範囲：記事、タグ、キーワード',
        result: '結果：{state}',
        sort: '並べ替え',
        sortAria: '検索結果の並べ替え',
        relevance: '関連度',
        latest: '最新',
        hot: '人気',
        previous: '前へ',
        next: '次へ',
        searching: '検索中',
        unavailable: '検索対象は利用できません',
        backHome: 'ホームに戻る'
    }
} as const satisfies LocaleSchema<typeof zhCNPublicMessages>
