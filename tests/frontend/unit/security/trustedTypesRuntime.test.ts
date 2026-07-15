import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sanitizePreviewHtml } from '@/utils/safeHtml'
import {
  resetTrustedTypesRuntimeForTests,
  setCommentPrivacyProverScriptUrl,
  setNonExecutableScriptText,
  setSanitizedTemplateHtml,
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
