#!/usr/bin/env node
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const frontendRoot = path.join(root, 'src/frontend')
const playwright = await import(pathToFileURL(path.join(frontendRoot, 'node_modules/playwright/index.mjs')).href)
const requested = (process.env.FSUSBLOG_AEDS_BROWSERS || 'chromium,firefox,webkit').split(',').map(value => value.trim()).filter(Boolean)
const outFile = path.join(root, '.tmp/frontend/aeds-wasm-browser/summary.json')
const releaseFile = path.join(root, '.tmp/release-evidence/aeds-wasm-browser-summary.json')
const port = await freePort()
const origin = `http://127.0.0.1:${port}`
const vite = spawn(path.join(frontendRoot, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: frontendRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_FSUSBLOG_BUILD_ID: '' }
})
let viteLog = ''
vite.stdout.on('data', chunk => { viteLog += String(chunk) })
vite.stderr.on('data', chunk => { viteLog += String(chunk) })

try {
  await waitForServer(`${origin}/wasm/aeds-runtime-manifest.json`)
  const results = []
  for (const browserName of requested) results.push(await runBrowser(browserName))
  const supported = results.filter(result => result.supported)
  const failures = supported.filter(result => result.status !== 'ok')
  if (supported.length === 0) failures.push({ browser: 'none', error: 'no_supported_browser' })
  const summary = {
    status: failures.length === 0 ? 'ok' : 'failed',
    generatedAt: new Date().toISOString(),
    origin,
    results,
    failures
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.mkdirSync(path.dirname(releaseFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(releaseFile, `${JSON.stringify({
    status: summary.status,
    generatedAt: summary.generatedAt,
    artifact: path.relative(root, outFile).replaceAll(path.sep, '/'),
    hydrationTakeoverEvidence: '.tmp/release-evidence/public-hydration-sidecar-summary.json',
    selectionRate: supported.length > 0 ? supported.filter(result => result.normal?.diagnostics?.selectedTier === 'speed').length / supported.length : 0,
    fallbackRate: supported.length > 0 ? supported.filter(result => result.fallback?.diagnostics?.selectedTier === 'basic').length / supported.length : 0,
    browsers: results.map(result => ({
      browser: result.browser,
      supported: result.supported,
      status: result.status,
      selectedTier: result.normal?.diagnostics?.selectedTier ?? null,
      fallbackTier: result.fallback?.diagnostics?.selectedTier ?? null,
      fallbackCount: result.fallback?.diagnostics?.fallbackCount ?? 0,
      load: result.normal?.diagnostics?.load ?? null,
      decode: result.normal ? {
        elapsedMs: result.normal.elapsedMs,
        megabytesPerSecond: result.normal.megabytesPerSecond,
        frameBuckets: result.normal.diagnostics?.frameBuckets ?? {},
        jsToWasmCopiedBytes: result.normal.diagnostics?.jsToWasmCopiedBytes ?? 0,
        wasmToJsCopiedBytes: result.normal.diagnostics?.wasmToJsCopiedBytes ?? 0,
        peakPages: result.normal.diagnostics?.peakPages ?? 0,
        growCount: result.normal.diagnostics?.growCount ?? 0,
        longTaskCount: result.normal.longTaskCount,
        longTaskDurationMs: result.normal.longTaskDurationMs
      } : null,
      workerTransferMs: result.worker?.response?.workerTransferMs ?? null
    }))
  }, null, 2)}\n`)
  if (summary.status !== 'ok') {
    for (const failure of failures) console.error(`[aeds-tier-browser] ${failure.browser}: ${failure.error ?? failure.status}`)
    process.exitCode = 1
  } else {
    console.log(`[aeds-tier-browser] ok ${supported.map(result => `${result.browser}:${result.normal.diagnostics.selectedTier}->${result.fallback.diagnostics.selectedTier}`).join(' ')}`)
  }
} finally {
  vite.kill('SIGTERM')
}

async function runBrowser(browserName) {
  const browserType = playwright[browserName]
  if (!browserType) return { browser: browserName, supported: false, status: 'unsupported', error: 'unknown_browser' }
  let browser
  try {
    browser = await browserType.launch({ headless: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Executable doesn't exist|browserType\.launch|Please run.*playwright install/isu.test(message)) {
      return { browser: browserName, supported: false, status: 'unsupported', error: 'browser_not_installed' }
    }
    return { browser: browserName, supported: true, status: 'failed', error: message }
  }
  try {
    const normal = await runScenario(browser, false)
    const fallback = await runScenario(browser, true)
    const worker = await runWorkerScenario(browser)
    const errors = []
    if (normal.diagnostics.selectedTier !== 'speed') errors.push(`normal_tier_${normal.diagnostics.selectedTier}`)
    if (normal.requests.some(url => url.includes('aeds_decoder_basic'))) errors.push('normal_downloaded_basic')
    if (normal.decodeFailures !== 0 || normal.diagnostics.decodeCount !== 40) errors.push('normal_decode_count')
    if (normal.diagnostics.growCount !== 0) errors.push('speed_memory_grew')
    if (fallback.diagnostics.selectedTier !== 'basic' || fallback.diagnostics.fallbackCount !== 1) errors.push('fallback_not_basic')
    const speedRequestIndex = fallback.requests.findIndex(url => url.includes('aeds_decoder_speed.wasm'))
    const basicRequestIndex = fallback.requests.findIndex(url => url.includes('aeds_decoder_basic.wasm'))
    if (speedRequestIndex < 0 || basicRequestIndex <= speedRequestIndex) errors.push('fallback_request_order')
    if (fallback.decodeFailures !== 0 || fallback.diagnostics.decodeCount !== 1) errors.push('fallback_double_decode')
    if (!worker.detached || !worker.response?.ok || worker.response?.diagnostics?.selectedTier !== 'speed') errors.push('worker_transfer_decode')
    if (worker.requests.filter(url => url.includes('aeds_decoder_speed.wasm')).length !== 1
      || worker.requests.some(url => url.includes('aeds_decoder_basic'))) errors.push('worker_repeated_compile_or_basic_download')
    return { browser: browserName, supported: true, status: errors.length === 0 ? 'ok' : 'failed', errors, normal, fallback, worker }
  } finally {
    await browser.close()
  }
}

async function runScenario(browser, blockSpeed) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const requests = []
  page.on('request', request => {
    if (request.url().includes('/wasm/aeds')) requests.push(request.url())
  })
  if (blockSpeed) {
    await page.route('**/wasm/aeds_decoder_speed.wasm', route => route.abort('failed'))
  }
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async ({ blockSpeed }) => {
    let longTaskCount = 0
    let longTaskDurationMs = 0
    let longTaskObserver
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      longTaskObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          longTaskCount += 1
          longTaskDurationMs += entry.duration
        }
      })
      longTaskObserver.observe({ entryTypes: ['longtask'] })
    }
    const runtime = await import('/wasm/web/aeds.ts')
    const ready = await runtime.initWasm()
    if (!ready) throw new Error('aeds_wasm_init_failed')
    const iterations = blockSpeed ? 1 : 40
    const payloadBytes = 256 * 1024
    const frame = new Uint8Array(16 + payloadBytes)
    const view = new DataView(frame.buffer)
    view.setUint32(0, 0x53444541, true)
    view.setUint8(4, 2)
    view.setUint8(5, 16)
    view.setUint16(8, 14, true)
    view.setUint32(10, payloadBytes, true)
    for (let offset = 16; offset < frame.byteLength; offset += 1) frame[offset] = (offset * 17) & 0xff
    view.setUint16(14, runtime.crc16(frame.subarray(16)), true)
    let decodeFailures = 0
    const started = performance.now()
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const decoded = runtime.decode(frame.buffer.slice(0))
      if (!decoded.ok || decoded.payloadView.byteLength !== payloadBytes) decodeFailures += 1
    }
    const elapsedMs = performance.now() - started
    await new Promise(resolve => setTimeout(resolve, 0))
    longTaskObserver?.disconnect()
    return {
      decodeFailures,
      elapsedMs,
      megabytesPerSecond: ((frame.byteLength * iterations) / (1024 * 1024)) / (elapsedMs / 1000),
      longTaskCount,
      longTaskDurationMs,
      diagnostics: runtime.getAedsRuntimeDiagnostics()
    }
  }, { blockSpeed })
  await context.close()
  return { ...result, requests }
}

async function runWorkerScenario(browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const requests = []
  page.on('request', request => {
    if (request.url().includes('/wasm/aeds')) requests.push(request.url())
  })
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const result = await page.evaluate(async () => {
    const worker = new Worker('/src/workers/wasmDecode.worker.ts', { type: 'module' })
    const payload = new Uint8Array(8)
    new DataView(payload.buffer).setBigInt64(0, 42n, true)
    const frame = new Uint8Array(24)
    const view = new DataView(frame.buffer)
    view.setUint32(0, 0x53444541, true)
    view.setUint8(4, 2)
    view.setUint8(5, 16)
    view.setUint16(8, 241, true)
    view.setUint32(10, payload.byteLength, true)
    frame.set(payload, 16)
    let crc = 0xffff
    for (const byte of payload) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
    }
    view.setUint16(14, crc & 0xffff, true)
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('worker_timeout')), 15_000)
      worker.onmessage = event => { clearTimeout(timeout); resolve(event.data) }
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message || 'worker_error')) }
    })
    const buffer = frame.buffer
    worker.postMessage({ v: 1, type: 'decode', requestId: 1, buffer, expectedFrameType: 241, sentAtUnixMs: Date.now() }, [buffer])
    const detached = buffer.byteLength === 0
    const response = await responsePromise
    worker.terminate()
    return { detached, response }
  })
  await context.close()
  return { ...result, requests }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const value = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(value))
    })
  })
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`vite_exited:${vite.exitCode}\n${viteLog}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`vite_start_timeout\n${viteLog}`)
}
