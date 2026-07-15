import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const srcRoot = resolve(process.cwd(), 'src')
const repoRoot = resolve(process.cwd(), '..', '..')

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
  'public-renderers/PublicArticleDetailPage.vue',
  'views/ArticleDetail.vue'
])

const trustedHtmlImportWhitelist = new Set([
  'public-renderers/PublicArticleDetailPage.vue',
  'utils/trustedHtml.ts',
  'views/ArticleDetail.vue'
])

// Public renderer HTML sinks must be explicitly audited through trustedHtml
// before a path can be added here.
const publicRendererInnerHtmlWhitelist = new Set()

const cspRuntimeStyleBoundary = 'services/cspStyleRuntime.ts'

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

    if (
      relativePath.startsWith('public-renderers/')
      && /\.innerHTML\s*=/.test(content)
      && !publicRendererInnerHtmlWhitelist.has(relativePath)
    ) {
      violations.push(`${relativePath}: public renderer innerHTML sink is not in the audited whitelist`)
    }

    if (relativePath !== cspRuntimeStyleBoundary) {
      if (/(?:^|\s)(?::|v-bind:)?style\s*=/.test(content)) {
        violations.push(`${relativePath}: CSP forbids HTML style attributes and Vue style bindings`)
      }
      if (/\b[A-Za-z_$][\w$]*\.style(?:\.|\[)/.test(content)) {
        violations.push(`${relativePath}: CSP forbids direct element.style mutation`)
      }
      if (/\.setAttribute\(\s*['"]style['"]/.test(content)) {
        violations.push(`${relativePath}: CSP forbids setAttribute style mutation`)
      }
      if (/\bstyle\s*:\s*(?:\{|\[)/.test(content)) {
        violations.push(`${relativePath}: CSP forbids render-function style props`)
      }
    }
  }
}

walk(srcRoot)

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function requireContains(file, needle, message) {
  const content = readRepoFile(file)
  if (!content.includes(needle)) {
    violations.push(`${file}: ${message}`)
  }
}

function requireNotContains(file, needle, message) {
  const content = readRepoFile(file)
  if (content.includes(needle)) {
    violations.push(`${file}: ${message}`)
  }
}

const privatePreview = readRepoFile('src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue')
if (privatePreview.includes('sandbox="allow-scripts"')) {
  violations.push('src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue: preview iframe must not allow scripts')
}
if (/executableHtmlPattern|eventHandlerAttributePattern|\.replace\(executableHtmlPattern/.test(privatePreview)) {
  violations.push('src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue: preview sanitizer must not be regex-based')
}
if (!privatePreview.includes('sanitizePreviewHtml')) {
  violations.push('src/frontend/src/components/admin/article/ArticlePrivatePreviewPanel.vue: preview must use audited sanitizePreviewHtml')
}

const localFixtureSession = readRepoFile('src/frontend/src/services/localFixtureSession.ts')
for (const token of ['import.meta.env.MODE', 'import.meta.env.PROD', 'isLocalFixtureHost']) {
  if (!localFixtureSession.includes(token)) {
    violations.push(`src/frontend/src/services/localFixtureSession.ts: local fixture gate must include ${token}`)
  }
}

const binaryClient = readRepoFile('src/frontend/src/api/binaryApiClient.ts')
const binaryContracts = readRepoFile('src/frontend/src/api/contracts.ts')
if (!binaryClient.includes('FSUS_HEADERS.csrfToken') || !binaryClient.includes('readCsrfToken') || !binaryContracts.includes("csrfToken: 'X-Fsus-Csrf-Token'")) {
  violations.push('src/frontend/src/api/binaryApiClient.ts: credentialed mutation requests must attach X-Fsus-Csrf-Token when available')
}

const adminArticleWrite = readRepoFile('src/frontend/src/composables/useAdminArticleWrite.ts')
if (/localStorage\.setItem\(key,\s*encodePublicAotPayload\(snapshot\)\)/.test(adminArticleWrite)) {
  violations.push('src/frontend/src/composables/useAdminArticleWrite.ts: article draft body must not be persisted to localStorage')
}

const openResty = readRepoFile('deploy/production-openresty.conf')
for (const header of ['Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Resource-Policy']) {
  if (!openResty.includes(header)) {
    violations.push(`deploy/production-openresty.conf: missing ${header} response header`)
  }
}
for (const token of ["require-trusted-types-for 'script'", 'trusted-types vue fsusblog;']) {
  if (!openResty.includes(token)) {
    violations.push(`deploy/production-openresty.conf: production CSP must include ${token}`)
  }
}
if (/trusted-types\s+(?:\*|default)|allow-duplicates/.test(openResty)) {
  violations.push('deploy/production-openresty.conf: Trusted Types CSP must not allow wildcard, default, or duplicate policies')
}

const viteConfig = readRepoFile('src/frontend/vite.config.ts')
for (const token of ['Content-Security-Policy', "default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "style-src-attr 'none'", 'report-uri /api/security/csp-report']) {
  if (!viteConfig.includes(token)) {
    violations.push(`src/frontend/vite.config.ts: preview security headers must include ${token}`)
  }
}
if (viteConfig.includes("style-src-attr 'unsafe-inline'")) {
  violations.push("src/frontend/vite.config.ts: preview CSP must not allow inline style attributes")
}
if (viteConfig.includes("require-trusted-types-for 'script'") || viteConfig.includes('trusted-types vue fsusblog')) {
  violations.push('src/frontend/vite.config.ts: development and preview CSP must preserve HMR by leaving Trusted Types enforcement disabled')
}

const composition = readRepoFile('src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs')
const staticCspSource = composition.slice(
  composition.indexOf('internal static string BuildStaticCsp'),
  composition.indexOf('private static string BuildHtmlCsp')
)
for (const token of ["style-src-attr 'none'", 'report-uri /api/security/csp-report']) {
  if (!staticCspSource.includes(token)) {
    violations.push(`src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs: static CSP must include ${token}`)
  }
}
if (staticCspSource.includes('wasm-unsafe-eval') || staticCspSource.includes("style-src-attr 'unsafe-inline'")) {
  violations.push('src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs: non-HTML CSP must deny Wasm compilation and inline style attributes')
}
for (const token of ["require-trusted-types-for 'script'", 'trusted-types vue fsusblog;']) {
  if (!composition.includes(token)) {
    violations.push(`src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs: production CSP must include ${token}`)
  }
}
if (/trusted-types\s+(?:\*|default)|allow-duplicates/.test(composition)) {
  violations.push('src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs: Trusted Types CSP must not allow wildcard, default, or duplicate policies')
}

const trustedTypesRuntime = readRepoFile('src/frontend/src/security/trustedTypesRuntime.ts')
for (const token of [
  "const APP_POLICY_NAME = 'fsusblog'",
  "const COMMENT_PRIVACY_PROVER_MODULE_PATH = '/wasm/comment-privacy-prover.js'",
  'setSanitizedTemplateHtml',
  'setNonExecutableScriptText',
  'setCommentPrivacyProverScriptUrl'
]) {
  if (!trustedTypesRuntime.includes(token)) {
    violations.push(`src/frontend/src/security/trustedTypesRuntime.ts: audited Trusted Types boundary must include ${token}`)
  }
}
if (/createPolicy\(\s*['"](?:default|\*)['"]|allow-duplicates/.test(trustedTypesRuntime)) {
  violations.push('src/frontend/src/security/trustedTypesRuntime.ts: policy must not use default, wildcard, or duplicate escape hatches')
}
requireContains(
  'src/frontend/src/utils/safeHtml.ts',
  'setSanitizedTemplateHtml(template, sanitizeHtmlFallback(html))',
  'HTML parser must use the sanitized TrustedHTML wrapper'
)
requireNotContains(
  'src/frontend/src/utils/safeHtml.ts',
  'template.innerHTML =',
  'HTML parser must not assign raw strings to innerHTML'
)
requireContains(
  'src/frontend/src/privacy/commentPrivacyWasmProver.ts',
  'setCommentPrivacyProverScriptUrl(script, moduleUrl)',
  'privacy prover module must use the exact-path TrustedScriptURL wrapper'
)
requireNotContains(
  'src/frontend/src/privacy/commentPrivacyWasmProver.ts',
  'script.src =',
  'privacy prover must not assign raw strings to script.src'
)

requireContains(
  'src/backend/Modules/Endpoints/CspReportEndpoints.cs',
  'internal const string ReportPath = "/api/security/csp-report"',
  'CSP report collector route must remain available'
)

const routerSource = readRepoFile('src/frontend/src/router/index.ts')
for (const pattern of [/\bmeta\b[^\n]*\broles\b/u, /to[.]meta[.]roles/u, /meta:\s*\{\s*roles:/u]) {
  if (pattern.test(routerSource)) {
    violations.push(`src/frontend/src/router/index.ts: route authorization must not restore legacy role metadata ${pattern}`)
  }
}

requireContains(
  'src/frontend/src/fsusui/markdown.ts',
  'sanitizeMarkdownRuntimeHtml',
  'markdown runtime wrapper must apply a second-pass sanitizer'
)
requireNotContains(
  'src/frontend/eslint.config.mjs',
  'export default []',
  'eslint config must not be empty for security-sensitive frontend code'
)

if (violations.length > 0) {
  console.error('[check-security-consistency] failed')
  for (let i = 0; i < violations.length; i += 1) {
    console.error(`- ${violations[i]}`)
  }
  process.exit(1)
}

console.log('[check-security-consistency] ok')
