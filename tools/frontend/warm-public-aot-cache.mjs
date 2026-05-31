#!/usr/bin/env node

import { readAedsResponse } from '../../tests/frontend/support/aeds-envelope.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
const timeoutMs = Number(process.env.FSUSBLOG_HTTP_TIMEOUT_MS || 15000)
const waitMs = Number(process.env.FSUSBLOG_PUBLIC_AOT_WAIT_MS || 15000)

const publicPaths = ['/', '/about', '/archive', '/article/1']

function withTimeout(promise, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return {
    controller,
    promise: promise(controller.signal).finally(() => clearTimeout(timer))
  }
}

async function fetchAeds(path) {
  const { promise } = withTimeout((signal) => fetch(`${baseUrl}${path}`, {
    signal,
    headers: { Accept: 'application/octet-stream' }
  }), timeoutMs)
  const response = await promise
  if (!response.ok) {
    return null
  }
  try {
    return await readAedsResponse(response)
  } catch {
    return null
  }
}

async function fetchHtml(path) {
  const { promise } = withTimeout((signal) => fetch(`${baseUrl}${path}`, {
    signal,
    headers: { Accept: 'text/html,application/xhtml+xml' }
  }), timeoutMs)
  const response = await promise
  const source = response.headers.get('X-Fsus-Public-Aot-Source') || 'unknown'
  if (!response.ok) {
    throw new Error(`${path} => ${response.status}`)
  }
  await response.text()
  return source
}

async function waitForAotHit(path) {
  const startedAt = Date.now()
  let lastSource = 'unknown'
  while (Date.now() - startedAt < waitMs) {
    lastSource = await fetchHtml(path)
    if (lastSource !== 'spa-fallback' && lastSource !== 'spa-index') {
      return lastSource
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return lastSource
}

async function tryAppendFilterPaths(paths) {
  const [categoryRes, tagRes] = await Promise.all([fetchAeds('/api/binary/category.aeds'), fetchAeds('/api/binary/tag.aeds')])
  const categoryId = Number(categoryRes?.[0]?.id ?? 0)
  const tagId = Number(tagRes?.[0]?.id ?? 0)
  if (Number.isFinite(categoryId) && categoryId > 0) {
    paths.push(`/category/${Math.trunc(categoryId)}`)
  }
  if (Number.isFinite(tagId) && tagId > 0) {
    paths.push(`/tag/${Math.trunc(tagId)}`)
  }
}

async function main() {
  const paths = [...publicPaths]
  await tryAppendFilterPaths(paths)

  for (const path of paths) {
    const first = await fetchHtml(path)
    const second = await waitForAotHit(path)
    console.log(`[warm-public-aot] ${path} first=${first} settled=${second}`)
  }
}

main().catch((error) => {
  console.error(`[warm-public-aot] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
