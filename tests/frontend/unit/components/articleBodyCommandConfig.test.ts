import { describe, expect, it } from 'vitest'

import {
  applyArticleBodyPrimaryPriorities,
  composeArticleBodyEditorCommands,
  articleBodyCommandOverflowLabel,
  articleBodyCommandSurfaces,
  articleBodyExtraCommandKeys,
  articleBodyForbiddenCommandKeys,
  articleBodyInsertCommandKeys,
  articleBodyLocaleText,
  articleBodyPrimaryCommandKeys,
  articleBodyPrimaryPriorityByKey,
  articleBodyStructureCommandKeys,
  isArticleBodyForbiddenCommandKey,
  isArticleBodyPrimaryCommandKey
} from '@/components/ui/markdown-editor/articleBodyCommandConfig'
import { markdownEditorCommands } from '@/components/ui/markdown-editor/commands'

describe('article body command configuration', () => {
  it('freezes the six primary keys in product order', () => {
    expect(articleBodyPrimaryCommandKeys).toEqual([
      'heading',
      'bold',
      'italic',
      'link',
      'quote',
      'code'
    ])
    expect(articleBodyPrimaryCommandKeys).toHaveLength(6)
    expect(new Set(articleBodyPrimaryCommandKeys).size).toBe(6)
  })

  it('does not expose a body H1 insert key or alias', () => {
    expect(articleBodyForbiddenCommandKeys).toEqual(expect.arrayContaining(['h1', 'heading-1']))
    expect(articleBodyPrimaryCommandKeys).not.toContain('h1')
    expect(articleBodyExtraCommandKeys).not.toContain('h1')
    expect(markdownEditorCommands.some((command: { readonly key: string }) => command.key === 'h1' || command.key === 'heading-1')).toBe(false)
    expect(isArticleBodyForbiddenCommandKey('h1')).toBe(true)
    expect(isArticleBodyForbiddenCommandKey('heading')).toBe(false)
  })

  it('keeps H3-H6 in structure and lists/media/code in insert, never in the primary six', () => {
    expect(articleBodyStructureCommandKeys).toEqual([
      'heading-3',
      'heading-4',
      'heading-5',
      'heading-6'
    ])
    expect(articleBodyInsertCommandKeys).toEqual([
      'ul',
      'ol',
      'task',
      'block',
      'latex',
      'mermaid',
      'table',
      'hr'
    ])
    for (const key of [...articleBodyStructureCommandKeys, ...articleBodyInsertCommandKeys]) {
      expect(articleBodyPrimaryCommandKeys).not.toContain(key)
    }
  })

  it('uses one surface configuration for toolbar, slash, selection, and palette', () => {
    expect(articleBodyCommandSurfaces).toEqual({
      toolbar: true,
      commandPalette: true,
      selectionToolbar: true,
      slashMenu: true
    })
    expect(articleBodyCommandOverflowLabel).toBe('插入')
  })

  it('maps canonical keys to frozen Chinese product copy without exposing body H1', () => {
    expect(articleBodyLocaleText.commands).toEqual({
      heading: '章节',
      bold: '粗体',
      italic: '斜体',
      link: '链接',
      quote: '引用',
      code: '行内代码'
    })
    expect(Object.values(articleBodyLocaleText.commands).join('')).not.toContain('正文 H1')
    expect(articleBodyLocaleText.commandGroups).toEqual({
      format: '文本',
      block: '结构',
      insert: '插入',
      code: '代码',
      media: '媒体'
    })
  })

  it('orders the six commands by product priority instead of viewport or usage evidence', () => {
    const source = [
      { key: 'code', priority: 60 },
      { key: 'heading', priority: 80 },
      { key: 'ul', priority: 10 },
      { key: 'bold', priority: 100 }
    ]
    const ranked = applyArticleBodyPrimaryPriorities(source)
      .filter((command) => isArticleBodyPrimaryCommandKey(command.key))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
      .map((command) => command.key)

    expect(ranked).toEqual(['heading', 'bold', 'code'])
    expect(articleBodyPrimaryPriorityByKey.heading).toBeGreaterThan(articleBodyPrimaryPriorityByKey.bold)
    expect(articleBodyPrimaryPriorityByKey.bold).toBeGreaterThan(articleBodyPrimaryPriorityByKey.italic)
    expect(articleBodyPrimaryPriorityByKey.italic).toBeGreaterThan(articleBodyPrimaryPriorityByKey.link)
    expect(articleBodyPrimaryPriorityByKey.link).toBeGreaterThan(articleBodyPrimaryPriorityByKey.quote)
    expect(articleBodyPrimaryPriorityByKey.quote).toBeGreaterThan(articleBodyPrimaryPriorityByKey.code)
  })

  it('merges FsusUI defaults with extras and drops body H1 insert paths', () => {
    const composed = composeArticleBodyEditorCommands(
      [
        { key: 'h1', priority: 90 },
        { key: 'heading', priority: 80 },
        { key: 'bold', priority: 100 },
        { key: 'italic', priority: 90 },
        { key: 'link', priority: 50 },
        { key: 'quote', priority: 70 },
        { key: 'code', priority: 60 },
        { key: 'image', priority: 40 }
      ],
      [
        { key: 'h1', priority: 1 },
        { key: 'heading-3', priority: 20 },
        { key: 'ul', priority: 10 },
        { key: 'block', priority: 10 },
        { key: 'undo', priority: 0 }
      ],
      ['image']
    )

    expect(composed.map((command) => command.key)).toEqual([
      'heading',
      'bold',
      'italic',
      'link',
      'quote',
      'code',
      'heading-3',
      'ul',
      'block'
    ])
    expect(composed.find((command) => command.key === 'heading')?.priority).toBe(600)
    expect(composed.some((command) => command.key === 'h1')).toBe(false)
    expect(composed.some((command) => command.key === 'image')).toBe(false)
    expect(composed.some((command) => command.key === 'undo')).toBe(false)
  })

  it('has no usage-evidence, locale, or viewport branch in the frozen primary set', () => {
    const configSource = [
      articleBodyPrimaryCommandKeys.join(','),
      JSON.stringify(articleBodyCommandSurfaces)
    ].join('\n')

    expect(configSource).not.toMatch(/matchMedia|innerWidth|locale|telemetry|analytics|usage/i)
    expect([...articleBodyPrimaryCommandKeys]).toEqual([...articleBodyPrimaryCommandKeys])
  })
})
