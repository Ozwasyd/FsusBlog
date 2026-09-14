export const localeDomainIdentity = Object.freeze({ locale: 'ja-JP', domain: 'common' } as const);

import type { LocaleSchema } from '../keys';
import type { common as zhCNCommon } from '../zh-CN/common';

export const common = {
    actions: {
        save: '保存',
        cancel: 'キャンセル',
        confirm: '確認',
        retry: '再試行',
        delete: '削除',
        refresh: '更新',
        publish: '公開',
        close: '閉じる',
        backHome: 'ホームに戻る'
    },
    time: {
        unknown: '日時不明',
        invalid: '日時形式が無効です',
        justNow: 'たった今'
    },
    routeTitles: {
        home: 'ホーム',
        article: '記事詳細',
        archive: 'アーカイブ',
        about: '概要',
        privacy: 'プライバシーポリシー',
        guidelines: '利用規約',
        copyright: '著作権表示',
        search: '検索結果',
        login: 'ログイン',
        register: '登録',
        recover: 'アクセス復旧',
        account: 'アイデンティティセンター',
        messages: 'メッセージ',
        dashboard: 'ダッシュボード',
        writeArticle: '記事作成',
        moderateComments: 'コメント審査',
        settings: 'システム設定',
        forbidden: 'アクセス拒否',
        notFound: 'ページが見つかりません'
    },
    loading: {
        status: '読み込み中',
        statusWithSite: '{siteTitle} を読み込み中'
    }
} as const satisfies LocaleSchema<typeof zhCNCommon>;
