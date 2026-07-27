// @vitest-environment node
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

function countListenerRegistrations(source: string, target: 'window' | 'document', type: string): number {
  const pattern = new RegExp(
    `${target}\\.(?:addEventListener|removeEventListener)\\(\\s*['"]${type}['"]`,
    'gu'
  )
  return source.match(pattern)?.length ?? 0
}

describe('public intent ownership contract', () => {
  it('keeps BootKernel as the only pre-entry pointer/touch/key/scroll owner', () => {
    const kernel = readSource('src/frontend/src/bootstrap/publicBootKernel.ts')
    const shell = readSource('src/frontend/src/bootstrap/publicShell.ts')
    const runtime = readSource('src/frontend/src/bootstrap/publicActivationRuntime.ts')
    const app = readSource('src/frontend/src/App.vue')

    expect(kernel).toContain("const intentTypes = ['pointerdown', 'touchstart', 'keydown', 'scroll']")
    expect(kernel).toContain('window.addEventListener(type, onIntent')
    expect(kernel).toContain('window.removeEventListener(type, onIntent)')

    for (const type of ['pointerdown', 'touchstart', 'keydown', 'scroll'] as const) {
      // BootKernel registers via the intentTypes loop (variable `type`), not literals.
      // AOT/runtime/App must not re-bind these activation intents after handoff.
      expect(countListenerRegistrations(shell, 'window', type)).toBe(0)
      expect(countListenerRegistrations(shell, 'document', type)).toBe(0)
      expect(countListenerRegistrations(runtime, 'window', type)).toBe(0)
      expect(countListenerRegistrations(runtime, 'document', type)).toBe(0)
      expect(countListenerRegistrations(app, 'window', type)).toBe(0)
      expect(countListenerRegistrations(app, 'document', type)).toBe(0)
      expect(shell).not.toContain(`'${type}'`)
      expect(runtime).not.toContain(`addEventListener('${type}'`)
    }
  })

  it('limits AOT public intent capture to publicShell click plus prewarm focus surfaces', () => {
    const shell = readSource('src/frontend/src/bootstrap/publicShell.ts')

    expect(countListenerRegistrations(shell, 'document', 'click')).toBe(0)
    expect(shell).toContain("addPublicShellEventListener(document, 'click'")
    expect(shell).toContain("addPublicShellEventListener(document, 'pointerenter'")
    expect(shell).toContain("addPublicShellEventListener(document, 'focusin'")
    expect(shell).toContain('submitPublicActivationIntent')
    expect(shell).not.toContain(['bind', 'Public', 'Activation', 'Triggers'].join(''))
    expect(shell).not.toContain(['fsus:public-shell', ':', 'takeover'].join(''))
    expect(shell).not.toContain(['fsus:public-shell', ':', 'search-focus'].join(''))
    expect(shell).not.toContain(['begin', 'Public', 'Takeover', 'Prewarm'].join(''))
    expect(shell).not.toContain(['mark', 'Public', 'Takeover', 'Prepared'].join(''))
  })

  it('removes dual root AOT action entry and orphan event bridges from production sources', () => {
    const app = readSource('src/frontend/src/App.vue')
    const fullApp = readSource('src/frontend/src/bootstrap/fullApp.ts')
    const layout = readSource('src/frontend/src/layouts/BlogLayout.vue')
    const runtime = readSource('src/frontend/src/bootstrap/publicActivationRuntime.ts')

    expect(app).not.toContain(['handle', 'Root', 'Aot', 'Click'].join(''))
    expect(app).not.toContain(['aot', 'Action', 'Bridge'].join(''))
    expect(fullApp).toContain('requestPublicSearchFocusIntent')
    expect(fullApp).toContain("import('@/bootstrap/publicActivationRuntime')")
    expect(layout).toContain('requestPublicSearchFocusIntent')
    expect(runtime).toContain('requestPublicSearchFocusIntent')
    expect(fullApp).not.toMatch(/import\s*\{[^}]*requestPublicSearchFocusIntent[^}]*\}\s*from\s*['"]@\/bootstrap\/publicActivationRuntime['"]/u)
    expect(fullApp).not.toContain(['fsus:public-shell', ':', 'search-focus'].join(''))
    expect(layout).not.toContain(['fsus:public-shell', ':', 'search-focus'].join(''))
    expect(runtime).not.toContain(['fsus:public-shell', ':', 'search-focus'].join(''))
    expect(runtime).not.toContain(['fsus:public-shell', ':', 'takeover'].join(''))
  })
})
