declare const trustedHtmlBrand: unique symbol

export type TrustedHtml = string & { readonly [trustedHtmlBrand]: 'TrustedHtml' }

export const EMPTY_TRUSTED_HTML = '' as TrustedHtml

export function trustRendererHtml(html: string): TrustedHtml {
  return (typeof html === 'string' ? html : '') as TrustedHtml
}

export function trustStaticHtml(html: string): TrustedHtml {
  return (typeof html === 'string' ? html : '') as TrustedHtml
}
