#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('../../src/frontend/node_modules/playwright')

const repoRoot = resolve(import.meta.dirname, '../..')
const outputDir = resolve(repoRoot, 'docs/assets/screenshots')
mkdirSync(outputDir, { recursive: true })

const surfaces = [
  {
    file: 'public-home-light.png',
    title: 'Public Home',
    subtitle: 'AOT shell + HotRead public list',
    theme: 'light',
    viewport: { width: 1440, height: 920 },
    layout: 'public-home'
  },
  {
    file: 'article-detail-light.png',
    title: 'Article Detail',
    subtitle: 'Reading tools, TOC, comments, related reading',
    theme: 'light',
    viewport: { width: 1440, height: 920 },
    layout: 'article-detail'
  },
  {
    file: 'article-detail-mobile.png',
    title: 'Mobile Article',
    subtitle: 'Compact reading action bar',
    theme: 'light',
    viewport: { width: 390, height: 844 },
    layout: 'mobile-article'
  },
  {
    file: 'public-dark.png',
    title: 'Public Dark Mode',
    subtitle: 'Dark public shell and article cards',
    theme: 'dark',
    viewport: { width: 1440, height: 920 },
    layout: 'public-home'
  },
  {
    file: 'admin-dashboard.png',
    title: 'Admin Dashboard',
    subtitle: 'Operational counters and moderation state',
    theme: 'admin',
    viewport: { width: 1440, height: 920 },
    layout: 'admin-dashboard'
  },
  {
    file: 'article-editor.png',
    title: 'Article Editor',
    subtitle: 'Authoring workflow with preview',
    theme: 'admin',
    viewport: { width: 1440, height: 920 },
    layout: 'article-editor'
  },
  {
    file: 'comment-moderation.png',
    title: 'Comment Moderation',
    subtitle: 'Pending review queue and policy signals',
    theme: 'admin',
    viewport: { width: 1440, height: 920 },
    layout: 'comment-moderation'
  },
  {
    file: 'security-console.png',
    title: 'Security Console',
    subtitle: 'Anti-crawler, PoW, and risk policy overview',
    theme: 'admin',
    viewport: { width: 1440, height: 920 },
    layout: 'security-console'
  },
  {
    file: 'operations-status.png',
    title: 'Operations Status',
    subtitle: 'AOT, cache, and release evidence status',
    theme: 'admin',
    viewport: { width: 1440, height: 920 },
    layout: 'operations-status'
  }
]

const articles = [
  ['Public Preview Walkthrough', 'A fictional article explaining the local demo surface.'],
  ['AEDS And Public AOT Notes', 'Operations notes for binary transport and pre-rendering.'],
  ['Moderation Queue Basics', 'Safe sample content for review workflow screenshots.']
]

function shell(surface) {
  const dark = surface.theme === 'dark'
  const admin = surface.theme === 'admin'
  const palette = dark
    ? { bg: '#101316', panel: '#171b20', soft: '#20262d', text: '#eef2f3', muted: '#a7b0b9', line: '#313942', accent: '#9bd7c4', warn: '#ffd166' }
    : admin
      ? { bg: '#f5f7f8', panel: '#ffffff', soft: '#edf1f3', text: '#162023', muted: '#65727a', line: '#d8e0e4', accent: '#2f7f73', warn: '#9b6a1c' }
      : { bg: '#fbfaf7', panel: '#ffffff', soft: '#f0eee8', text: '#1f2426', muted: '#687175', line: '#ded8cf', accent: '#3c7f72', warn: '#8a6d1d' }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  background: ${palette.bg};
  color: ${palette.text};
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.screen { width: 100vw; min-height: 100vh; padding: ${surface.viewport.width < 600 ? '18px' : '36px'}; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 18px 22px; border: 1px solid ${palette.line}; background: ${palette.panel}; }
.brand { font-size: 21px; font-weight: 800; letter-spacing: 0; }
.nav { display: flex; gap: 18px; color: ${palette.muted}; font-size: 14px; font-weight: 700; }
.pill { display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border: 1px solid ${palette.line}; color: ${palette.muted}; background: ${palette.soft}; font-size: 12px; font-weight: 800; }
.hero { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 24px; margin-top: 26px; }
.panel { border: 1px solid ${palette.line}; background: ${palette.panel}; padding: 24px; }
.soft { background: ${palette.soft}; }
h1 { margin: 0; font-size: ${surface.viewport.width < 600 ? '33px' : '56px'}; line-height: 1.02; letter-spacing: 0; }
h2 { margin: 0 0 16px; font-size: 24px; letter-spacing: 0; }
h3 { margin: 0 0 8px; font-size: 16px; letter-spacing: 0; }
p { margin: 0; color: ${palette.muted}; line-height: 1.55; }
.grid { display: grid; gap: 16px; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 22px; }
.card { border: 1px solid ${palette.line}; background: ${palette.panel}; padding: 18px; min-height: 150px; }
.meta { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; }
.kpi { font-size: 36px; font-weight: 850; color: ${palette.accent}; }
.table { display: grid; gap: 10px; }
.row { display: grid; grid-template-columns: 1.4fr 0.8fr 0.8fr 0.7fr; gap: 12px; align-items: center; min-height: 48px; border: 1px solid ${palette.line}; background: ${palette.panel}; padding: 12px 14px; font-size: 13px; }
.sidebar-layout { display: grid; grid-template-columns: 250px 1fr; gap: 20px; margin-top: 24px; }
.sidebar { border: 1px solid ${palette.line}; background: ${palette.panel}; padding: 18px; }
.workspace { display: grid; gap: 16px; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.code { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; background: ${dark ? '#0d1114' : '#f6f4ee'}; color: ${palette.text}; border: 1px solid ${palette.line}; padding: 18px; min-height: 420px; white-space: pre-wrap; font-size: 13px; line-height: 1.6; }
.safe-note { position: fixed; right: 18px; bottom: 14px; color: ${palette.muted}; font-size: 11px; }
.mobile-bar { position: fixed; left: 12px; right: 12px; bottom: 12px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.mobile-action { border: 1px solid ${palette.line}; background: ${palette.panel}; padding: 10px 4px; text-align: center; font-size: 12px; font-weight: 800; }
@media (max-width: 600px) {
  .topbar { padding: 14px; }
  .nav { display: none; }
  .hero, .cards, .split, .sidebar-layout { grid-template-columns: 1fr; }
  .screen { padding-bottom: 80px; }
  .card { min-height: 110px; }
}
</style>
</head>
<body>
<main class="screen">
${renderBody(surface, palette)}
<div class="safe-note">Sanitized public-preview screenshot · fictional demo data · no production identifiers</div>
</main>
</body>
</html>`
}

function renderTop(surface) {
  return `<div class="topbar">
  <div class="brand">FsusBlog</div>
  <div class="nav"><span>Home</span><span>Archive</span><span>Search</span><span>Admin</span></div>
  <span class="pill">PUBLIC PREVIEW</span>
</div>`
}

function renderBody(surface, palette) {
  switch (surface.layout) {
    case 'public-home':
      return `${renderTop(surface)}
<section class="hero">
  <div class="panel">
    <span class="pill">Kestrel-only baseline</span>
    <h1 style="margin-top:18px">${surface.title}</h1>
    <p style="margin-top:18px">${surface.subtitle}. Internal APIs are experimental during v1.1.x.</p>
  </div>
  <div class="panel soft">
    <h2>HotRead / AOT</h2>
    <p>Public pages use safe demo content, pre-rendered shell behavior, and binary runtime contracts.</p>
    <div class="meta"><span class="pill">RSS</span><span class="pill">Sitemap</span><span class="pill">robots.txt</span></div>
  </div>
</section>
<section class="cards">
${articles.map(([title, text]) => `<article class="card"><h3>${title}</h3><p>${text}</p><div class="meta"><span class="pill">demo</span><span class="pill">safe</span></div></article>`).join('')}
</section>`
    case 'article-detail':
      return `${renderTop(surface)}
<section class="sidebar-layout">
  <aside class="sidebar"><h3>Contents</h3><p>Intro</p><p>AEDS</p><p>Public AOT</p><p>Comments</p></aside>
  <article class="panel"><span class="pill">DEMO ARTICLE</span><h1 style="margin-top:16px">${surface.title}</h1><p style="margin-top:16px">This sanitized article page shows reading tools, table of contents, related reading, and approved fictional comments.</p>
  <div class="cards"><div class="card"><h3>Copy link</h3><p>Link copied feedback uses local UI state.</p></div><div class="card"><h3>Related</h3><p>Demo content only.</p></div><div class="card"><h3>Comments</h3><p>Approved safe sample comment.</p></div></div></article>
</section>`
    case 'mobile-article':
      return `${renderTop(surface)}
<article class="panel" style="margin-top:18px"><span class="pill">MOBILE</span><h1 style="margin-top:14px">${surface.title}</h1><p style="margin-top:16px">Compact reading layout with fixed action targets and no production content.</p></article>
<section class="grid" style="margin-top:14px"><div class="card"><h3>Contents</h3><p>Intro · AOT · Comments</p></div><div class="card"><h3>Comment</h3><p>Fictional approved comment.</p></div></section>
<div class="mobile-bar"><div class="mobile-action">TOC</div><div class="mobile-action">Share</div><div class="mobile-action">Copy</div><div class="mobile-action">Top</div></div>`
    case 'admin-dashboard':
      return `${renderTop(surface)}
<section class="cards"><div class="card"><p>Public reads</p><div class="kpi">42k</div></div><div class="card"><p>Pending review</p><div class="kpi">7</div></div><div class="card"><p>AOT hit rate</p><div class="kpi">96%</div></div></section>
<section class="panel" style="margin-top:18px"><h2>${surface.title}</h2><div class="table">${['AOT warmup complete','Moderation queue healthy','Security risk policy observe'].map((row) => `<div class="row"><strong>${row}</strong><span>demo</span><span>healthy</span><span class="pill">safe</span></div>`).join('')}</div></section>`
    case 'article-editor':
      return `${renderTop(surface)}
<section class="split" style="margin-top:24px"><div class="panel"><h2>${surface.title}</h2><div class="code"># Public Preview Walkthrough

This editor screenshot uses fictional content.

- no private drafts
- no production assets
- no real author identity</div></div><div class="panel"><h2>Preview</h2><p>Rendered preview remains admin-only until publication.</p><div class="cards" style="grid-template-columns:1fr"><div class="card"><h3>SEO preview</h3><p>example.com placeholder only</p></div></div></div></section>`
    case 'comment-moderation':
      return `${renderTop(surface)}
<section class="panel" style="margin-top:24px"><h2>${surface.title}</h2><div class="table">
${['Pending: demo comment awaiting review','Approved: fictional public comment','Hidden: sample policy replay'].map((row, index) => `<div class="row"><strong>${row}</strong><span>${index === 0 ? 'pending' : 'settled'}</span><span>global</span><span class="pill">demo</span></div>`).join('')}
</div></section>`
    case 'security-console':
      return `${renderTop(surface)}
<section class="cards"><div class="card"><p>Anti-crawler mode</p><div class="kpi">observe</div></div><div class="card"><p>PoW difficulty</p><div class="kpi">20</div></div><div class="card"><p>Risk events</p><div class="kpi">demo</div></div></section>
<section class="panel" style="margin-top:18px"><h2>${surface.title}</h2><div class="table">${['Verified crawler allowed','Social preview guarded','Unknown bot observed'].map((row) => `<div class="row"><strong>${row}</strong><span>policy</span><span>safe sample</span><span class="pill">logged</span></div>`).join('')}</div></section>`
    case 'operations-status':
      return `${renderTop(surface)}
<section class="cards"><div class="card"><p>AOT cache</p><div class="kpi">warm</div></div><div class="card"><p>Release evidence</p><div class="kpi">preview</div></div><div class="card"><p>Redis</p><div class="kpi">ok</div></div></section>
<section class="panel" style="margin-top:18px"><h2>${surface.title}</h2><p>Operations screenshot uses synthetic status rows only.</p><div class="meta"><span class="pill">no production logs</span><span class="pill">no tokens</span><span class="pill">no IPs</span></div></section>`
    default:
      return renderTop(surface)
  }
}

async function launchBrowser() {
  try {
    return await chromium.launch()
  } catch (error) {
    const systemChrome = '/usr/bin/google-chrome'
    if (existsSync(systemChrome)) {
      return await chromium.launch({ executablePath: systemChrome, args: ['--no-sandbox'] })
    }
    throw error
  }
}

const browser = await launchBrowser()
try {
  for (const surface of surfaces) {
    const page = await browser.newPage({ viewport: surface.viewport, deviceScaleFactor: 1 })
    await page.setContent(shell(surface), { waitUntil: 'load' })
    await page.screenshot({ path: resolve(outputDir, surface.file), fullPage: false })
    await page.close()
    console.log(`[screenshots] wrote ${surface.file}`)
  }
} finally {
  await browser.close()
}
