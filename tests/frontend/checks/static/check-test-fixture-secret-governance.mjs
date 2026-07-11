import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const repoRoot = resolve(process.env.FSUSBLOG_TEST_FIXTURE_GOVERNANCE_ROOT || checkerRoot)
const scanRoots = [
  'tests/frontend',
  'tests/backend',
  'src/backend/Infrastructure/Operations'
]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function literalPattern(value) {
  return new RegExp(escapeRegExp(value), 'g')
}

const bannedPatterns = [
  {
    label: 'hardcoded fixture admin password',
    regex: literalPattern('BinaryAdminPass123!')
  },
  {
    label: 'hardcoded fixture user password',
    regex: literalPattern('BinaryUserPass123!')
  },
  {
    label: 'fixture JWT secret fallback',
    regex: literalPattern('local-dev-secret-key-32-chars-min-aaaaaa')
  },
  {
    label: 'plaintext default JWT denylist secret',
    regex: new RegExp([
      literalPattern('Were_I_you_I_would_get_high_like_some_airplanes').source,
      literalPattern('Local_Release_Smoke_Key_For_FsusBlog_2026_Only').source
    ].join('|'), 'g')
  },
  {
    label: 'production-like test JWT secret naming',
    regex: literalPattern('production-secret-key-with-at-least-thirty-two-chars')
  },
  {
    label: 'generic unit test JWT secret literal',
    regex: new RegExp([
      literalPattern('unit-test-secret-key-with-at-least-32-chars').source,
      literalPattern('unit-test-secret-key-with-enough-entropy').source
    ].join('|'), 'g')
  },
  {
    label: 'legacy JwtHelper test secret literal',
    regex: literalPattern('SuperSecretTestKeyThatIs32Chars!!')
  },
  {
    label: 'integration JWT secret literal',
    regex: literalPattern('integration-test-secret-key-with-at-least-thirty-two-chars')
  },
  {
    label: 'real production domain in test config',
    regex: new RegExp([
      literalPattern('https://fsus.blog').source,
      literalPattern('https://www.fsus.blog').source,
      String.raw`["']${escapeRegExp('fsus.blog')}["']`
    ].join('|'), 'g')
  },
  {
    label: 'default postgres fixture container',
    regex: literalPattern('fsusblog-postgres')
  },
  {
    label: 'static RFC TOTP seed',
    regex: new RegExp([
      literalPattern('JBSWY3DPEHPK3PXP').source,
      literalPattern('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').source
    ].join('|'), 'g')
  },
  {
    label: 'legacy SQL username sample',
    regex: /\blegacy-user\b/gi,
    files: new Set(['tests/backend/Fixtures/legacy-20260517-minimal.sql'])
  },
  {
    label: 'legacy SQL plaintext refresh token',
    regex: /\bplaintext-refresh-token\b/gi,
    files: new Set(['tests/backend/Fixtures/legacy-20260517-minimal.sql'])
  },
  {
    label: 'legacy SQL loopback IPv4 sample',
    regex: /'127(?:[.]\d{1,3}){3}'/g,
    files: new Set(['tests/backend/Fixtures/legacy-20260517-minimal.sql'])
  },
  {
    label: 'legacy SQL placeholder hash',
    regex: /'hash'/gi,
    files: new Set(['tests/backend/Fixtures/legacy-20260517-minimal.sql'])
  },
  {
    label: 'legacy SQL guest role',
    regex: /'guest'/gi,
    files: new Set(['tests/backend/Fixtures/legacy-20260517-minimal.sql'])
  }
]

const allowlist = new Map([
  [
    'tests/frontend/checks/static/check-test-fixture-secret-governance.mjs',
    new Set(bannedPatterns.map((pattern) => pattern.label))
  ],
  [
    'tests/frontend/checks/static/check-test-fixture-secret-governance-fixture.mjs',
    new Set([
      'legacy SQL username sample',
      'legacy SQL plaintext refresh token',
      'legacy SQL loopback IPv4 sample',
      'legacy SQL placeholder hash',
      'legacy SQL guest role'
    ])
  ]
])

const requiredMarkers = [
  {
    file: 'tests/frontend/support/session-fixtures.mjs',
    marker: 'assertSafeFixtureContainer',
    message: 'session fixture SQL must guard docker container names'
  },
  {
    file: 'tests/frontend/support/session-fixtures.mjs',
    marker: 'FSUSBLOG_TEST_SESSION_SECRET',
    message: 'session JWT signing must require an explicit test secret'
  },
  {
    file: 'tests/frontend/support/auth-helpers.mjs',
    marker: 'loginWithFixtureSessionBypass',
    message: 'fixture bypass login must be explicitly named'
  },
  {
    file: 'tests/frontend/e2e/acceptance/admin-console.spec.ts',
    marker: 'assertLocalAcceptanceBackend',
    message: 'raw draft cleanup fetch must require a local backend'
  }
]

const violations = []

function walk(dir) {
  if (!existsSync(dir)) {
    return
  }

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) {
      walk(path)
      continue
    }

    if (!/\.(?:cs|ts|mjs|json|sql)$/.test(path)) {
      continue
    }

    const rel = relative(repoRoot, path).replace(/\\/g, '/')
    const content = readFileSync(path, 'utf8')
    for (const pattern of bannedPatterns) {
      if (pattern.files && !pattern.files.has(rel)) {
        continue
      }
      pattern.regex.lastIndex = 0
      let match
      while ((match = pattern.regex.exec(content)) !== null) {
        if (!allowlist.get(rel)?.has(pattern.label)) {
          const line = content.slice(0, match.index).split('\n').length
          violations.push(`${rel}:${line}:${pattern.label}`)
        }
        if (match[0].length === 0) pattern.regex.lastIndex += 1
      }
    }
  }
}

for (const scanRoot of scanRoots) {
  walk(resolve(repoRoot, scanRoot))
}

for (const rule of requiredMarkers) {
  const path = resolve(repoRoot, rule.file)
  const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (!content.includes(rule.marker)) {
    violations.push(`${rule.file}:1:${rule.message}`)
  }
}

const legacyFixtureRoot = resolve(repoRoot, 'src/frontend/.playwright-fixtures')
try {
  lstatSync(legacyFixtureRoot)
  violations.push('src/frontend/.playwright-fixtures:1:legacy fixture directory or symbolic link must not remain on disk')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

function checkPrivateAuthFixturePath(path) {
  const rel = relative(repoRoot, path).replace(/\\/g, '/')
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) {
    violations.push(`${rel}:1:auth fixture paths must not be symbolic links`)
    return
  }
  if (stats.isDirectory()) {
    if ((stats.mode & 0o777) !== 0o700) {
      violations.push(`${rel}:1:auth fixture directories must use mode 0700`)
    }
    for (const entry of readdirSync(path)) {
      checkPrivateAuthFixturePath(join(path, entry))
    }
    return
  }
  if ((stats.mode & 0o777) !== 0o600) {
    violations.push(`${rel}:1:auth fixture files must use mode 0600`)
  }
}

const namespacedFixtureRoot = resolve(repoRoot, '.tmp/fixtures')
if (existsSync(namespacedFixtureRoot)) {
  for (const namespace of readdirSync(namespacedFixtureRoot)) {
    const authDirectory = join(namespacedFixtureRoot, namespace, 'auth')
    if (existsSync(authDirectory)) {
      checkPrivateAuthFixturePath(authDirectory)
    }
  }
}

if (violations.length > 0) {
  console.error('[check-test-fixture-secret-governance] failed')
  for (const violation of violations) {
    console.error(`- ${violation}`)
  }
  process.exit(1)
}

console.log('[check-test-fixture-secret-governance] ok')
