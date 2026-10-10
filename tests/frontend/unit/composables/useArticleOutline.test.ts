// @vitest-environment happy-dom

import { nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'

import {
  createArticleOutlineSnapshot,
  flattenArticleOutlineTree,
  isArticleOutlineSnapshotCurrent,
  useArticleOutline,
} from '@/composables/useArticleOutline'

describe('article outline FsusUI projection adapter', () => {
  it('consumes the required heading-count matrix without a consumer-side parser', () => {
    for (const count of [0, 1, 10, 100, 1000, 10000]) {
      const source = Array.from({ length: count }, (_, index) => `# Heading ${index}`).join('\n\n')
      const snapshot = createArticleOutlineSnapshot({
        articleIdentity: `article-${count}`,
        documentIdentity: { id: `article-${count}:tab`, epoch: 1 },
        source,
        sourceRevision: 0,
      })

      expect(snapshot?.items).toHaveLength(count)
    }
  }, 30_000)

  it('keeps syntax, diagnostics and ranges in the canonical projection', () => {
    const documentIdentity = { id: 'article-a', epoch: 1 }
    const snapshot = createArticleOutlineSnapshot({
      articleIdentity: 'article-a',
      documentIdentity,
      source: '# One\n\n### Jumped\n\nTwo\n---\n\n# One\n',
      sourceRevision: 4,
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.items.map((item) => item.text)).toEqual([
      'One',
      'Jumped',
      'Two',
      'One',
    ])
    expect(snapshot?.items[1]?.diagnostics).toContainEqual({
      code: 'heading-layer-jump',
      nodeId: snapshot?.items[1]?.nodeId,
    })
    expect(snapshot?.items[3]?.diagnostics).toContainEqual({
      code: 'duplicate-h1',
      nodeId: snapshot?.items[3]?.nodeId,
    })
    expect(snapshot?.items.every((item) => item.sourceRange.end > item.sourceRange.start)).toBe(true)
    expect(snapshot?.tree[0]?.children[0]?.parentId).toBe(snapshot?.tree[0]?.nodeId)
  })

  it('preserves empty, CJK, RTL, emoji, long, duplicate, setext and jumped headings', () => {
    const longHeading = `Long ${'heading '.repeat(40).trim()}`
    const snapshot = createArticleOutlineSnapshot({
      articleIdentity: 'article-content-matrix',
      documentIdentity: { id: 'article-content-matrix:tab', epoch: 1 },
      source: [
        '#',
        '#  ',
        '# 中文标题',
        '# عنوان عربي',
        '# Emoji 🧭✨',
        `# ${longHeading}`,
        '# 中文标题',
        'Setext title\n============',
        '### Jumped',
      ].join('\n\n'),
      sourceRevision: 9,
    })

    expect(snapshot?.items.map((item) => item.text)).toEqual([
      '',
      '',
      '中文标题',
      'عنوان عربي',
      'Emoji 🧭✨',
      longHeading,
      '中文标题',
      'Setext title',
      'Jumped',
    ])
    expect(new Set(snapshot?.items.map((item) => item.nodeId)).size).toBe(9)
    for (const item of snapshot?.items.slice(0, 2) ?? []) {
      expect(item.diagnostics).toContainEqual({ code: 'empty-heading', nodeId: item.nodeId })
    }
    expect(snapshot?.items[6]?.diagnostics).toContainEqual({
      code: 'duplicate-h1',
      nodeId: snapshot?.items[6]?.nodeId,
    })
    expect(snapshot?.items[8]?.diagnostics).toContainEqual({
      code: 'heading-layer-jump',
      nodeId: snapshot?.items[8]?.nodeId,
    })
  })

  it('binds snapshots to article identity, document epoch and source revision', () => {
    const source = '# Same source\n\nBody\n'
    const first = createArticleOutlineSnapshot({
      articleIdentity: 'article-a',
      documentIdentity: { id: 'article-a:tab', epoch: 1 },
      source,
      sourceRevision: 0,
    })
    const second = createArticleOutlineSnapshot({
      articleIdentity: 'article-b',
      documentIdentity: { id: 'article-b:tab', epoch: 1 },
      source,
      sourceRevision: 0,
    })

    expect(first?.items[0]?.nodeId).not.toBe(second?.items[0]?.nodeId)
    expect(isArticleOutlineSnapshotCurrent(first, {
      articleIdentity: 'article-a',
      documentIdentity: { id: 'article-a:tab', epoch: 1 },
      sourceRevision: 0,
    })).toBe(true)
    expect(isArticleOutlineSnapshotCurrent(first, {
      articleIdentity: 'article-a',
      documentIdentity: { id: 'article-a:tab', epoch: 2 },
      sourceRevision: 0,
    })).toBe(false)
  })

  it('resolves active heading from selection and resets on document replacement', async () => {
    const source = ref('# One\n\n## Two\n\nBody\n')
    const identity = ref({ id: 'article-a:tab', epoch: 1 })
    const revision = ref(0)
    const selection = ref({ start: 13, end: 13, direction: 'none' as const })
    const outline = useArticleOutline({
      articleIdentity: () => identity.value.id,
      documentIdentity: identity,
      source,
      sourceRevision: revision,
      selection,
      cause: 'caret',
    })

    const before = outline.snapshot.value
    expect(before?.items).toHaveLength(2)
    expect(outline.active.value?.headingId).toBe(before?.items[1]?.nodeId)

    expect(outline.noteOutlineNavigation(before?.items[0]?.nodeId ?? '')).toBe(true)
    expect(outline.active.value?.headingId).toBe(before?.items[0]?.nodeId)

    identity.value = { id: 'article-b:tab', epoch: 1 }
    await nextTick()
    const after = outline.snapshot.value
    expect(after?.items[0]?.nodeId).not.toBe(before?.items[0]?.nodeId)
    expect(outline.active.value?.headingId).toBe(after?.items[1]?.nodeId)
  })

  it('flattens only expanded tree nodes without inventing a second hierarchy', () => {
    const snapshot = createArticleOutlineSnapshot({
      articleIdentity: 'article-a',
      documentIdentity: { id: 'article-a:tab', epoch: 1 },
      source: '# One\n\n## Two\n\n### Three\n\n# Four\n',
      sourceRevision: 0,
    })
    expect(snapshot).not.toBeNull()
    const root = snapshot?.tree ?? []
    expect(flattenArticleOutlineTree(root, new Set())).toHaveLength(2)
    expect(flattenArticleOutlineTree(root, new Set([root[0]?.nodeId ?? '']))).toHaveLength(3)
    expect(flattenArticleOutlineTree(root, new Set(root.flatMap((node) => [node.nodeId, ...node.children.map((child) => child.nodeId)])))).toHaveLength(4)
  })
})
