import http from 'node:http'

const baseUrl = new URL(process.env.ASPNETCORE_URLS)
const server = http.createServer((request, response) => {
  if (request.url === '/health/live') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      status: 'live',
      nodeId: process.env.FSUSBLOG_TEST_NODE_ID,
      runtimeMode: process.env.FSUSBLOG_TEST_RUNTIME_MODE
    }))
    return
  }
  response.writeHead(404)
  response.end()
})

server.listen(Number(baseUrl.port), baseUrl.hostname)

function shutdown() {
  server.close(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
