import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const clientRoot = resolve(new URL('..', import.meta.url).pathname)
const repoRoot = resolve(clientRoot, '..')

const tsEnumPath = resolve(clientRoot, 'src/utils/appError.ts')
const csharpEnumPath = resolve(repoRoot, 'FsusBlog.Core/Common/ErrorCode.cs')
const resultBoundaryPath = resolve(clientRoot, 'scripts/check-result-boundaries.mjs')

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
    file: resolve(clientRoot, 'src/services/sseRuntime.ts'),
    patterns: [
      /message\s*===\s*['"]protocol_mismatch['"]/
    ]
  }
]

function parseEnumMembers(source) {
  return [...source.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=/gm)].map((match) => match[1])
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

  if (JSON.stringify(allowEntries) !== JSON.stringify(expectedAllowEntries)) {
    violations.push(`unexpected result-boundary allowList: ${allowEntries.join(', ')}`)
  }
}

if (violations.length > 0) {
  console.error('error-code alignment violations:')
  for (const violation of violations) {
    console.error(` - ${violation}`)
  }
  process.exit(1)
}

console.log('ok: error-code alignment and final exception allowlist are consistent')
