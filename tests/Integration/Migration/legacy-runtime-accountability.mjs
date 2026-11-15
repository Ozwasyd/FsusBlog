import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const hidden = process.argv.length === 4 && process.argv[3] === '--hidden'
assert(process.argv.length === 3 || hidden, 'Usage: node legacy-runtime-accountability.mjs BASE_URL [--hidden]')
const base = new URL(process.argv[2])
assert(['http:', 'https:'].includes(base.protocol) && ['127.0.0.1', '[::1]'].includes(base.hostname) &&
  base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash,
'The accountability probe requires a literal loopback origin.')

const article = '/integrity/article/42'
const missingArticle = '/integrity/article/43'
const evidence = {}
const missing = {
  manifestVersion: 1,
  code: 'article_responsibility_not_found',
  message: 'Integrity verification manifest not found.',
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function probe(label, path, status, expected) {
  const response = await fetch(new URL(path, base), {
    redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.status, status, path)
  assert.equal(response.headers.get('set-cookie'), null, path)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json;\s*charset=utf-8$/i, path)
  assert.equal(response.headers.get('cache-control'), 'no-store', path)
  assert(response.headers.get('vary')?.toLowerCase().split(/\s*,\s*/).includes('accept-encoding'), path)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), expected, path)
  evidence[label] = sha256(bytes)
}

function manifest(revision, snapshotId) {
  const fallback = snapshotId === undefined
  return {
    schemaVersion: 1,
    articleId: 42,
    revisionNo: revision,
    responsibilityVersion: fallback ? 0 : 1,
    inheritsSiteAuthor: true,
    legacyFallback: fallback,
    authors: [{ name: 'Fsu' }],
    sources: [],
    responsiblePersonConfirmed: !fallback,
    ...(!fallback && {
      responsibilitySnapshotId: snapshotId,
      update: { summary: 'First revision', reason: '未提供变更原因', conclusionImpact: 'unknown' },
    }),
    verification: { url: `${article}/revisions/${revision}`, revisionNo: revision, proofStatus: 'unavailable' },
  }
}

if (hidden) {
  await probe('hiddenCurrent', `${article}/responsibility`, 404, missing)
  await probe('hiddenHistory', `${article}/revisions/1/responsibility`, 404, missing)
} else {
  const restored = manifest(3, '802')
  await probe('current', `${article}/responsibility`, 200, restored)
  await probe('revision1', `${article}/revisions/1/responsibility`, 200, manifest(1, '799'))
  await probe('revision2', `${article}/revisions/2/responsibility`, 200, manifest(2))
  await probe('revision3', `${article}/revisions/3/responsibility`, 200, restored)
  assert.equal(evidence.current, evidence.revision3)
  await probe('missingCurrent', `${missingArticle}/responsibility`, 404, missing)
  await probe('missingArticleRevision', `${missingArticle}/revisions/1/responsibility`, 404, missing)
  await probe('missingRevision', `${article}/revisions/4/responsibility`, 404, missing)
}
console.log(sha256(JSON.stringify(evidence)))
