import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizePreviewHtml } from '@/utils/safeHtml'
import {
  resetTrustedTypesRuntimeForTests,
  setCommentPrivacyProverScriptUrl,
  setNonExecutableScriptText,
  setSanitizedTemplateHtml,
  toTrustedApplicationWorkerScriptUrl,
  toTrustedMarkdownWorkerScriptUrl,
  toTrustedServiceWorkerScriptUrl,
  toTrustedSanitizedHtml
} from '@/security/trustedTypesRuntime'

const trustedTypeMarker = Symbol('trusted-type')
const restores: Array<() => void> = []

describe('trustedTypesRuntime', () => {
  beforeEach(() => {
    resetTrustedTypesRuntimeForTests()
    const createPolicy = vi.fn((_name: string, rules: TrustedTypeRules) => ({
      createHTML: (value: string) => trustedValue('html', rules.createHTML?.(value) ?? value),
      createScript: (value: string) => trustedValue('script', rules.createScript?.(value) ?? value),
      createScriptURL: (value: string) => trustedValue('script-url', rules.createScriptURL?.(value) ?? value)
    }))
    vi.stubGlobal('trustedTypes', { createPolicy })
    restores.push(
      enforceTrustedSetter(document.createElement('template'), 'innerHTML', 'html'),
      enforceTrustedSetter(document.createElement('iframe'), 'srcdoc', 'html'),
      enforceTrustedSetter(document.createElement('script'), 'src', 'script-url'),
      enforceTrustedSetter(document.createElement('script'), 'textContent', 'script')
    )
  })

  afterEach(() => {
    while (restores.length > 0) restores.pop()?.()
    vi.unstubAllGlobals()
    resetTrustedTypesRuntimeForTests()
  })

  it('rejects raw HTML and script URL strings while allowing the audited wrappers', () => {
    const template = document.createElement('template')
    expect(() => {
      template.innerHTML = '<p>raw</p>'
    }).toThrow('mock_trusted_types_html_required')

    const sanitized = sanitizePreviewHtml('<p onclick="steal()">safe</p><script>steal()</script>')
    expect(sanitized).toBe('<p>safe</p>')
    expect(() => setSanitizedTemplateHtml(template, '<img src="x" onerror="steal()">'))
      .toThrow('trusted_types_unsanitized_html_rejected')
    const previewFrame = document.createElement('iframe')
    expect(() => {
      previewFrame.srcdoc = '<p>raw preview</p>'
    }).toThrow('mock_trusted_types_html_required')
    expect(() => {
      previewFrame.srcdoc = toTrustedSanitizedHtml('<!doctype html><body><p>safe preview</p></body>')
    }).not.toThrow()

    const script = document.createElement('script')
    expect(() => {
      script.src = '/wasm/comment-privacy-prover.js'
    }).toThrow('mock_trusted_types_script-url_required')
    expect(() => setCommentPrivacyProverScriptUrl(script, '/wasm/comment-privacy-prover.js')).not.toThrow()
    expect(new URL(script.src).pathname).toBe('/wasm/comment-privacy-prover.js')
    expect(() => setCommentPrivacyProverScriptUrl(script, 'https://evil.example/prover.js'))
      .toThrow('comment_privacy_prover_artifact_invalid')
    expect(() => setCommentPrivacyProverScriptUrl(script, 'blob:https://app.example.invalid/opaque'))
      .toThrow('comment_privacy_prover_artifact_invalid')
    expect(() => setCommentPrivacyProverScriptUrl(script, '/wasm/comment-privacy-prover.js?replace=1'))
      .toThrow('comment_privacy_prover_artifact_invalid')

    const createPolicy = vi.mocked((globalThis as unknown as {
      trustedTypes: { createPolicy: (name: string, rules: TrustedTypeRules) => unknown }
    }).trustedTypes.createPolicy)
    expect(createPolicy).toHaveBeenCalledTimes(1)
    expect(createPolicy).toHaveBeenCalledWith('fsusblog', expect.objectContaining({
      createHTML: expect.any(Function),
      createScript: expect.any(Function),
      createScriptURL: expect.any(Function)
    }))
  })

  it('only creates TrustedScript values for non-executable data script types', () => {
    const dataScript = document.createElement('script')
    dataScript.type = 'application/json'
    expect(() => {
      dataScript.textContent = '{"raw":true}'
    }).toThrow('mock_trusted_types_script_required')
    expect(() => setNonExecutableScriptText(dataScript, '{"safe":true}')).not.toThrow()
    expect(dataScript.textContent).toBe('{"safe":true}')

    const executableScript = document.createElement('script')
    executableScript.type = 'module'
    expect(() => setNonExecutableScriptText(executableScript, 'alert(1)'))
      .toThrow('trusted_types_executable_script_text_rejected')
  })

  it('only trusts the same-origin hashed markdown renderer worker artifact', () => {
    const workerUrl = new URL('/assets/markdown-renderer.worker-Abc_123.js', globalThis.location.href)
    const trustedWorkerUrl = toTrustedMarkdownWorkerScriptUrl(workerUrl)

    expect(String(trustedWorkerUrl)).toBe(workerUrl.href)
    expect(() => toTrustedMarkdownWorkerScriptUrl('/assets/markdown-renderer.worker.js'))
      .toThrow('markdown_renderer_worker_artifact_invalid')
    expect(() => toTrustedMarkdownWorkerScriptUrl('/assets/other.worker-Abc_123.js'))
      .toThrow('markdown_renderer_worker_artifact_invalid')
    expect(() => toTrustedMarkdownWorkerScriptUrl(`${workerUrl.href}?replace=1`))
      .toThrow('markdown_renderer_worker_artifact_invalid')
    expect(() => toTrustedMarkdownWorkerScriptUrl(`${workerUrl.href}#replace`))
      .toThrow('markdown_renderer_worker_artifact_invalid')
    expect(() => toTrustedMarkdownWorkerScriptUrl('https://evil.example/markdown-renderer.worker-Abc_123.js'))
      .toThrow('markdown_renderer_worker_artifact_invalid')
  })

  it('only trusts named same-origin application worker artifacts', () => {
    for (const workerName of [
      'captcha.worker-Abc_123.js',
      'commentPrivacy.worker-Abc_123.js',
      'perception-v2.worker-Abc_123.js',
      'pospace.worker-Abc_123.js',
      'pow.worker--_vxlx1q.js',
      'wasmDecode.worker-Abc_123.js'
    ]) {
      const workerUrl = new URL(`/assets/${workerName}`, globalThis.location.href)
      expect(String(toTrustedApplicationWorkerScriptUrl(workerUrl))).toBe(workerUrl.href)
    }

    const devWorkerUrl = new URL('/src/workers/pow.worker.ts', globalThis.location.href)
    expect(String(toTrustedApplicationWorkerScriptUrl(devWorkerUrl))).toBe(devWorkerUrl.href)

    expect(() => toTrustedApplicationWorkerScriptUrl('/assets/data-pipeline.worker-Abc_123.js'))
      .toThrow('application_worker_artifact_invalid')
    expect(() => toTrustedApplicationWorkerScriptUrl('/assets/pow.worker-Abc_123.js?replace=1'))
      .toThrow('application_worker_artifact_invalid')
    expect(() => toTrustedApplicationWorkerScriptUrl('https://evil.example/assets/pow.worker-Abc_123.js'))
      .toThrow('application_worker_artifact_invalid')
  })

  it('only trusts the same-origin release service worker artifact', () => {
    expect(String(toTrustedServiceWorkerScriptUrl('/sw.js')))
      .toBe(new URL('/sw.js', globalThis.location.href).href)
    expect(String(toTrustedServiceWorkerScriptUrl('/sw.js?build=20260716010203-0123456789ab')))
      .toBe(new URL('/sw.js?build=20260716010203-0123456789ab', globalThis.location.href).href)
    expect(() => toTrustedServiceWorkerScriptUrl('/sw.js?build=latest'))
      .toThrow('service_worker_artifact_invalid')
    expect(() => toTrustedServiceWorkerScriptUrl('/sw.js?replace=1'))
      .toThrow('service_worker_artifact_invalid')
    expect(() => toTrustedServiceWorkerScriptUrl('/sw.js?build=release-2026&build=other-2026'))
      .toThrow('service_worker_artifact_invalid')
    expect(() => toTrustedServiceWorkerScriptUrl('/sw.js#replace'))
      .toThrow('service_worker_artifact_invalid')
    expect(() => toTrustedServiceWorkerScriptUrl('https://evil.example/sw.js'))
      .toThrow('service_worker_artifact_invalid')
  })

  it('fails closed at an enforced sink when the application policy cannot be created', () => {
    resetTrustedTypesRuntimeForTests()
    const createPolicy = vi.mocked((globalThis as unknown as {
      trustedTypes: { createPolicy: () => never }
    }).trustedTypes.createPolicy)
    createPolicy.mockImplementation(() => {
      throw new TypeError('policy_blocked')
    })

    expect(() => setSanitizedTemplateHtml(document.createElement('template'), '<p>safe</p>'))
      .toThrow('mock_trusted_types_html_required')
  })
})

type TrustedTypeKind = 'html' | 'script' | 'script-url'
type TrustedTypeRules = {
  createHTML?: (value: string) => string
  createScript?: (value: string) => string
  createScriptURL?: (value: string) => string
}

function trustedValue(kind: TrustedTypeKind, value: string) {
  return {
    [trustedTypeMarker]: kind,
    toString: () => value
  }
}

function enforceTrustedSetter(
  target: object,
  property: 'innerHTML' | 'srcdoc' | 'src' | 'textContent',
  kind: TrustedTypeKind
): () => void {
  let owner: object | null = target
  let descriptor: PropertyDescriptor | undefined
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, property)
    if (!descriptor) owner = Object.getPrototypeOf(owner)
  }
  if (!owner || !descriptor?.set) throw new Error(`missing_setter_${property}`)
  const original = descriptor
  Object.defineProperty(owner, property, {
    ...original,
    set(value: unknown) {
      if (!value || typeof value !== 'object'
        || (value as Record<PropertyKey, unknown>)[trustedTypeMarker] !== kind) {
        throw new TypeError(`mock_trusted_types_${kind}_required`)
      }
      original.set?.call(this, String(value))
    }
  })
  return () => Object.defineProperty(owner, property, original)
}
