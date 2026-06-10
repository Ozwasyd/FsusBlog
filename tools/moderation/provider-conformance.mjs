#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import process from 'node:process'

const CONTRACT_VERSION = 'fsusblog-moderation-provider-v1'
const FORBIDDEN_FINAL_ACTION_FIELDS = [
  'allow',
  'reject_submit',
  'geo_block',
  'publish',
  'hide',
  'legal_in_region',
  'illegal_in_region',
  'blocked_regions',
  'submit_action',
  'display_action',
  'action'
]

const CATEGORY_IDS = new Set([
  'advertising',
  'contact_lead',
  'scam',
  'spam_repeat',
  'malicious_link',
  'html_risk',
  'pornographic',
  'sexual_explicit',
  'sexual_suggestion',
  'political_sensitive',
  'public_order_risk',
  'national_security_risk',
  'hate_speech',
  'terrorism_extremism',
  'gambling',
  'violence_extreme',
  'child_safety',
  'harassment'
])

function parseArgs(argv) {
  const options = {
    timeoutMs: 2000
  }

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      options[key] = next
      index += 1
    } else {
      options[key] = true
    }
  }

  if (!['cli-json', 'http-json', 'schema-only'].includes(String(options.provider))) {
    throw new Error('Use --provider cli-json, --provider http-json, or --provider schema-only')
  }

  options.timeoutMs = Number(options.timeoutMs)
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100) {
    throw new Error('--timeoutMs must be >= 100')
  }

  return options
}

function splitArgs(value) {
  if (!value) return []
  return String(value).match(/(?:[^\s"]+|"[^"]*")+/g)?.map(part => part.replace(/^"|"$/g, '')) ?? []
}

function sampleRequest(overrides = {}) {
  return {
    contract_version: CONTRACT_VERSION,
    request_id: '01JZ0000000000000000000000',
    content_type: 'comment',
    text: 'normal comment text',
    language: 'zh-CN',
    region_hint: 'CN-MAINLAND',
    threshold_profile: 'cn-mainland-strict-v1',
    max_evidence_items: 8,
    metadata: {
      source: 'fsusblog',
      article_id: '123',
      comment_depth: 0
    },
    ...overrides
  }
}

function validateRequest(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('request must be object')
  if (value.contract_version !== CONTRACT_VERSION) errors.push('request.contract_version mismatch')
  if (typeof value.request_id !== 'string' || value.request_id.length < 8) errors.push('request.request_id invalid')
  if (!['comment', 'article', 'profile', 'message'].includes(value.content_type)) errors.push('request.content_type invalid')
  if (typeof value.text !== 'string') errors.push('request.text must be string')
  if (value.region_hint != null && !/^[A-Z0-9][A-Z0-9-]{1,63}$/.test(value.region_hint)) errors.push('request.region_hint invalid')
  return errors
}

function validateError(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('error payload must be object')
  for (const field of FORBIDDEN_FINAL_ACTION_FIELDS) {
    if (Object.hasOwn(value, field)) errors.push(`error payload contains forbidden final-action field ${field}`)
  }
  if (value.contract_version !== CONTRACT_VERSION) errors.push('error.contract_version mismatch')
  if (typeof value.request_id !== 'string') errors.push('error.request_id invalid')
  if (typeof value.provider_id !== 'string' || value.provider_id.length === 0) errors.push('error.provider_id invalid')
  if (!['provider_error', 'model_unavailable', 'contract_mismatch', 'too_long', 'empty', 'unsupported_language'].includes(value.status)) errors.push('error.status invalid')
  if (!value.error || typeof value.error !== 'object' || Array.isArray(value.error)) {
    errors.push('error.error object required')
  } else {
    if (!/^[A-Z0-9_]+$/.test(String(value.error.code ?? ''))) errors.push('error.error.code invalid')
    if (typeof value.error.message !== 'string' || value.error.message.length === 0) errors.push('error.error.message invalid')
    if (typeof value.error.retryable !== 'boolean') errors.push('error.error.retryable invalid')
  }
  return errors
}

function validateResult(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push('result must be object')
  for (const field of FORBIDDEN_FINAL_ACTION_FIELDS) {
    if (Object.hasOwn(value, field)) errors.push(`result contains forbidden final-action field ${field}`)
  }
  if (value.contract_version !== CONTRACT_VERSION) errors.push('result.contract_version mismatch')
  if (typeof value.request_id !== 'string') errors.push('result.request_id invalid')
  if (typeof value.provider_id !== 'string' || value.provider_id.length === 0) errors.push('result.provider_id invalid')
  if (typeof value.model_profile !== 'string' || value.model_profile.length === 0) errors.push('result.model_profile invalid')
  if (!['scored', 'unsupported_language', 'too_long', 'empty', 'provider_error', 'model_unavailable', 'contract_mismatch'].includes(value.status)) errors.push('result.status invalid')
  if (!['clean', 'suspicious', 'risky', 'blocked_candidate'].includes(value.label)) errors.push('result.label invalid')
  if (typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) errors.push('result.confidence invalid')
  if (!['low', 'medium', 'high', 'critical'].includes(value.severity)) errors.push('result.severity invalid')
  if (!Array.isArray(value.categories)) {
    errors.push('result.categories must be array')
  } else {
    for (const [index, category] of value.categories.entries()) {
      if (!category || typeof category !== 'object' || Array.isArray(category)) {
        errors.push(`result.categories[${index}] must be object`)
        continue
      }
      if (!CATEGORY_IDS.has(category.id)) errors.push(`result.categories[${index}].id unknown`)
      if (typeof category.confidence !== 'number' || category.confidence < 0 || category.confidence > 1) errors.push(`result.categories[${index}].confidence invalid`)
      if (!['low', 'medium', 'high', 'critical'].includes(category.severity)) errors.push(`result.categories[${index}].severity invalid`)
      if (!['show_full', 'show_category_only', 'redact'].includes(category.evidence_policy)) errors.push(`result.categories[${index}].evidence_policy invalid`)
      for (const field of FORBIDDEN_FINAL_ACTION_FIELDS) {
        if (Object.hasOwn(category, field)) errors.push(`result.categories[${index}] contains forbidden field ${field}`)
      }
    }
  }
  if (Object.hasOwn(value, 'needs_second_round') && typeof value.needs_second_round !== 'boolean') errors.push('result.needs_second_round invalid')
  return errors
}

async function assertSchemasAreJson() {
  const files = [
    'schemas/moderation/model-provider-request.schema.json',
    'schemas/moderation/model-provider-result.schema.json',
    'schemas/moderation/model-provider-error.schema.json'
  ]
  for (const file of files) {
    JSON.parse(await readFile(file, 'utf8'))
  }
}

async function runCliProvider(options, request) {
  if (!options.executable) throw new Error('--executable is required for cli-json')
  const args = splitArgs(options.args)
  return new Promise((resolve, reject) => {
    const child = spawn(String(options.executable), args, {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('provider timeout'))
    }, options.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`provider exited with ${code}: ${stderr.trim()}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (error) {
        reject(new Error(`provider stdout is not JSON: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    child.stdin.end(`${JSON.stringify(request)}\n`)
  })
}

async function runHttpProvider(options, request) {
  if (!options.endpoint) throw new Error('--endpoint is required for http-json')
  const url = new URL(String(options.endpoint))
  const client = url.protocol === 'https:' ? https : http
  const body = JSON.stringify(request)

  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: options.timeoutMs
    }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        data += chunk
      })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (response.statusCode && response.statusCode >= 500) {
            reject(new Error(`provider returned ${response.statusCode}: ${data}`))
            return
          }
          resolve(parsed)
        } catch (error) {
          reject(new Error(`provider response is not JSON: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
    })
    req.on('timeout', () => {
      req.destroy(new Error('provider timeout'))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function runProvider(options, request) {
  if (options.provider === 'cli-json') return await runCliProvider(options, request)
  if (options.provider === 'http-json') return await runHttpProvider(options, request)
  throw new Error(`provider ${options.provider} cannot be executed`)
}

function assertNoErrors(name, errors) {
  if (errors.length === 0) return
  throw new Error(`${name} failed:\n${errors.map(error => `  - ${error}`).join('\n')}`)
}

async function main() {
  const options = parseArgs(process.argv)
  await assertSchemasAreJson()
  assertNoErrors('sample request validation', validateRequest(sampleRequest()))

  const validResult = {
    contract_version: CONTRACT_VERSION,
    request_id: '01JZ0000000000000000000000',
    provider_id: 'self-test-provider',
    model_profile: 'self-test-v1',
    threshold_profile: 'global-baseline',
    status: 'scored',
    label: 'clean',
    confidence: 0.01,
    severity: 'low',
    primary_reason: null,
    categories: [],
    needs_second_round: false,
    evidence: [],
    latency_ms: 1
  }
  assertNoErrors('sample result validation', validateResult(validResult))
  assertNoErrors('sample error validation', validateError({
    contract_version: CONTRACT_VERSION,
    request_id: '01JZ0000000000000000000000',
    provider_id: 'self-test-provider',
    status: 'provider_error',
    error: {
      code: 'MODEL_TIMEOUT',
      message: 'model timed out',
      retryable: true
    }
  }))

  const forbiddenErrors = validateResult({ ...validResult, reject_submit: true, blocked_regions: ['CN-MAINLAND'] })
  if (!forbiddenErrors.some(error => error.includes('forbidden'))) {
    throw new Error('forbidden final-action response fields were not rejected')
  }

  const unknownCategoryErrors = validateResult({
    ...validResult,
    categories: [
      {
        id: 'unknown_risk',
        confidence: 0.9,
        severity: 'high',
        evidence_policy: 'show_category_only'
      }
    ]
  })
  if (!unknownCategoryErrors.some(error => error.includes('unknown'))) {
    throw new Error('unknown category was not rejected deterministically')
  }

  if (options.provider !== 'schema-only') {
    const result = await runProvider(options, sampleRequest({ text: 'normal text with possible spam signal' }))
    const errors = Object.hasOwn(result, 'error') ? validateError(result) : validateResult(result)
    assertNoErrors('provider response validation', errors)

    const mismatch = await runProvider(options, sampleRequest({ contract_version: 'fsusblog-moderation-provider-v0' }))
    const mismatchErrors = Object.hasOwn(mismatch, 'error') ? validateError(mismatch) : validateResult(mismatch)
    assertNoErrors('provider contract mismatch response validation', mismatchErrors)
    if (mismatch.status !== 'contract_mismatch') {
      throw new Error('provider did not return contract_mismatch for unsupported contract version')
    }
  }

  console.log(`[provider-conformance] ok provider=${options.provider}`)
}

main().catch(error => {
  console.error(`[provider-conformance] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
