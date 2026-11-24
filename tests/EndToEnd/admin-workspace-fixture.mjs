import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { encodeFrame } from '../../src/Contracts/aeds.ts'
import { assertStatus } from './response-status-fixture.mjs'
import { waitForUrlResponse } from './response-wait-fixture.mjs'
import { exactText, roleWithExactName } from './role-locators.mjs'

const execFileAsync = promisify(execFile)

// Keep route changes inside the shared authenticated shell when it is available.
export async function visitAdminWorkspace(page, path) {
  if (new URL(page.url()).pathname === path) return
  await page.locator('.account-workspace-nav').locator(`a[href="${path}"]`).click()
  await page.waitForURL(url => url.pathname === path)
}

export function runFixtureCommand(executable, args = [], timeout = 8_000) {
  return execFileAsync(executable, args, { timeout })
}

export const sha256Hex = value => createHash('sha256').update(value).digest('hex')

export const packFrame = (type, payload) => Buffer.from(encodeFrame(type, payload))

export function postBinary(request, url, origin, data, headers = {}) {
  return request.post(url, {
    headers: { Origin: origin, 'Content-Type': 'application/octet-stream', ...headers }, data,
  })
}

export async function assertPostStatus(request, url, origin, data, expected, headers = {}) {
  const response = await postBinary(request, url, origin, data, headers)
  try { assertStatus(response, expected) } finally { await response.dispose() }
}

export async function clickForResponse(page, url, trigger, method = 'GET', options) {
  const [response] = await Promise.all([waitForUrlResponse(page, () => url, method, options), trigger.click()])
  return response
}

export async function pressForResponse(page, url, trigger, method = 'GET', options) {
  const [response] = await Promise.all([waitForUrlResponse(page, () => url, method, options), trigger.press('Enter')])
  return response
}

export async function assertFocused(locator) {
  assert.equal(await locator.evaluate(node => document.activeElement === node), true)
}

export async function assertFitsWidth(locator) {
  assert(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1))
}

export async function checkLabeledCheckbox(scope, text) {
  await exactText(scope, text).click()
  assert(await roleWithExactName(scope, 'checkbox', text).isChecked())
}

export function assertPasskeyProof(value, message) {
  assert(/^[A-Za-z0-9_-]{43}$/.test(value ?? ''), message)
}

export async function selectOption(page, scope, comboName, optionName) {
  await scope.getByRole('combobox', { name: comboName }).click()
  await roleWithExactName(page, 'option', optionName).click()
}
