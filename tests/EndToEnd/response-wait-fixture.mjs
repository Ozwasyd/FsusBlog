// Evaluate the expected endpoint when each response arrives.
export function waitForUrlResponse(page, url, method, ...options) {
  return page.waitForResponse(response => response.url() === url() &&
    (method === undefined || response.request().method() === method), ...options)
}

export function waitForPathResponse(page, path, method, ...options) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path() &&
    (method === undefined || response.request().method() === method), ...options)
}
