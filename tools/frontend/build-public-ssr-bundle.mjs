#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const clientRoot = process.cwd()
const binExtension = process.platform === 'win32' ? '.cmd' : ''
const viteBin = join(clientRoot, 'node_modules', '.bin', `vite${binExtension}`)
const distRoot = resolve(process.env.FSUSBLOG_FRONTEND_DIST_ROOT || join(clientRoot, 'dist'))
const distServerDir = join(distRoot, 'server')
const sourceEntry = join(distServerDir, 'renderPublicPage.js')
const stableEntry = join(distServerDir, 'public-ssr.mjs')
const moduleBoundaryManifest = join(distServerDir, 'package.json')
const scriptSourceDir = join(clientRoot, 'scripts')
const workerScripts = [
  'server-public-ssr.bundle.mjs',
  'server-public-ssr.worker-core.mjs'
]

function log(message) {
  console.log(`[public-ssr-build] ${message}`)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
    const child = spawn(command, args, {
      cwd: clientRoot,
      env: {
        ...process.env,
        FSUSBLOG_PUBLIC_SSR_BUILD: '1'
      },
      stdio: 'inherit',
      shell: useShell,
      windowsHide: true
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      reject(new Error(`vite public SSR build failed with ${reason}`))
    })
  })
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function finalizeStableEntry() {
  if (!(await pathExists(sourceEntry))) {
    throw new Error(`missing Vite SSR entry output: ${sourceEntry}`)
  }

  await copyFile(sourceEntry, stableEntry)
  log('copied stable SSR entry alias public-ssr.mjs -> renderPublicPage.js')
}

async function writeModuleBoundaryManifest() {
  await writeFile(
    moduleBoundaryManifest,
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`,
    'utf8'
  )
  log('wrote dist/server/package.json ESM boundary for split SSR chunks')
}

async function copyWorkerScripts() {
  await mkdir(distServerDir, { recursive: true })
  for (const fileName of workerScripts) {
    await copyFile(join(scriptSourceDir, fileName), join(distServerDir, fileName))
  }

  log('copied production worker scripts into dist/server')
}

async function main() {
  await run(viteBin, [
    'build',
    '--ssr',
    'src/public-renderers/renderPublicPage.ts',
    '--outDir',
    distServerDir,
    '--emptyOutDir',
    'true'
  ])
  await finalizeStableEntry()
  await writeModuleBoundaryManifest()
  await copyWorkerScripts()
}

main().catch((error) => {
  console.error('[public-ssr-build] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
