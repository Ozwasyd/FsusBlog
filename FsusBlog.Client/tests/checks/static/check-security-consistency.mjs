import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const srcRoot = resolve(process.cwd(), 'src')

const bannedRules = [
  {
    label: 'stale token localStorage fallback',
    regex: /localStorage\.getItem\(\s*['"]token['"]\s*\)/g
  },
  {
    label: 'DOMPurify mainline import',
    regex: /from\s+['"]dompurify['"]/g
  }
]

const vHtmlWhitelist = new Set([
  'components/ArticleCard.vue',
  'components/PolicyModal.vue',
  'components/SearchModal.vue',
  'components/ui/MarkdownRenderer.vue',
  'public-renderers/PublicArticleDetailPage.vue'
])

const trustedHtmlImportWhitelist = new Set([
  'components/ArticleCard.vue',
  'components/PolicyModal.vue',
  'components/SearchModal.vue',
  'components/ui/MarkdownRenderer.vue',
  'public-renderers/PublicArticleDetailPage.vue',
  'services/markdownRenderHost.ts',
  'utils/trustedHtml.ts'
])

const violations = []

function walk(dir) {
  const entries = readdirSync(dir)
  for (let i = 0; i < entries.length; i += 1) {
    const fullPath = join(dir, entries[i])
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      walk(fullPath)
      continue
    }

    if (!/\.(ts|vue|js|mjs)$/.test(fullPath)) {
      continue
    }

    const relativePath = relative(srcRoot, fullPath).replace(/\\/g, '/')
    const content = readFileSync(fullPath, 'utf8')

    for (let j = 0; j < bannedRules.length; j += 1) {
      const rule = bannedRules[j]
      if (rule.regex.test(content)) {
        violations.push(`${relativePath}: forbidden ${rule.label}`)
      }
      rule.regex.lastIndex = 0
    }

    if (content.includes('v-html=') && !vHtmlWhitelist.has(relativePath)) {
      violations.push(`${relativePath}: v-html is not in the audited whitelist`)
    }

    if (
      /from\s+['"]@\/utils\/trustedHtml['"]|from\s+['"]\.{1,2}\/.*trustedHtml['"]/.test(content)
      && !trustedHtmlImportWhitelist.has(relativePath)
    ) {
      violations.push(`${relativePath}: trustedHtml import is not in the audited whitelist`)
    }
  }
}

walk(srcRoot)

if (violations.length > 0) {
  console.error('[check-security-consistency] failed')
  for (let i = 0; i < violations.length; i += 1) {
    console.error(`- ${violations[i]}`)
  }
  process.exit(1)
}

console.log('[check-security-consistency] ok')
