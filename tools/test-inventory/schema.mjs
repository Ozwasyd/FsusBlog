#!/usr/bin/env node
/**
 * Closed, versioned schema for the canonical repository test inventory.
 *
 * This module owns only the schema and its validator. Discovery, adapters,
 * artifact production and closure verification live in sibling modules so a
 * single inventory authority serves every consumer.
 */

export const INVENTORY_SCHEMA = 'fsusblog.test-inventory.v1'

export const SOURCE_FILE_KINDS = new Set([
  'discoverable-test',
  'support',
  'fixture',
  'corpus'
])

export const CASE_IDENTITY_MODES = new Set(['static', 'dynamic'])

export const DIAGNOSTIC_SEVERITIES = new Set(['info', 'warning', 'error'])

const KNOWN_ROOT_KEYS = new Set([
  'schema',
  'adapterVersion',
  'inventoryDigest',
  'sourceState',
  'discoverySources',
  'sourceFiles',
  'testCases',
  'diagnostics'
])

const KNOWN_SOURCE_STATE_KEYS = new Set(['commit', 'worktreeFingerprint'])

const KNOWN_DISCOVERY_SOURCES_KEYS = new Set([
  'directories',
  'toolsDirectories',
  'matrixTiers',
  'coverageEntries',
  'requirementProfiles'
])

const KNOWN_SOURCE_FILE_KEYS = new Set([
  'path',
  'adapter',
  'adapterVersion',
  'kind',
  'sourceDigest',
  'declaredBy',
  'caseIdentity'
])

const KNOWN_CASE_IDENTITY_KEYS = new Set([
  'mode',
  'owner',
  'generationLocation',
  'inventoryObligation',
  'extractionStatus',
  'deferredTo'
])

const KNOWN_TEST_CASE_KEYS = new Set([
  'id',
  'displayName',
  'kind',
  'identity',
  'ownerFile',
  'ownerClass',
  'ownerSuite',
  'methodName',
  'adapter',
  'sourceSpan',
  'bodySpan',
  'bodySource',
  'traits',
  'category',
  'platform',
  'fixture',
  'skipReason',
  'explicit',
  'timeoutMs',
  'dynamicCaseInfo',
  'methodFacts'
])

const KNOWN_SOURCE_SPAN_KEYS = new Set(['start', 'end'])

const KNOWN_SOURCE_POSITION_KEYS = new Set(['line', 'column'])

const KNOWN_TRAIT_KEYS = new Set(['name', 'value'])

const KNOWN_DYNAMIC_CASE_INFO_KEYS = new Set([
  'generationLocation',
  'inventoryObligation'
])

const KNOWN_METHOD_FACTS_KEYS = new Set([
  'invocations',
  'assertionCandidates',
  'returnStatements',
  'productionSymbolReferences',
  'testAttributeReferences'
])

const KNOWN_METHOD_FACT_KEYS = new Set([
  'methodName',
  'containingType',
  'assembly',
  'assemblyKind',
  'callsTestMethod',
  'calledTestMethodId',
  'location'
])

const KNOWN_DIAGNOSTIC_KEYS = new Set([
  'severity',
  'code',
  'file',
  'message'
])

const KNOWN_DECLARATION_PREFIXES = [
  'directory',
  'matrix:command:',
  'matrix:evidence:',
  'matrix:artifact:',
  'coverage:',
  'requirement:command:',
  'requirement:evidence:'
]

function fail(message) {
  throw new Error(`invalid ${INVENTORY_SCHEMA} artifact: ${message}`)
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`)
}

function assertStringArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  for (const [index, entry] of value.entries()) {
    assertString(entry, `${label}[${index}]`)
  }
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicates`)
}

function assertClosedObject(value, knownKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) fail(`${label} contains unknown field: ${key}`)
  }
}

function assertSha256Digest(value, label) {
  assertString(value, label)
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) fail(`${label} must be a sha256 digest`)
}

function validateSourceSpan(span, label) {
  assertClosedObject(span, KNOWN_SOURCE_SPAN_KEYS, label)
  for (const side of ['start', 'end']) {
    const position = span[side]
    assertClosedObject(position, KNOWN_SOURCE_POSITION_KEYS, `${label}.${side}`)
    for (const axis of ['line', 'column']) {
      const value = position[axis]
      if (!Number.isInteger(value) || value < 0) fail(`${label}.${side}.${axis} must be a non-negative integer`)
    }
  }
  if (span.start.line > span.end.line
    || (span.start.line === span.end.line && span.start.column > span.end.column)) {
    fail(`${label} span must be ordered`)
  }
}

function validateMethodFacts(methodFacts, label) {
  assertClosedObject(methodFacts, KNOWN_METHOD_FACTS_KEYS, label)
  for (const key of ['invocations', 'assertionCandidates', 'productionSymbolReferences', 'testAttributeReferences']) {
    const entries = methodFacts[key]
    if (!Array.isArray(entries)) fail(`${label}.${key} must be an array`)
    for (const [index, entry] of entries.entries()) {
      assertClosedObject(entry, KNOWN_METHOD_FACT_KEYS, `${label}.${key}[${index}]`)
      assertString(entry.methodName, `${label}.${key}[${index}].methodName`)
      for (const field of ['containingType', 'assembly', 'assemblyKind']) {
        if (entry[field] !== undefined) assertString(entry[field], `${label}.${key}[${index}].${field}`)
      }
      if (entry.callsTestMethod !== undefined && typeof entry.callsTestMethod !== 'boolean') {
        fail(`${label}.${key}[${index}].callsTestMethod must be a boolean`)
      }
      if (entry.calledTestMethodId !== undefined) assertString(entry.calledTestMethodId, `${label}.${key}[${index}].calledTestMethodId`)
      if (entry.location !== undefined) validateSourceSpan(entry.location, `${label}.${key}[${index}].location`)
    }
  }
  const returns = methodFacts.returnStatements
  if (!Array.isArray(returns)) fail(`${label}.returnStatements must be an array`)
  for (const [index, value] of returns.entries()) assertString(value, `${label}.returnStatements[${index}]`)
}

function validateCaseIdentity(identity, label) {
  assertClosedObject(identity, KNOWN_CASE_IDENTITY_KEYS, label)
  if (!CASE_IDENTITY_MODES.has(identity.mode)) {
    fail(`${label}.mode must be one of ${[...CASE_IDENTITY_MODES].join(', ')}`)
  }
  for (const key of ['owner', 'inventoryObligation']) {
    if (identity[key] !== undefined) assertString(identity[key], `${label}.${key}`)
  }
  if (identity.generationLocation !== undefined) {
    assertString(identity.generationLocation, `${label}.generationLocation`)
  }
  if (identity.extractionStatus !== undefined) {
    assertString(identity.extractionStatus, `${label}.extractionStatus`)
  }
  if (identity.deferredTo !== undefined) {
    assertString(identity.deferredTo, `${label}.deferredTo`)
  }
  if (identity.mode === 'dynamic' && identity.generationLocation === undefined) {
    fail(`${label}.generationLocation is required for dynamic case identity`)
  }
  if (identity.mode === 'dynamic' && identity.inventoryObligation === undefined) {
    fail(`${label}.inventoryObligation is required for dynamic case identity`)
  }
}

function validateSourceFile(file, label) {
  assertClosedObject(file, KNOWN_SOURCE_FILE_KEYS, label)
  assertString(file.path, `${label}.path`)
  if (!file.path.startsWith('tests/') && !file.path.startsWith('tools/')) {
    fail(`${label}.path must be repository-relative under tests/ or tools/`)
  }
  assertString(file.adapter, `${label}.adapter`)
  assertString(file.adapterVersion, `${label}.adapterVersion`)
  if (!SOURCE_FILE_KINDS.has(file.kind)) {
    fail(`${label}.kind must be one of ${[...SOURCE_FILE_KINDS].join(', ')}`)
  }
  assertSha256Digest(file.sourceDigest, `${label}.sourceDigest`)
  assertStringArray(file.declaredBy ?? [], `${label}.declaredBy`)
  for (const declaration of file.declaredBy ?? []) {
    if (!KNOWN_DECLARATION_PREFIXES.some((prefix) => declaration === prefix || declaration.startsWith(prefix))) {
      fail(`${label}.declaredBy contains unknown declaration source: ${declaration}`)
    }
  }
  if (file.caseIdentity !== undefined) validateCaseIdentity(file.caseIdentity, `${label}.caseIdentity`)
}

function validateTestCase(testCase, label) {
  assertClosedObject(testCase, KNOWN_TEST_CASE_KEYS, label)
  assertString(testCase.id, `${label}.id`)
  assertString(testCase.displayName, `${label}.displayName`)
  if (testCase.kind !== undefined) assertString(testCase.kind, `${label}.kind`)
  if (testCase.sourceSpan !== undefined) validateSourceSpan(testCase.sourceSpan, `${label}.sourceSpan`)
  if (testCase.bodySpan !== undefined) validateSourceSpan(testCase.bodySpan, `${label}.bodySpan`)
  if (testCase.bodySource !== undefined) assertString(testCase.bodySource, `${label}.bodySource`)
  assertString(testCase.ownerFile, `${label}.ownerFile`)
  if (testCase.ownerClass !== undefined) assertString(testCase.ownerClass, `${label}.ownerClass`)
  if (testCase.ownerSuite !== undefined) assertString(testCase.ownerSuite, `${label}.ownerSuite`)
  if (testCase.methodName !== undefined) assertString(testCase.methodName, `${label}.methodName`)
  if (!CASE_IDENTITY_MODES.has(testCase.identity)) {
    fail(`${label}.identity must be one of ${[...CASE_IDENTITY_MODES].join(', ')}`)
  }
  if (testCase.adapter !== undefined) assertString(testCase.adapter, `${label}.adapter`)
  for (const key of ['category', 'platform', 'fixture', 'skipReason']) {
    if (testCase[key] !== undefined) assertString(testCase[key], `${label}.${key}`)
  }
  if (testCase.explicit !== undefined && typeof testCase.explicit !== 'boolean') {
    fail(`${label}.explicit must be a boolean`)
  }
  if (testCase.timeoutMs !== undefined && !Number.isInteger(testCase.timeoutMs)) {
    fail(`${label}.timeoutMs must be an integer`)
  }
  if (testCase.dynamicCaseInfo !== undefined) {
    assertClosedObject(testCase.dynamicCaseInfo, KNOWN_DYNAMIC_CASE_INFO_KEYS, `${label}.dynamicCaseInfo`)
    assertString(testCase.dynamicCaseInfo.generationLocation, `${label}.dynamicCaseInfo.generationLocation`)
    assertString(testCase.dynamicCaseInfo.inventoryObligation, `${label}.dynamicCaseInfo.inventoryObligation`)
  }
  if (testCase.methodFacts !== undefined) validateMethodFacts(testCase.methodFacts, `${label}.methodFacts`)
  if (testCase.identity === 'dynamic' && testCase.dynamicCaseInfo === undefined) {
    fail(`${label}.dynamicCaseInfo is required for dynamic test case identity`)
  }
  if (testCase.traits !== undefined) {
    if (!Array.isArray(testCase.traits)) fail(`${label}.traits must be an array`)
    for (const [index, trait] of testCase.traits.entries()) {
      assertClosedObject(trait, KNOWN_TRAIT_KEYS, `${label}.traits[${index}]`)
      assertString(trait.name, `${label}.traits[${index}].name`)
      assertString(trait.value, `${label}.traits[${index}].value`)
    }
  }
}

function validateDiagnostic(diagnostic, label) {
  assertClosedObject(diagnostic, KNOWN_DIAGNOSTIC_KEYS, label)
  if (!DIAGNOSTIC_SEVERITIES.has(diagnostic.severity)) {
    fail(`${label}.severity must be one of ${[...DIAGNOSTIC_SEVERITIES].join(', ')}`)
  }
  assertString(diagnostic.code, `${label}.code`)
  assertString(diagnostic.message, `${label}.message`)
  if (diagnostic.file !== undefined) assertString(diagnostic.file, `${label}.file`)
}

/**
 * Validate a complete inventory artifact. The validator is intentionally
 * closed: unknown top-level fields, unknown per-record fields, malformed
 * digests, untyped case identities and missing dynamic obligations all fail.
 */
export function validateInventoryArtifact(artifact) {
  assertClosedObject(artifact, KNOWN_ROOT_KEYS, 'artifact')
  if (artifact.schema !== INVENTORY_SCHEMA) {
    fail(`schema must be ${INVENTORY_SCHEMA}`)
  }
  assertString(artifact.adapterVersion, 'artifact.adapterVersion')
  assertSha256Digest(artifact.inventoryDigest, 'artifact.inventoryDigest')

  if (artifact.sourceState !== null && artifact.sourceState !== undefined) {
    assertClosedObject(artifact.sourceState, KNOWN_SOURCE_STATE_KEYS, 'artifact.sourceState')
    if (artifact.sourceState.commit !== undefined && artifact.sourceState.commit !== null) {
      assertString(artifact.sourceState.commit, 'artifact.sourceState.commit')
    }
    if (artifact.sourceState.worktreeFingerprint !== undefined && artifact.sourceState.worktreeFingerprint !== null) {
      assertString(artifact.sourceState.worktreeFingerprint, 'artifact.sourceState.worktreeFingerprint')
    }
  }

  assertClosedObject(artifact.discoverySources, KNOWN_DISCOVERY_SOURCES_KEYS, 'artifact.discoverySources')
  for (const key of ['directories', 'toolsDirectories', 'matrixTiers', 'coverageEntries', 'requirementProfiles']) {
    assertStringArray(artifact.discoverySources[key] ?? [], `artifact.discoverySources.${key}`)
  }

  if (!Array.isArray(artifact.sourceFiles)) fail('artifact.sourceFiles must be an array')
  const seenPaths = new Set()
  for (const [index, file] of artifact.sourceFiles.entries()) {
    validateSourceFile(file, `artifact.sourceFiles[${index}]`)
    if (seenPaths.has(file.path)) fail(`artifact.sourceFiles contains duplicate path: ${file.path}`)
    seenPaths.add(file.path)
  }

  if (!Array.isArray(artifact.testCases)) fail('artifact.testCases must be an array')
  const seenCaseIds = new Set()
  for (const [index, testCase] of artifact.testCases.entries()) {
    validateTestCase(testCase, `artifact.testCases[${index}]`)
    if (seenCaseIds.has(testCase.id)) fail(`artifact.testCases contains duplicate id: ${testCase.id}`)
    seenCaseIds.add(testCase.id)
  }
  for (const testCase of artifact.testCases) {
    if (!seenPaths.has(testCase.ownerFile)) {
      fail(`artifact.testCases ownerFile is not a declared source file: ${testCase.ownerFile}`)
    }
  }

  if (!Array.isArray(artifact.diagnostics)) fail('artifact.diagnostics must be an array')
  for (const [index, diagnostic] of artifact.diagnostics.entries()) {
    validateDiagnostic(diagnostic, `artifact.diagnostics[${index}]`)
  }

  return artifact
}
