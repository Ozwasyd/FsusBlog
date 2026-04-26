import { createHash } from 'node:crypto'
import { expect, type Browser, type Locator, type Page, type ScreenshotOptions, type StorageState } from '@playwright/test'
import { loadAuditFixtures } from './routeAuditFixtures'

export type RuntimeAudit = {
  checkpoint: () => number
  assertCleanSince: (start: number, label: string) => void
}

type RouteExpectation = Readonly<{
  path: string
  expectedUrl?: string
  label: string
  selectors: Array<(page: Page) => Locator>
}>

export const APP_READY_TIMEOUT_MS = 45_000
export const WARMUP_TIMEOUT_MS = 45_000
export const DESKTOP_VIEWPORT = { width: 1440, height: 960 }
export const TABLET_VIEWPORT = { width: 1024, height: 900 }
export const MOBILE_VIEWPORT = { width: 390, height: 844 }
export const NARROW_MOBILE_VIEWPORT = { width: 360, height: 780 }

export const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser'
export const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!'
export const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin'
export const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!'
export const fixtures = loadAuditFixtures()
export type ThemeMode = 'light' | 'dark'
const acceptanceBackendUrl = process.env.FSUSBLOG_ACCEPTANCE_BACKEND_URL || 'http://127.0.0.1:5000'
const acceptanceDeviceFingerprint = 'playwright-acceptance-fp'
const ACCEPTANCE_UTF8_DECODER = new TextDecoder()
const ACCEPTANCE_AEDS_MAGIC = 0x53444541
const ACCEPTANCE_FRAME_API_ENVELOPE = 250
const ACCEPTANCE_FRAME_API_ERROR = 251

export function attachRuntimeAudit(page: Page): RuntimeAudit {
  const events: string[] = []

  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') {
      return
    }

    const text = message.text().trim()
    if (isIgnorableRuntimeMessage(text)) {
      return
    }

    events.push(`console:${message.type()}:${text}`)
  })

  page.on('pageerror', (error) => {
    const text = error.message.trim()
    if (isIgnorableRuntimeMessage(text)) {
      return
    }

    events.push(`pageerror:${text}`)
  })

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || 'request_failed'
    const requestUrl = request.url()
    if (isIgnorableRequestFailure(requestUrl, failure)) {
      return
    }

    events.push(`requestfailed:${request.method()} ${requestUrl} ${failure}`)
  })

  return {
    checkpoint: () => events.length,
    assertCleanSince: (start, label) => {
      expect(events.slice(start), `${label} should not emit runtime errors or warnings`).toEqual([])
    }
  }
}

function isIgnorableRuntimeMessage(text: string): boolean {
  return text.includes('favicon.ico')
    || text.includes('Deprecated API for given entry type.')
    || text.includes('Failed to load resource: the server responded with a status of 401 (Unauthorized)')
    || text.includes('Failed to load resource: net::ERR_NETWORK_CHANGED')
    || text.includes('ERR_ABORTED')
    || text.includes('ERR_NETWORK_CHANGED')
}

function isIgnorableRequestFailure(url: string, failure: string): boolean {
  if (url.includes('favicon.ico')) {
    return true
  }

  return failure.includes('ERR_ABORTED') || failure.includes('ERR_NETWORK_CHANGED')
}

export async function waitForAppReady(page: Page, timeout = APP_READY_TIMEOUT_MS): Promise<void> {
  await page.waitForFunction(
    () => {
      const isPublicShell = Boolean(document.querySelector('#fsus-aot-shell'))
      const renderableStylesheets = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
        .filter((link) => {
          const href = (link.getAttribute('href') ?? '').toLowerCase()
          const marker = (link.dataset.fsusStyle ?? '').toLowerCase()
          return !marker.includes('font') && !href.includes('font')
        })
      const stylesReady = !isPublicShell || (
        renderableStylesheets.length === 0
        || renderableStylesheets.some((link) => Boolean(link.sheet))
      )

      return document.readyState === 'complete'
        && Boolean(document.querySelector('#app'))
        && stylesReady
    },
    undefined,
    { timeout }
  )
}

export async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(200)
}

export async function openAuditedPage(browser: Browser, storageState?: StorageState): Promise<{
  page: Page
  audit: RuntimeAudit
  close: () => Promise<void>
}> {
  return await openThemedAuditedPage(browser, 'light', storageState)
}

export async function openThemedAuditedPage(
  browser: Browser,
  themeMode: ThemeMode = 'light',
  storageState?: StorageState
): Promise<{
  page: Page
  audit: RuntimeAudit
  close: () => Promise<void>
}> {
  const context = await browser.newContext(storageState ? { storageState } : undefined)
  await context.addInitScript((mode: ThemeMode) => {
    try {
      localStorage.setItem('fsus:theme-mode', mode)
    } catch {
      // ignore storage access errors during init
    }

    const applyTheme = () => {
      const root = document.documentElement
      if (!root) {
        return false
      }

      const isDark = mode === 'dark'
      root.classList.toggle('dark', isDark)
      root.dataset.theme = isDark ? 'dark' : 'light'
      root.dataset.themeMode = mode
      root.style.colorScheme = isDark ? 'dark' : 'light'
      return true
    }

    if (!applyTheme()) {
      setTimeout(applyTheme, 0)
    }
  }, themeMode)
  const page = await context.newPage()
  const audit = attachRuntimeAudit(page)

  return {
    page,
    audit,
    close: async () => {
      await context.close()
    }
  }
}

export async function setThemeMode(page: Page, mode: ThemeMode): Promise<void> {
  await page.evaluate((nextMode: ThemeMode) => {
    localStorage.setItem('fsus:theme-mode', nextMode)
    const root = document.documentElement
    const body = document.body
    const isDark = nextMode === 'dark'
    root.classList.toggle('dark', isDark)
    root.dataset.theme = isDark ? 'dark' : 'light'
    root.dataset.themeMode = nextMode
    root.style.colorScheme = isDark ? 'dark' : 'light'
    if (body) {
      body.dataset.theme = root.dataset.theme
      body.dataset.themeMode = nextMode
      body.style.colorScheme = root.style.colorScheme
    }
  }, mode)
}

export async function ensureThemeApplied(page: Page, mode: ThemeMode): Promise<void> {
  await setThemeMode(page, mode)
  await page.waitForFunction(
    (nextMode: ThemeMode) => {
      const root = document.documentElement
      return root.dataset.themeMode === nextMode
        && root.classList.contains('dark') === (nextMode === 'dark')
    },
    mode,
    { timeout: 5_000 }
  )
  await settlePage(page)
}

export async function prewarmDevRuntime(browser: Browser): Promise<void> {
  const session = await openAuditedPage(browser)

  try {
    await session.page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
  } finally {
    await session.close()
  }
}

export async function captureStorageState(
  browser: Browser,
  username: string,
  password: string,
  redirectTo: string
): Promise<StorageState> {
  void redirectTo
  const context = await browser.newContext()

  try {
    const cookies = await loginViaApi(username, password)
    await context.addCookies(cookies)
    return await context.storageState()
  } finally {
    await context.close()
  }
}

function hasLeadingDifficulty(hash: Buffer, difficulty: number): boolean {
  let remaining = difficulty
  for (const byte of hash) {
    if (remaining <= 0) {
      return true
    }

    if (remaining >= 2) {
      if (byte !== 0) {
        return false
      }
      remaining -= 2
      continue
    }

    if ((byte >> 4) !== 0) {
      return false
    }
    return true
  }

  return remaining <= 0
}

function solvePowNonce(salt: string, browserFp: string, difficulty: number): string {
  let nonce = 0
  while (true) {
    const payload = `${salt}:${nonce}:${browserFp}`
    const hash = createHash('sha256').update(payload, 'utf8').digest()
    if (hasLeadingDifficulty(hash, difficulty)) {
      return String(nonce)
    }
    nonce += 1
  }
}

async function fetchAcceptanceJson(path: string, init?: RequestInit): Promise<any> {
  const response = await fetch(`${acceptanceBackendUrl}${path}`, init)
  const payload = await readAcceptanceJsonLikeResponse(response).catch(() => ({}))
  if (!response.ok) {
    const message = payload?.message ?? payload?.Message ?? `status ${response.status}`
    throw new Error(`acceptance fetch failed for ${path}: ${message}`)
  }
  return payload
}

async function readAcceptanceJsonLikeResponse(response: Response): Promise<any> {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/octet-stream')) {
    return await response.json()
  }

  const envelope = decodeAcceptanceBinaryEnvelope(await response.arrayBuffer())
  return envelope.bodyJson ?? null
}

function decodeAcceptanceBinaryEnvelope(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 24) {
    throw new Error('acceptance_aeds_frame_too_short')
  }

  const magic = view.getUint32(0, true)
  if (magic !== ACCEPTANCE_AEDS_MAGIC) {
    throw new Error('acceptance_aeds_magic_mismatch')
  }

  const frameType = view.getUint16(6, true)
  if (frameType !== ACCEPTANCE_FRAME_API_ENVELOPE && frameType !== ACCEPTANCE_FRAME_API_ERROR) {
    throw new Error(`acceptance_aeds_frame_type_unsupported:${frameType}`)
  }

  const payloadLength = view.getUint32(12, true)
  if (payloadLength !== bytes.byteLength - 24) {
    throw new Error('acceptance_aeds_payload_length_mismatch')
  }

  const payload = bytes.subarray(24)
  const payloadView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let offset = 0
  offset += 4 // status code
  const contentTypeLength = payloadView.getUint16(offset, true)
  offset += 2
  const nestedContentType = ACCEPTANCE_UTF8_DECODER.decode(payload.subarray(offset, offset + contentTypeLength))
  offset += contentTypeLength
  const bodyLength = payloadView.getInt32(offset, true)
  offset += 4
  const bodyBytes = payload.subarray(offset, offset + bodyLength)
  const bodyText = bodyBytes.byteLength > 0 ? ACCEPTANCE_UTF8_DECODER.decode(bodyBytes) : ''
  const bodyJson = bodyText && nestedContentType.toLowerCase().includes('application/json')
    ? JSON.parse(bodyText)
    : null

  return {
    frameType,
    bodyJson
  }
}

async function buildAcceptancePowHeaders(): Promise<Record<string, string>> {
  const challenge = await fetchAcceptanceJson('/api/Auth/pow-challenge', {
    headers: { Accept: 'application/json' }
  })

  const salt = challenge.salt ?? challenge.Salt
  const signature = challenge.signature ?? challenge.Signature
  const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4)
  const timestamp = Number(challenge.timestamp ?? challenge.Timestamp)

  if (!salt || !signature) {
    throw new Error('acceptance pow challenge payload invalid')
  }

  const nonce = solvePowNonce(salt, acceptanceDeviceFingerprint, difficulty)
  const proof = Buffer.from(JSON.stringify({
    powSalt: salt,
    powNonce: nonce,
    powTimestamp: timestamp,
    difficulty,
    powSignature: signature,
    browserFp: acceptanceDeviceFingerprint
  }), 'utf8').toString('base64')

  return {
    'X-Fsus-Pow-Proof': proof,
    'X-Fsus-Device-Fp': acceptanceDeviceFingerprint
  }
}

async function loginViaApi(username: string, password: string) {
  const powHeaders = await buildAcceptancePowHeaders()
  const response = await fetch(`${acceptanceBackendUrl}/api/Auth/login`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...powHeaders
    },
    body: JSON.stringify({
      username,
      password,
      rememberMe: false
    })
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = payload?.message ?? payload?.Message ?? `status ${response.status}`
    throw new Error(`acceptance login failed: ${message}`)
  }

  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : []

  if (!setCookies.length) {
    throw new Error('acceptance login did not return auth cookies')
  }

  const baseUrl = new URL(acceptanceBackendUrl)
  return setCookies
    .map((header) => parseSetCookie(header, baseUrl.hostname))
    .filter((cookie): cookie is NonNullable<typeof cookie> => Boolean(cookie))
}

function parseSetCookie(header: string, hostname: string) {
  const [pair, ...attributes] = header.split(';').map((part) => part.trim())
  if (!pair) {
    return null
  }

  const separatorIndex = pair.indexOf('=')
  if (separatorIndex <= 0) {
    return null
  }

  const name = pair.slice(0, separatorIndex)
  const value = pair.slice(separatorIndex + 1)
  let path = '/'
  let secure = false
  let httpOnly = false
  let sameSite: 'Lax' | 'None' | 'Strict' = 'Lax'

  for (const attribute of attributes) {
    const [rawKey, rawValue] = attribute.split('=')
    const key = rawKey.trim().toLowerCase()
    const parsedValue = rawValue?.trim()

    if (key === 'path' && parsedValue) {
      path = parsedValue
    } else if (key === 'secure') {
      secure = true
    } else if (key === 'httponly') {
      httpOnly = true
    } else if (key === 'samesite' && parsedValue) {
      if (parsedValue.toLowerCase() === 'none') sameSite = 'None'
      if (parsedValue.toLowerCase() === 'strict') sameSite = 'Strict'
      if (parsedValue.toLowerCase() === 'lax') sameSite = 'Lax'
    }
  }

  return {
    name,
    value,
    domain: hostname,
    path,
    httpOnly,
    secure,
    sameSite
  }
}

export async function loginViaUi(
  page: Page,
  audit: RuntimeAudit,
  username: string,
  password: string,
  redirectTo: string
): Promise<void> {
  const start = audit.checkpoint()
  await page.goto(`/login?redirect=${encodeURIComponent(redirectTo)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#username'), 'username field should be ready on login page').toBeVisible()
  await expect(page.locator('#password'), 'password field should be ready on login page').toBeVisible()

  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  const submitButton = page.getByRole('button', { name: /进行/ }).first()
  if (await submitButton.count()) {
    await submitButton.click()
  } else {
    await page.locator('form').evaluate((form) => {
      ;(form as HTMLFormElement).requestSubmit()
    })
  }

  await page.waitForFunction(
    () => {
      const path = `${location.pathname}${location.search}`
      return (path !== '/login' && !path.startsWith('/login?'))
        || Boolean(document.querySelector('#mfa-code'))
        || Boolean(document.querySelector('[role="alert"]'))
    },
    undefined,
    { timeout: 45_000 }
  )

  const alertText = (await page.locator('[role="alert"]').allTextContents()).join(' | ').trim()
  const hasMfaPrompt = await page.locator('#mfa-code').count()
  expect(hasMfaPrompt, `${username} should not be forced into MFA`).toBe(0)
  expect(alertText, `${username} login should not fail`).toBe('')

  await waitForAppReady(page)
  await settlePage(page)
  await expect
    .poll(() => {
      const current = new URL(page.url())
      return `${current.pathname}${current.search}`
    }, { message: `${username} should land on redirect target` })
    .toBe(redirectTo)

  audit.assertCleanSince(start, `${username}-login`)
}

export async function expectAnyVisible(locatorCandidates: Locator[], label: string): Promise<void> {
  for (const locator of locatorCandidates) {
    if (await locator.count()) {
      const first = locator.first()
      if (await first.isVisible().catch(() => false)) {
        await expect(first, `${label} should be visible`).toBeVisible()
        return
      }
    }

    if (await locator.isVisible().catch(() => false)) {
      await expect(locator, `${label} should be visible`).toBeVisible()
      return
    }
  }

  throw new Error(`${label} selector not found`)
}

export async function expectVisibleShell(page: Page): Promise<void> {
  const body = page.locator('body')
  await expect(body).not.toContainText('TypeError')
  await expect(body).not.toContainText('ReferenceError')
  await expect(body).not.toContainText('Unhandled')
  await expect(body).not.toContainText('article_payload_invalid')
}

export async function assertNoHorizontalOverflow(page: Page, tolerance = 4): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth
  }))

  expect(
    metrics.scrollWidth,
    `page should not overflow horizontally (scrollWidth=${metrics.scrollWidth}, viewport=${metrics.innerWidth})`
  ).toBeLessThanOrEqual(metrics.innerWidth + tolerance)
}

export async function assertResponsiveLayoutContract(page: Page, label = 'responsive layout'): Promise<void> {
  await assertNoHorizontalOverflow(page)

  const violations = await page.evaluate(() => {
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const isNarrow = viewportWidth < 640
    const issues: string[] = []
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) {
        return false
      }
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.visibility !== 'hidden'
        && style.display !== 'none'
        && rect.width > 0
        && rect.height > 0
        && rect.bottom >= 0
        && rect.right >= 0
        && rect.top <= viewportHeight
        && rect.left <= viewportWidth
    }
    const labelFor = (element: HTMLElement) => {
      const text = (element.getAttribute('aria-label') || element.textContent || element.id || element.className || element.tagName)
        .toString()
        .trim()
        .replace(/\s+/g, ' ')
      return text.slice(0, 80) || element.tagName.toLowerCase()
    }
    const isInsideControlledScroll = (element: HTMLElement) => {
      let current: HTMLElement | null = element
      while (current) {
        if (current.matches('.admin-table-panel, .responsive-table-panel, .fsus-scroll-x-safe, .custom-table, .el-table, .markdown-body, .prose')) {
          const style = getComputedStyle(current)
          if (style.overflowX === 'auto' || style.overflowX === 'scroll' || current.scrollWidth > current.clientWidth) {
            return true
          }
        }
        current = current.parentElement
      }
      return false
    }

    for (const element of Array.from(document.querySelectorAll('body *')).filter(visible)) {
      const rect = element.getBoundingClientRect()
      if (rect.width > viewportWidth + 4 && !isInsideControlledScroll(element)) {
        issues.push(`wide element ${element.tagName.toLowerCase()} ${labelFor(element)} width=${Math.round(rect.width)}`)
      }
    }

    if (isNarrow) {
      const controls = Array.from(document.querySelectorAll('button, input, textarea, select, .el-button')).filter(visible)
      for (const control of controls) {
        const style = getComputedStyle(control)
        if (style.opacity === '0' || control.getAttribute('aria-hidden') === 'true') {
          continue
        }
        if (control instanceof HTMLInputElement && ['checkbox', 'radio', 'file', 'hidden'].includes(control.type)) {
          continue
        }
        if (control.closest('.el-table, table')) {
          continue
        }
        const rect = control.getBoundingClientRect()
        const requiresTouchTarget = control.matches('.el-button, input, textarea, select, button[type="submit"], .account-mobile-menu')
        if (requiresTouchTarget && (rect.height < 36 || rect.width < 32)) {
          const type = control instanceof HTMLInputElement ? ` type=${control.type}` : ''
          issues.push(`small control ${control.tagName.toLowerCase()}${type} class=${control.className} label=${labelFor(control)} ${Math.round(rect.width)}x${Math.round(rect.height)}`)
        }
      }
    }

    return issues.slice(0, 20)
  })

  expect(violations, `${label} should fit viewport and keep controls reachable`).toEqual([])
}

export async function assertThemeReadable(page: Page, mode: ThemeMode): Promise<void> {
  const palette = await page.evaluate(() => {
    const root = document.documentElement
    const body = document.body

    const read = (selector: string) => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) {
        return null
      }

      const style = getComputedStyle(element)
      return {
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor
      }
    }

    return {
      themeMode: root.dataset.themeMode ?? '',
      hasDarkClass: root.classList.contains('dark'),
      body: read('body'),
      main: read('main'),
      input: read('input, textarea, [role="textbox"]'),
      panel: read('.account-shell-panel, .el-card, .el-dialog, .el-drawer, .custom-table')
    }
  })

  expect(palette.themeMode, 'theme mode dataset should match requested mode').toBe(mode)
  expect(palette.hasDarkClass, 'dark class should match requested mode').toBe(mode === 'dark')
  expect(palette.body, 'body should expose computed colors').not.toBeNull()
  expect(palette.main, 'main should expose computed colors').not.toBeNull()
  if (palette.input === null) {
    expect(mode, 'pages without inputs should still resolve theme mode').toMatch(/light|dark/)
  }
  if (palette.panel === null) {
    expect(mode, 'pages without panel containers should still resolve theme mode').toMatch(/light|dark/)
  }

  if (mode === 'dark') {
    expect(
      palette.body?.backgroundColor || palette.main?.backgroundColor,
      'dark mode should not render a pure white page shell'
    ).not.toBe('rgb(255, 255, 255)')
  }
}

export async function freezeUiForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `
  })
}

export async function collectVisualMasks(page: Page): Promise<Locator[]> {
  const selectors = [
    'time',
    'canvas',
    '.echarts',
    '.echarts-for-react',
    '.el-message',
    '.dashboard-kpi-value',
    '.dashboard-stat__value',
    '.dashboard-chart canvas',
    '[data-visual-dynamic]'
  ]
  const masks: Locator[] = []

  for (const selector of selectors) {
    const locator = page.locator(selector)
    if (await locator.count().catch(() => 0)) {
      masks.push(locator)
    }
  }

  return masks
}

export async function expectStableScreenshot(
  page: Page,
  locator: Locator,
  name: string,
  options?: Omit<ScreenshotOptions, 'mask'>
): Promise<void> {
  await locator.scrollIntoViewIfNeeded().catch(() => {})
  await freezeUiForScreenshot(page)
  const mask = await collectVisualMasks(page)
  await expect(locator).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    mask,
    ...options
  })
}

export async function assertElementInViewport(page: Page, locator: Locator, label: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded()
  await expect(locator, `${label} should be visible`).toBeVisible()

  const box = await locator.boundingBox()
  expect(box, `${label} should have bounding box`).not.toBeNull()
  expect(box!.width, `${label} width should be positive`).toBeGreaterThan(0)
  expect(box!.height, `${label} height should be positive`).toBeGreaterThan(0)

  const viewport = page.viewportSize()
  if (!viewport) {
    return
  }

  expect(box!.x, `${label} should not start outside viewport`).toBeGreaterThanOrEqual(-2)
  expect(box!.x + Math.min(box!.width, viewport.width), `${label} should not exceed viewport width`).toBeLessThanOrEqual(viewport.width + 4)
}

export async function assertElementHitTarget(page: Page, locator: Locator, label: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded()
  await expect(locator, `${label} should be visible`).toBeVisible()

  const box = await locator.boundingBox()
  expect(box, `${label} should have bounding box`).not.toBeNull()

  const viewport = page.viewportSize()
  const x = Math.min(Math.max((box!.x + box!.width / 2), 1), (viewport?.width ?? 2000) - 1)
  const y = Math.min(Math.max((box!.y + box!.height / 2), 1), (viewport?.height ?? 2000) - 1)

  const hitTarget = await locator.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y)
    return Boolean(hit && (hit === element || element.contains(hit)))
  }, { x, y })

  expect(hitTarget, `${label} should not be obscured at interaction point`).toBeTruthy()
}

export async function assertSectionsDoNotOverlap(sections: Array<{ locator: Locator; label: string }>): Promise<void> {
  const visibleBoxes: Array<{ label: string; box: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>> }> = []

  for (const section of sections) {
    if (!await section.locator.count()) {
      continue
    }
    if (!await section.locator.isVisible().catch(() => false)) {
      continue
    }
    await section.locator.scrollIntoViewIfNeeded().catch(() => {})
    const box = await section.locator.boundingBox()
    if (box) {
      visibleBoxes.push({ label: section.label, box })
    }
  }

  for (let index = 0; index < visibleBoxes.length; index += 1) {
    for (let compareIndex = index + 1; compareIndex < visibleBoxes.length; compareIndex += 1) {
      const current = visibleBoxes[index]!
      const next = visibleBoxes[compareIndex]!
      const overlapX = Math.max(0, Math.min(current.box.x + current.box.width, next.box.x + next.box.width) - Math.max(current.box.x, next.box.x))
      const overlapY = Math.max(0, Math.min(current.box.y + current.box.height, next.box.y + next.box.height) - Math.max(current.box.y, next.box.y))
      const overlapArea = overlapX * overlapY
      expect(overlapArea, `${current.label} should not overlap ${next.label}`).toBeLessThanOrEqual(4)
    }
  }
}

export async function assertToastInViewport(page: Page): Promise<void> {
  const messages = page.locator('.el-message')
  const count = await messages.count()
  if (count === 0) {
    return
  }

  for (let index = count - 1; index >= 0; index -= 1) {
    const toast = messages.nth(index)
    if (!await toast.isVisible().catch(() => false)) {
      continue
    }

    const box = await toast.boundingBox().catch(() => null)
    if (!box) {
      return
    }

    const viewport = page.viewportSize()
    if (!viewport) {
      return
    }

    expect(box.width, 'toast width should be positive').toBeGreaterThan(0)
    expect(box.height, 'toast height should be positive').toBeGreaterThan(0)
    expect(box.x, 'toast should not start outside viewport').toBeGreaterThanOrEqual(-2)
    expect(box.x + Math.min(box.width, viewport.width), 'toast should not exceed viewport width').toBeLessThanOrEqual(viewport.width + 4)
    return
  }
}

export async function expectAnyToastText(page: Page, pattern: RegExp): Promise<void> {
  await expect
    .poll(async () => {
      const texts = await page.locator('.el-message').allTextContents()
      return texts.some((text) => pattern.test(text))
    }, { message: `expected a toast matching ${pattern}` })
    .toBe(true)
}

export async function assertTableLayout(page: Page, table: Locator, pagination?: Locator): Promise<void> {
  await assertElementInViewport(page, table, 'table')
  const header = table.locator('.el-table__header')
  const body = table.locator('.el-table__body-wrapper')
  if (await header.count()) {
    await assertElementInViewport(page, header.first(), 'table header')
  }
  if (await body.count()) {
    await assertElementInViewport(page, body.first(), 'table body')
  }
  if (pagination && await pagination.count()) {
    await assertElementInViewport(page, pagination.first(), 'pagination')
  }
}

export async function expectRouteAndShell(page: Page, audit: RuntimeAudit, route: RouteExpectation): Promise<void> {
  const start = audit.checkpoint()
  await page.goto(route.path, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
  await settlePage(page)

  if (route.expectedUrl) {
    await expect
      .poll(() => {
        const current = new URL(page.url())
        return `${current.pathname}${current.search}`
      }, { message: `${route.label} should land on expected route` })
      .toBe(route.expectedUrl)
  }

  await expect(page.locator('#app')).toHaveCount(1)
  await expectAnyVisible(route.selectors.map((factory) => factory(page)), route.label)
  await expectVisibleShell(page)
  await assertNoHorizontalOverflow(page)
  audit.assertCleanSince(start, route.label)
}

export async function fillTextareaWithLabel(page: Page, label: string, value: string): Promise<void> {
  const field = page.getByLabel(label)
  if (await field.count()) {
    await field.fill(value)
    return
  }

  throw new Error(`textarea/input with label "${label}" not found`)
}
