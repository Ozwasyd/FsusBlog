import http from 'node:http'
import net from 'node:net'

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function proxyHeaders(headers, target) {
  return { ...headers, host: target.host }
}

async function createLoopbackProxy(targetValue) {
  const target = new URL(targetValue)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') {
    throw new Error(`browser lane proxy target must be loopback HTTP: ${targetValue}`)
  }
  const sockets = new Set()
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: proxyHeaders(request.headers, target)
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.once('error', (error) => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`browser lane upstream failed: ${error.message}`)
    })
    request.pipe(upstream)
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`]
      for (const [name, value] of Object.entries(proxyHeaders(request.headers, target))) {
        if (Array.isArray(value)) value.forEach((item) => lines.push(`${name}: ${item}`))
        else if (value !== undefined) lines.push(`${name}: ${value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.once('error', () => socket.destroy())
  })
  await listen(server)
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

export async function createBrowserLaneProxySet(targets) {
  const entries = Object.entries(targets)
  const proxies = []
  try {
    for (const [name, target] of entries) {
      proxies.push([name, await createLoopbackProxy(target)])
    }
  } catch (error) {
    await Promise.allSettled(proxies.map(([, proxy]) => proxy.close()))
    throw error
  }
  return {
    urls: Object.fromEntries(proxies.map(([name, proxy]) => [name, proxy.url])),
    ports: Object.fromEntries(proxies.map(([name, proxy]) => [name, proxy.port])),
    close: () => Promise.allSettled(proxies.map(([, proxy]) => proxy.close()))
  }
}
