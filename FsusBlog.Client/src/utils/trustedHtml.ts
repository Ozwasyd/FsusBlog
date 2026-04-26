declare const trustedHtmlBrand: unique symbol

export type TrustedHtml = string & { readonly [trustedHtmlBrand]: 'TrustedHtml' }

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#47;',
  '`': '&#96;'
}

export const EMPTY_TRUSTED_HTML = '' as TrustedHtml

export function trustRendererHtml(html: string): TrustedHtml {
  return (typeof html === 'string' ? html : '') as TrustedHtml
}

export function trustStaticHtml(html: string): TrustedHtml {
  return (typeof html === 'string' ? html : '') as TrustedHtml
}

export function escapeHtml(input: string): string {
  return String(input).replace(/[&<>"'`/]/g, (char) => HTML_ESCAPE_MAP[char] ?? char)
}

export function escapeRegExpLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createHighlightedTrustedHtml(
  text: string,
  regex: RegExp | null,
  markClass: string
): TrustedHtml {
  const escaped = escapeHtml(text)
  if (!regex) {
    return escaped as TrustedHtml
  }

  return escaped.replace(regex, `<mark class="${markClass}">$1</mark>`) as TrustedHtml
}
