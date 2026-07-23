import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

function commandResult(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return {
    ok: result.status === 0,
    text: String(result.stdout || result.stderr || '').trim()
  }
}

function executable(command, cwd) {
  return commandResult('which', [command], cwd).ok
}

function digestFile(file) {
  return fs.existsSync(file)
    ? createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    : null
}

function privateRegistryState(root, env) {
  const lockfiles = [
    path.join(root, 'src/frontend/package-lock.json'),
    path.join(root, 'package-lock.json')
  ].filter(fs.existsSync)
  const npmrc = path.join(root, 'src/frontend/.npmrc')
  const npmrcText = fs.existsSync(npmrc) ? fs.readFileSync(npmrc, 'utf8') : ''
  const registryText = `${lockfiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n')}\n${npmrcText}`
  const privateAuthRequired = /npm\.pkg\.github\.com|registry\.github\.com/iu.test(registryText)
  const requiredCredentials = [...npmrcText.matchAll(/:_authToken=\$\{([A-Z][A-Z0-9_]*)\}/gu)]
    .map((match) => match[1])
  const credentialPresent = requiredCredentials.length > 0
    && requiredCredentials.every((key) => String(env[key] ?? '').trim())
  return {
    privateAuthRequired,
    credentialPresent: privateAuthRequired ? credentialPresent : false,
    registryMode: privateAuthRequired ? 'private-auth-required' : 'public-registry'
  }
}

function playwrightCapability(root, browser) {
  const script = `import { ${browser} } from '@playwright/test'; import fs from 'node:fs'; process.exit(fs.existsSync(${browser}.executablePath()) ? 0 : 1)`
  return commandResult('node', ['--input-type=module', '-e', script], path.join(root, 'src/frontend')).ok
}

export function sourceIdentity(root) {
  const commit = commandResult('git', ['rev-parse', 'HEAD'], root).text
  const worktree = commandResult('git', ['diff', '--binary', 'HEAD'], root).text
  const untracked = commandResult('git', ['ls-files', '--others', '--exclude-standard'], root).text
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort()
  const untrackedDigest = createHash('sha256')
  for (const relative of untracked) {
    untrackedDigest.update(relative).update('\0').update(fs.readFileSync(path.join(root, relative))).update('\0')
  }
  return {
    commit,
    worktreeFingerprint: createHash('sha256')
      .update(worktree)
      .update('\0')
      .update(untrackedDigest.digest())
      .digest('hex')
  }
}

function capability(ready, detail) {
  return { status: ready ? 'ready' : 'blocked', detail }
}

export function detectAuditPreflight(root, { env = process.env } = {}) {
  const dotnet = commandResult('dotnet', ['--list-sdks'], root)
  const node = commandResult('node', ['--version'], root)
  const npm = commandResult('npm', ['--version'], root)
  const registry = privateRegistryState(root, env)
  const packageLock = path.join(root, 'src/frontend/package-lock.json')
  const chromium = node.ok && playwrightCapability(root, 'chromium')
  const firefox = node.ok && playwrightCapability(root, 'firefox')
  const webkit = node.ok && playwrightCapability(root, 'webkit')
  const cmake = commandResult('cmake', ['--version'], root)
  const cxx = commandResult(env.CXX || 'c++', ['--version'], root)
  const clang = commandResult(env.FSUSBLOG_NATIVE_FUZZ_CXX || 'clang++', ['--version'], root)
  const databaseFixture = executable('docker', root)
    || (executable('pg_isready', root) && executable('redis-cli', root))

  return {
    schema: 'fsusblog.test-asset-audit-preflight.v1',
    source: sourceIdentity(root),
    package: {
      manager: npm.text || 'unavailable',
      lockfile: path.relative(root, packageLock).split(path.sep).join('/'),
      lockfileDigest: digestFile(packageLock),
      ...registry
    },
    configuration: {
      auditProfileDigest: digestFile(path.join(root, 'config/testing/test-asset-audit-profile.json')),
      matrixDigest: digestFile(path.join(root, 'tests/matrix.yml')),
      coverageBaselineDigest: digestFile(path.join(root, 'tests/test-coverage-retention-baseline.json'))
    },
    capabilities: {
      dotnet10: capability(dotnet.ok && /(?:^|\n)10\./u.test(dotnet.text), dotnet.text.split(/\r?\n/u).filter(Boolean)),
      node: capability(node.ok && npm.ok, { node: node.text, npm: npm.text }),
      packages: capability(npm.ok && fs.existsSync(packageLock) && (!registry.privateAuthRequired || registry.credentialPresent), registry.registryMode),
      playwrightChromium: capability(chromium, 'local Chromium executable'),
      playwrightAll: capability(chromium && firefox && webkit, { chromium, firefox, webkit }),
      nativeSmoke: capability(cmake.ok && cxx.ok && executable('ctest', root), { cmake: cmake.text.split(/\r?\n/u)[0], compiler: cxx.text.split(/\r?\n/u)[0] }),
      nativeFuzz: capability(cmake.ok && clang.ok, { cmake: cmake.text.split(/\r?\n/u)[0], compiler: clang.text.split(/\r?\n/u)[0], sanitizers: ['address', 'undefined'] }),
      databaseFixture: capability(databaseFixture, databaseFixture ? 'local fixture provider available' : 'docker or local postgres/redis tooling required')
    }
  }
}

export function blockedRequirements(preflight, requirements) {
  return requirements.filter((id) => preflight.capabilities[id]?.status !== 'ready')
}
