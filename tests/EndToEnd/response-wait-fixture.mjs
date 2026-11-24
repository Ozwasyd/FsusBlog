async function retainAedsBody(response) {
  // Playwright caches this original body. Read it before a caller waits for a
  // follow-up request or click, while Chromium still retains the resource.
  const type = response.headers()['content-type']?.split(';')[0].trim().toLowerCase()
  const status = response.status()
  if (response.request().method() !== 'HEAD' && status >= 200 && status !== 204 &&
      !(status >= 300 && status < 400) && type === 'application/octet-stream')
    await response.body()
  return response
}

// Evaluate the expected endpoint when each response arrives.
export function waitForUrlResponse(page, url, method, ...options) {
  return page.waitForResponse(response => response.url() === url() &&
    (method === undefined || response.request().method() === method), ...options).then(retainAedsBody)
}

export function waitForPathResponse(page, path, method, ...options) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path() &&
    (method === undefined || response.request().method() === method), ...options).then(retainAedsBody)
}
