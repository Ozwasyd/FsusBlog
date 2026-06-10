#!/usr/bin/env node
import http from 'node:http'
import process from 'node:process'

const CONTRACT_VERSION = 'fsusblog-moderation-provider-v1'

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let data = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      data += chunk
      if (data.length > 64 * 1024) {
        reject(new Error('request too large'))
        request.destroy()
      }
    })
    request.on('end', () => resolve(data))
    request.on('error', reject)
  })
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  response.end(JSON.stringify(payload))
}

function score(request) {
  const text = String(request.text ?? '')
  const risky = /spam|广告/i.test(text)
  return {
    contract_version: CONTRACT_VERSION,
    request_id: request.request_id,
    provider_id: 'example-http-json-node',
    model_profile: 'mock-keyword-v1',
    threshold_profile: request.threshold_profile ?? null,
    status: 'scored',
    label: risky ? 'suspicious' : 'clean',
    confidence: risky ? 0.82 : 0.08,
    severity: risky ? 'medium' : 'low',
    primary_reason: risky ? 'advertising' : null,
    categories: risky
      ? [
          {
            id: 'advertising',
            confidence: 0.82,
            severity: 'medium',
            evidence_policy: 'show_category_only'
          }
        ]
      : [],
    needs_second_round: false,
    evidence: [],
    latency_ms: 1
  }
}

const port = Number(optionValue('--port', '8787'))
const host = optionValue('--host', '127.0.0.1')

const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/moderation/score') {
    json(response, 404, { error: 'not found' })
    return
  }

  try {
    const payload = JSON.parse(await readRequestBody(request))
    if (payload.contract_version !== CONTRACT_VERSION) {
      json(response, 200, {
        contract_version: CONTRACT_VERSION,
        request_id: payload.request_id ?? 'unknown-request',
        provider_id: 'example-http-json-node',
        status: 'contract_mismatch',
        error: {
          code: 'CONTRACT_MISMATCH',
          message: 'unsupported provider contract version',
          retryable: false
        }
      })
      return
    }

    json(response, 200, score(payload))
  } catch (error) {
    json(response, 400, {
      contract_version: CONTRACT_VERSION,
      request_id: 'unknown-request',
      provider_id: 'example-http-json-node',
      status: 'provider_error',
      error: {
        code: 'INVALID_REQUEST',
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    })
  }
})

server.listen(port, host, () => {
  process.stderr.write(`[example-http-json-node] listening on http://${host}:${port}/v1/moderation/score\n`)
})
