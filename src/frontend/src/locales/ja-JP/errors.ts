import type { DeepStringShape } from '../keys'
import type { errors as zhCNErrors } from '../zh-CN/errors'

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: 'アクセスが拒否されました',
        description: 'このアカウントにはこのエリアへのアクセス権限がありません。',
        homeCta: 'ホームに戻る',
        reLoginCta: '別のアカウントでログイン'
    },
    notFound: {
        codePrefix: '404',
        title: 'ページが見つかりません',
        description: 'リソースは移動、削除されたか、存在しません。',
        homeCta: 'ホームに戻る',
        searchCta: '記事を検索',
        archiveCta: 'アーカイブを見る'
    }
} as const satisfies DeepStringShape<typeof zhCNErrors>
