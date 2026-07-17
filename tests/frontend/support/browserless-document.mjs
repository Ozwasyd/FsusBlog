import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Window } = require(require.resolve('happy-dom', { paths: [process.cwd()] }))

export function withBrowserlessDocument(html, inspect, options = {}) {
  const window = new Window({
    url: options.url ?? 'https://example.com/'
  })

  try {
    window.document.open()
    window.document.write(html)
    window.document.close()
    return inspect(window.document, window)
  } finally {
    window.close()
  }
}

export function normalizedText(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}
