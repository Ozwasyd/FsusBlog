import { Window } from 'happy-dom'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SHIKI_SUPPORTED_LANGS } from '@/services/shikiHighlighter'
import { activateMarkdownFeatures } from '@/services/markdownActivationService'

let testWindow: Window

beforeEach(() => {
  testWindow = new Window()
  ;(globalThis as { window?: Window }).window = testWindow
  ;(globalThis as { document?: Document }).document = testWindow.document
})

afterEach(() => {
  delete (globalThis as { window?: Window }).window
  delete (globalThis as { document?: Document }).document
})

// ---------------------------------------------------------------------------
// SHIKI_SUPPORTED_LANGS — 回归测试
// 确保所有曾因缺失而产生 ShikiError 的语言都在支持列表中。
// ---------------------------------------------------------------------------
describe('SHIKI_SUPPORTED_LANGS', () => {
  it('包含基础 Web 语言', () => {
    const required = ['javascript', 'typescript', 'html', 'css', 'yaml', 'markdown', 'bash', 'sql']
    for (const lang of required) {
      expect(SHIKI_SUPPORTED_LANGS).toContain(lang)
    }
  })

  it('包含后端语言', () => {
    const required = ['csharp', 'cpp', 'rust', 'go', 'python']
    for (const lang of required) {
      expect(SHIKI_SUPPORTED_LANGS).toContain(lang)
    }
  })

  it('包含曾触发 ShikiError 的语言：java / kotlin / swift', () => {
    expect(SHIKI_SUPPORTED_LANGS).toContain('java')
    expect(SHIKI_SUPPORTED_LANGS).toContain('kotlin')
    expect(SHIKI_SUPPORTED_LANGS).toContain('swift')
  })

  it('包含曾触发 ShikiError 的语言：xml / latex', () => {
    expect(SHIKI_SUPPORTED_LANGS).toContain('xml')
    expect(SHIKI_SUPPORTED_LANGS).toContain('latex')
  })

  it('列表中无重复项', () => {
    const set = new Set(SHIKI_SUPPORTED_LANGS)
    expect(set.size).toBe(SHIKI_SUPPORTED_LANGS.length)
  })
})

describe('activateMarkdownFeatures (headings & hash links)', () => {
  it('为标题注入 slug id，并对重复标题追加序号', async () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <h2>Markdown 基础标记测试</h2>
      <h2>Markdown 基础标记测试</h2>
      <h3>开篇：多语言文本的河流</h3>
    `

    await activateMarkdownFeatures(container)

    const headings = container.querySelectorAll('h2, h3')
    expect(headings[0]?.id).toBe('markdown-基础标记测试')
    expect(headings[1]?.id).toBe('markdown-基础标记测试-2')
    expect(headings[2]?.id).toBe('开篇多语言文本的河流')
  })

  it('保留已有 id，不重复覆盖', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<h2 id="custom-id">Hello World</h2>'

    await activateMarkdownFeatures(container)

    expect(container.querySelector('h2')?.id).toBe('custom-id')
  })

  it('修复 hash 链接，不再保留 target/rel', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<a href="#toc" target="_blank" rel="noopener noreferrer">jump</a>'

    await activateMarkdownFeatures(container)

    const link = container.querySelector('a[href="#toc"]')
    expect(link?.hasAttribute('target')).toBe(false)
    expect(link?.hasAttribute('rel')).toBe(false)
  })
})
