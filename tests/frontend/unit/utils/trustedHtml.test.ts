import { describe, it, expect } from 'vitest'
import {
  trustRendererHtml,
  trustStaticHtml,
  EMPTY_TRUSTED_HTML
} from '@/utils/trustedHtml'

describe('trustRendererHtml / trustStaticHtml', () => {
  it('trustRendererHtml returns string as TrustedHtml', () => {
    expect(trustRendererHtml('<p>html</p>')).toBe('<p>html</p>')
  })

  it('trustRendererHtml returns empty string for non-string input', () => {
    expect(trustRendererHtml(null as unknown as string)).toBe('')
  })

  it('trustStaticHtml returns string as TrustedHtml', () => {
    expect(trustStaticHtml('static')).toBe('static')
  })
})

describe('EMPTY_TRUSTED_HTML', () => {
  it('is an empty string', () => {
    expect(EMPTY_TRUSTED_HTML).toBe('')
  })
})
