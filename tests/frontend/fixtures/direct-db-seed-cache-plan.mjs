export function buildDirectDbSeedCacheActions(seed) {
  const candidates = Array.isArray(seed?.articleIds) && seed.articleIds.length > 0
    ? seed.articleIds
    : [seed?.articleId]
  const articleIds = [...new Set(candidates
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))]

  if (articleIds.length === 0) {
    throw new Error('direct DB seed cache plan requires at least one article id')
  }

  return [
    ...articleIds.map((articleId) => ({ action: 'output-cache-clear', articleId })),
    { action: 'public-hot-rebuild', articleId: null }
  ]
}
