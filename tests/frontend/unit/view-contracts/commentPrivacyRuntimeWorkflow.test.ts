import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const vueTemplate = (source: string): string => source.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? ''

describe('comment privacy runtime workflow contract', () => {
  const runtime = readRepoFile('src/frontend/src/privacy/commentPrivacyRuntime.ts')
  const types = readRepoFile('src/frontend/src/privacy/commentPrivacyTypes.ts')
  const workerClient = readRepoFile('src/frontend/src/privacy/commentPrivacyWorkerClient.ts')
  const articleDetail = readRepoFile('src/frontend/src/composables/useArticleDetailView.ts')
  const articleView = readRepoFile('src/frontend/src/views/ArticleDetail.vue')
  const composer = readRepoFile('src/frontend/src/components/article/ArticleCommentComposer.vue')
  const composerTemplate = vueTemplate(composer)

  it('keeps proof internals inside the privacy runtime boundary', () => {
    expect(types).toContain("export type CommentPrivacyUiState = 'ready' | 'preparing' | 'unavailable' | 'publicOnly'")
    expect(runtime).toContain('ensureCredentialPrepared')
    expect(runtime).toContain('preloadPrivacyMetadata')
    expect(runtime).toContain('prewarmProver')
    expect(runtime).toContain('prepareAnonymousTicket')
    expect(runtime).toContain('consumePreparedTicket')
    expect(runtime).toContain('getUiState')
    expect(runtime).not.toContain('localStorage')
    expect(runtime).not.toContain('sessionStorage')
  })

  it('uses low-priority scheduling and aborts stale article preloads', () => {
    expect(runtime).toContain('new AbortController()')
    expect(runtime).toContain('requestIdleCallback')
    expect(runtime).toContain('queueMicrotask')
    expect(runtime).toContain('cancelActivePreload')
  })

  it('keeps the worker client lazy and transferable-friendly', () => {
    expect(workerClient).toContain('let singleton')
    expect(workerClient).toContain('new Worker')
    expect(workerClient).toContain('postMessage(message, transfer')
    expect(workerClient).toContain('metadataBytes')
  })

  it('wires article idle preload, composer intent, and submit-time ticket consumption', () => {
    expect(articleDetail).toContain('commentPrivacyRuntime.preloadPrivacyMetadata(article.value.id)')
    expect(articleDetail).toContain('prepareCommentPrivacyTicket')
    expect(articleDetail).toContain('consumePreparedTicket(commentAnonymousScope.value)')
    expect(articleView).toContain(':privacy-state="commentPrivacyUiState"')
    expect(articleView).toContain('@privacy-intent="prepareCommentPrivacyTicket"')
    expect(composer).toContain('privacyState')
    expect(composer).toContain('privacy-intent')
  })

  it('keeps the empty composer editable so privacy intent can prepare a ticket', () => {
    expect(composerTemplate).toContain(':disabled="composerInputDisabled"')
    expect(composer).toContain('const composerInputDisabled = computed(() =>')
    const inputDisabledBlock = extractConstBlock(composer, 'const composerInputDisabled = computed')
    expect(inputDisabledBlock).not.toContain('hasContent')
    expect(inputDisabledBlock).not.toContain('contentModel')
    expect(inputDisabledBlock).not.toContain('publicIdentityModel')
    expect(inputDisabledBlock).not.toContain('publicSendConfirmed')
    expect(composer).toContain('const submitDisabled = computed(() => composerUi.value.disabled || !markdownValidation.value.isValid)')
    expect(composer).not.toContain('anonymousTicketPreparing')
  })

  it('keeps the composer user-facing and free of proof terminology', () => {
    expect(composerTemplate).toContain('匿名发布暂不可用')
    expect(composerTemplate.toLowerCase()).not.toContain('proof')
    expect(composerTemplate.toLowerCase()).not.toContain('root')
    expect(composerTemplate.toLowerCase()).not.toContain('nullifier')
    expect(composerTemplate.toLowerCase()).not.toContain('circuit')
    expect(composerTemplate).not.toContain('凭证')
  })
})

function extractConstBlock(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}
