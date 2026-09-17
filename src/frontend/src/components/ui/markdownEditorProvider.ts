
import { AsyncMarkdownRenderer } from '@/components/ui/AsyncMarkdownRenderer';
import MarkdownTextEditor from '@/components/ui/MarkdownTextEditor.vue';
import type { MarkdownEditorProviderContract } from '@/ui-contracts/markdownEditor';

import type { Component } from 'vue';

function requireComponent(value: unknown, name: string): Component
{
    if ((typeof value === 'object' && value !== null) || typeof value === 'function')
    {
        return value;
    }
    throw new TypeError(`${name} must resolve to a Vue component`);
}

const markdownTextEditorProvider: MarkdownEditorProviderContract = {
    id: 'fsusui-markdown-editor',
    label: 'FsusUI MarkdownEditor',
    editorComponent: requireComponent(MarkdownTextEditor, 'MarkdownTextEditor'),
    previewComponent: requireComponent(AsyncMarkdownRenderer, 'AsyncMarkdownRenderer'),
    defaultMode: 'source',
    defaultToolbarsExclude: []
};

export function resolveMarkdownEditorProvider(): MarkdownEditorProviderContract
{
    return markdownTextEditorProvider;
}
