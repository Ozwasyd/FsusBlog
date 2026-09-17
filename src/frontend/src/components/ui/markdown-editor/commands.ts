import {
    insertAtSelection,
    outdentLines,
    prefixLines,
    prependInline,
    wrapSelection,
    type SelectionResult,
    type SelectionSnapshot
} from '@/components/ui/markdown-editor/selection';
import type { MarkdownEditorCommand, MarkdownEditorCommandKey } from '@/ui-contracts/markdownEditor';

export type MarkdownEditorCommandContext = Readonly<{
    snapshot: SelectionSnapshot;
}>;

type CommandHandler = (context: MarkdownEditorCommandContext) => SelectionResult;

export const markdownEditorCommands: readonly MarkdownEditorCommand[] = [
    { key: 'undo', label: '撤销', ariaLabel: '撤销上一步编辑', shortcut: 'Ctrl+Z', group: 'action' },
    { key: 'redo', label: '重做', ariaLabel: '重做上一步编辑', shortcut: 'Ctrl+Y', group: 'action' },
    { key: 'heading-3', label: '小节', ariaLabel: '插入小节', group: 'block' },
    { key: 'heading-4', label: '四级标题', ariaLabel: '插入四级标题', group: 'block' },
    { key: 'heading-5', label: '五级标题', ariaLabel: '插入五级标题', group: 'block' },
    { key: 'heading-6', label: '六级标题', ariaLabel: '插入六级标题', group: 'block' },
    { key: 'ul', label: '无序列表', ariaLabel: '插入无序列表', group: 'insert' },
    { key: 'ol', label: '有序列表', ariaLabel: '插入有序列表', group: 'insert' },
    { key: 'task', label: '任务列表', ariaLabel: '插入任务列表', group: 'insert' },
    { key: 'table', label: '表格', ariaLabel: '插入 Markdown 表格', group: 'insert' },
    { key: 'hr', label: '分割线', ariaLabel: '插入分割线', group: 'insert' },
    { key: 'block', label: '代码块', ariaLabel: '插入代码块', group: 'code' },
    { key: 'latex', label: '公式', ariaLabel: '插入 LaTeX 公式块', group: 'code' },
    { key: 'mermaid', label: '流程图', ariaLabel: '插入 Mermaid 图表', group: 'code' },
    { key: 'image', label: '图片', ariaLabel: '上传并插入图片', group: 'media' },
    { key: 'save', label: '保存草稿', ariaLabel: '保存文章草稿', shortcut: 'Ctrl+S', group: 'action' }
] as const;

const handlers: Readonly<Record<Exclude<MarkdownEditorCommandKey, 'undo' | 'redo' | 'image' | 'save' | 'bold' | 'italic' | 'quote' | 'link' | 'code'>, CommandHandler>> = {
    'heading-3': ({ snapshot }) => prependInline(snapshot, '### ', '小节'),
    'heading-4': ({ snapshot }) => prependInline(snapshot, '#### ', '标题'),
    'heading-5': ({ snapshot }) => prependInline(snapshot, '##### ', '标题'),
    'heading-6': ({ snapshot }) => prependInline(snapshot, '###### ', '标题'),
    ul: ({ snapshot }) => prefixLines(snapshot, '- ', '列表项'),
    ol: ({ snapshot }) => prefixLines(snapshot, '1. ', '列表项'),
    task: ({ snapshot }) => prefixLines(snapshot, '- [ ] ', '待办项'),
    block: ({ snapshot }) => wrapSelection(snapshot, '```text\n', '\n```', 'code'),
    latex: ({ snapshot }) => wrapSelection(snapshot, '$$\n', '\n$$', 'E = mc^2'),
    mermaid: ({ snapshot }) => insertAtSelection(snapshot, '```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```'),
    table: ({ snapshot }) => insertAtSelection(snapshot, '| 列1 | 列2 |\n| --- | --- |\n| 值1 | 值2 |\n'),
    hr: ({ snapshot }) => insertAtSelection(snapshot, '\n---\n')
};

export function executeMarkdownEditorCommand(
    key: Exclude<MarkdownEditorCommandKey, 'undo' | 'redo' | 'image' | 'save' | 'bold' | 'italic' | 'quote' | 'link' | 'code'>,
    context: MarkdownEditorCommandContext
): SelectionResult
{
    return handlers[key](context);
}

export function indentSelection(context: MarkdownEditorCommandContext): SelectionResult
{
    return prefixLines(context.snapshot, '  ');
}

export function outdentSelection(context: MarkdownEditorCommandContext): SelectionResult
{
    return outdentLines(context.snapshot);
}
