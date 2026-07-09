import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const collectSourceFiles = (root: string): string[] =>
  readdirSync(repoFile(root)).flatMap((entry) => {
    const path = `${root}/${entry}`
    const absolutePath = repoFile(path)
    if (statSync(absolutePath).isDirectory()) {
      return collectSourceFiles(path)
    }

    return /\.(ts|vue)$/.test(entry) ? [path] : []
  })

describe('frontend handwritten pattern simplification contracts', () => {
  it('keeps PolicyModal close routed through the v-model model ref', () => {
    const policyModal = readRepoFile('src/frontend/src/components/PolicyModal.vue')

    expect(policyModal).not.toContain('const dialogVisible = computed({')
    expect(policyModal).toContain("const dialogVisible = defineModel<boolean>('visible', { required: true })")
    expect(policyModal).toContain('const close = () => {')
    expect(policyModal).toContain('dialogVisible.value = false')
  })

  it('dispatches mutation toast messages through a typed lookup table', () => {
    const mutationFlow = readRepoFile('src/frontend/src/composables/useMutationFlow.ts')

    expect(mutationFlow).toContain('const messageDispatch: Record<MutationMessageType, (text: string) => void> = {')
    expect(mutationFlow).toContain('messageDispatch[type](options.successMessage)')
    expect(mutationFlow).not.toContain("if (type === 'warning')")
    expect(mutationFlow).not.toContain("else if (type === 'error')")
    expect(mutationFlow).not.toContain("else if (type === 'info')")
  })

  it('keeps admin article list delete and row commands on named dispatch paths', () => {
    const adminArticleList = readRepoFile('src/frontend/src/composables/useAdminArticleList.ts')

    expect(adminArticleList).not.toContain('void (async')
    expect(adminArticleList).toContain('const safeDelete = async (row: ArticleListItemResponse): Promise<void> => {')
    expect(adminArticleList).toContain('void safeDelete(row)')
    expect(adminArticleList).toContain('type ArticleListCommand =')
    expect(adminArticleList).toContain('const actionDispatch: Record<ArticleListCommand, () => void> = {')
    expect(adminArticleList).toContain('actionDispatch[command]?.()')
  })

  it('does not keep fire-and-forget async IIFEs in frontend source', () => {
    const offenders = collectSourceFiles('src/frontend/src')
      .filter((path) => readRepoFile(path).includes('void (async'))

    expect(offenders).toEqual([])
  })
})
