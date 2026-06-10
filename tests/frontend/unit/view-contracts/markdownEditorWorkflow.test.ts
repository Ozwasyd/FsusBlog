import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('admin markdown editor workflow contract', () => {
  const contracts = readRepoFile('src/frontend/src/ui-contracts/markdownEditor.ts')
  const commands = readRepoFile('src/frontend/src/components/ui/markdown-editor/commands.ts')
  const textEditor = readRepoFile('src/frontend/src/components/ui/MarkdownTextEditor.vue')
  const adapter = readRepoFile('src/frontend/src/components/ui/MarkdownEditorAdapter.vue')
  const writeEditor = readRepoFile('src/frontend/src/components/admin/article/ArticleWriteEditor.vue')
  const writePage = readRepoFile('src/frontend/src/views/admin/article/Write.vue')
  const writeComposable = readRepoFile('src/frontend/src/composables/useAdminArticleWrite.ts')

  it('supports split preview without dropping write or preview modes', () => {
    expect(contracts).toContain("export type MarkdownEditorMode = 'write' | 'split' | 'preview'")
    expect(adapter).toContain('value="split"')
    expect(adapter).toContain("mode === 'write' || mode === 'split'")
    expect(adapter).toContain('v-if="isPreviewMounted"')
    expect(adapter).toContain("mode.value === 'preview' || mode.value === 'split'")
    expect(adapter).toContain('editor-shell__body--split')
  })

  it('routes Ctrl/Cmd+S to draft save while Ctrl/Cmd+Enter keeps the submit confirmation path', () => {
    const keydownBlock = textEditor.slice(
      textEditor.indexOf('async function handleKeydown'),
      textEditor.indexOf("if (event.key === 'Tab')")
    )
    expect(keydownBlock).toContain("emit('on-draft-save')")
    expect(keydownBlock).not.toContain("emit('on-save')")
    expect(keydownBlock).toContain("emit('on-submit')")
    expect(writeEditor).toContain('@draft-save="$emit(\'draft-save\')"')
    expect(writePage).toContain('@draft-save="saveDraftNow"')
    expect(writePage).not.toContain('@save="requestSubmit"')
  })

  it('inserts reusable assets at the editor cursor before falling back to append', () => {
    expect(textEditor).toContain('defineExpose')
    expect(textEditor).toContain('insertMarkdownAtCursor')
    expect(adapter).toContain('insertMarkdownAtCursor')
    expect(writeEditor).toContain('insertMarkdownAtCursor')
    expect(writePage).toContain('@insert="insertAssetIntoEditor"')
    expect(writeComposable).toContain('insertAtCursor?.(`\\n${markdown}\\n`)')
  })

  it('keeps editing available during image uploads and replaces upload placeholders', () => {
    expect(textEditor).toContain(':disabled="editorDisabled"')
    expect(textEditor).toContain('图片上传中，可继续编辑')
    expect(textEditor).toContain('fsus-upload-placeholder://')
    expect(textEditor).toContain('replaceUploadPlaceholders')
    expect(textEditor).toContain('可重新粘贴或点击图片按钮重试')
  })

  it('uses grouped author-friendly toolbar terminology and native textarea undo', () => {
    expect(contracts).toContain('MarkdownEditorCommandGroup')
    expect(commands).toContain("label: '一级标题'")
    expect(commands).toContain("label: '公式'")
    expect(commands).toContain("label: '流程图'")
    expect(textEditor).toContain('markdown-text-editor__toolbar-group')
    expect(textEditor).toContain("command.key !== 'undo'")
    expect(textEditor).toContain("command.key !== 'redo'")
  })

  it('exposes writing status, right-sidebar tabs, and layout density controls', () => {
    expect(textEditor).toContain('Intl as typeof Intl')
    expect(textEditor).toContain('约 {{ readingMinutes }} 分钟')
    expect(textEditor).toContain('Ln {{ cursorLine }}, Col {{ cursorColumn }}')
    expect(writePage).toContain('v-model="sidePanelTab"')
    expect(writePage).toContain('label="发布设置"')
    expect(writePage).toContain('label="内容检查"')
    expect(writePage).toContain('label="预览"')
    expect(writePage).toContain('label="历史版本"')
    expect(writePage).toContain('label="资源"')
    expect(writePage).toContain('editorLayoutMode')
    expect(writePage).toContain('layoutModeDescription')
    expect(writePage).toContain('write-grid--wide')
  })
})
