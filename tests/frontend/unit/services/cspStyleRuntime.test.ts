import { afterEach, describe, expect, it } from 'vitest'
import { createCspStyleBinding } from '@/services/cspStyleRuntime'

afterEach(() => {
  document.head.querySelectorAll('[data-fsus-csp-runtime-style]').forEach((node) => node.remove())
  document.body.replaceChildren()
})

describe('cspStyleRuntime', () => {
  it('moves dynamic declarations into a nonce-authorized class rule', () => {
    const nonceSource = document.createElement('meta')
    nonceSource.setAttribute('property', 'csp-nonce')
    nonceSource.nonce = 'request_nonce'
    document.head.append(nonceSource)
    const target = document.createElement('div')
    document.body.append(target)

    const binding = createCspStyleBinding(target, {
      backgroundColor: '#123456',
      '--reading-progress': 0.25
    }, 'test')

    const runtimeStyle = document.head.querySelector<HTMLStyleElement>('[data-fsus-csp-runtime-style="test"]')
    expect(runtimeStyle?.nonce).toBe('request_nonce')
    expect(target.classList.contains(binding.className)).toBe(true)
    expect(target.hasAttribute('style')).toBe(false)
    expect(runtimeStyle?.sheet?.cssRules[0]?.cssText).toContain('background-color: #123456')
    expect(runtimeStyle?.sheet?.cssRules[0]?.cssText).toContain('--reading-progress: 0.25')

    binding.update({ width: '42px' })
    expect(runtimeStyle?.sheet?.cssRules[0]?.cssText).not.toContain('background-color')
    expect(runtimeStyle?.sheet?.cssRules[0]?.cssText).toContain('width: 42px')

    binding.dispose()
    expect(target.classList.contains(binding.className)).toBe(false)
    expect(runtimeStyle?.isConnected).toBe(false)
    nonceSource.remove()
  })

  it('rejects property-name injection before creating a declaration', () => {
    const target = document.createElement('div')
    document.body.append(target)
    const binding = createCspStyleBinding(target)

    expect(() => binding.update({ 'color;background': 'red' })).toThrow(/invalid CSS property/)
    expect(target.hasAttribute('style')).toBe(false)
    binding.dispose()
  })
})
