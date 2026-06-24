import { existsSync } from 'node:fs'

const SYSTEM_CHROMIUM_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

export function resolveSystemChromiumExecutablePath() {
  return process.env.PLAYWRIGHT_CHROMIUM_PATH
    || SYSTEM_CHROMIUM_CANDIDATES.find((candidate) => existsSync(candidate))
    || undefined
}

export function systemChromiumLaunchOptions(options = {}) {
  const executablePath = resolveSystemChromiumExecutablePath()
  const args = Array.from(new Set([
    ...(Array.isArray(options.args) ? options.args : []),
    '--no-sandbox',
    '--disable-dev-shm-usage'
  ]))

  return {
    ...options,
    ...(executablePath ? { executablePath } : {}),
    args
  }
}
