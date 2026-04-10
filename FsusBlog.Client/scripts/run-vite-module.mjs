#!/usr/bin/env node

import { createServer, normalizePath } from 'vite'

async function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('[run-vite-module] missing target module path')
    process.exit(1)
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
    const modulePath = target.startsWith('/') ? target : `/${target.replace(/^\.\//, '')}`
    await server.ssrLoadModule(normalizePath(modulePath))
  } finally {
    await server.close()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error('[run-vite-module] fatal:', message)
  process.exit(1)
})
