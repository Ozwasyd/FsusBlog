import type { MarkdownEditorProviderContract } from '@/ui-contracts/markdownEditor'
import { AsyncMarkdownRenderer } from '@/components/ui/AsyncMarkdownRenderer'
import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue'

const markdownTextEditorProvider: MarkdownEditorProviderContract = {
  id: 'markdown-text-editor',
  label: 'markdown text editor',
  editorComponent: MarkdownTextEditor,
  previewComponent: AsyncMarkdownRenderer,
  defaultMode: 'write',
  defaultToolbarsExclude: []
}

export function resolveMarkdownEditorProvider(): MarkdownEditorProviderContract {
  return markdownTextEditorProvider
}
