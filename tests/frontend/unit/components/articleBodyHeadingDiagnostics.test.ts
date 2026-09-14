import { describe, expect, it } from 'vitest'

import {
  diagnoseArticleBodyH1,
  formatArticleBodyH1Diagnostic
} from '@/components/ui/markdown-editor/articleBodyHeadingDiagnostics'

describe('article body H1 diagnostics', () => {
  it('reports ATX and setext H1 without rewriting source', () => {
    const source = [
      '# 章节标题',
      '',
      '## 正常章节',
      '',
      'Setext title',
      '=============',
      '',
      '### 小节',
      '# English title',
      '# Заголовок',
      '# عنوان'
    ].join('\n')
    const snapshot = source
    const issues = diagnoseArticleBodyH1(source)

    expect(source).toBe(snapshot)
    expect(issues.map((issue) => ({ line: issue.line, kind: issue.kind, text: issue.text }))).toEqual([
      { line: 1, kind: 'atx', text: '章节标题' },
      { line: 5, kind: 'setext', text: 'Setext title' },
      { line: 9, kind: 'atx', text: 'English title' },
      { line: 10, kind: 'atx', text: 'Заголовок' },
      { line: 11, kind: 'atx', text: 'عنوان' }
    ])
  })

  it('ignores empty documents, H2-H6, and fenced heading examples', () => {
    const source = [
      '',
      '## 章节',
      '### 小节',
      '#### 四级标题',
      '##### 五级标题',
      '###### 六级标题',
      '',
      '```markdown',
      '# not a heading',
      '```',
      '',
      '~~~md',
      '# still fenced',
      '~~~'
    ].join('\n')

    expect(diagnoseArticleBodyH1('')).toEqual([])
    expect(diagnoseArticleBodyH1(source)).toEqual([])
  })

  it('formats a non-destructive migration hint', () => {
    const issues = diagnoseArticleBodyH1('# 旧标题\n\n正文')
    const text = formatArticleBodyH1Diagnostic(issues)

    expect(text).toContain('正文含 1 个一级标题（第 1 行）')
    expect(text).toContain('不会被改写')
    expect(text).toContain('章节（##）')
    expect(formatArticleBodyH1Diagnostic([])).toBeNull()
  })
})
