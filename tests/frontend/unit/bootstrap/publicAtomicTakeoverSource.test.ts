import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('public atomic takeover source contract', () => {
  const publicShell = readRepoFile('src/frontend/src/bootstrap/publicShell.ts')

  it('uses atomic public navigation as the default public route path', () => {
    expect(publicShell).toContain('navigateWithAtomicPublicTakeover')
    expect(publicShell).not.toContain('isPublicAtomicTakeoverEnabled')
    expect(publicShell).not.toContain('navigateWithinPublicShell')
  })

  it('routes atomic navigation through prewarm, prepare and commit without legacy document parsing', () => {
    const start = publicShell.indexOf('async function navigateWithAtomicPublicTakeover')
    const end = publicShell.indexOf('async function handleShellAction')
    const atomicBody = publicShell.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(atomicBody).toContain('prewarmPublicRoute')
    expect(atomicBody).toContain('prepareFullApp')
    expect(atomicBody).toContain('commitPreparedFullApp')
    expect(atomicBody).toContain('navigateWithDocumentRequest')
    expect(atomicBody).not.toContain('DOMParser')
    expect(atomicBody).not.toContain('applyPublicNavigationDocument')
  })
})
