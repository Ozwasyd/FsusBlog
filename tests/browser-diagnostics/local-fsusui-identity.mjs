import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readFsusUiBaseline } from '../../tools/test/fsusui-baseline.mjs'

export const LOCAL_FSUSUI_IDENTITY_SCHEMA = 'fsusblog.browser-diagnostics.local-fsusui-identity.v1'
export const LOCAL_FSUSUI_ROOT_ENV = 'FSUSBLOG_LOCAL_FSUSUI_ROOT'

const sourceScope = 'git-tracked-vue-packages-alias-surface'
const themeDistFiles = [
  'vue/packages/theme-chalk/dist/index.css',
  'vue/packages/theme-chalk/dist/el-public-shell-critical.css',
  'vue/packages/theme-chalk/dist/el-fsus-theme.css',
]
const digestFrame = 'fsusblog.local-fsusui-path-content-sha256.v1'
const fullCommit = /^[0-9a-f]{40}$/u

function fail(message) {
  throw new Error(`local FsusUI identity: ${message}`)
}

function runGit(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim()
    fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
}

function resolveRepositoryRoot(rawRoot) {
  if (typeof rawRoot !== 'string' || rawRoot.trim() === '') {
    fail(`${LOCAL_FSUSUI_ROOT_ENV} is required`)
  }
  const requestedRoot = path.resolve(rawRoot.trim())
  let canonicalRoot
  try {
    canonicalRoot = fs.realpathSync(requestedRoot)
  } catch {
    fail(`${LOCAL_FSUSUI_ROOT_ENV} does not resolve to a directory`)
  }
  if (!fs.statSync(canonicalRoot).isDirectory()) {
    fail(`${LOCAL_FSUSUI_ROOT_ENV} does not resolve to a directory`)
  }
  const gitRoot = fs.realpathSync(runGit(canonicalRoot, ['rev-parse', '--show-toplevel']).trim())
  if (gitRoot !== canonicalRoot) {
    fail(`${LOCAL_FSUSUI_ROOT_ENV} must name the FsusUI Git worktree root`)
  }
  return canonicalRoot
}

function resolveExpectedCommit(rawCommit) {
  const expectedCommit = typeof rawCommit === 'string' ? rawCommit.trim() : ''
  if (!fullCommit.test(expectedCommit)) {
    fail('FsusUI baseline must be a full lowercase Git commit')
  }
  return expectedCommit
}

function assertCleanPinnedHead(root, expectedCommit) {
  const status = runGit(root, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ])
  if (status.length > 0) fail('worktree must be clean, including staged and untracked files')

  const commit = runGit(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  if (!fullCommit.test(commit)) fail('HEAD must resolve to a full lowercase Git commit')
  if (commit !== expectedCommit) {
    fail(`HEAD ${commit} does not match expected commit ${expectedCommit}`)
  }
  return commit
}

function trackedSourceFiles(root) {
  const files = runGit(root, ['ls-files', '-z', '--', 'vue/packages'])
    .split('\0')
    .filter(Boolean)
    .sort()
  if (files.length === 0) fail('tracked vue/packages source is empty')

  for (const required of [
    'vue/packages/element-plus/index.ts',
    'vue/packages/icons-vue/src/index.ts',
    'vue/packages/components/public-shell/index.ts',
    'vue/packages/components/public-shell/src/public-shell.vue',
  ]) {
    if (!files.includes(required)) fail(`harness source is missing ${required}`)
  }
  return files
}

function digestFiles(root, relativeFiles) {
  const digest = createHash('sha256')
  digest.update(`${digestFrame}\0`)
  for (const relativeFile of relativeFiles) {
    const normalized = relativeFile.split(path.sep).join('/')
    const absoluteFile = path.resolve(root, relativeFile)
    if (absoluteFile !== root && !absoluteFile.startsWith(`${root}${path.sep}`)) {
      fail(`identity input escapes the FsusUI root: ${normalized}`)
    }
    let stat
    try {
      stat = fs.lstatSync(absoluteFile)
    } catch {
      fail(`identity input is missing: ${normalized}`)
    }
    if (!stat.isFile()) fail(`identity input must be a regular file: ${normalized}`)
    const bytes = fs.readFileSync(absoluteFile)
    digest.update(normalized)
    digest.update('\0')
    digest.update(String(bytes.length))
    digest.update('\0')
    digest.update(bytes)
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

function digestValue(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

export function resolveLocalFsusUiIdentity(options = {}) {
  const env = options.env || process.env
  const root = resolveRepositoryRoot(options.root ?? env[LOCAL_FSUSUI_ROOT_ENV])
  const expectedCommit = resolveExpectedCommit(
    options.expectedCommit ?? readFsusUiBaseline().commit,
  )
  const commit = assertCleanPinnedHead(root, expectedCommit)
  const sourceFiles = trackedSourceFiles(root)

  const identity = {
    schema: LOCAL_FSUSUI_IDENTITY_SCHEMA,
    provider: 'FsusUI',
    consumptionMode: 'local-git-source-and-theme-dist',
    expectedCommit,
    commit,
    worktreeState: 'clean',
    source: {
      scope: sourceScope,
      algorithm: digestFrame,
      fileCount: sourceFiles.length,
      sha256: digestFiles(root, sourceFiles),
    },
    themeDist: {
      scope: 'harness-required-theme-dist',
      algorithm: digestFrame,
      files: [...themeDistFiles],
      fileCount: themeDistFiles.length,
      sha256: digestFiles(root, themeDistFiles),
    },
  }
  return { ...identity, contentDigest: digestValue(identity) }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args.length === 1 && args[0] !== '--verify')) {
      throw new Error('usage: local-fsusui-identity.mjs [--verify]')
    }
    const identity = resolveLocalFsusUiIdentity()
    process.stdout.write(args[0] === '--verify'
      ? `[fsusui-baseline] ok commit=${identity.commit}\n`
      : `${JSON.stringify(identity, null, 2)}\n`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
