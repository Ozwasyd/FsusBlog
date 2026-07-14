import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createBrowserLaneProxySet } from '../../tools/test/bundles/browser-lane-proxy.mjs'

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function close(server) {
  return new Promise((resolve) => server.close(resolve))
}

test('browser lane proxies allocate distinct loopback ports and preserve HTTP request identity', async () => {
  const target = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ url: request.url, host: request.headers.host }))
  })
  await listen(target)
  const targetUrl = `http://127.0.0.1:${target.address().port}`
  const first = await createBrowserLaneProxySet({ frontend: targetUrl, backend: targetUrl })
  const second = await createBrowserLaneProxySet({ frontend: targetUrl })
  try {
    assert.notEqual(first.ports.frontend, first.ports.backend)
    assert.notEqual(first.ports.frontend, second.ports.frontend)
    const response = await fetch(`${first.urls.frontend}/route?lane=one`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      url: '/route?lane=one',
      host: new URL(targetUrl).host
    })
  } finally {
    await first.close()
    await second.close()
    await close(target)
  }
  await assert.rejects(fetch(`${first.urls.frontend}/after-close`, {
    signal: AbortSignal.timeout(250)
  }))
})
