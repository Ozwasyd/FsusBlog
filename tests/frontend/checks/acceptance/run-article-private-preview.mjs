#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')
const frontendRoot = path.join(root, 'src/frontend')
const playwrightCli = path.join(frontendRoot, 'node_modules/@playwright/test/cli.js')
const workerResolver = path.join(root, 'tools/test/resolve-playwright-workers.mjs')

export const fixedArticlePrivatePreviewSpec = 'acceptance/article-private-preview.spec.ts'
export const fixedArticlePrivatePreviewWorkerProfile = 'article-private-preview'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: frontendRoot,
    env: options.env ?? process.env,
    stdio: 'inherit'
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${options.label ?? command} failed with exit ${String(result.status)}`)
  }
}

export function fixedPlaywrightArguments() {
  return [
    playwrightCli,
    'test',
    '--config=playwright.config.ts',
    '--workers=1',
    '--retries=0',
    fixedArticlePrivatePreviewSpec
  ]
}

export function runArticlePrivatePreview({
  args = process.argv.slice(2),
  env = process.env,
  runCommand = run
} = {}) {
  if (args.length !== 0) {
    throw new Error('article private preview runner does not accept CLI arguments')
  }

  const resolver = spawnSync(process.execPath, [workerResolver, fixedArticlePrivatePreviewWorkerProfile], {
    cwd: root,
    env,
    encoding: 'utf8'
  })
  if (resolver.status !== 0 || !/^[1-9]\d*\s*$/u.test(resolver.stdout ?? '')) {
    throw new Error('article private preview worker resolver failed')
  }

  runCommand('npm', ['run', 'verify:wasm'], {
    env,
    label: 'article private preview Wasm receipt verification'
  })
  const playwrightEnv = { ...env }
  delete playwrightEnv.NO_COLOR
  playwrightEnv.NODE_PATH = './node_modules'
  playwrightEnv.FSUSBLOG_PLAYWRIGHT_WORKERS = '1'
  runCommand(process.execPath, fixedPlaywrightArguments(), {
    env: playwrightEnv,
    label: 'article private preview fixed Playwright leaf'
  })
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    runArticlePrivatePreview()
  } catch (error) {
    console.error(`[article-private-preview] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
