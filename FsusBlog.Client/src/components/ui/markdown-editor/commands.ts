import type { MarkdownEditorCommand, MarkdownEditorCommandKey } from '@/ui-contracts/markdownEditor'
import {
  insertAtSelection,
  outdentLines,
  prefixLines,
  prependInline,
  wrapSelection,
  type SelectionResult,
  type SelectionSnapshot
} from '@/components/ui/markdown-editor/selection'

export type MarkdownEditorCommandContext = Readonly<{
  snapshot: SelectionSnapshot
}>

type CommandHandler = (context: MarkdownEditorCommandContext) => SelectionResult

export const markdownEditorCommands: readonly MarkdownEditorCommand[] = [
  { key: 'undo', label: '撤销', ariaLabel: '撤销上一步编辑', shortcut: 'Ctrl+Z' },
  { key: 'redo', label: '重做', ariaLabel: '重做上一步编辑', shortcut: 'Ctrl+Y' },
  { key: 'h1', label: 'H1', ariaLabel: '插入一级标题' },
  { key: 'h2', label: 'H2', ariaLabel: '插入二级标题' },
  { key: 'h3', label: 'H3', ariaLabel: '插入三级标题' },
  { key: 'bold', label: '粗体', ariaLabel: '加粗选中文本' },
  { key: 'italic', label: '斜体', ariaLabel: '将选中文本设为斜体' },
  { key: 'quote', label: '引用', ariaLabel: '插入引用块' },
  { key: 'ul', label: '列表', ariaLabel: '插入无序列表' },
  { key: 'ol', label: '有序', ariaLabel: '插入有序列表' },
  { key: 'task', label: '任务', ariaLabel: '插入任务列表' },
  { key: 'link', label: '链接', ariaLabel: '插入链接' },
  { key: 'code', label: '代码', ariaLabel: '插入行内代码' },
  { key: 'block', label: '代码块', ariaLabel: '插入代码块' },
  { key: 'latex', label: 'LaTeX', ariaLabel: '插入 LaTeX 公式块' },
  { key: 'mermaid', label: 'Mermaid', ariaLabel: '插入 Mermaid 图表' },
  { key: 'table', label: '表格', ariaLabel: '插入 Markdown 表格' },
  { key: 'hr', label: '分割线', ariaLabel: '插入分割线' },
  { key: 'image', label: '图片', ariaLabel: '上传并插入图片' },
  { key: 'save', label: '保存', ariaLabel: '保存文章', shortcut: 'Ctrl+S' }
] as const

const handlers: Readonly<Record<Exclude<MarkdownEditorCommandKey, 'undo' | 'redo' | 'image' | 'save'>, CommandHandler>> = {
  h1: ({ snapshot }) => prependInline(snapshot, '# ', '标题'),
  h2: ({ snapshot }) => prependInline(snapshot, '## ', '标题'),
  h3: ({ snapshot }) => prependInline(snapshot, '### ', '标题'),
  bold: ({ snapshot }) => wrapSelection(snapshot, '**', '**', '文本'),
  italic: ({ snapshot }) => wrapSelection(snapshot, '*', '*', '文本'),
  quote: ({ snapshot }) => prefixLines(snapshot, '> ', '引用内容'),
  ul: ({ snapshot }) => prefixLines(snapshot, '- ', '列表项'),
  ol: ({ snapshot }) => prefixLines(snapshot, '1. ', '列表项'),
  task: ({ snapshot }) => prefixLines(snapshot, '- [ ] ', '待办项'),
  link: ({ snapshot }) => wrapSelection(snapshot, '[', '](https://example.com)', '链接文本'),
  code: ({ snapshot }) => wrapSelection(snapshot, '`', '`', 'code'),
  block: ({ snapshot }) => wrapSelection(snapshot, '```text\n', '\n```', 'code'),
  latex: ({ snapshot }) => wrapSelection(snapshot, '$$\n', '\n$$', 'E = mc^2'),
  mermaid: ({ snapshot }) => insertAtSelection(snapshot, '```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```'),
  table: ({ snapshot }) => insertAtSelection(snapshot, '| 列1 | 列2 |\n| --- | --- |\n| 值1 | 值2 |\n'),
  hr: ({ snapshot }) => insertAtSelection(snapshot, '\n---\n')
}

export function executeMarkdownEditorCommand(
  key: Exclude<MarkdownEditorCommandKey, 'undo' | 'redo' | 'image' | 'save'>,
  context: MarkdownEditorCommandContext
): SelectionResult {
  return handlers[key](context)
}

export function indentSelection(context: MarkdownEditorCommandContext): SelectionResult {
  return prefixLines(context.snapshot, '  ')
}

export function outdentSelection(context: MarkdownEditorCommandContext): SelectionResult {
  return outdentLines(context.snapshot)
}
