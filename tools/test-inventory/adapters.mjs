/**
 * Canonical adapter registry for the repository test inventory.
 *
 * Adapters declare file-level membership only. Concrete case extraction for
 * C#, JS/TS, native and shell surfaces is intentionally deferred to the
 * dedicated adapter issues (#2617/#2618/#2619); this module records the
 * capability, case identity mode and runtime inventory obligation for every
 * member so no surface is silently dropped or forged into a static case.
 */

export const ADAPTER_VERSION = 'fsusblog.test-inventory.adapters.v1'

const posix = (value) => String(value ?? '').replaceAll('\\', '/')

const JS_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u
const FIXTURE_DIRECTORY = /^tests\/.*(?:\/|^)(?:fixtures?|Fixtures)(?:\/|$)/u
const NATIVE_CORPUS = /^tests\/native\/corpus\//u
const CHECKS_MJS = /^tests\/frontend\/checks\/.*\.mjs$/u
const BACKEND_CS_TESTS = /^tests\/backend\/.*(?:Tests|Test)\.cs$/u
const BACKEND_CS_SUPPORT = /^tests\/backend\/.*(?:Fixture|Collection)\.cs$/u
const NATIVE_SMOKE = 'tests/native/AedsCrc16SmokeTests.cpp'
const NATIVE_FUZZ = 'tests/native/AedsCrc16Fuzz.cpp'
const NATIVE_CMAKE = 'tests/native/CMakeLists.txt'
const E2E_SPEC = (file) => JS_TEST_FILE.test(file) && /\/e2e\//u.test(file) && /\.spec\./u.test(file)

const hasNodeTestImport = (source) => (
  /(?:from\s*['"]node:test['"]|require\s*\(\s*['"]node:test['"]\s*\))/u.test(source ?? '')
)

const deferredStaticCase = (adapterOwner, deferredTo) => ({
  mode: 'static',
  owner: adapterOwner,
  extractionStatus: 'deferred',
  deferredTo,
  inventoryObligation: `case records for this file are produced by the ${adapterOwner} adapter before per-case membership is counted`
})

const readyStaticCase = (adapterOwner) => ({
  mode: 'static',
  owner: adapterOwner,
  extractionStatus: 'ready',
  inventoryObligation: `case records for this file are produced by the ${adapterOwner} adapter and merged into the canonical inventory`
})

const dynamicCase = (adapterOwner, generationLocation) => ({
  mode: 'dynamic',
  owner: adapterOwner,
  generationLocation,
  inventoryObligation: `runtime inventory must record every executed case id after ${generationLocation} execution`
})

const notApplicableCase = (adapterOwner, obligation) => ({
  mode: 'static',
  owner: adapterOwner,
  extractionStatus: 'not-applicable',
  inventoryObligation: obligation
})

export const SUPPORT_CLASSIFICATION = {
  adapter: 'support',
  adapterVersion: 'support.v1',
  kind: 'support',
  caseIdentity: notApplicableCase(
    'support-adapter',
    'support files are never counted as discoverable test cases'
  )
}

/**
 * Ordered registry. Every file must be claimed by exactly one adapter; two
 * adapters claiming the same path is a duplicate-owner failure. Predicates
 * are mutually exclusive by construction; the catch-all support adapter
 * explicitly excludes every domain claimed by more specific adapters.
 */
export const ADAPTERS = [
  {
    id: 'xunit',
    version: 'xunit.v2',
    kind: 'discoverable-test',
    caseIdentity: () => readyStaticCase('xunit-adapter'),
    matches: (file) => BACKEND_CS_TESTS.test(file)
  },
  {
    id: 'xunit-support',
    version: 'xunit-support.v1',
    kind: 'fixture',
    caseIdentity: () => notApplicableCase(
      'xunit-support-adapter',
      'fixture and collection support files never count as discoverable test cases'
    ),
    matches: (file) => BACKEND_CS_SUPPORT.test(file)
  },
  {
    id: 'native-smoke',
    version: 'native-smoke.v1',
    kind: 'discoverable-test',
    caseIdentity: () => deferredStaticCase('native-smoke-adapter', '#2619'),
    matches: (file) => file === NATIVE_SMOKE
  },
  {
    id: 'native-fuzz',
    version: 'native-fuzz.v1',
    kind: 'discoverable-test',
    caseIdentity: () => deferredStaticCase('native-fuzz-adapter', '#2619'),
    matches: (file) => file === NATIVE_FUZZ
  },
  {
    id: 'native-cmake',
    version: 'native-cmake.v1',
    kind: 'support',
    caseIdentity: () => notApplicableCase(
      'native-cmake-adapter',
      'native target graph is a support surface, not a discoverable test case'
    ),
    matches: (file) => file === NATIVE_CMAKE
  },
  {
    id: 'native-corpus',
    version: 'native-corpus.v1',
    kind: 'corpus',
    caseIdentity: () => notApplicableCase(
      'native-corpus-adapter',
      'corpus inputs are never counted as discoverable test cases'
    ),
    matches: (file) => NATIVE_CORPUS.test(file)
  },
  {
    id: 'playwright',
    version: 'playwright.v1',
    kind: 'discoverable-test',
    caseIdentity: () => deferredStaticCase('playwright-adapter', '#2618'),
    matches: (file) => E2E_SPEC(file)
  },
  {
    id: 'node-test',
    version: 'node-test.v1',
    kind: 'discoverable-test',
    caseIdentity: () => deferredStaticCase('node-test-adapter', '#2618'),
    matches: (file, source) => JS_TEST_FILE.test(file) && !E2E_SPEC(file) && hasNodeTestImport(source)
  },
  {
    id: 'vitest',
    version: 'vitest.v1',
    kind: 'discoverable-test',
    caseIdentity: () => deferredStaticCase('vitest-adapter', '#2618'),
    matches: (file, source) => JS_TEST_FILE.test(file) && !E2E_SPEC(file) && !hasNodeTestImport(source)
  },
  {
    id: 'node-script',
    version: 'node-script.v1',
    kind: 'discoverable-test',
    caseIdentity: () => dynamicCase('node-script-adapter', 'matrix-or-coverage-declared-entrypoint'),
    matches: (file) => (
      !JS_TEST_FILE.test(file)
      && (
        /^tools\/.*\.(?:mjs|js|cjs|mts|ts)$/u.test(file)
        || CHECKS_MJS.test(file)
      )
    )
  },
  {
    id: 'shell',
    version: 'shell.v1',
    kind: 'discoverable-test',
    caseIdentity: () => dynamicCase('shell-adapter', 'matrix-declared-entrypoint'),
    matches: (file) => (
      !JS_TEST_FILE.test(file)
      && /^tools\/.*\.sh$/u.test(file)
    )
  },
  {
    id: 'fixture',
    version: 'fixture.v1',
    kind: 'fixture',
    caseIdentity: () => notApplicableCase(
      'fixture-adapter',
      'fixture inputs are never counted as discoverable test cases'
    ),
    matches: (file) => (
      !JS_TEST_FILE.test(file)
      && !/\.cs$/u.test(file)
      && FIXTURE_DIRECTORY.test(file)
    )
  },
  {
    id: 'support',
    version: 'support.v1',
    kind: 'support',
    caseIdentity: () => notApplicableCase(
      'support-adapter',
      'support files are never counted as discoverable test cases'
    ),
    matches: (file) => (
      /^tests\//u.test(file)
      && !JS_TEST_FILE.test(file)
      && !FIXTURE_DIRECTORY.test(file)
      && !NATIVE_CORPUS.test(file)
      && !CHECKS_MJS.test(file)
      && !BACKEND_CS_TESTS.test(file)
      && !BACKEND_CS_SUPPORT.test(file)
      && ![NATIVE_SMOKE, NATIVE_FUZZ, NATIVE_CMAKE].includes(file)
    )
  }
]

/**
 * Classify a repository-relative path into exactly one adapter membership.
 * Duplicate ownership (two adapters claiming the same file) is a hard error.
 */
export function classifyFile(file, source = '') {
  const normalized = posix(file)
  if (!normalized.startsWith('tests/') && !normalized.startsWith('tools/')) return null
  const matches = ADAPTERS.filter((adapter) => adapter.matches(normalized, source))
  if (matches.length === 0) return SUPPORT_CLASSIFICATION
  if (matches.length > 1) {
    const ids = matches.map((adapter) => adapter.id).sort().join(', ')
    throw new Error(`test inventory duplicate adapter ownership for ${normalized}: ${ids}`)
  }
  const adapter = matches[0]
  return {
    adapter: adapter.id,
    adapterVersion: adapter.version,
    kind: adapter.kind,
    caseIdentity: adapter.caseIdentity()
  }
}

/** File-level membership predicate used by consumers that only need a boolean. */
export function isInventoryPath(file, source = '') {
  return classifyFile(file, source) !== null
}

export function adapterById(id) {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null
}
