import { describe, expect, it } from 'vitest'

import { executeMarkdownEditorCommand, markdownEditorCommands } from '@/components/ui/markdown-editor/commands'
import { createSnapshot } from '@/components/ui/markdown-editor/selection'

describe('article body extra markdown commands', () => {
  it('does not register an H1 insert handler', () => {
    expect(markdownEditorCommands.map((command) => command.key)).not.toContain('h1')
    expect(markdownEditorCommands.map((command) => command.key)).not.toContain('h2')
    expect(markdownEditorCommands.some((command) => command.label.includes('一级标题'))).toBe(false)
  })

  it('inserts subsection headings from H3 without creating H1', () => {
    const snapshot = createSnapshot('正文', 0, 0)
    const heading3 = executeMarkdownEditorCommand('heading-3', { snapshot })
    const heading4 = executeMarkdownEditorCommand('heading-4', { snapshot })

    expect(heading3.value).toMatch(/^### /u)
    expect(heading4.value).toMatch(/^#### /u)
    expect(heading3.value).not.toMatch(/^# /u)
    expect(heading3.value).not.toMatch(/^## (?!#)/u)
  })

  it('keeps list and code extras available for insert/palette discovery', () => {
    const snapshot = createSnapshot('', 0, 0)
    expect(executeMarkdownEditorCommand('ul', { snapshot }).value).toContain('- ')
    expect(executeMarkdownEditorCommand('block', { snapshot }).value).toContain('```text')
    expect(markdownEditorCommands.map((command) => command.key)).toEqual(
      expect.arrayContaining(['heading-3', 'ul', 'ol', 'task', 'block', 'latex', 'mermaid', 'table', 'hr'])
    )
  })
})
