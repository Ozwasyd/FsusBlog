#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const rel = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const read = (file) => fs.readFileSync(file, 'utf8')

const files = {
  filterHeader: path.join(repoRoot, 'src/frontend/src/components/filter/FilterHeader.vue'),
  home: path.join(repoRoot, 'src/frontend/src/components/public/pages/PublicHomePageContent.vue'),
  archive: path.join(repoRoot, 'src/frontend/src/components/public/pages/PublicArchivePageContent.vue'),
  about: path.join(repoRoot, 'src/frontend/src/components/public/pages/PublicAboutPageContent.vue'),
  featured: path.join(repoRoot, 'src/frontend/src/components/home/FeaturedArticlesSection.vue'),
  readingNotice: path.join(repoRoot, 'src/frontend/src/components/article/ArticleReadingNotice.vue'),
  recommendations: path.join(repoRoot, 'src/frontend/src/components/home/HomeTextFirstRecommendations.vue'),
  publicLayoutRules: path.join(repoRoot, 'docs/public-layout-rules.md'),
  packageJson: path.join(repoRoot, 'src/frontend/package.json')
}

const publicFiles = [
  files.filterHeader,
  files.home,
  files.archive,
  files.about,
  files.featured,
  files.readingNotice
]

function fail(file, line, message) {
  failures.push(`${rel(file)}:${line}: ${message}`)
}

function hasAllowComment(lines, index) {
  return /fsus-allow-public-editorial:/.test(lines[index] ?? '')
    || /fsus-allow-public-editorial:/.test(lines[index - 1] ?? '')
}

function checkLines(file, checks) {
  const lines = read(file).split(/\r?\n/)
  lines.forEach((line, index) => {
    if (hasAllowComment(lines, index)) {
      return
    }

    for (const check of checks) {
      if (check.pattern.test(line)) {
        fail(file, index + 1, check.message)
      }
    }
  })
}

for (const file of publicFiles) {
  checkLines(file, [
    {
      pattern: /\btext-(?:6xl|7xl)\b/,
      message: 'public utility/editorial pages must not use oversized SaaS-like display headings'
    },
    {
      pattern: /\bfont-black\b/,
      message: 'public metadata must not use font-black'
    },
    {
      pattern: /\bselect-none\b/,
      message: 'public readable text containers must stay selectable'
    },
    {
      pattern: /\bslide-in-from-bottom/,
      message: 'public pages must not use local slide-in entrance animation by default'
    },
    {
      pattern: /\btext-\[(?:10|11)px\]\s+(?:tabular-nums\s+)?font-(?:bold|semibold)\b/,
      message: 'public metadata must use 12px+ readable scale'
    }
  ])
}

checkLines(files.filterHeader, [
  {
    pattern: /\banimate-in\b/,
    message: 'filter header must not use local entrance animation'
  }
])

checkLines(files.archive, [
  {
    pattern: /\banimate-in\b/,
    message: 'archive year sections must not use per-section entrance animation'
  },
  {
    pattern: /border\s+border-\[var\(--fsusblog-panel-border\)\]/,
    message: 'archive quick year navigation must not use bordered pill controls'
  }
])

checkLines(files.about, [
  {
    pattern: /\banimate-in\b/,
    message: 'about content page must not use local entrance animation'
  },
  {
    pattern: />\s*\/\s*</,
    message: 'about metadata must not use decorative slash separators'
  },
  {
    pattern: /\b(?:opacity-60|hover:opacity-100)\b/,
    message: 'about footer must not hide site information until hover'
  }
])

checkLines(files.home, [
  {
    pattern: /siteTitleText\s*}}\s*<span[^>]*>\.<\/span>/,
    message: 'home title must not append hard-coded trailing punctuation'
  },
  {
    pattern: /\bfont-light\b/,
    message: 'home intro copy must keep normal readable weight'
  }
])

const homeSource = read(files.home)
const featuredSource = read(files.featured)
const recommendationsSource = read(files.recommendations)
const publicLayoutRules = read(files.publicLayoutRules)

const expectHomeIncludes = (file, source, expected, message) => {
  if (!source.includes(expected)) {
    fail(file, 1, message)
  }
}

expectHomeIncludes(files.featured, featuredSource, 'home-editorial-lead__title text-[28px]', 'home lead title must keep the 28px editorial tier')
expectHomeIncludes(files.featured, featuredSource, "'gap-8 py-12 md:grid-cols-2 md:items-center md:py-16'", 'home media lead must keep 48/64px block padding')
expectHomeIncludes(files.featured, featuredSource, "'py-12 md:py-16'", 'home text lead must keep 48/64px block padding')
expectHomeIncludes(files.recommendations, recommendationsSource, 'class="text-xl font-bold leading-[1.2]', 'home section headings must keep the 20px/700 tier')
expectHomeIncludes(files.home, homeSource, 'data-home-punctuation-motif="metadata"', 'home must confine the punctuation motif to feed metadata')
expectHomeIncludes(files.home, homeSource, 'font-size: 12px;', 'home feed metadata must keep a readable 12px tier')
expectHomeIncludes(files.home, homeSource, 'font-size: 14px;', 'home feed summaries must keep the 14px tier')
expectHomeIncludes(files.home, homeSource, 'line-height: 1.6;', 'home feed summaries must keep 1.6 line height')
expectHomeIncludes(files.publicLayoutRules, publicLayoutRules, 'Scholarly Blue 仅用于 link hover、focus 与 active', 'public layout rules must document interaction-only Scholarly Blue')

for (const [file, source] of [
  [files.home, homeSource],
  [files.featured, featuredSource],
  [files.recommendations, recommendationsSource]
]) {
  for (const [pattern, message] of [
    [/\b(?:bg-gradient|from-\[|via-\[|to-\[)/u, 'home hierarchy must not introduce gradients'],
    [/\b(?:shadow-lg|shadow-xl|backdrop-blur|hover:-translate|hover:scale)/u, 'home hierarchy must not introduce card/glow/lift treatments'],
    [/\buppercase\b/u, 'home editorial headings and metadata must preserve natural casing']
  ]) {
    if (pattern.test(source)) {
      fail(file, 1, message)
    }
  }
}

const packageJson = JSON.parse(read(files.packageJson))
const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-public-editorial-governance.mjs'
if (scripts['check:public-editorial-governance'] !== checkScript) {
  fail(files.packageJson, 1, 'check:public-editorial-governance script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:public-editorial-governance')) {
  fail(files.packageJson, 1, 'check:views-constraints must run check:public-editorial-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[public-editorial-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[public-editorial-governance] ok')
