import { requireWebPackage } from './web-package-fixture.mjs'

export function launchIsolatedChromium() {
  return requireWebPackage('@playwright/test').chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, args: ['--no-proxy-server'] })
}

export function restrictBrowserOrigins(context, ...origins) {
  return context.route('**/*', route => origins.some(origin => origin && route.request().url().startsWith(origin + '/')) ? route.continue() : route.abort())
}
