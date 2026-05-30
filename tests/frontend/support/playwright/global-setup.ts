import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { FullConfig } from '@playwright/test'

function findRepoRoot(start: string): string {
  let current = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(current, 'FsusBlog.slnx'))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`unable to locate repo root from ${start}`)
    }

    current = parent
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  if (process.env.FSUSBLOG_TEST_SESSION_ISOLATION !== '1') {
    return
  }

  if (process.env.FSUSBLOG_SKIP_PLAYWRIGHT_SESSION_PREP === '1') {
    return
  }

  const workers = typeof config.workers === 'number' && config.workers > 0
    ? config.workers
    : Number(process.env.FSUSBLOG_PLAYWRIGHT_WORKERS || '4')

  const repoRoot = findRepoRoot(process.cwd())
  const script = path.join(repoRoot, 'tests', 'frontend', 'fixtures', 'prepare-playwright-sessions.mjs')
  const result = spawnSync(process.execPath, [script, '--workers', String(workers)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FSUSBLOG_PLAYWRIGHT_WORKERS: String(workers)
    },
    stdio: 'inherit'
  })

  if (result.status !== 0) {
    throw new Error(`prepare-playwright-sessions failed with exit ${result.status}`)
  }
}
