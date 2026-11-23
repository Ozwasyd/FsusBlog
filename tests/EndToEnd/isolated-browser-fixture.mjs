import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireWebPackage } from './web-package-fixture.mjs'

export function launchIsolatedChromium() {
  return requireWebPackage('@playwright/test').chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, args: ['--no-proxy-server'] })
}

export function restrictBrowserOrigins(context, ...origins) {
  return context.route('**/*', route => origins.some(origin => origin && route.request().url().startsWith(origin + '/')) ? route.continue() : route.abort())
}

export async function withBrowserEvidence(browser, evidence, filename, fields, run) {
  let failure
  try {
    await run()
  } catch (error) {
    failure = error
  } finally {
    await browser.close()
    await writeFile(join(evidence, filename), JSON.stringify({ ...fields, ...(failure && { failure: String(failure) }) }, null, 2))
  }
  if (failure) throw failure
}
