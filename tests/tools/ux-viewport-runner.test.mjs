import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { runUxViewportWithSummary } from '../frontend/checks/ux/run-ux-viewport-playwright.mjs'

test('runner always writes the current-run summary after Playwright fails', async () => {
  const events = []
  const result = await runUxViewportWithSummary({
    mode: 'boundaries',
    runPlaywright: async () => {
      events.push('playwright')
      return { exitCode: 7, signal: null }
    },
    writeSummary: async () => {
      events.push('summary')
      return { summary: { status: 'failed' } }
    }
  })

  assert.deepEqual(events, ['playwright', 'summary'])
  assert.equal(result.exitCode, 7)
  assert.equal(result.playwrightExitCode, 7)
  assert.equal(result.summaryStatus, 'failed')
})

test('runner preserves a Playwright failure when summary writing also fails', async () => {
  const result = await runUxViewportWithSummary({
    mode: 'visual',
    runPlaywright: async () => ({ exitCode: 9, signal: null }),
    writeSummary: async () => {
      throw new Error('summary unavailable')
    }
  })

  assert.equal(result.exitCode, 9)
  assert.match(result.summaryError.message, /summary unavailable/u)
})

test('runner fails a successful Playwright process when summary is not ok', async () => {
  const result = await runUxViewportWithSummary({
    mode: 'smoke',
    runPlaywright: async () => ({ exitCode: 0, signal: null }),
    writeSummary: async () => ({ summary: { status: 'incomplete' } })
  })

  assert.equal(result.exitCode, 1)
  assert.equal(result.summaryStatus, 'incomplete')
})

test('runner succeeds only when Playwright and the summary both succeed', async () => {
  const result = await runUxViewportWithSummary({
    mode: 'smoke',
    runPlaywright: async () => ({ exitCode: 0, signal: null }),
    writeSummary: async () => ({ summary: { status: 'ok' } })
  })

  assert.equal(result.exitCode, 0)
})

test('all UX package scripts use the always-summary runner instead of an and-chain', async () => {
  const packageJson = JSON.parse(await readFile(
    new URL('../../src/frontend/package.json', import.meta.url),
    'utf8'
  ))

  for (const mode of ['smoke', 'visual', 'boundaries']) {
    const command = packageJson.scripts[`check:ux:viewport-${mode}`]
    assert.match(command, new RegExp(`run-ux-viewport-playwright\\.mjs ${mode}`))
    assert.doesNotMatch(command, /playwright test[\s\S]*&&\s*node [^\n]*write-ux-viewport-summary/u)
  }
})
