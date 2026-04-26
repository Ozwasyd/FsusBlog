import type { MarkdownEditorProviderContract } from '@/ui-contracts/markdownEditor'
import { AsyncMarkdownRenderer } from '@/components/ui/AsyncMarkdownRenderer'
import WasmMarkdownEditor from '@/components/ui/WasmMarkdownEditor.vue'

export const wasmMarkdownEditorProvider: MarkdownEditorProviderContract = {
  id: 'wasm-markdown-editor',
  label: 'wasm markdown editor',
  editorComponent: WasmMarkdownEditor,
  previewComponent: AsyncMarkdownRenderer,
  defaultMode: 'write',
  defaultToolbarsExclude: []
}

export function resolveMarkdownEditorProvider(): MarkdownEditorProviderContract {
  return wasmMarkdownEditorProvider
}
