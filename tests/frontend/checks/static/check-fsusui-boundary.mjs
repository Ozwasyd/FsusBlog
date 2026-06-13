import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const srcRoot = path.join(repoRoot, 'src/frontend/src')
const fsusuiRoot = path.join(srcRoot, 'fsusui')
const uiIndexPath = path.join(srcRoot, 'components/ui/index.ts')
const packageJsonPath = path.join(repoRoot, 'src/frontend/package.json')
const strict = process.argv.includes('--strict') || process.env.FSUSBLOG_FSUSUI_BOUNDARY_STRICT === '1'

const sourceExtensions = new Set(['.css', '.js', '.mjs', '.scss', '.ts', '.tsx', '.vue'])
const programmaticApis = new Set(['ElMessage', 'ElMessageBox', 'ElNotification', 'ElLoading'])
const warnings = []

function rel(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, '/')
}

function isUnder(file, root) {
  const relative = path.relative(root, file)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue
    }

    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, files)
      continue
    }

    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }
  return files
}

function warn(file, rule, detail) {
  warnings.push({ file: rel(file), rule, detail })
}

function checkDeepImports(file, content) {
  const deepImportPattern =
    /@ozwasyd\/element-plus\/(?:(?:es|lib)\/[^'"]*\/src\/[^'"]*|es\/icons-vue\/src\/index\.mjs|es\/wasm\/index\.mjs|es\/components\/config-provider\/src\/theme-mode)/g
  for (const match of content.matchAll(deepImportPattern)) {
    warn(file, 'deep-import', `uses ${match[0]}`)
  }
}

function checkProgrammaticImports(file, content) {
  if (rel(file) === 'src/frontend/src/fsusui/feedback.ts') {
    return
  }

  const importPattern = /import\s*\{([^}]+)\}\s*from\s*['"]@ozwasyd\/element-plus['"]/g
  for (const match of content.matchAll(importPattern)) {
    const imports = match[1]
      .split(',')
      .map((item) => item.trim().split(/\s+as\s+/i)[0].trim())
      .filter(Boolean)
    const blocked = imports.filter((name) => programmaticApis.has(name))
    if (blocked.length > 0) {
      warn(file, 'programmatic-api', `imports ${blocked.join(', ')}`)
    }
  }
}

function checkInternalSelectors(file, content) {
  const fileRel = rel(file)
  const allowPublicShell = fileRel === 'src/frontend/src/assets/public-shell-critical.css'
  const selectorPattern = /(?::deep\()?\.el-[a-z0-9_-]+/gi
  for (const match of content.matchAll(selectorPattern)) {
    const selector = match[0].replace(':deep(', '')
    if (allowPublicShell && selector.startsWith('.el-public-shell')) {
      continue
    }
    warn(file, 'internal-selector', `uses ${selector}`)
  }
}

function checkVisualRewriteClasses(file, content) {
  if (!file.endsWith('.vue')) {
    return
  }

  const componentClassPattern = /<el-[\w-]+[^>]*\bclass=(["'])([^"']*(?:\bbg-|\btext-|\bborder-|\brounded-|\bshadow-|!important)[^"']*)\1/gi
  for (const match of content.matchAll(componentClassPattern)) {
    warn(file, 'visual-rewrite-class', `class="${match[2].trim()}"`)
  }
}

function checkMarkdownActivationOwnership(file, content) {
  const fileRel = rel(file)
  if (fileRel === 'src/frontend/src/fsusui/markdown.ts') {
    return
  }

  const blocked = [
    [/import\s*\(\s*['"]mermaid['"]\s*\)/g, 'direct-mermaid-import'],
    [/import\s*\(\s*['"]katex['"]\s*\)/g, 'direct-katex-import'],
    [/import\s*\(\s*['"]shiki(?:\/[^'"]*)?['"]\s*\)/g, 'direct-shiki-import'],
    [/@\/services\/shikiHighlighter/g, 'local-shiki-highlighter'],
    [/markdownActivationService/g, 'local-markdown-activation'],
    [/data-mermaid-placeholder/g, 'manual-mermaid-placeholder'],
    [/data-latex-placeholder/g, 'manual-latex-placeholder'],
    [/pre\s*>\s*code\[class\*=["']language-["']\]/g, 'manual-code-highlight-selector'],
    [/Node\.prototype\.(?:appendChild|insertBefore)/g, 'dom-nonce-monkey-patch']
  ]

  for (const [pattern, rule] of blocked) {
    if (pattern.test(content)) {
      warn(file, rule, 'generic Markdown feature activation belongs to FsusUI')
    }
  }
}

function checkPackageMarkdownDependencies() {
  if (!fs.existsSync(packageJsonPath)) {
    return
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  for (const name of ['mermaid', 'katex', 'shiki']) {
    if (pkg.dependencies?.[name] || pkg.devDependencies?.[name]) {
      warn(packageJsonPath, 'direct-markdown-feature-package', `${name} must be provided by @ozwasyd/element-plus`)
    }
  }

  if (pkg.dependencies?.['@ozwasyd/element-plus'] !== '1.5.0') {
    warn(packageJsonPath, 'fsusui-version', '@ozwasyd/element-plus must stay on 1.5.0 for Markdown feature ownership')
  }
}

function checkRequiredAdapters() {
  const required = [
    'index.ts',
    'theme.ts',
    'feedback.ts',
    'result.ts',
    'icons.ts',
    'markdown.ts',
    'renderPipeline.ts',
    'primitiveAdapters.ts'
  ]

  for (const name of required) {
    const file = path.join(fsusuiRoot, name)
    if (!fs.existsSync(file)) {
      warnings.push({
        file: rel(fsusuiRoot),
        rule: 'missing-adapter',
        detail: `${name} is missing`
      })
    }
  }
}

function checkUiIndexSurface() {
  if (!fs.existsSync(uiIndexPath)) {
    return
  }

  const content = fs.readFileSync(uiIndexPath, 'utf8')
  const exportLines = content.split('\n').filter((line) => /^\s*export\s+/.test(line))
  if (exportLines.length > 3) {
    warn(uiIndexPath, 'ui-index-surface', `exports ${exportLines.length} entries`)
  }
}

for (const file of walk(srcRoot)) {
  const content = fs.readFileSync(file, 'utf8')
  checkDeepImports(file, content)
  checkProgrammaticImports(file, content)
  checkInternalSelectors(file, content)
  checkVisualRewriteClasses(file, content)
  checkMarkdownActivationOwnership(file, content)
}

checkPackageMarkdownDependencies()
checkRequiredAdapters()
checkUiIndexSurface()

if (warnings.length === 0) {
  console.log('[fsusui-boundary] ok warnings=0 strict=' + strict)
  process.exit(0)
}

console.log(`[fsusui-boundary] warnings=${warnings.length} strict=${strict}`)
for (const item of warnings) {
  console.log(`- ${item.file}: ${item.rule}: ${item.detail}`)
}

if (strict) {
  process.exit(1)
}
