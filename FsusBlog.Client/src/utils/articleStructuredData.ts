export type ArticleStructuredDataInput = Readonly<{
  id: number | string
  title: string
  summary?: string | null
  articleBody?: string | null
  publishedTime?: string | null
  authorName?: string | null
  categoryName?: string | null
  canonicalUrl?: string | null
}>

export function buildArticleStructuredData(input: ArticleStructuredDataInput): string {
  const summary = input.summary?.trim() || input.title.trim()
  const articleBody = input.articleBody?.trim() || summary
  const authorName = input.authorName?.trim() || 'Fsu'
  const canonicalUrl = input.canonicalUrl?.trim() || `/article/${String(input.id)}`
  const payload = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: input.title.trim(),
    description: summary,
    articleBody,
    datePublished: input.publishedTime?.trim() || undefined,
    dateModified: input.publishedTime?.trim() || undefined,
    articleSection: input.categoryName?.trim() || undefined,
    author: {
      '@type': 'Person',
      name: authorName
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': canonicalUrl
    }
  }

  return JSON.stringify(payload)
}
