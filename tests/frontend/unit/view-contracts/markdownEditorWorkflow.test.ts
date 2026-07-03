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
    expect(textEditor).toContain('@save="emitSave"')
    expect(textEditor).toContain('@submit="emitSubmit"')
    expect(textEditor).toContain('function emitSave(): void')
    expect(textEditor).toContain("emit('on-draft-save')")
    expect(textEditor).toContain("emit('on-save')")
    expect(textEditor).toContain('function emitSubmit(): void')
    expect(textEditor).toContain("emit('on-submit')")
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
    expect(textEditor).toContain('ElMarkdownEditor')
    expect(textEditor).toContain('fsusUiCommands')
    expect(textEditor).toContain("type BlogCommandKey = Exclude<MarkdownEditorCommandKey, 'undo' | 'redo' | 'image' | 'save'>")
    expect(textEditor).toContain('fsusCommandKeys.has(command.key as BlogCommandKey)')
  })

  it('keeps toolbar commands large enough for mobile touch input', () => {
    expect(adapter).toContain(':deep(.el-markdown-editor__command)')
    expect(adapter).toContain(':deep(.el-markdown-editor__action)')
    expect(adapter).toContain('min-height: 36px;')
  })

  it('exposes writing status, inspector sections, and secondary view controls', () => {
    expect(textEditor).toContain('Intl as typeof Intl')
    expect(textEditor).toContain('约 {{ readingMinutes }} 分钟')
    expect(textEditor).toContain('Ln {{ cursorLine }}, Col {{ cursorColumn }}')
    expect(writePage).toContain('class="write-inspector"')
    expect(writePage).toContain('class="write-inspector-section"')
    expect(writePage).toContain('内容检查')
    expect(writePage).toContain('阅读预览')
    expect(writePage).toContain('版本')
    expect(writePage).toContain('资源')
    expect(writePage).toContain('editorLayoutMode')
    expect(writePage).toContain('editorLayoutModeLabel')
    expect(writePage).toContain('write-grid--wide')
    expect(writePage).toContain('grid-template-columns: minmax(0, 1fr) minmax(16rem, min(22rem, 38%));')
  })
})
