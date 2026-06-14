#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '../..')
const errors = []

function repoPath(path) {
  return resolve(repoRoot, path)
}

function read(path) {
  return readFileSync(repoPath(path), 'utf8')
}

function rel(path) {
  return relative(repoRoot, path).replaceAll('\\', '/')
}

function walk(dir, output = []) {
  if (!existsSync(dir)) {
    return output
  }

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'coverage'].includes(entry)) {
        continue
      }
      walk(full, output)
      continue
    }
    if (/\.(vue|ts|md)$/.test(full)) {
      output.push(full)
    }
  }
  return output
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length
}

function addError(file, line, message) {
  errors.push(`${file}:${line}: ${message}`)
}

function findAll(source, token) {
  const matches = []
  let index = source.indexOf(token)
  while (index !== -1) {
    matches.push(index)
    index = source.indexOf(token, index + token.length)
  }
  return matches
}

function isLikelyTechnicalLine(line) {
  return /\b(import|export|interface|type|const|let|function|class|from)\b/.test(line)
    || /\b(class|className|style)\s*=/.test(line)
    || /\btransition(?:-|:)|\btransform(?:-|:|\s+var|\s*!important)/.test(line)
    || /data-fsus-motion-surface|fsusBlogMotionPresets|homeHero|FEATURED_ARTICLE|HOME_FEATURED/.test(line)
    || /\.Views\b|formatViews\b|views:\s*toNumber/.test(line)
}

function isPublicVisitorCopyPath(path) {
  return path.startsWith('src/frontend/src/components/public/')
    || path.startsWith('src/frontend/src/components/home/')
    || path.startsWith('src/frontend/src/components/filter/')
    || path.startsWith('src/frontend/src/view-contracts/')
    || path.startsWith('src/frontend/src/public-renderers/')
    || path === 'src/frontend/src/composables/useHomeView.ts'
    || path.startsWith('docs/frontend/')
}

function isAdminWorkspaceCopyPath(path) {
  return path.startsWith('src/frontend/src/views/admin/')
    || path.startsWith('src/frontend/src/components/admin/')
    || path.startsWith('src/frontend/src/layouts/')
    || path.startsWith('src/frontend/src/components/account/')
    || path.startsWith('src/frontend/src/components/user/')
    || path.startsWith('src/frontend/src/views/user/')
    || path.startsWith('src/frontend/src/views/auth/')
    || path.startsWith('src/frontend/src/view-contracts/')
}

function isUserFacingLine(line) {
  return !isLikelyTechnicalLine(line)
    && !/^\s*(\/\/|\/\*|\*|#)/.test(line)
}

function isCommentLine(line) {
  return /^\s*(\/\/|\/\*|\*|#|<!--)/.test(line)
}

function isLikelyVisibleCopyLine(line) {
  if (isCommentLine(line)) {
    return false
  }
  if (hasHanText(line)) {
    return true
  }
  return /(?:eyebrow|title|label|caption|description|placeholder|aria-label|helper|emptyText|message|text|toast)\s*(?:=|:)/i.test(line)
    || />\s*[^<]*[A-Za-z][^<]*</.test(line)
}

function hasHanText(line) {
  return /\p{Script=Han}/u.test(line)
}

function hasSpecificStateContext(line) {
  return /(文章|文章列表|正文|分类|标签|搜索|关键词|来源|路径|热点|归档|评论|互动|延伸阅读|介绍内容|站点|内容连接|访问校验|筛选|页面|资产|预览|用户|记录|数据|草稿|稿件|事件|规则|成员|会话|消息|通知|审计|地区|词库|策略|队列|任务|备份|错误|异常|缓存|性能|浏览器|样本|回收站|风险|快照|条目|工单|RUM|AOT|404)/.test(line)
}

function forEachGovernedLine(path, source, callback) {
  const markdown = path.endsWith('.md')
  let inCodeBlock = false

  source.split('\n').forEach((line, lineIndex) => {
    if (markdown && /^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock
      return
    }
    if (inCodeBlock) {
      return
    }
    callback(line, lineIndex)
  })
}

const scanRoots = [
  'src/frontend/src/components/public',
  'src/frontend/src/components/home',
  'src/frontend/src/components/filter',
  'src/frontend/src/components/admin',
  'src/frontend/src/components/account',
  'src/frontend/src/components/user',
  'src/frontend/src/layouts',
  'src/frontend/src/views/admin',
  'src/frontend/src/views/auth',
  'src/frontend/src/views/user',
  'src/frontend/src/view-contracts',
  'src/frontend/src/public-renderers',
  'docs/frontend'
]

const explicitFiles = [
  'src/frontend/src/store/site.ts',
  'src/frontend/src/config/consoleWelcomeCallout.ts',
  'src/frontend/src/components/admin/ConsoleWelcomeCallout.vue',
  'src/frontend/src/views/admin/article/Write.vue',
  'src/frontend/src/composables/useCommentModerationQueue.ts',
  'src/frontend/src/composables/useAdminUserManage.ts',
  'src/frontend/src/composables/useHomeView.ts',
  'src/frontend/src/composables/useAdminArticleWrite.ts',
  'docs/api/contracts.md',
  'src/frontend/package.json'
]

const scannedFiles = Array.from(new Set([
  ...scanRoots.flatMap((path) => walk(repoPath(path))).map(rel),
  ...explicitFiles
]))
  .filter((path) => existsSync(repoPath(path)))
  .sort()

const exactForbidden = [
  { token: '极简主义个人内容发布系统', reason: 'old CMS/template public default description' },
  { token: 'Minimalism, Blog, Fsu', reason: 'old generic public default keywords' },
  { token: 'Security verifying', reason: 'English middleware-style public loading copy' },
  { token: 'secure check', reason: 'English middleware-style public loading copy' },
  { token: 'verifying environment', reason: 'English middleware-style public loading copy' },
  { token: 'checking browser', reason: 'English middleware-style public loading copy' },
  { token: 'Welcome to FsusBlog.', reason: 'generic OSS starter callout copy' },
  { token: 'Found a console problem or have an improvement idea?', reason: 'generic OSS starter callout copy' },
  { token: 'send a patch', reason: 'generic OSS starter callout copy' },
  { token: 'Contribution guide', reason: 'generic OSS starter link label' },
  { token: 'Create GitHub issue', reason: 'generic OSS starter link label' },
  { token: 'Project community', reason: 'generic OSS starter link label' },
  { token: 'SPOTLIGHT', reason: 'decorative uppercase public section label' },
  { token: 'TRENDING', reason: 'decorative uppercase public section label' },
  { token: 'RECOMMENDED', reason: 'decorative uppercase public section label' },
  { token: 'AI CHECK', reason: 'AI-forward authoring panel label' },
  { token: 'AI 辅助检查', reason: 'AI-forward authoring primary action' },
  { token: '作者辅助 / AI CHECK', reason: 'old authoring panel label' },
  { token: '管理 / CONTENT EDITING', reason: 'decorative bilingual authoring label' },
  { token: '文章标题 / TITLE', reason: 'decorative bilingual authoring label' },
  { token: '正文编辑器 / EDITOR', reason: 'decorative bilingual authoring label' },
  { token: '内容辅助 / DRAFT CHECK', reason: 'decorative bilingual authoring label' },
  { token: '图片上传策略 / IMAGE POLICY', reason: 'decorative bilingual authoring label' },
  { token: '发布前警告 / WARNING OVERRIDE', reason: 'decorative bilingual authoring label' },
  { token: 'provider=', reason: 'internal provider diagnostics must not appear in normal authoring UI copy' },
  { token: '按当前标题与正文生成摘要、标题候选、标签和结构建议。', reason: 'old authoring panel description' },
  { token: '没有找到文章。', reason: 'placeholder public empty state' },
  { token: '没有匹配的文章', reason: 'generic public empty state' },
  { token: '无相关内容', reason: 'placeholder public empty state' },
  { token: '筛选目标不存在', reason: 'placeholder public empty state' },
  { token: '这个筛选条件下暂无文章', reason: 'generic public filter empty state' },
  { token: '暂时无法加载内容', reason: 'placeholder public unavailable state' },
  { token: '内容暂时无法载入', reason: 'generic public unavailable state' },
  { token: '连接丢失。', reason: 'dramatic public connection copy' },
  { token: '数据加载异常', reason: 'generic public loading error copy' },
  { token: 'Long Read', reason: 'English public article microcopy' },
  { token: ' Views', reason: 'English public view-count label' },
  { token: '公开页面', reason: 'CMS meta label leaked to public static pages' },
  { token: '内容文档', reason: 'CMS meta label leaked to public static pages' },
  { token: '目前发布', reason: 'awkward archive count copy' }
]

const marketingTerms = [
  'unlock',
  'empower',
  'transform',
  'next-generation',
  'future of',
  'seamless',
  'intelligent experience',
  'AI-powered'
]

const requiredCopy = [
  {
    path: 'src/frontend/src/store/site.ts',
    tokens: [
      '工程记录、性能实验、UI 系统与 FsusBlog 构建过程。',
      '.NET, 前端性能, 系统设计, UI 系统, 技术博客, FsusBlog'
    ]
  },
  {
    path: 'src/frontend/src/view-contracts/filterView.ts',
    tokens: ['正在完成访问校验', '这个分类还没放文章', '这个标签下还没有文章', '换个词试试']
  },
  {
    path: 'src/frontend/src/view-contracts/aboutPage.ts',
    tokens: ['站点说明', '持续更新', '隐私说明', '访问边界', '站点规范', '阅读与互动', '版权说明', '内容授权']
  },
  {
    path: 'src/frontend/src/components/admin/ConsoleWelcomeCallout.vue',
    tokens: ['控制台维护', '发现后台问题或需要记录改进项，可以从这里进入项目维护入口。']
  },
  {
    path: 'src/frontend/src/config/consoleWelcomeCallout.ts',
    tokens: ['维护说明', '新建 Issue', '讨论区']
  },
  {
    path: 'src/frontend/src/views/admin/article/Write.vue',
    tokens: ['标题', '正文', '内容检查', '图片上传策略', '发布警告处理', '检查内容', '生成摘要建议', '应用标签']
  }
]

const uppercaseSuffixAllowlist = new Set(['RSS'])

const technicalAcronymAllowlist = new Set([
  'AOT',
  'RUM',
  'MFA',
  'POW',
  'CIDR',
  'TTL',
  'RSS',
  'IP',
  'UA',
  'API',
  'JWT',
  'SEO',
  'POD',
  'AEDS',
  'SSR',
  'PWA',
  'HTTP',
  'JSON',
  'CLI',
  'DOM',
  'CSRF',
  'CORS',
  'ID',
  'SHA',
  'URL',
  'DNS'
])

const visitorDecorativeLabels = [
  'SPOTLIGHT',
  'TRENDING',
  'RECOMMENDED',
  'DISCOVER',
  'FEATURED'
]

const visitorMicrocopyForbidden = [
  { token: 'Views', reason: 'English public view-count label' },
  { token: 'Long Read', reason: 'English public article microcopy' },
  { token: '公开页面', reason: 'CMS meta label leaked to public static pages' },
  { token: '内容文档', reason: 'CMS meta label leaked to public static pages' }
]

const adminDecorativeLabels = [
  'ADMINISTRATION',
  'TODAY',
  'TRAFFIC',
  'GEOGRAPHY',
  'WORKFLOW',
  'AUTHOR ANALYTICS',
  'ARTICLE LIST',
  'CONTENT EDITING',
  'DRAFT CHECK',
  'IMAGE POLICY',
  'WARNING OVERRIDE'
]

const unnaturalChineseCopy = [
  { token: '文章成果', reason: 'awkward article empty-state copy' },
  { token: '平台使用规范', reason: 'use 站点使用规范 for the site policy label' },
  { token: '学术式阅读节奏', reason: 'design-document wording leaked into user-facing copy' },
  { token: '保持账户区统一的阅读节奏', reason: 'design-document wording leaked into account copy' },
  { token: '双栏工作台', reason: 'design-document layout wording leaked into account copy' }
]

const internalStatusPatterns = [
  { pattern: /\bchecked\s+\$\{?formatTime/i, reason: 'raw check timestamp caption needs localization' },
  { pattern: /\bsnapshot\s+(?:id|\$\{|[=:])/i, reason: 'raw snapshot details need localized framing or an allowlist' },
  { pattern: /(^|[^-A-Za-z])provider=/i, reason: 'raw provider diagnostics must not appear as normal UI copy' },
  { pattern: /(^|[^-A-Za-z])mode=/i, reason: 'raw mode diagnostics must not appear as normal UI copy' },
  { pattern: /model\s+\$\{[^`]*modelProvider[^`]*modelMode/i, reason: 'raw model provider and mode need localized framing' },
  { pattern: /\b(Global Runtime State|External Provider)\b/, reason: 'internal runtime/provider heading needs localization' }
]

function normalizeAcronym(token) {
  return token.replaceAll('-', '').replaceAll('_', '').toUpperCase()
}

function isAllowedTechnicalSuffix(suffix) {
  const words = suffix
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)

  return words.length > 0 && words.every((word) => technicalAcronymAllowlist.has(normalizeAcronym(word)))
}

function hasDisallowedUppercaseWord(suffix) {
  return suffix
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .some((word) => /^[A-Z][A-Z0-9_-]{2,}$/.test(word) && !technicalAcronymAllowlist.has(normalizeAcronym(word)))
}

function findBilingualUppercaseSuffixes(line) {
  const matches = []
  const pattern = /\/\s*([A-Za-z][A-Za-z0-9_-]*(?:\s+[A-Za-z][A-Za-z0-9_-]*)*)\b/g
  for (const match of line.matchAll(pattern)) {
    const suffix = match[1]
    if (hasHanText(line) && hasDisallowedUppercaseWord(suffix) && !isAllowedTechnicalSuffix(suffix)) {
      matches.push(suffix)
    }
  }
  return matches
}

function findStandaloneUppercaseLabels(line) {
  const matches = []
  const pattern = /(?:eyebrow|title|label|caption|description)\s*=\s*["']([A-Z][A-Z0-9_-]*(?:\s+[A-Z][A-Z0-9_-]*)*)["']|>\s*([A-Z][A-Z0-9_-]*(?:\s+[A-Z][A-Z0-9_-]*)*)\s*</g
  for (const match of line.matchAll(pattern)) {
    const token = match[1] ?? match[2]
    if (token && !isAllowedTechnicalSuffix(token)) {
      matches.push(token)
    }
  }
  return matches
}

function hasRawStatusInterpolation(line) {
  if (!/\{\{/.test(line)) {
    return false
  }
  if (/statusLabel|statusText|formatStatus|formatRuntimeStatus|formatOutcome|formatSeverity|formatIssueSeverity|formatCheckStatus|modelStatusLabel|dictionaryStatus|policyStatus/.test(line)) {
    return false
  }
  if (/\?\s*['"`][^'"`]*\p{Script=Han}/u.test(line)) {
    return false
  }
  return /\{\{[^}]*\.(status|outcome|severity)\b[^}]*\}\}/i.test(line)
}

const requiredScannedPaths = [
  'src/frontend/src/views/admin',
  'src/frontend/src/components/admin',
  'src/frontend/src/layouts',
  'src/frontend/src/views/user',
  'src/frontend/src/views/auth',
  'src/frontend/src/components/user',
  'src/frontend/src/components/account',
  'src/frontend/src/view-contracts',
  'src/frontend/src/public-renderers',
  'src/frontend/src/composables/useCommentModerationQueue.ts',
  'src/frontend/src/composables/useAdminUserManage.ts',
  'src/frontend/src/composables/useAdminArticleWrite.ts',
  'src/frontend/src/composables/useHomeView.ts'
]

const vagueEmptyStateTokens = [
  '暂无',
  '没有匹配',
  '内容暂时无法',
  '无相关内容',
  '没有找到'
]

for (const path of scannedFiles) {
  const source = read(path)

  forEachGovernedLine(path, source, (line, lineIndex) => {
    if (isCommentLine(line)) {
      return
    }

    for (const { token, reason } of exactForbidden) {
      if (token === 'provider=' && /model-provider=/.test(line)) {
        continue
      }
      if (line.includes(token)) {
        addError(path, lineIndex + 1, `forbidden copy "${token}" (${reason})`)
      }
    }

    for (const { token, reason } of unnaturalChineseCopy) {
      if (line.includes(token) && isLikelyVisibleCopyLine(line)) {
        addError(path, lineIndex + 1, `forbidden awkward copy "${token}" (${reason})`)
      }
    }
  })

  const lines = source.split('\n')
  lines.forEach((line, lineIndex) => {
    if (!isUserFacingLine(line)) {
      return
    }
    for (const term of marketingTerms) {
      if (term === 'transform' && /`[^`]*transform|transform[^`]*`|transition/.test(line)) {
        continue
      }
      const pattern = new RegExp(`(^|[^a-z0-9-])${term.replaceAll('-', '\\-')}([^a-z0-9-]|$)`, 'i')
      if (pattern.test(line)) {
        addError(path, lineIndex + 1, `review English marketing/template term "${term}"`)
      }
    }
  })

  if (isPublicVisitorCopyPath(path)) {
    forEachGovernedLine(path, source, (line, lineIndex) => {
      if (!isUserFacingLine(line)) {
        return
      }

      for (const token of visitorDecorativeLabels) {
        if (line.includes(token)) {
          addError(path, lineIndex + 1, `decorative uppercase public label "${token}" is not allowed`)
        }
      }

      for (const { token, reason } of visitorMicrocopyForbidden) {
        if (line.includes(token)) {
          addError(path, lineIndex + 1, `forbidden public microcopy "${token}" (${reason})`)
        }
      }

      for (const suffix of findBilingualUppercaseSuffixes(line)) {
        if (!uppercaseSuffixAllowlist.has(suffix)) {
          addError(path, lineIndex + 1, `decorative bilingual uppercase suffix "${suffix}" is not allowed in public copy`)
        }
      }

      for (const token of vagueEmptyStateTokens) {
        if (line.includes(token) && !hasSpecificStateContext(line)) {
          addError(path, lineIndex + 1, `vague empty/error state "${token}" needs context-specific wording or an explicit check update`)
        }
      }
    })
  }

  if (isAdminWorkspaceCopyPath(path)) {
    forEachGovernedLine(path, source, (line, lineIndex) => {
      if (!isLikelyVisibleCopyLine(line)) {
        return
      }

      for (const token of adminDecorativeLabels) {
        if (line.includes(token)) {
          addError(path, lineIndex + 1, `decorative uppercase admin label "${token}" is not allowed in normal UI copy`)
        }
      }

      for (const suffix of findBilingualUppercaseSuffixes(line)) {
        addError(path, lineIndex + 1, `decorative bilingual uppercase suffix "${suffix}" is not allowed in admin/account copy`)
      }

      for (const token of findStandaloneUppercaseLabels(line)) {
        addError(path, lineIndex + 1, `standalone uppercase UI label "${token}" needs Chinese copy or an explicit acronym allowlist`)
      }

      for (const { pattern, reason } of internalStatusPatterns) {
        if (pattern.test(line)) {
          addError(path, lineIndex + 1, `${reason}`)
        }
      }

      if (hasRawStatusInterpolation(line)) {
        addError(path, lineIndex + 1, 'raw status/outcome/severity interpolation needs a readable Chinese display label or an explicit diagnostic context')
      }

      for (const token of vagueEmptyStateTokens) {
        if (line.includes(token) && !hasSpecificStateContext(line)) {
          addError(path, lineIndex + 1, `vague admin/account empty/error state "${token}" needs context-specific wording or an explicit check update`)
        }
      }
    })
  }
}

for (const requiredPath of requiredScannedPaths) {
  if (requiredPath.includes('.')) {
    if (!scannedFiles.includes(requiredPath)) {
      addError(requiredPath, 1, 'required governed copy source is not scanned')
    }
    continue
  }

  const normalized = requiredPath.endsWith('/') ? requiredPath : `${requiredPath}/`
  if (!scannedFiles.some((path) => path.startsWith(normalized))) {
    addError(requiredPath, 1, 'required governed copy root is not scanned')
  }
}

for (const { path, tokens } of requiredCopy) {
  const source = read(path)
  for (const token of tokens) {
    if (!source.includes(token)) {
      addError(path, 1, `missing required governed copy "${token}"`)
    }
  }
}

const packageJson = JSON.parse(read('src/frontend/package.json'))
if (!packageJson.scripts?.['check:public-copy-governance']) {
  addError('src/frontend/package.json', 1, 'missing check:public-copy-governance script')
}

const viewsConstraints = packageJson.scripts?.['check:views-constraints'] ?? ''
if (!viewsConstraints.includes('npm run check:public-copy-governance')) {
  addError('src/frontend/package.json', 1, 'check:views-constraints must run check:public-copy-governance')
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[public-copy-governance] ${error}`)
  }
  process.exit(1)
}

console.log(`[public-copy-governance] ok files=${scannedFiles.length} technicalAllowlist=${technicalAcronymAllowlist.size}`)
