import { AsyncMarkdownRenderer } from '@/components/ui/AsyncMarkdownRenderer';
import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue';
import type { MarkdownEditorProviderContract } from '@/ui-contracts/markdownEditor';

const markdownTextEditorProvider: MarkdownEditorProviderContract = {
    id: 'fsusui-markdown-editor',
    label: 'FsusUI MarkdownEditor',
    editorComponent: MarkdownTextEditor,
    previewComponent: AsyncMarkdownRenderer,
    defaultMode: 'write',
    defaultToolbarsExclude: []
};

export function resolveMarkdownEditorProvider(): MarkdownEditorProviderContract
{
    return markdownTextEditorProvider;
}
