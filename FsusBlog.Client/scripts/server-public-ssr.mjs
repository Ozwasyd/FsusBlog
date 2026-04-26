#!/usr/bin/env node

import { createServer, normalizePath } from 'vite'

function fail(message) {
  console.error(`[server-public-ssr] ${message}`)
  process.exit(1)
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      raw += chunk
    })
    process.stdin.on('end', () => resolve(raw))
    process.stdin.on('error', reject)
  })
}

function pickRenderer(module, pageKind) {
  switch (pageKind) {
    case 'Home':
      return module.renderPublicHomeBundle
    case 'ArticleDetail':
      return module.renderPublicArticleDetailBundle
    case 'About':
      return module.renderPublicAboutBundle
    case 'Archive':
      return module.renderPublicArchiveBundle
    case 'Filter':
      return module.renderPublicFilterBundle
    default:
      return null
  }
}

async function main() {
  const raw = await readStdin()
  if (!raw.trim()) {
    fail('missing stdin payload')
  }

  let request
  try {
    request = JSON.parse(raw)
  } catch (error) {
    fail(`invalid json: ${error instanceof Error ? error.message : String(error)}`)
  }

  const pageKind = typeof request?.pageKind === 'string' ? request.pageKind.trim() : ''
  const hydrationPropsJson = typeof request?.hydrationPropsJson === 'string' ? request.hydrationPropsJson : ''
  if (!pageKind || !hydrationPropsJson) {
    fail('pageKind and hydrationPropsJson are required')
  }

  const server = await createServer({
    root: process.cwd(),
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false,
      watch: null
    },
    appType: 'custom',
    configFile: normalizePath(`${process.cwd()}/vite.config.ts`)
  })

  try {
    const module = await server.ssrLoadModule(normalizePath('/src/public-renderers/renderPublicPage.ts'))
    const render = pickRenderer(module, pageKind)
    if (typeof render !== 'function') {
      fail(`unsupported pageKind: ${pageKind}`)
    }

    const hydrationPayload = JSON.parse(hydrationPropsJson)
    const rendered = await render(hydrationPayload)
    process.stdout.write(JSON.stringify({
      html: rendered?.html ?? '',
      rendererVersion: rendered?.rendererVersion ?? ''
    }))
  } finally {
    await server.close()
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error))
})
