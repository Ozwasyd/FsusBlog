#!/usr/bin/env node
/**
 * Repository-owned native/fuzz/shell/executable entry adapter.
 *
 * Owns the non xUnit/JS executable test surface of the canonical inventory:
 *   - native CTest smoke target bound to its source symbol and known vector;
 *   - native fuzz harness (LLVMFuzzerTestOneInput) with corpus/dictionary as
 *     evidence dependencies, never as independent assertion cases;
 *   - matrix/coverage-declared shell lanes and node executable check
 *     entrypoints as process-boundary records with child command, receipt and
 *     fail-closed exit-contract facts.
 * node:test cases inside JS test files remain owned by the TS AST adapter;
 * this adapter only records the wrapper/process boundary and references the
 * child files, so no test is recorded twice.
 *
 * Deterministic for identical source, matrix and membership inputs. Unknown
 * native targets, unknown CTest registrations or unowned executable surfaces
 * fail closed with precise diagnostics. Runtime CTest/fuzz listing is a
 * cross-validation obligation recorded on the cases; local absence of a
 * runtime listing does not fabricate runtime evidence.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const NATIVE_SMOKE_FILE = 'tests/native/AedsCrc16SmokeTests.cpp'
const NATIVE_FUZZ_FILE = 'tests/native/AedsCrc16Fuzz.cpp'
const NATIVE_CMAKE_FILE = 'tests/native/CMakeLists.txt'
const NATIVE_CORPUS_DIRECTORY = 'tests/native/corpus/'
const OWNED_ADAPTERS = new Set([
  'native-smoke',
  'native-fuzz',
  'native-cmake',
  'native-corpus',
  'node-script',
  'shell'
])

const CLOSED_NATIVE_TARGETS = new Set(['FsusNativeSmokeTests', 'FsusCrc16Fuzz'])
const CLOSED_CTEST_NAMES = new Set(['FsusNativeSmokeTests'])
const JS_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const MAX_BODY_SOURCE = 4000
const MAX_CHILD_COMMANDS = 40
const MAX_CHILD_FILES = 40

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 10)
}

function sha256Digest(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

function positionAt(source, offset) {
  let line = 1
  let column = 1
  const limit = Math.max(0, Math.min(offset, source.length))
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { line, column }
}

function spanOf(source, start, end) {
  return { start: positionAt(source, start), end: positionAt(source, end) }
}

function trait(name, value) {
  return { name: String(name), value: String(value) }
}

function orderedTraits(entries) {
  return [...entries]
    .sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value))
}

function matrixTierMap(matrixTiers) {
  const map = new Map()
  for (const tier of matrixTiers ?? []) {
    map.set(tier.id, tier)
  }
  return map
}

function tierIdsFromDeclaredBy(declaredBy) {
  const tiers = new Set()
  for (const declaration of declaredBy ?? []) {
    for (const prefix of ['matrix:command:', 'matrix:evidence:', 'matrix:artifact:']) {
      if (declaration.startsWith(prefix)) tiers.add(declaration.slice(prefix.length))
    }
  }
  return [...tiers].sort()
}

function declarationTraits(declaredBy) {
  const traits = []
  for (const declaration of (declaredBy ?? []).sort()) {
    for (const prefix of ['matrix:command:', 'matrix:evidence:', 'matrix:artifact:']) {
      if (declaration.startsWith(prefix)) {
        traits.push(trait(prefix === 'matrix:command:' ? 'MatrixTier' : prefix === 'matrix:evidence:' ? 'MatrixEvidenceTier' : 'MatrixArtifactTier', declaration.slice(prefix.length)))
      }
    }
    if (declaration.startsWith('coverage:')) traits.push(trait('Coverage', declaration.slice('coverage:'.length)))
    if (declaration.startsWith('requirement:command:')) traits.push(trait('RequirementCommand', declaration.slice('requirement:command:'.length)))
    if (declaration.startsWith('requirement:evidence:')) traits.push(trait('RequirementEvidence', declaration.slice('requirement:evidence:'.length)))
    if (declaration === 'directory') traits.push(trait('DeclaredBy', 'directory'))
  }
  return traits
}

function parseCmakeGraph(source) {
  const executables = new Map()
  const libraries = new Map()
  const tests = []
  const sanitizers = new Set()
  let fuzzingEnabled = false
  for (const rawLine of String(source ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const executable = line.match(/^add_executable\(\s*([A-Za-z0-9_.-]+)\s+([^)]*)\)/u)
    if (executable) {
      const target = executable[1]
      const sources = executable[2].split(/\s+/).filter(Boolean)
      executables.set(target, [...new Set([...(executables.get(target) ?? []), ...sources])])
      continue
    }
    const library = line.match(/^add_library\(\s*([A-Za-z0-9_.-]+)(?:\s+(?:STATIC|SHARED|INTERFACE))?\s+([^)]*)\)/u)
    if (library) {
      libraries.set(library[1], library[2].split(/\s+/).filter(Boolean))
      continue
    }
    const ctest = line.match(/^add_test\(\s*NAME\s+([A-Za-z0-9_.-]+)\s+COMMAND\s+([^\s)]+)/u)
    if (ctest) {
      tests.push({ name: ctest[1], command: ctest[2] })
      continue
    }
    if (/FSUSBLOG_ENABLE_FUZZING/u.test(line)) fuzzingEnabled = true
    for (const match of line.matchAll(/-fsanitize=([A-Za-z0-9_,-]+)/gu)) {
      sanitizers.add(match[1])
    }
  }
  return { executables, libraries, tests, sanitizers: [...sanitizers].sort(), fuzzingEnabled }
}

function findFunctionSpan(source, signature) {
  const index = source.indexOf(signature)
  if (index === -1) return null
  const bodyStart = source.indexOf('{', index)
  if (bodyStart === -1) return null
  let depth = 0
  let bodyEnd = -1
  for (let cursor = bodyStart; cursor < source.length; cursor += 1) {
    if (source[cursor] === '{') depth += 1
    else if (source[cursor] === '}') {
      depth -= 1
      if (depth === 0) {
        bodyEnd = cursor + 1
        break
      }
    }
  }
  if (bodyEnd === -1) return null
  return {
    sourceSpan: spanOf(source, index, bodyEnd),
    bodySpan: spanOf(source, bodyStart, bodyEnd),
    bodySource: source.slice(bodyStart, bodyEnd).trim().slice(0, MAX_BODY_SOURCE)
  }
}

function findReturnStatements(source, bodySpan) {
  const returns = []
  const body = source.slice(
    positionOffset(source, bodySpan.start),
    positionOffset(source, bodySpan.end)
  )
  for (const match of body.matchAll(/\breturn\b[^;]*;/gu)) {
    const normalized = match[0].replace(/\s+/gu, ' ').trim()
    if (normalized && !returns.includes(normalized)) returns.push(normalized.slice(0, 240))
  }
  return returns
}

function positionOffset(source, position) {
  let line = 1
  let offset = 0
  while (line < position.line && offset < source.length) {
    if (source[offset] === '\n') line += 1
    offset += 1
  }
  return Math.min(source.length, offset + Math.max(0, position.column - 1))
}

function shellCommandWords(line) {
  const words = []
  const pattern = /[^\s"'`]+|"[^"]*"|'[^']*'/gu
  for (const match of line.matchAll(pattern)) {
    words.push(match[0].replace(/^['"]|['"]$/gu, ''))
  }
  return words
}

function normalizeRepoReference(value) {
  let normalized = String(value ?? '').trim()
  normalized = normalized.replace(/^['"]|['"]$/gu, '').replace(/\\$/u, '')
  while (normalized.startsWith('../')) normalized = normalized.slice(3)
  normalized = normalized.replace(/^\.\//u, '')
  if (/^(tools|tests)\//u.test(normalized)) return normalized
  if (normalized.startsWith('.tmp/')) return normalized
  return null
}

const CHILD_EXECUTABLES = new Set([
  'node',
  'bash',
  'sh',
  'dash',
  'dotnet',
  'cmake',
  'ctest',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'bun',
  'python3',
  'python',
  'perl',
  'go',
  'cargo',
  'make',
  'ninja'
])

function scriptEntryFacts(file, source) {
  const childCommands = []
  const childFiles = new Set()
  const receipts = new Set()
  let aggregation = false
  for (const rawLine of String(source ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const words = shellCommandWords(line)
    if (words.length === 0) continue
    const firstNormalized = words[0].replace(/^\.\//u, '')
    const isExecutable = CHILD_EXECUTABLES.has(firstNormalized)
      || /^(?:tools|tests)\/.*\.(?:sh|mjs|js|cjs)$/u.test(firstNormalized)
    for (const ref of words.map(normalizeRepoReference).filter(Boolean)) {
      if (ref.startsWith('.tmp/')) {
        receipts.add(ref)
        aggregation = true
      } else if (JS_TEST_FILE.test(ref) || ref.endsWith('.sh') || /^tools\/.*\.(?:mjs|js|cjs)$/u.test(ref)) {
        childFiles.add(ref)
        aggregation = true
      }
    }
    if (isExecutable && childCommands.length < MAX_CHILD_COMMANDS) {
      const invocation = words.slice(0, 8).join(' ')
      if (!childCommands.includes(invocation)) childCommands.push(invocation)
    }
  }
  return {
    childCommands: childCommands.slice(0, MAX_CHILD_COMMANDS),
    childFiles: [...childFiles].sort().slice(0, MAX_CHILD_FILES),
    receipts: [...receipts].sort().slice(0, MAX_CHILD_FILES),
    aggregation
  }
}

function processBoundaryCase({ file, adapter, declaredBy, source, matrixTiers, tierById, digest }) {
  const tierIds = tierIdsFromDeclaredBy(declaredBy)
  const facts = scriptEntryFacts(file, source)
  const traits = [
    ...declarationTraits(declaredBy),
    trait('Framework', adapter === 'shell' ? 'shell' : 'node-script'),
    trait('SourceDigest', digest),
    trait('FailClosedContract', facts.aggregation ? 'aggregation-with-evidence' : 'exit-code-only')
  ]
  if (facts.aggregation) traits.push(trait('Aggregation', 'true'))
  if (facts.childCommands.length > 0) {
    for (const command of facts.childCommands) traits.push(trait('ChildCommand', command))
  }
  if (facts.childFiles.length > 0) {
    for (const childFile of facts.childFiles) traits.push(trait('ChildTestFile', childFile))
  }
  if (facts.receipts.length > 0) {
    for (const receipt of facts.receipts) traits.push(trait('Receipt', receipt))
  }
  for (const tierId of tierIds) {
    const tier = tierById.get(tierId)
    if (tier?.command) traits.push(trait('MatrixCommand', `${tierId}::${String(tier.command).replace(/\s+/gu, ' ').trim()}`))
  }
  const sourceEnd = spanOf(source, 0, source.length).end
  return {
    id: `${adapter === 'shell' ? 'shell' : 'node-script'}:${file}`,
    displayName: path.basename(file),
    kind: adapter === 'shell' ? 'shell' : 'node-script',
    identity: 'dynamic',
    ownerFile: file,
    adapter: 'native-entry',
    sourceSpan: spanOf(source, 0, source.length),
    bodySpan: { start: { line: 1, column: 1 }, end: sourceEnd },
    traits: orderedTraits(traits),
    platform: adapter === 'shell' ? 'shell' : 'node',
    dynamicCaseInfo: {
      generationLocation: adapter === 'shell'
        ? 'matrix-declared-entrypoint'
        : 'matrix-or-coverage-declared-entrypoint',
      inventoryObligation: `runtime inventory must record every executed child test case id or receipt for ${file} after each run`
    }
  }
}

function nativeSmokeCase({ source, cmake, declaredBy, tierById, digest, diagnostics }) {
  const functionInfo = findFunctionSpan(source, 'int main()')
  if (!functionInfo) {
    diagnostics.push({
      severity: 'error',
      code: 'native-entry-smoke-symbol-missing',
      file: NATIVE_SMOKE_FILE,
      message: `native smoke source must declare int main() at ${NATIVE_SMOKE_FILE}`
    })
    return null
  }
  const ctest = (cmake.tests ?? []).find((entry) => entry.name === 'FsusNativeSmokeTests')
  const executableSources = cmake.executables.get('FsusNativeSmokeTests') ?? []
  if (!ctest) {
    diagnostics.push({
      severity: 'error',
      code: 'native-entry-ctest-registration-missing',
      file: NATIVE_CMAKE_FILE,
      message: 'native smoke source has no CTest registration for FsusNativeSmokeTests in tests/native/CMakeLists.txt'
    })
    return null
  }
  if (ctest.command !== 'FsusNativeSmokeTests') {
    diagnostics.push({
      severity: 'error',
      code: 'native-entry-ctest-target-mismatch',
      file: NATIVE_CMAKE_FILE,
      message: `CTest FsusNativeSmokeTests must invoke target FsusNativeSmokeTests, got ${ctest.command}`
    })
    return null
  }
  if (!executableSources.includes('AedsCrc16SmokeTests.cpp')) {
    diagnostics.push({
      severity: 'error',
      code: 'native-entry-smoke-source-mismatch',
      file: NATIVE_CMAKE_FILE,
      message: `CMake target FsusNativeSmokeTests must compile AedsCrc16SmokeTests.cpp, got ${executableSources.join(', ') || '<none>'}`
    })
    return null
  }
  const returns = findReturnStatements(source, functionInfo.bodySpan)
  const traits = [
    ...declarationTraits(declaredBy),
    trait('Framework', 'CTest'),
    trait('CMakeTarget', 'FsusNativeSmokeTests'),
    trait('CTestName', 'FsusNativeSmokeTests'),
    trait('KnownVector', '0x4B37'),
    trait('Platform', 'native'),
    trait('RuntimeReceipt', '.tmp/release-evidence/native-smoke.json'),
    trait('RuntimeObligation', 'runtime CTest listing must cross-check the static native-smoke target inventory after native-smoke execution'),
    trait('SourceDigest', digest)
  ]
  for (const tierId of tierIdsFromDeclaredBy(declaredBy)) {
    const tier = tierById.get(tierId)
    if (tier?.command) traits.push(trait('MatrixCommand', `${tierId}::${String(tier.command).replace(/\s+/gu, ' ').trim()}`))
  }
  return {
    id: 'native-smoke:aeds-crc16-known-vector',
    displayName: 'AEDS CRC16 known vector smoke',
    kind: 'native-smoke',
    identity: 'static',
    ownerFile: NATIVE_SMOKE_FILE,
    ownerClass: 'FsusNativeSmokeTests',
    methodName: 'main',
    adapter: 'native-entry',
    sourceSpan: functionInfo.sourceSpan,
    bodySpan: functionInfo.bodySpan,
    bodySource: functionInfo.bodySource,
    traits: orderedTraits(traits),
    platform: 'native',
    methodFacts: {
      invocations: [{
        methodName: 'ComputeCrc16',
        containingType: 'FsusBlog::Aeds',
        assembly: 'FsusAedsCrc16',
        assemblyKind: 'production',
        location: functionInfo.bodySpan
      }],
      assertionCandidates: [],
      returnStatements: returns,
      productionSymbolReferences: [{
        methodName: 'ComputeCrc16',
        containingType: 'FsusBlog::Aeds',
        assembly: 'FsusAedsCrc16',
        assemblyKind: 'production'
      }],
      testAttributeReferences: []
    }
  }
}

function nativeFuzzCase({ source, cmake, declaredBy, tierById, digest, diagnostics }) {
  const functionInfo = findFunctionSpan(source, 'LLVMFuzzerTestOneInput')
  if (!functionInfo) {
    diagnostics.push({
      severity: 'error',
      code: 'native-entry-fuzz-symbol-missing',
      file: NATIVE_FUZZ_FILE,
      message: `native fuzz source must declare LLVMFuzzerTestOneInput at ${NATIVE_FUZZ_FILE}`
    })
    return null
  }
  const executableSources = cmake.executables.get('FsusCrc16Fuzz') ?? []
  if (!executableSources.includes('AedsCrc16Fuzz.cpp')) {
    diagnostics.push({
      severity: 'error',
      code: 'native-entry-fuzz-source-mismatch',
      file: NATIVE_CMAKE_FILE,
      message: `CMake target FsusCrc16Fuzz must compile AedsCrc16Fuzz.cpp, got ${executableSources.join(', ') || '<none>'}`
    })
    return null
  }
  const returns = findReturnStatements(source, functionInfo.bodySpan)
  const traits = [
    ...declarationTraits(declaredBy),
    trait('Framework', 'libFuzzer'),
    trait('CMakeTarget', 'FsusCrc16Fuzz'),
    trait('FuzzEntry', 'LLVMFuzzerTestOneInput'),
    trait('Sanitizers', cmake.sanitizers.join(',') || 'address,undefined'),
    trait('FuzzingConditional', cmake.fuzzingEnabled ? 'FSUSBLOG_ENABLE_FUZZING' : 'unconditional'),
    trait('RuntimeBudget', '-runs=1000 -jobs=1'),
    trait('Corpus', 'tests/native/corpus/aeds-crc16'),
    trait('RuntimeReceipt', '.tmp/release-evidence/native-fuzz-sanitizer.json'),
    trait('CrashArtifacts', '.tmp/native-tests/fuzz-sanitizer/crashes'),
    trait('RuntimeObligation', 'runtime fuzz listing and crash artifacts must cross-check the static native-fuzz harness inventory after native-fuzz-sanitizer execution'),
    trait('SourceDigest', digest)
  ]
  for (const tierId of tierIdsFromDeclaredBy(declaredBy)) {
    const tier = tierById.get(tierId)
    if (tier?.command) traits.push(trait('MatrixCommand', `${tierId}::${String(tier.command).replace(/\s+/gu, ' ').trim()}`))
  }
  return {
    id: 'native-fuzz:aeds-crc16-input-space',
    displayName: 'AEDS CRC16 input space fuzz',
    kind: 'native-fuzz',
    identity: 'static',
    ownerFile: NATIVE_FUZZ_FILE,
    ownerClass: 'FsusCrc16Fuzz',
    methodName: 'LLVMFuzzerTestOneInput',
    adapter: 'native-entry',
    sourceSpan: functionInfo.sourceSpan,
    bodySpan: functionInfo.bodySpan,
    bodySource: functionInfo.bodySource,
    traits: orderedTraits(traits),
    platform: 'native',
    fixture: 'tests/native/corpus/aeds-crc16',
    methodFacts: {
      invocations: [{
        methodName: 'ComputeCrc16',
        containingType: 'FsusBlog::Aeds',
        assembly: 'FsusAedsCrc16Fuzz',
        assemblyKind: 'production',
        location: functionInfo.bodySpan
      }],
      assertionCandidates: [],
      returnStatements: returns,
      productionSymbolReferences: [{
        methodName: 'ComputeCrc16',
        containingType: 'FsusBlog::Aeds',
        assembly: 'FsusAedsCrc16Fuzz',
        assemblyKind: 'production'
      }],
      testAttributeReferences: []
    }
  }
}

function validateCmakeGraph(cmake, diagnostics, hasSmoke, hasFuzz) {
  for (const [target] of cmake.executables) {
    if (!CLOSED_NATIVE_TARGETS.has(target)) {
      diagnostics.push({
        severity: 'error',
        code: 'native-entry-unknown-target',
        file: NATIVE_CMAKE_FILE,
        message: `unknown native executable target without adapter owner: ${target}`
      })
    }
  }
  for (const entry of cmake.tests) {
    if (!CLOSED_CTEST_NAMES.has(entry.name)) {
      diagnostics.push({
        severity: 'error',
        code: 'native-entry-unknown-ctest',
        file: NATIVE_CMAKE_FILE,
        message: `unknown CTest registration without adapter owner: ${entry.name}`
      })
    }
  }
  if (hasSmoke && !cmake.executables.has('FsusNativeSmokeTests')) {
    diagnostics.push({
      severity: 'error',
      code: 'native-entry-smoke-target-missing',
      file: NATIVE_CMAKE_FILE,
      message: 'native smoke source is inventoried but CMake target FsusNativeSmokeTests is not registered'
    })
  }
  if (hasFuzz && !cmake.executables.has('FsusCrc16Fuzz')) {
    diagnostics.push({
      severity: 'error',
      code: 'native-entry-fuzz-target-missing',
      file: NATIVE_CMAKE_FILE,
      message: 'native fuzz source is inventoried but CMake target FsusCrc16Fuzz is not registered'
    })
  }
}

function extractFile(entry, root, context) {
  const file = entry.path
  const adapter = entry.adapter
  const absolute = path.join(root, file)
  if (!existsSync(absolute)) {
    return {
      testCases: [],
      diagnostics: [{
        severity: 'error',
        code: 'native-entry-file-missing',
        file,
        message: `requested adapter input file does not exist: ${file}`
      }]
    }
  }
  if (!OWNED_ADAPTERS.has(adapter)) {
    return {
      testCases: [],
      diagnostics: [{
        severity: 'error',
        code: 'native-entry-unowned-adapter',
        file,
        message: `native entry adapter does not own adapter ${adapter} for ${file}`
      }]
    }
  }
  const source = readFileSync(absolute, 'utf8')
  const digest = sha256Digest(source)
  const declaredBy = Array.isArray(entry.declaredBy) ? entry.declaredBy : []
  const diagnostics = []
  let testCases = []

  if (adapter === 'native-smoke' || adapter === 'native-fuzz') {
    if (!context.cmakeLoaded) {
      context.cmake = { executables: new Map(), libraries: new Map(), tests: [], sanitizers: [], fuzzingEnabled: false }
      diagnostics.push({
        severity: 'warning',
        code: 'native-entry-cmake-missing',
        file: NATIVE_CMAKE_FILE,
        message: `native target graph ${NATIVE_CMAKE_FILE} is absent; static/runtime target cross-check cannot be completed`
      })
    }
    const caseResult = adapter === 'native-smoke'
      ? nativeSmokeCase({ source, cmake: context.cmake, declaredBy, tierById: context.tierById, digest, diagnostics })
      : nativeFuzzCase({ source, cmake: context.cmake, declaredBy, tierById: context.tierById, digest, diagnostics })
    if (caseResult) testCases.push(caseResult)
  } else if (adapter === 'native-cmake') {
    context.cmake = parseCmakeGraph(source)
    context.cmakeLoaded = true
    validateCmakeGraph(context.cmake, diagnostics, context.hasSmoke, context.hasFuzz)
  } else if (adapter === 'native-corpus') {
    // Corpus inputs are evidence dependencies for the fuzz harness; they never
    // become independent assertion cases and produce no case records.
    return { testCases: [], diagnostics: [] }
  } else if (adapter === 'shell' || adapter === 'node-script') {
    testCases.push(processBoundaryCase({ file, adapter, declaredBy, source, matrixTiers: context.matrixTiers, tierById: context.tierById, digest }))
  }

  return { testCases, diagnostics }
}

function readRequest() {
  const requestPath = process.argv[2]
  if (requestPath) return JSON.parse(readFileSync(requestPath, 'utf8'))
  const chunks = []
  for (const chunk of process.stdin) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function main() {
  const request = readRequest()
  const root = request.root
  const files = Array.isArray(request.files) ? request.files : []
  const context = {
    matrixTiers: Array.isArray(request.matrixTiers) ? request.matrixTiers : [],
    tierById: matrixTierMap(request.matrixTiers),
    cmake: null,
    cmakeLoaded: false,
    hasSmoke: files.some((entry) => entry.path === NATIVE_SMOKE_FILE && entry.adapter === 'native-smoke'),
    hasFuzz: files.some((entry) => entry.path === NATIVE_FUZZ_FILE && entry.adapter === 'native-fuzz')
  }
  // The CMake target graph must be available before per-file extraction so
  // native smoke/fuzz sources are never misread as an absent graph just
  // because CMakeLists.txt sorts after them.
  const cmakePath = path.join(root, NATIVE_CMAKE_FILE)
  if (existsSync(cmakePath)) {
    context.cmake = parseCmakeGraph(readFileSync(cmakePath, 'utf8'))
    context.cmakeLoaded = true
  }
  const testCases = []
  const diagnostics = []
  for (const entry of files) {
    const result = extractFile(entry, root, context)
    testCases.push(...result.testCases)
    diagnostics.push(...result.diagnostics)
  }
  testCases.sort((left, right) => left.id.localeCompare(right.id))
  diagnostics.sort((left, right) => (
    left.severity.localeCompare(right.severity)
    || left.code.localeCompare(right.code)
    || String(left.file ?? '').localeCompare(String(right.file ?? ''))
  ))
  process.stdout.write(`${JSON.stringify({ testCases, diagnostics })}\n`)
}

main()
