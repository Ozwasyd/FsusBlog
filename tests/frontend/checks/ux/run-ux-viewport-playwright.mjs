#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeUxViewportSummary } from './write-ux-viewport-summary.mjs'

const validModes = new Set(['smoke', 'visual', 'boundaries'])
const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const frontendRoot = path.join(repositoryRoot, 'src/frontend')
const playwrightCli = path.join(frontendRoot, 'node_modules/@playwright/test/cli.js')

export async function runUxViewportWithSummary({
  mode,
  runPlaywright = () => spawnPlaywright(mode),
  writeSummary = () => writeUxViewportSummary({ root: repositoryRoot, mode })
}) {
  if (!validModes.has(mode)) {
    throw new Error(`unknown UX viewport runner mode: ${String(mode)}`)
  }

  let playwrightResult
  try {
    playwrightResult = await runPlaywright()
  } catch (error) {
    playwrightResult = { exitCode: 1, signal: null, error }
  }
  const playwrightExitCode = Number.isInteger(playwrightResult?.exitCode)
    ? playwrightResult.exitCode
    : 1

  let summaryResult = null
  let summaryError = null
  try {
    summaryResult = await writeSummary()
  } catch (error) {
    summaryError = error instanceof Error ? error : new Error(String(error))
  }
  const summaryStatus = summaryResult?.summary?.status ?? 'error'
  const summarySucceeded = summaryError === null && summaryStatus === 'ok'

  return {
    exitCode: playwrightExitCode !== 0
      ? playwrightExitCode
      : summarySucceeded
        ? 0
        : 1,
    playwrightExitCode,
    playwrightSignal: playwrightResult?.signal ?? null,
    playwrightError: playwrightResult?.error ?? null,
    summaryStatus,
    summaryError,
    summaryResult
  }
}

async function spawnPlaywright(mode) {
  const workers = resolveWorkers(process.env.FSUSBLOG_UX_VIEWPORT_WORKERS)
  const args = [
    playwrightCli,
    'test',
    ...resolveShardArgs(process.env.FSUSBLOG_PLAYWRIGHT_SHARD_ARG),
    `--workers=${workers}`,
    'ux/viewport-boundaries.spec.ts'
  ]
  const env = {
    ...process.env,
    FSUSBLOG_UX_VIEWPORT_MODE: mode
  }

  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: frontendRoot,
      env,
      stdio: 'inherit'
    })
    let spawnError = null
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('close', (exitCode, signal) => {
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        signal,
        error: spawnError
      })
    })
  })
}

function resolveWorkers(raw) {
  const workers = Number.parseInt(raw ?? '1', 10)
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`invalid FSUSBLOG_UX_VIEWPORT_WORKERS: ${String(raw)}`)
  }
  return workers
}

function resolveShardArgs(raw) {
  if (!raw?.trim()) {
    return []
  }
  const match = raw.trim().match(/^--shard(?:=|\s+)(\d+)\/(\d+)$/u)
  if (!match) {
    throw new Error(`invalid FSUSBLOG_PLAYWRIGHT_SHARD_ARG: ${raw}`)
  }
  const current = Number.parseInt(match[1], 10)
  const total = Number.parseInt(match[2], 10)
  if (current < 1 || total < 1 || current > total) {
    throw new Error(`invalid FSUSBLOG_PLAYWRIGHT_SHARD_ARG: ${raw}`)
  }
  return [`--shard=${current}/${total}`]
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const mode = process.argv[2]
  try {
    const result = await runUxViewportWithSummary({ mode })
    if (result.playwrightError) {
      console.error(`[ux-viewport-runner] Playwright launch failed: ${result.playwrightError.message}`)
    }
    if (result.summaryError) {
      console.error(`[ux-viewport-runner] summary failed: ${result.summaryError.message}`)
    } else {
      console.log(`[ux-viewport-runner] summary status=${result.summaryStatus}`)
    }
    process.exitCode = result.exitCode
  } catch (error) {
    console.error(`[ux-viewport-runner] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
