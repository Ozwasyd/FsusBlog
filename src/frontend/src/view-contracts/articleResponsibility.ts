export type ArticleResponsiblePersonView = Readonly<{ name: string; profileUrl: string | null }>

export type ArticleEvidenceSourceView = Readonly<{
  title: string
  url: string
  sourceType: string
  accessedOn: string | null
  version: string | null
  citationNote: string | null
}>

export type ArticleResponsibilityPublicView = Readonly<{
  articleId: number
  revisionNo: number
  authors: readonly ArticleResponsiblePersonView[]
  reviewer: ArticleResponsiblePersonView | null
  sources: readonly ArticleEvidenceSourceView[]
  update: Readonly<{ summary: string; reason: string; conclusionImpact: string }> | null
  verification: Readonly<{ url: string; proofStatus: string }>
}>

export function normalizeArticleResponsibilityPublicView(value: unknown): ArticleResponsibilityPublicView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<ArticleResponsibilityPublicView>
  if (!Number.isInteger(record.articleId) || !Number.isInteger(record.revisionNo)
    || !Array.isArray(record.authors) || !Array.isArray(record.sources)
    || !record.verification || typeof record.verification.url !== 'string') return null
  return record as ArticleResponsibilityPublicView
}
