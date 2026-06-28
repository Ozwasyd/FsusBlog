import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '..', '..')
const scanRoots = [
  'tests/frontend',
  'tests/backend',
  'src/backend/Infrastructure/Operations'
]

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function literalPattern(parts) {
  return new RegExp(escapeRegExp(parts.join('')), 'g')
}

const bannedPatterns = [
  {
    label: 'hardcoded fixture admin password',
    regex: literalPattern(['BinaryAdmin', 'Pass123!'])
  },
  {
    label: 'hardcoded fixture user password',
    regex: literalPattern(['BinaryUser', 'Pass123!'])
  },
  {
    label: 'fixture JWT secret fallback',
    regex: literalPattern(['local-dev-secret-key', '-32-chars-min-aaaaaa'])
  },
  {
    label: 'plaintext default JWT denylist secret',
    regex: new RegExp([
      literalPattern(['Were_I_you', '_I_would_get_high_like_some_airplanes']).source,
      literalPattern(['Local_Release', '_Smoke_Key_For_FsusBlog_2026_Only']).source
    ].join('|'), 'g')
  },
  {
    label: 'production-like test JWT secret naming',
    regex: literalPattern(['production-secret-key', '-with-at-least-thirty-two-chars'])
  },
  {
    label: 'generic unit test JWT secret literal',
    regex: new RegExp([
      literalPattern(['unit-test-secret-key', '-with-at-least-32-chars']).source,
      literalPattern(['unit-test-secret-key', '-with-enough-entropy']).source
    ].join('|'), 'g')
  },
  {
    label: 'legacy JwtHelper test secret literal',
    regex: literalPattern(['SuperSecretTestKey', 'ThatIs32Chars!!'])
  },
  {
    label: 'integration JWT secret literal',
    regex: literalPattern(['integration-test-secret-key', '-with-at-least-thirty-two-chars'])
  },
  {
    label: 'real production domain in test config',
    regex: new RegExp([
      literalPattern(['https://', 'fsus', '.blog']).source,
      literalPattern(['https://www.', 'fsus', '.blog']).source,
      String.raw`["']${escapeRegExp(['fsus', '.blog'].join(''))}["']`
    ].join('|'), 'g')
  },
  {
    label: 'default postgres fixture container',
    regex: literalPattern(['fsusblog', '-postgres'])
  },
  {
    label: 'static RFC TOTP seed',
    regex: new RegExp([
      literalPattern(['JBSWY3D', 'PEHPK3PXP']).source,
      literalPattern(['GEZDGNBVGY3TQOJQ', 'GEZDGNBVGY3TQOJQ']).source
    ].join('|'), 'g')
  },
  {
    label: 'deterministic legacy identity fixture',
    regex: /legacy-(?:admin|credential|public-key|recovery-key-hash)/g,
    files: new Set(['tests/backend/Integration/LegacyIdentityColdStartResetIntegrationTests.cs'])
  }
]

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

const storageStateFiles = [
  'src/frontend/.playwright-fixtures/admin.storage-state.json',
  'src/frontend/.playwright-fixtures/user.storage-state.json',
  'src/frontend/.playwright-fixtures/auth-fixtures.json'
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

    if (!/\.(?:cs|ts|mjs|json)$/.test(path)) {
      continue
    }

    const rel = relative(repoRoot, path).replace(/\\/g, '/')
    const content = readFileSync(path, 'utf8')
    for (const pattern of bannedPatterns) {
      if (pattern.files && !pattern.files.has(rel)) {
        continue
      }
      pattern.regex.lastIndex = 0
      if (pattern.regex.test(content)) {
        violations.push(`${rel}: ${pattern.label}`)
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
    violations.push(`${rule.file}: ${rule.message}`)
  }
}

for (const file of storageStateFiles) {
  if (existsSync(resolve(repoRoot, file))) {
    violations.push(`${file}: fixture credential storage state must not remain on disk`)
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
