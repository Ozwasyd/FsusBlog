import type { HighlighterCore } from 'shiki/core'

export const SHIKI_SUPPORTED_LANGS = [
  'javascript', 'typescript', 'csharp', 'cpp', 'rust', 'go', 'python',
  'html', 'css', 'yaml', 'markdown', 'bash', 'sql',
  'java', 'kotlin', 'swift', 'xml', 'latex',
] as const

let shikiHighlighterPromise: Promise<HighlighterCore> | null = null

export function normalizeShikiLanguage(lang: string): string {
  return (SHIKI_SUPPORTED_LANGS as readonly string[]).includes(lang) ? lang : 'text'
}

export async function getShikiHighlighter(): Promise<HighlighterCore> {
  shikiHighlighterPromise ??= createShikiHighlighter()
  return await shikiHighlighterPromise
}

async function createShikiHighlighter(): Promise<HighlighterCore> {
  const [
    core,
    engine,
    javascript,
    typescript,
    csharp,
    cpp,
    rust,
    go,
    python,
    html,
    css,
    yaml,
    markdown,
    bash,
    sql,
    java,
    kotlin,
    swift,
    xml,
    latex,
    githubLight,
    githubDark
  ] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
    import('shiki/langs/javascript'),
    import('shiki/langs/typescript'),
    import('shiki/langs/csharp'),
    import('shiki/langs/cpp'),
    import('shiki/langs/rust'),
    import('shiki/langs/go'),
    import('shiki/langs/python'),
    import('shiki/langs/html'),
    import('shiki/langs/css'),
    import('shiki/langs/yaml'),
    import('shiki/langs/markdown'),
    import('shiki/langs/bash'),
    import('shiki/langs/sql'),
    import('shiki/langs/java'),
    import('shiki/langs/kotlin'),
    import('shiki/langs/swift'),
    import('shiki/langs/xml'),
    import('shiki/langs/latex'),
    import('shiki/themes/github-light'),
    import('shiki/themes/github-dark')
  ])

  return await core.createHighlighterCore({
    themes: [githubLight.default, githubDark.default],
    langs: [
      javascript.default,
      typescript.default,
      csharp.default,
      cpp.default,
      rust.default,
      go.default,
      python.default,
      html.default,
      css.default,
      yaml.default,
      markdown.default,
      bash.default,
      sql.default,
      java.default,
      kotlin.default,
      swift.default,
      xml.default,
      latex.default
    ],
    engine: engine.createJavaScriptRegexEngine()
  })
}
