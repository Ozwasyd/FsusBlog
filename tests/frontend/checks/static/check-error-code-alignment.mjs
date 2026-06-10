import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const clientRoot = process.cwd()
const repoRoot = resolve(clientRoot, '..', '..')

const tsEnumPath = resolve(clientRoot, 'src/utils/appError.ts')
const csharpEnumPath = resolve(repoRoot, 'src/core/Common/ErrorCode.cs')
const resultBoundaryPath = resolve(repoRoot, 'tests/frontend/checks/static/check-result-boundaries.mjs')

const alignment = {
  Validation: { ts: 'Validation', csharp: 'Validation' },
  Unauthorized: { ts: 'Unauthorized', csharp: 'Unauthorized' },
  Forbidden: { ts: 'Forbidden', csharp: 'Forbidden' },
  NotFound: { ts: 'NotFound', csharp: 'NotFound' },
  Conflict: { ts: 'Conflict', csharp: 'Conflict' },
  InfraFailure: { ts: 'InfraFailure', csharp: 'InfraFailure' },
  ProtocolFailure: { ts: 'ProtocolFailure', csharp: null },
  InvariantViolation: { ts: 'InvariantViolation', csharp: null }
}

const bannedPatterns = [
  {
    file: resolve(clientRoot, 'src/store/user.ts'),
    patterns: [
      /message\s*===\s*['"]Unauthorized['"]/,
      /message\??\.includes\(\s*['"]Unauthorized['"]\s*\)/,
      /message\??\.includes\(\s*['"]401['"]\s*\)/
    ]
  },
  {
    file: resolve(clientRoot, 'src/services/authSessionRuntime.ts'),
    patterns: [
      /message\s*===\s*['"]Unauthorized['"]/,
      /message\??\.includes\(\s*['"]Unauthorized['"]\s*\)/,
      /message\??\.includes\(\s*['"]401['"]\s*\)/
    ]
  },
  {
    file: resolve(clientRoot, 'src/services/notificationStreamRuntime.ts'),
    patterns: [
      /message\s*===\s*['"]protocol_mismatch['"]/
    ]
  },
  {
    file: resolve(clientRoot, 'src/services/binaryTransport.ts'),
    patterns: [
      /message\??\.includes\(\s*['"]disabled['"]\s*\)/,
      /message\??\.includes\(\s*['"]decode['"]\s*\)/,
      /message\??\.includes\(\s*['"]frame['"]\s*\)/,
      /message\??\.includes\(\s*['"]schema['"]\s*\)/
    ]
  },
  {
    file: resolve(clientRoot, 'src/composables/useAuthLogin.ts'),
    patterns: [
      /normalized\.message\.includes\(\s*['"]POW_CALCULATION_TIMEOUT['"]\s*\)/
    ]
  },
  {
    file: resolve(clientRoot, 'src/composables/useAuthRegister.ts'),
    patterns: [
      /msg\.includes\(\s*['"]POW_CALCULATION_TIMEOUT['"]\s*\)/,
      /msg\.includes\(\s*['"]Network Error['"]\s*\)/,
      /msg\.includes\(\s*['"]timeout['"]\s*\)/,
      /msg\.includes\(\s*['"]已存在['"]\s*\)/,
      /msg\.includes\(\s*['"]占用['"]\s*\)/
    ]
  }
]

function parseEnumMembers(source) {
  const enumMembers = [...source.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=/gm)].map((match) => match[1])
  const constObjectMembers = [...source.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*['"][^'"]+['"],?/gm)].map((match) => match[1])
  return [...new Set([...enumMembers, ...constObjectMembers])]
}

const tsEnumSource = await readFile(tsEnumPath, 'utf8')
const csharpEnumSource = await readFile(csharpEnumPath, 'utf8')
const tsEnumMembers = new Set(parseEnumMembers(tsEnumSource))
const csharpEnumMembers = new Set(parseEnumMembers(csharpEnumSource))

const violations = []

for (const [semantic, mapping] of Object.entries(alignment)) {
  if (!tsEnumMembers.has(mapping.ts)) {
    violations.push(`missing TS AppErrorCode mapping for ${semantic}`)
  }

  if (mapping.csharp && !csharpEnumMembers.has(mapping.csharp)) {
    violations.push(`missing C# ErrorCode mapping for ${semantic}`)
  }
}

for (const target of bannedPatterns) {
  const source = await readFile(target.file, 'utf8')
  for (const pattern of target.patterns) {
    if (pattern.test(source)) {
      violations.push(`string-based error branching remains in ${target.file.replace(`${clientRoot}/`, '')}: ${pattern}`)
    }
  }
}

const resultBoundarySource = await readFile(resultBoundaryPath, 'utf8')
const allowListMatch = resultBoundarySource.match(/const allowList = new Set\(\[(?<body>[\s\S]*?)\]\)/)
if (!allowListMatch?.groups?.body) {
  violations.push('unable to parse final allowList from check-result-boundaries.mjs')
} else {
  const allowEntries = [...allowListMatch.groups.body.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()
  const expectedAllowEntries = [
    'src/bootstrap/fullApp.ts',
    'src/public-renderers/hydrationIdentityGuard.ts'
  ].sort()

  if (allowEntries.join('\0') !== expectedAllowEntries.join('\0')) {
    violations.push(`unexpected result-boundary allowList: ${allowEntries.join(', ')}`)
  }
}

try {
  await readFile(resolve(clientRoot, 'src/services/notificationService.ts'), 'utf8')
  violations.push('legacy runtime alias src/services/notificationService.ts must be removed')
} catch {
  // expected: compat alias removed in stage 5
}

if (violations.length > 0) {
  console.error('error-code alignment violations:')
  for (const violation of violations) {
    console.error(` - ${violation}`)
  }
  process.exit(1)
}

console.log('ok: error-code alignment and final exception allowlist are consistent')
