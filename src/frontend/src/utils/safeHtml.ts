import { setSanitizedTemplateHtml } from '@/security/trustedTypesRuntime'

const blockedElements = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'svg',
  'math',
  'foreignobject'
])

const urlAttributes = new Set(['href', 'src', 'xlink:href', 'formaction', 'poster'])
const allowedUrlProtocols = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const allowedDataImagePattern = /^data:image\/(?:png|gif|jpe?g|webp|avif);base64,/i

function sanitizeHtmlFallback(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|svg|math|form|input|button|textarea|select|option|link|meta|base)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|svg|math|form|input|button|textarea|select|option|link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(srcdoc|style|sandbox)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href|formaction|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, sanitizeUrlAttributeFallback)
}

function sanitizeUrlAttributeFallback(attribute: string, _name: string, rawValue: string): string {
  const value = rawValue.length >= 2 && (rawValue[0] === '"' || rawValue[0] === "'")
    ? rawValue.slice(1, -1)
    : rawValue
  return isSafeUrl(decodeHtmlEntities(value)) ? attribute : ''
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);?/gi, (_match, code: string) => {
      const radix = code[0]?.toLowerCase() === 'x' ? 16 : 10
      const raw = code[0]?.toLowerCase() === 'x' ? code.slice(1) : code
      const parsed = Number.parseInt(raw, radix)
      if (!Number.isFinite(parsed)) {
        return ''
      }

      try {
        return String.fromCodePoint(parsed)
      } catch {
        return ''
      }
    })
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
      switch (entity.toLowerCase()) {
        case 'amp':
          return '&'
        case 'lt':
          return '<'
        case 'gt':
          return '>'
        case 'quot':
          return '"'
        case 'apos':
          return "'"
        default:
          return ''
      }
    })
}

function isSafeUrl(value: string): boolean {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, '')
  if (normalized.length === 0 || normalized.startsWith('#') || normalized.startsWith('/') || normalized.startsWith('./') || normalized.startsWith('../')) {
    return true
  }

  if (allowedDataImagePattern.test(normalized)) {
    return true
  }

  try {
    return allowedUrlProtocols.has(new URL(normalized, 'https://fsus.invalid').protocol)
  } catch {
    return false
  }
}

function sanitizeElement(element: Element): void {
  const tagName = element.tagName.toLowerCase()
  if (blockedElements.has(tagName)) {
    element.remove()
    return
  }

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value
    if (
      name.startsWith('on') ||
      name === 'srcdoc' ||
      name === 'style' ||
      name === 'sandbox' ||
      name.startsWith('data-') && value.toLowerCase().includes('javascript:')
    ) {
      element.removeAttribute(attribute.name)
      continue
    }

    if (urlAttributes.has(name) && !isSafeUrl(value)) {
      element.removeAttribute(attribute.name)
    }
  }

  if (tagName === 'a') {
    element.setAttribute('rel', 'noopener noreferrer')
  }
}

export function sanitizeHtmlAllowlist(html: string): string {
  if (typeof document === 'undefined') {
    return sanitizeHtmlFallback(html)
  }

  const template = document.createElement('template')
  setSanitizedTemplateHtml(template, sanitizeHtmlFallback(html))
  const showElement = document.defaultView?.NodeFilter.SHOW_ELEMENT ?? 1
  const walker = document.createTreeWalker(template.content, showElement)
  const elements: Element[] = []
  while (walker.nextNode()) {
    elements.push(walker.currentNode as Element)
  }

  for (const element of elements) {
    sanitizeElement(element)
  }

  return template.innerHTML
}

export function sanitizePreviewHtml(html: string): string {
  return sanitizeHtmlAllowlist(html)
}

export function sanitizeMarkdownRuntimeHtml(html: string): string {
  return sanitizeHtmlAllowlist(html)
}
