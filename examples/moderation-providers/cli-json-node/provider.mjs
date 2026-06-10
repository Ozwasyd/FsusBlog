#!/usr/bin/env node
import process from 'node:process'

const CONTRACT_VERSION = 'fsusblog-moderation-provider-v1'

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function score(request) {
  const text = String(request.text ?? '')
  const lower = text.toLowerCase()
  const risky = lower.includes('spam') || text.includes('广告')
  const category = lower.includes('spam') ? 'spam_repeat' : 'advertising'

  return {
    contract_version: CONTRACT_VERSION,
    request_id: request.request_id,
    provider_id: 'example-cli-json-node',
    model_profile: 'mock-keyword-v1',
    threshold_profile: request.threshold_profile ?? null,
    status: 'scored',
    label: risky ? 'suspicious' : 'clean',
    confidence: risky ? 0.82 : 0.08,
    severity: risky ? 'medium' : 'low',
    primary_reason: risky ? category : null,
    categories: risky
      ? [
          {
            id: category,
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

try {
  const raw = await readStdin()
  const request = JSON.parse(raw)
  if (request.contract_version !== CONTRACT_VERSION) {
    process.stdout.write(JSON.stringify({
      contract_version: CONTRACT_VERSION,
      request_id: request.request_id ?? 'unknown-request',
      provider_id: 'example-cli-json-node',
      status: 'contract_mismatch',
      error: {
        code: 'CONTRACT_MISMATCH',
        message: 'unsupported provider contract version',
        retryable: false
      }
    }))
    process.exit(0)
  }

  process.stdout.write(JSON.stringify(score(request)))
} catch (error) {
  process.stderr.write(`[example-cli-json-node] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
