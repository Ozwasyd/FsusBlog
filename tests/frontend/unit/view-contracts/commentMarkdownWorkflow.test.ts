import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('comment markdown workflow contract', () => {
  const composer = readRepoFile('src/frontend/src/components/article/ArticleCommentComposer.vue')
  const list = readRepoFile('src/frontend/src/components/article/ArticleCommentsVirtualList.vue')
  const renderer = readRepoFile('src/frontend/src/components/article/CommentMarkdownRenderer.vue')

  it('uses a lightweight write/preview composer with local markdown validation', () => {
    expect(composer).toContain("commentComposerMode")
    expect(composer).toContain("value: 'write'")
    expect(composer).toContain("value: 'preview'")
    expect(composer).toContain('inspectCommentMarkdownContent')
    expect(composer).toContain('markdownValidation')
    expect(composer).toContain('editorInputRef')
    expect(composer).toContain('focusEditorAfterSubmit')
    expect(composer).toContain('aria-live="polite"')
  })

  it('supports long-form writing without changing the restricted markdown surface', () => {
    expect(composer).toContain('commentMaxChars')
    expect(composer).toContain('commentMaxUtf8Bytes')
    expect(composer).toContain('comment-composer-focus')
    expect(composer).toContain('focusModeVisible')
    expect(composer).toContain('localDraft')
    expect(composer).toContain('savedAt')
    expect(composer).toContain('discardCommentDraft')
    expect(composer).toContain('comment-composer-metrics')
    expect(composer).toContain('autosize')
    expect(composer).toContain(':rows="4"')
    expect(composer).not.toContain('show-image-action')
    expect(composer).not.toContain('upload-image')
  })

  it('renders comments through the restricted comment renderer and folds long content', () => {
    expect(list).toContain('CommentMarkdownRenderer')
    expect(list).toContain('isCommentExpanded')
    expect(list).toContain('toggleCommentExpansion')
    expect(list).toContain('COMMENT_CONTENT_CONSTRAINT.collapsedMarkdownMaxLines')
    expect(list).not.toContain('{{ thread.content }}')
    expect(list).not.toContain('{{ reply.content }}')
  })

  it('keeps the comment renderer locked to the restricted markdown feature set', () => {
    expect(renderer).toContain(':allow-html="false"')
    expect(renderer).toContain(':allow-latex="false"')
    expect(renderer).toContain(':allow-mermaid="false"')
    expect(renderer).toContain('comment-markdown-renderer')
    expect(renderer).toContain('overflow-wrap: anywhere')
  })
})
