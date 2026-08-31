#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import Module, { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { digestCatalog } from '../contracts/behavior-contract-catalog.mjs'
import {
    resolveGitRepositoryAuthority,
    runGitRepository,
    sealSourceIdentity
} from '../fact-extractors/identity.mjs'
import { parseMatrix } from '../test-matrix/parse-matrix.mjs'
import { assertPreRuntimeQualified } from '../test-matrix/behavior-evidence-pre-runtime.mjs'
import { validatePostRuntimeReceipt } from '../test-matrix/behavior-evidence-post-runtime.mjs'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const finalReportSchema = 'fsusblog.behavior-document-consistency-final-report.v1'

export const zeroLegacyScanSchema = 'fsusblog.zero-legacy-governance-scan.v1'

const scanRoots = Object.freeze([
    Object.freeze({ path: 'config', pathClass: 'config' }),
    Object.freeze({ path: 'docs', pathClass: 'docs' }),
    Object.freeze({ path: 'src', pathClass: 'production' }),
    Object.freeze({ path: 'tests', pathClass: 'tests' }),
    Object.freeze({ path: 'tools', pathClass: 'tools' })
])

export const zeroLegacyRequiredPathClasses = Object.freeze([
    'config',
    'docs',
    'production',
    'tests',
    'tools',
    'package-scripts',
    'generated-projection',
    'output-schema'
])

const forbiddenMachineFieldParts = Object.freeze([
    ['last', 'verified', 'commit'],
    ['maximum', 'verification', 'distance'],
    ['last', 'reviewed', 'commit'],
    ['last', 'reviewed', 'at'],
    ['verified', 'at'],
    ['content', 'baseline', 'sha'],
    ['approved', 'content', 'digest'],
    ['expected', 'value'],
    ['baseline', 'value'],
    ['ignore', 'difference'],
    ['allow', 'stale', 'until'],
    ['waiver']
])
const booleanSelfCertificationParts = Object.freeze([['verified'], ['reviewed']])
function evidenceSelectionRuleParts()
{
    return Object.freeze([
        ['latest', 'evidence'], ['latest', 'receipt'], ['latest', 'result'], ['latest', 'report'],
        ['newest', 'evidence'], ['newest', 'receipt'], ['evidence', 'history'], ['receipt', 'history'],
        ['historical', 'evidence'], ['history', 'fallback'], ['evidence', 'fallback'], ['receipt', 'fallback'],
        ['fallback', 'evidence'], ['fallback', 'receipt'], ['last', 'green'], ['last', 'passing'],
        ['evidence', 'mtime'], ['receipt', 'mtime'], ['evidence', 'ctime'], ['receipt', 'ctime'],
        ['evidence', 'age'], ['receipt', 'age'], ['evidence', 'glob'], ['receipt', 'glob'],
        ['evidence', 'search'], ['receipt', 'search'], ['evidence', 'scan'], ['receipt', 'scan'],
        ['retry', 'until', 'pass'], ['retry', 'as', 'correctness']
    ])
}

function authorityResidueRuleParts()
{
    return Object.freeze([
        ['self', 'certified'], ['self', 'certification'], ['self', 'certified', 'fact'],
        ['manual', 'approved'], ['manually', 'approved'], ['checked', 'in', 'authority'],
        ['checked', 'in', 'fact'], ['checked', 'in', 'expected'], ['checked', 'in', 'openapi'],
        ['openapi', 'regex', 'fallback'], ['git', 'diff'], ['git', 'diff', 'synchronization'],
        ['source', 'test', 'doc', 'diff'], ['source', 'tests', 'docs', 'changed'],
        ['test', 'file', 'exists', 'coverage'], ['file', 'presence', 'coverage'],
        ['source', 'patterns'], ['test', 'owners'], ['behavior', 'doc', 'parallel'],
        ['runtime', 'pre', 'runtime', 'parallel'],
        ['validation', 'sha'], ['expected', 'sha'], ['review', 'sha'], ['approved', 'sha'], ['baseline', 'sha'],
        ['llm', 'qualification'], ['embedding', 'qualification'], ['human', 'review', 'qualification'],
        ['release', 'final', 'discovery'], ['release', 'final', 'rerun'], ['release', 'final', 'repair']
    ])
}
const legacyRoleParts = Object.freeze([
    ['claim'], ['extractor'], ['renderer'], ['joiner'], ['cli'], ['schema'], ['feature', 'flag']
])
const legacyStateParts = Object.freeze([['legacy'], ['compat'], ['compatibility'], ['deprecated']])
const ignoredDirectoryNames = new Set([
    '.cache', '.git', '.tmp', 'bin', 'build', 'coverage', 'dist', 'node_modules', 'obj', 'out',
    'playwright-report', 'publish', 'temp', 'test-results', 'testresults', 'tmp'
])
const machineSourceExtensions = /\.(?:c|cc|cpp|cs|cxx|h|hpp|js|jsx|mjs|ps1|sh|ts|tsx|vue|ya?ml)$/u
const qualificationPathPattern = /(?:artifact|behavior|doc[-_.]?claim|evidence|fact[-_.]?extract|generated[-_.]?fact|governance|mutation|qualification|receipt|release[-_.]?final)/iu
const machineFencePattern = /^```(bash|csharp|cs|javascript|js|json|jsonc|powershell|ps1|sh|shell|toml|typescript|ts|yaml|yml)\s*\n([\s\S]*?)^```\s*$/gimu
const machineTextNormalization = 'NFKC'
const canonicalMachineText = (value) => String(value).normalize(machineTextNormalization)
const normalizeIdentifier = (value) => canonicalMachineText(value).toLowerCase().replace(/[^a-z0-9]/gu, '')
const canonicalField = (parts) => parts.map((part, index) => index === 0 ? part : `${part[0].toUpperCase()}${part.slice(1)}`).join('')
const fieldMap = (parts) => new Map(parts.map((entry) => [normalizeIdentifier(entry.join('')), canonicalField(entry)]))
const forbiddenMachineFields = fieldMap(forbiddenMachineFieldParts)
const booleanSelfCertificationFields = fieldMap(booleanSelfCertificationParts)
const evidenceSelectionFields = fieldMap(evidenceSelectionRuleParts())
const authorityResidueFields = fieldMap(authorityResidueRuleParts())
const legacyRoles = legacyRoleParts.map((parts) => normalizeIdentifier(parts.join('')))
const legacyStates = legacyStateParts.map((parts) => normalizeIdentifier(parts.join('')))
const scannerImplementationPath = 'tools/docs/behavior-document-consistency-final.mjs'
const jsonSchemaDialectPattern = /^https?:\/\/json-schema\.org\/draft(?:-0[4-7]|\/(?:2019-09|2020-12))\/schema#?$/u
const contentSchemaDialectPattern = /\/draft\/(?:2019-09|2020-12)\/schema#?$/u
const jsonWithCommentsPathPattern = /(?:^|\/)(?:appsettings(?:\.[^/]+)?|tsconfig(?:\.[^/]+)?)\.json$|\.jsonc$/iu
const jsonSchemaMapKeywords = new Set(['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties'])
const jsonSchemaArrayKeywords = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])
const jsonSubschemaKeywords = new Set([
    'additionalItems', 'additionalProperties', 'contains', 'else', 'if', 'items', 'not',
    'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties'
])
const valueChunkSize = 512
const maximumValueCandidateTokens = 4
const maximumValueTokenLength = 128
const yamlParserAuthority = Object.freeze({
    bundlePath: 'src/frontend/node_modules/playwright-core/lib/utilsBundleImpl/index.js',
    bundleSha256: '21d4f662e119524abcdfed152b715181017085bb8edc99ea4829b97aca1d5eec',
    consumerPath: 'src/frontend/package.json',
    dependencyName: '@playwright/test',
    lockPath: 'src/frontend/package-lock.json',
    packagePath: 'src/frontend/node_modules/playwright-core/package.json',
    packageSha256: 'd4b8727c495ff2632084e922ee1c7f19a608ed23d86e8f3b0ba0ff317eea58ec',
    version: '1.59.1'
})
const jsoncParserAuthority = Object.freeze({
    bundlePath: 'src/frontend/node_modules/typescript/lib/typescript.js',
    bundleSha256: '569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39',
    dependencyName: 'typescript',
    packagePath: 'src/frontend/node_modules/typescript/package.json',
    packageSha256: '9332e97c30d3e53ed54910b89207ed657fb444066484df6e5b6965bf130865e9',
    version: '6.0.3'
})
const nodeBuiltinModules = new Set([...builtinModules, ...builtinModules.map((entry) => `node:${entry}`)])

function zeroLegacyFail(message)
{
    throw new Error(`[zero-legacy-governance] ${message}`)
}

const commonJsParserModules = new Map()
const yamlDocumentParsers = new Map()

function readCanonicalAuthorityFile(repositoryRoot, relative, { expectedDigest = null, expectedModes = null } = {})
{
    const absolute = path.resolve(repositoryRoot, relative)
    if (absolute !== path.join(repositoryRoot, ...relative.split('/')) || fs.realpathSync(absolute) !== absolute)
    {
        zeroLegacyFail(`parser authority path is not canonical: ${relative}`)
    }
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true })
        const mode = Number(before.mode & 0o777n)
        if (!before.isFile() || before.nlink !== 1n || (before.mode & 0o111n) !== 0n || (before.mode & 0o002n) !== 0n
            || (expectedModes !== null && !expectedModes.includes(mode)))
        {
            zeroLegacyFail(`parser authority mode or link count is unsupported: ${relative}`)
        }
        const content = fs.readFileSync(descriptor)
        const after = fs.fstatSync(descriptor, { bigint: true })
        const pathAfter = fs.lstatSync(absolute, { bigint: true })
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeNs !== after.mtimeNs || after.dev !== pathAfter.dev || after.ino !== pathAfter.ino
            || after.size !== BigInt(content.length))
        {
            zeroLegacyFail(`parser authority changed while reading: ${relative}`)
        }
        const contentDigest = createHash('sha256').update(content).digest('hex')
        if (expectedDigest !== null && contentDigest !== expectedDigest)
        {
            zeroLegacyFail(`parser authority byte digest mismatch: ${relative}`)
        }
        return { content, contentDigest, mode }
    }
    finally
    {
        fs.closeSync(descriptor)
    }
}

function parseCanonicalAuthorityJson(content, indentation, label)
{
    const source = new TextDecoder('utf-8', { fatal: true }).decode(content)
    const document = JSON.parse(source)
    if (`${JSON.stringify(document, null, indentation)}\n` !== source)
    {
        zeroLegacyFail(`${label} must be canonical duplicate-free JSON`)
    }
    return document
}

function admittedInventoryAuthority(repositoryRoot, inventory, relative, options = {})
{
    const entry = inventory.files.find((candidate) => candidate.file === relative)
    if (!entry) zeroLegacyFail(`parser authority is outside the admitted inventory: ${relative}`)
    if (entry.indexContent !== null) return {
        content: entry.indexContent,
        contentDigest: createHash('sha256').update(entry.indexContent).digest('hex'),
        mode: entry.mode === '100755' ? 0o755 : 0o644
    }
    return readCanonicalAuthorityFile(repositoryRoot, relative, options)
}

function executeSealedCommonJs(bundleAuthority, filename)
{
    const cacheKey = `${bundleAuthority.contentDigest}:${bundleAuthority.mode}`
    const cached = commonJsParserModules.get(cacheKey)
    if (cached) return cached
    const module = { exports: {} }
    const nativeRequire = createRequire(filename)
    const sealedRequire = (specifier) =>
    {
        if (!nodeBuiltinModules.has(specifier)) zeroLegacyFail(`sealed YAML parser requested non-builtin module: ${specifier}`)
        return nativeRequire(specifier)
    }
    const wrapper = new vm.Script(Module.wrap(bundleAuthority.content.toString('utf8')), { filename }).runInThisContext()
    wrapper.call(module.exports, module.exports, sealedRequire, module, filename, path.dirname(filename))
    commonJsParserModules.set(cacheKey, module.exports)
    return module.exports
}

function executeSealedYamlParser(bundleAuthority, filename)
{
    const cacheKey = `${bundleAuthority.contentDigest}:${bundleAuthority.mode}`
    const cached = yamlDocumentParsers.get(cacheKey)
    if (cached) return cached
    const exports = executeSealedCommonJs(bundleAuthority, filename)
    const parser = exports?.yaml
    if (!parser || typeof parser.parseDocument !== 'function') zeroLegacyFail('sealed YAML parser export is invalid')
    yamlDocumentParsers.set(cacheKey, parser)
    return parser
}

function canonicalYamlParser(repositoryRoot, inventory)
{
    const consumerAuthority = admittedInventoryAuthority(repositoryRoot, inventory, yamlParserAuthority.consumerPath,
        { expectedModes: [0o600, 0o644, 0o664] })
    const consumer = parseCanonicalAuthorityJson(consumerAuthority.content, 4, 'YAML parser consumer')
    const lockAuthority = admittedInventoryAuthority(repositoryRoot, inventory, yamlParserAuthority.lockPath,
        { expectedModes: [0o600, 0o644, 0o664] })
    const lock = parseCanonicalAuthorityJson(lockAuthority.content, 2, 'YAML parser package lock')
    const packageAuthority = readCanonicalAuthorityFile(repositoryRoot, yamlParserAuthority.packagePath, {
        expectedDigest: yamlParserAuthority.packageSha256,
        expectedModes: [0o644, 0o664]
    })
    const installedPackage = parseCanonicalAuthorityJson(packageAuthority.content, 2, 'installed YAML parser package')
    const bundleAuthority = readCanonicalAuthorityFile(repositoryRoot, yamlParserAuthority.bundlePath, {
        expectedDigest: yamlParserAuthority.bundleSha256,
        expectedModes: [0o644, 0o664]
    })
    const consumerVersion = consumer.devDependencies?.[yamlParserAuthority.dependencyName]
    const lockedConsumerVersion = lock.packages?.['']?.devDependencies?.[yamlParserAuthority.dependencyName]
    const testPackage = lock.packages?.['node_modules/@playwright/test']
    const playwrightPackage = lock.packages?.['node_modules/playwright']
    const corePackage = lock.packages?.['node_modules/playwright-core']
    if (consumerVersion !== lockedConsumerVersion
        || testPackage?.dependencies?.playwright !== yamlParserAuthority.version
        || playwrightPackage?.dependencies?.['playwright-core'] !== yamlParserAuthority.version
        || testPackage?.version !== yamlParserAuthority.version
        || playwrightPackage?.version !== yamlParserAuthority.version
        || corePackage?.version !== yamlParserAuthority.version
        || installedPackage?.version !== yamlParserAuthority.version
        || typeof corePackage?.integrity !== 'string'
        || !corePackage.integrity.startsWith('sha512-'))
    {
        zeroLegacyFail('YAML parser consumer and package-lock chain is not exact')
    }
    return executeSealedYamlParser(bundleAuthority, path.resolve(repositoryRoot, yamlParserAuthority.bundlePath))
}

function canonicalJsoncParser(repositoryRoot, inventory)
{
    const consumerAuthority = admittedInventoryAuthority(repositoryRoot, inventory, yamlParserAuthority.consumerPath,
        { expectedModes: [0o600, 0o644, 0o664] })
    const consumer = parseCanonicalAuthorityJson(consumerAuthority.content, 4, 'JSONC parser consumer')
    const lockAuthority = admittedInventoryAuthority(repositoryRoot, inventory, yamlParserAuthority.lockPath,
        { expectedModes: [0o600, 0o644, 0o664] })
    const lock = parseCanonicalAuthorityJson(lockAuthority.content, 2, 'JSONC parser package lock')
    const packageAuthority = readCanonicalAuthorityFile(repositoryRoot, jsoncParserAuthority.packagePath, {
        expectedDigest: jsoncParserAuthority.packageSha256,
        expectedModes: [0o644, 0o664]
    })
    const installedPackage = parseCanonicalAuthorityJson(packageAuthority.content, 4, 'installed JSONC parser package')
    const bundleAuthority = readCanonicalAuthorityFile(repositoryRoot, jsoncParserAuthority.bundlePath, {
        expectedDigest: jsoncParserAuthority.bundleSha256,
        expectedModes: [0o644, 0o664]
    })
    const consumerVersion = consumer.devDependencies?.[jsoncParserAuthority.dependencyName]
    const lockedConsumerVersion = lock.packages?.['']?.devDependencies?.[jsoncParserAuthority.dependencyName]
    const lockedPackage = lock.packages?.['node_modules/typescript']
    if (consumerVersion !== lockedConsumerVersion
        || lockedPackage?.version !== jsoncParserAuthority.version
        || installedPackage?.version !== jsoncParserAuthority.version
        || typeof lockedPackage?.integrity !== 'string'
        || !lockedPackage.integrity.startsWith('sha512-'))
    {
        zeroLegacyFail('JSONC parser consumer and package-lock chain is not exact')
    }
    const parser = executeSealedCommonJs(bundleAuthority, path.resolve(repositoryRoot, jsoncParserAuthority.bundlePath))
    if (typeof parser?.parseJsonText !== 'function') zeroLegacyFail('sealed JSONC parser export is invalid')
    return parser
}

function assertUniqueJsonKeys(parser, sourceFile)
{
    const visit = (node) =>
    {
        if (parser.isObjectLiteralExpression(node))
        {
            const keys = new Set()
            for (const property of node.properties)
            {
                const key = property.name?.text
                if (typeof key !== 'string') continue
                if (keys.has(key)) throw new SyntaxError(`duplicate JSON key: ${key}`)
                keys.add(key)
            }
        }
        parser.forEachChild(node, visit)
    }
    visit(sourceFile)
}

function parseMachineJson(source, file, parser)
{
    if (!jsonWithCommentsPathPattern.test(file))
    {
        const value = JSON.parse(source)
        const sourceFile = parser.parseJsonText(file, source)
        assertUniqueJsonKeys(parser, sourceFile)
        return value
    }
    const sourceFile = parser.parseJsonText(file, source)
    if (sourceFile.parseDiagnostics.length > 0)
    {
        throw new SyntaxError(parser.flattenDiagnosticMessageText(sourceFile.parseDiagnostics[0].messageText, ' '))
    }
    assertUniqueJsonKeys(parser, sourceFile)
    const parsed = parser.parseConfigFileTextToJson(file, source)
    if (parsed.error) throw new SyntaxError(parser.flattenDiagnosticMessageText(parsed.error.messageText, ' '))
    return parsed.config
}

function pathClassesFor(file)
{
    const classes = []
    const rootEntry = scanRoots.find((entry) => file === entry.path || file.startsWith(`${entry.path}/`))
    if (rootEntry) classes.push(rootEntry.pathClass)
    if (path.posix.basename(file) === 'package.json') classes.push('package-scripts')
    if (/(?:^|\/)(?:generated|projections?)(?:[-_.\/]|$)|(?:^|[-_.])generated(?:[-_.]|$)/iu.test(file)) classes.push('generated-projection')
    if (/(?:^|\/)schemas?(?:\/|$)|\.schema\.json$/iu.test(file)) classes.push('output-schema')
    return [...new Set(classes)].sort()
}

function addFinding(findings, file, pathClasses, rule, location)
{
    findings.push({ file, pathClasses, rule, location })
}

function isQualificationPath(file)
{
    return qualificationPathPattern.test(file)
}

function isForbiddenMachineField(normalized, qualification)
{
    const canonical = forbiddenMachineFields.get(normalized)
    if (!canonical) return null
    if (!qualification && ['expectedValue', 'baselineValue', 'verifiedAt', 'waiver'].includes(canonical)) return null
    return canonical
}

function legacySurfaceName(value, context)
{
    const normalized = normalizeIdentifier(value)
    return legacyStates.some((state) => normalized.includes(state))
        && legacyRoles.some((role) => normalized.includes(role))
}

function evidenceSelectionField(identifier)
{
    const normalized = normalizeIdentifier(identifier)
    const exact = evidenceSelectionFields.get(normalized)
    if (exact) return exact
    const evidenceKind = '(?:artifact|evidence|fact|mutation|receipt|report|result|runtime|trx)'
    const selector = '(?:ctime|fallback|history|historical|latest|mtime|newest)'
    if (new RegExp(`^(?:${selector}.*${evidenceKind}|${evidenceKind}.*${selector})$`, 'u').test(normalized)
        || /(?:lastgreen|lastpassing|retry.*(?:correctness|pass))/u.test(normalized))
    {
        return identifier
    }
    return null
}

function authorityResidueField(identifier)
{
    const normalized = normalizeIdentifier(identifier)
    const exact = authorityResidueFields.get(normalized)
    if (exact) return exact
    if (/(?:releasefinal).*(?:discover|parse|repair|rerun)|(?:discover|parse|repair|rerun).*(?:releasefinal)/u.test(normalized)
        || /openapi.*regex.*fallback|regex.*openapi.*fallback/u.test(normalized)
        || /gitdiff.*(?:sync|synchron)|(?:sync|synchron).*gitdiff/u.test(normalized))
    {
        return identifier
    }
    return null
}

function scanMachineValueCandidates(rawValue, visit)
{
    const canonicalValue = canonicalMachineText(rawValue)
    let token = ''
    let tokenOverflow = false
    const recentTokens = []
    const flush = () =>
    {
        if (!token && !tokenOverflow) return
        if (tokenOverflow)
        {
            recentTokens.length = 0
        }
        else
        {
            const window = [...recentTokens, token]
            for (let length = 1; length <= maximumValueCandidateTokens && length <= window.length; length += 1)
            {
                visit(window.slice(window.length - length).join('-'))
            }
            recentTokens.push(token)
            if (recentTokens.length >= maximumValueCandidateTokens) recentTokens.shift()
        }
        token = ''
        tokenOverflow = false
    }
    for (let offset = 0; offset < canonicalValue.length; offset += valueChunkSize)
    {
        const chunk = canonicalValue.slice(offset, offset + valueChunkSize)
        for (const character of chunk)
        {
            if (!token && !tokenOverflow)
            {
                if (/[A-Za-z]/u.test(character)) token = character
                continue
            }
            if (/[A-Za-z0-9_-]/u.test(character))
            {
                if (token.length < maximumValueTokenLength) token += character
                else tokenOverflow = true
                continue
            }
            flush()
        }
    }
    flush()
}

function scanValueResidue(owner, rawValue, context)
{
    if (!context.qualification || typeof rawValue !== 'string') return
    const ownerName = normalizeIdentifier(owner)
    const selectionOwner = /(?:artifact|discovery|evidence|locator|receipt|selection)/u.test(ownerName)
        || /^(?:mode|result|source|strategy)$/u.test(ownerName)
    const authorityOwner = /(?:authority|cli|command|featureflag|input|kind|mode|path|provider|schema|source|strategy|type)/u.test(ownerName)
    const simpleSelector = new Set(['age', 'ctime', 'fallback', 'glob', 'historical', 'history', 'latest', 'mtime', 'newest', 'scan', 'search'])
    scanMachineValueCandidates(rawValue, (candidate) =>
    {
        const valueName = normalizeIdentifier(candidate)
        const selectionField = evidenceSelectionField(candidate)
        if (selectionOwner && (selectionField || simpleSelector.has(valueName)))
        {
            addFinding(context.findings, context.file, context.pathClasses, `forbidden-evidence-selection:${selectionField ?? `${owner}=${candidate}`}`, context.location)
        }
        const authorityField = authorityResidueField(candidate)
        if (authorityOwner && authorityField)
        {
            addFinding(context.findings, context.file, context.pathClasses, `forbidden-self-authority:${authorityField}`, context.location)
        }
        if (authorityOwner && legacySurfaceName(candidate, context))
        {
            addFinding(context.findings, context.file, context.pathClasses, `forbidden-legacy-surface:${candidate}`, context.location)
        }
    })
}

function scanIdentifier(identifier, valueText, context)
{
    const normalized = normalizeIdentifier(identifier)
    const pathLike = /[./\\]/u.test(identifier)
    const forbiddenField = isForbiddenMachineField(normalized, context.qualification)
    if (forbiddenField)
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-machine-field:${forbiddenField}`, context.location)
    }
    const booleanAttestation = booleanSelfCertificationFields.get(normalized)
    if (context.qualification && booleanAttestation && /^true\b/iu.test(String(valueText).trim()))
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-self-certification:${booleanAttestation}`, context.location)
    }
    const selectionField = pathLike ? null : evidenceSelectionField(identifier)
    if (context.qualification && selectionField)
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-evidence-selection:${selectionField}`, context.location)
    }
    const authorityField = pathLike ? null : authorityResidueField(identifier)
    if (context.qualification && authorityField)
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-self-authority:${authorityField}`, context.location)
    }
    if (!pathLike && legacySurfaceName(identifier, context))
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-legacy-surface:${identifier}`, context.location)
    }
    scanValueResidue(identifier, typeof valueText === 'string' ? valueText : '', context)
}

function validSchemaResourceId(value)
{
    if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || /\s/u.test(value)) return false
    try
    {
        return new URL(value, 'https://fsusblog.invalid/schema/').hash.length === 0
    }
    catch
    {
        return false
    }
}

function schemaResourceState(value, context, schemaMode, location)
{
    if (schemaMode !== 'schema' || typeof value?.$schema !== 'string')
    {
        return { context, schemaMode }
    }
    const resourceBoundary = location === '$' || validSchemaResourceId(value.$id)
    const dialect = value.$schema
    if (!resourceBoundary || !jsonSchemaDialectPattern.test(dialect))
    {
        return {
            context: { ...context, currentContentSchema: false, oldDialectDependencies: false },
            schemaMode: 'value'
        }
    }
    return {
        context: {
            ...context,
            currentContentSchema: contentSchemaDialectPattern.test(dialect),
            oldDialectDependencies: /\/draft-0[4-7]\/schema#?$/u.test(dialect)
        },
        schemaMode: 'schema'
    }
}

function scanObjectKeys(value, context, negated = false, location = '$', schemaMode = context.jsonSchemaDocument === true ? 'schema' : 'value')
{
    if (Array.isArray(value))
    {
        const itemMode = schemaMode === 'schema-array' ? 'schema' : 'value'
        value.forEach((entry, index) => scanObjectKeys(entry, context, negated, `${location}[${index}]`, itemMode))
        return
    }
    if (!value || typeof value !== 'object') return
    const resource = schemaResourceState(value, context, schemaMode, location)
    const resourceContext = resource.context
    const activeSchemaMode = resource.schemaMode
    const referenceIgnoresSiblings = activeSchemaMode === 'schema'
        && resourceContext.oldDialectDependencies === true
        && typeof value.$ref === 'string'
    for (const [key, nested] of Object.entries(value))
    {
        const siblingNegated = referenceIgnoresSiblings && key !== '$ref' ? false : negated
        if (!siblingNegated) scanIdentifier(key, nested, { ...resourceContext, location: `${location}.${key}` })
        if (!siblingNegated && Array.isArray(nested))
        {
            nested.forEach((entry, index) =>
            {
                if (entry == null || typeof entry === 'object') return
                scanIdentifier(key, entry, { ...resourceContext, location: `${location}.${key}[${index}]` })
            })
        }
        if (activeSchemaMode === 'schema' && key === '$ref' && typeof nested === 'string'
            && legacySurfaceName(nested, resourceContext))
        {
            addFinding(resourceContext.findings, resourceContext.file, resourceContext.pathClasses, `forbidden-legacy-surface:${nested}`, `${location}.$ref`)
        }
        const schemaNegation = activeSchemaMode === 'schema'
            && !referenceIgnoresSiblings
            && key === 'not'
            && nested != null
            && typeof nested === 'object'
            && !Array.isArray(nested)
        let nestedSchemaMode = 'value'
        if (referenceIgnoresSiblings && key !== '$ref') nestedSchemaMode = 'value'
        else if (activeSchemaMode === 'schema-map') nestedSchemaMode = 'schema'
        else if (activeSchemaMode === 'schema'
            && (jsonSchemaMapKeywords.has(key)
                || (key === 'dependencies' && resourceContext.oldDialectDependencies === true))) nestedSchemaMode = 'schema-map'
        else if (activeSchemaMode === 'schema' && jsonSchemaArrayKeywords.has(key)) nestedSchemaMode = 'schema-array'
        else if (activeSchemaMode === 'schema'
            && (jsonSubschemaKeywords.has(key)
                || (key === 'contentSchema' && resourceContext.currentContentSchema === true)))
        {
            nestedSchemaMode = key === 'items' && Array.isArray(nested) ? 'schema-array' : 'schema'
        }
        scanObjectKeys(nested, resourceContext, schemaNegation ? !siblingNegated : siblingNegated, `${location}.${key}`, nestedSchemaMode)
    }
}

function sourceLineTerminatorAt(source, index)
{
    if (source[index] === '\r' && source[index + 1] === '\n') return 2
    return /[\n\r\u2028\u2029]/u.test(source[index] ?? '') ? 1 : 0
}

function findSourceLineTerminator(source, start)
{
    for (let index = start; index < source.length; index += 1)
    {
        if (sourceLineTerminatorAt(source, index) > 0) return index
    }
    return source.length
}

function startsHashComment(source, index, commentStyle)
{
    if (!commentStyle || source[index] !== '#') return false
    if (commentStyle === 'hash' || commentStyle === 'powershell') return true
    if (index === 0 || /\s/u.test(source[index - 1])) return true
    return commentStyle === 'shell' && /[;&|()]/u.test(source[index - 1])
}

function powerShellBlockCommentEnd(source, start)
{
    let depth = 0
    for (let index = start; index < source.length - 1; index += 1)
    {
        if (source[index] === '<' && source[index + 1] === '#')
        {
            depth += 1
            index += 1
            continue
        }
        if (source[index] === '#' && source[index + 1] === '>')
        {
            depth -= 1
            index += 1
            if (depth === 0) return index + 1
        }
    }
    return source.length
}

function maskSourceLiteralsAndComments(source, commentStyle)
{
    const masked = source.split('')
    for (let index = 0; index < source.length; index += 1)
    {
        let end = index
        if (commentStyle === 'powershell' && source[index] === '<' && source[index + 1] === '#')
        {
            const closing = powerShellBlockCommentEnd(source, index)
            end = closing < 0 ? source.length : closing
        }
        else if (!commentStyle && source[index] === '/' && source[index + 1] === '/')
        {
            end = findSourceLineTerminator(source, index + 2)
        }
        else if (startsHashComment(source, index, commentStyle))
        {
            end = findSourceLineTerminator(source, index + 1)
        }
        else if (!commentStyle && source[index] === '/' && source[index + 1] === '*')
        {
            const closing = source.indexOf('*/', index + 2)
            end = closing < 0 ? source.length : closing + 2
        }
        else if (source[index] === '"' || source[index] === "'" || source[index] === '`')
        {
            const quote = source[index]
            end = index + 1
            while (end < source.length)
            {
                if (source[end] === '\\')
                {
                    end += 2
                    continue
                }
                if (source[end] === quote)
                {
                    end += 1
                    break
                }
                end += 1
            }
            let next = end
            while (/\s/u.test(source[next] ?? '')) next += 1
            const content = source.slice(index + 1, Math.max(index + 1, end - 1))
            if (source[next] === ':' && /^[\p{ID_Start}_][\p{ID_Continue}_-]*$/u.test(content))
            {
                index = end - 1
                continue
            }
        }
        else
        {
            continue
        }
        for (let cursor = index; cursor < end; cursor += 1)
        {
            if (sourceLineTerminatorAt(source, cursor) === 0) masked[cursor] = ' '
        }
        index = end - 1
    }
    return masked.join('')
}

function nextSignificantSourceCharacter(source, start, commentStyle)
{
    let index = start
    while (index < source.length)
    {
        if (/\s/u.test(source[index]))
        {
            index += 1
            continue
        }
        if (commentStyle === 'powershell' && source[index] === '<' && source[index + 1] === '#')
        {
            const closing = powerShellBlockCommentEnd(source, index)
            index = closing < 0 ? source.length : closing
            continue
        }
        if (!commentStyle && source[index] === '/' && source[index + 1] === '/')
        {
            const terminator = findSourceLineTerminator(source, index + 2)
            index = terminator + sourceLineTerminatorAt(source, terminator)
            continue
        }
        if (startsHashComment(source, index, commentStyle))
        {
            const terminator = findSourceLineTerminator(source, index + 1)
            index = terminator + sourceLineTerminatorAt(source, terminator)
            continue
        }
        if (!commentStyle && source[index] === '/' && source[index + 1] === '*')
        {
            const closing = source.indexOf('*/', index + 2)
            index = closing < 0 ? source.length : closing + 2
            continue
        }
        return { character: source[index], index }
    }
    return { character: '', index: source.length }
}

function readAssignmentValue(source, valueStart, commentStyle)
{
    let index = valueStart
    let valueText = ''
    let quote = null
    let nesting = 0
    const previousSignificant = () => {
        let previous = valueText.length - 1
        while (previous >= 0 && /\s/u.test(valueText[previous])) previous -= 1
        return valueText[previous] ?? ''
    }
    while (index < source.length)
    {
        const current = source[index]
        const next = source[index + 1]
        if (quote !== null)
        {
            valueText += current
            if (current === '\\')
            {
                if (index + 1 < source.length) valueText += source[index + 1]
                index += 2
                continue
            }
            if (current === quote) quote = null
            index += 1
            continue
        }
        if (current === '"' || current === "'" || current === '`')
        {
            quote = current
            valueText += current
            index += 1
            continue
        }
        if (current === '(' || current === '[' || current === '{')
        {
            nesting += 1
            valueText += current
            index += 1
            continue
        }
        if (current === ')' || current === ']' || current === '}')
        {
            if (nesting === 0) break
            nesting -= 1
            valueText += current
            index += 1
            continue
        }
        if (commentStyle === 'powershell' && current === '<' && next === '#')
        {
            const closing = powerShellBlockCommentEnd(source, index)
            if (closing < 0) break
            valueText += ' '
            index = closing
            continue
        }
        if (!commentStyle && current === '/' && next === '/')
        {
            const terminator = findSourceLineTerminator(source, index + 2)
            const nextLine = terminator + sourceLineTerminatorAt(source, terminator)
            const afterComment = nextSignificantSourceCharacter(source, nextLine, commentStyle)
            if (nesting === 0 && previousSignificant() !== '+' && afterComment.character !== '+') break
            valueText += '\n'
            index = nextLine
            continue
        }
        if (startsHashComment(source, index, commentStyle))
        {
            const terminator = findSourceLineTerminator(source, index + 1)
            const nextLine = terminator + sourceLineTerminatorAt(source, terminator)
            const afterComment = nextSignificantSourceCharacter(source, nextLine, commentStyle)
            if (nesting === 0 && previousSignificant() !== '+' && afterComment.character !== '+') break
            valueText += '\n'
            index = nextLine
            continue
        }
        if (!commentStyle && current === '/' && next === '*')
        {
            const closing = source.indexOf('*/', index + 2)
            if (closing < 0) break
            valueText += ' '
            index = closing + 2
            continue
        }
        const terminatorLength = sourceLineTerminatorAt(source, index)
        if (terminatorLength > 0)
        {
            const afterNewline = nextSignificantSourceCharacter(source, index + terminatorLength, commentStyle)
            if (nesting === 0 && previousSignificant() !== '+' && previousSignificant() !== '\\'
                && afterNewline.character !== '+') break
            valueText += '\n'
            index += terminatorLength
            continue
        }
        if (nesting === 0 && /[,;}]/u.test(current)) break
        valueText += current
        index += 1
    }
    return valueText
}

function sourceIdentifierAuthority(file, locationPrefix)
{
    if (/\.cs$/iu.test(file) || /^fence:(?:csharp|cs):/u.test(locationPrefix))
    {
        const escape = String.raw`\\(?:u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})`
        return { grammar: `@?(?:[\\p{ID_Start}_]|${escape})(?:[\\p{ID_Continue}_]|${escape})*`, language: 'csharp' }
    }
    if (/\.(?:js|jsx|mjs|ts|tsx|vue)$/iu.test(file) || /^fence:(?:javascript|js|typescript|ts):/u.test(locationPrefix))
    {
        const escape = String.raw`\\u(?:[0-9A-Fa-f]{4}|\{[0-9A-Fa-f]{1,6}\})`
        return { grammar: `#?(?:[$\\p{ID_Start}_]|${escape})(?:[$\\p{ID_Continue}_]|${escape})*`, language: 'javascript' }
    }
    if (/\.ps1$/iu.test(file) || /^fence:(?:powershell|ps1):/u.test(locationPrefix))
    {
        return { grammar: String.raw`(?:\$\{[^}\r\n]+\}|\$?[\p{ID_Start}_][\p{ID_Continue}_]*)`, language: 'powershell' }
    }
    if (/\.sh$/iu.test(file) || /^fence:(?:sh|shell):/u.test(locationPrefix))
    {
        return { grammar: String.raw`[A-Za-z_][A-Za-z0-9_]*`, language: 'shell' }
    }
    return { grammar: String.raw`[\p{ID_Start}_][\p{ID_Continue}_]*`, language: 'generic' }
}

function decodeEscapedIdentifier(identifier, language)
{
    let source = identifier
    if (language === 'powershell' && source.startsWith('${') && source.endsWith('}'))
    {
        return source.slice(2, -1).replace(/^[A-Za-z]+:/u, '')
    }
    source = source.replace(/^[@$#]/u, '')
    if (language !== 'javascript' && language !== 'csharp') return source
    let decoded = ''
    for (let index = 0; index < source.length;)
    {
        if (source[index] !== '\\')
        {
            const point = source.codePointAt(index)
            decoded += String.fromCodePoint(point)
            index += point > 0xffff ? 2 : 1
            continue
        }
        const rest = source.slice(index)
        const match = language === 'javascript'
            ? /^\\u(?:\{([0-9A-Fa-f]{1,6})\}|([0-9A-Fa-f]{4}))/u.exec(rest)
            : /^\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8}))/u.exec(rest)
        if (!match) return null
        const value = Number.parseInt(match[1] ?? match[2], 16)
        if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return null
        decoded += String.fromCodePoint(value)
        index += match[0].length
    }
    const characters = [...decoded]
    const first = characters.shift() ?? ''
    const firstPattern = language === 'javascript' ? /^[$\p{ID_Start}_]$/u : /^[\p{ID_Start}_]$/u
    const continuationPattern = language === 'javascript' ? /^[$\p{ID_Continue}_]$/u : /^[\p{ID_Continue}_]$/u
    if (!firstPattern.test(first) || characters.some((character) => !continuationPattern.test(character))) return null
    return decoded
}

function sourceAssignments(source, masked, commentStyle, identifierAuthority)
{
    const assignments = []
    const expression = new RegExp(`(?:^|[,;{([.\\s])(?:["']([^"']+)["']|(${identifierAuthority.grammar}))\\s*\\??\\s*(?::|=(?!=))`, 'dgmu')
    let match
    while ((match = expression.exec(masked)) !== null)
    {
        const identifierIndex = match.indices[1] ?? match.indices[2]
        const valueStart = match.indices[0][1]
        const rawIdentifier = source.slice(identifierIndex[0], identifierIndex[1]).replace(/^["']|["']$/gu, '')
        const identifier = match.indices[1]
            ? rawIdentifier
            : decodeEscapedIdentifier(rawIdentifier, identifierAuthority.language)
        if (identifier === null) continue
        assignments.push({
            identifier,
            valueText: readAssignmentValue(source, valueStart, commentStyle),
            index: match.index
        })
    }
    return assignments
}

function declaredIdentifiers(masked, identifierAuthority)
{
    const identifiers = []
    const expressions = [
        new RegExp(`\\b(?:class|const|enum|function|interface|let|type|var)\\s+(${identifierAuthority.grammar})`, 'gu'),
        new RegExp(`(?:^|[^$#@\\p{ID_Continue}_])(${identifierAuthority.grammar})\\s*(?:\\??\\s*:|\\{[\\t ]*(?:get|init|set)\\s*;)`, 'gmu')
    ]
    for (const expression of expressions)
    {
        let match
        while ((match = expression.exec(masked)) !== null)
        {
            const identifier = decodeEscapedIdentifier(match[1], identifierAuthority.language)
            if (identifier !== null) identifiers.push({ identifier, index: match.index })
        }
    }
    return [...new Map(identifiers.map((entry) => [`${entry.identifier}\0${entry.index}`, entry])).values()]
}

function sourceInvocations(source, masked, identifierAuthority)
{
    const invocations = []
    const expression = new RegExp(`(?:^|[^$#@\\p{ID_Continue}_])(${identifierAuthority.grammar}(?:\\.${identifierAuthority.grammar})*)\\s*\\(([^()\\n\\r\\u2028\\u2029]*)\\)`, 'dgmu')
    let match
    while ((match = expression.exec(masked)) !== null)
    {
        const argumentIndex = match.indices[2]
        const argumentsText = source.slice(argumentIndex[0], argumentIndex[1])
        const stringArguments = []
        const stringExpression = /(["'])(.*?)\1/gu
        let stringMatch
        while ((stringMatch = stringExpression.exec(argumentsText)) !== null) stringArguments.push(stringMatch[2])
        const identifierParts = match[1].split('.').map((entry) => decodeEscapedIdentifier(entry, identifierAuthority.language))
        if (identifierParts.includes(null)) continue
        invocations.push({
            identifier: identifierParts.join('.'),
            stringArguments,
            index: match.index
        })
    }
    return invocations
}

function autoPropertyInitializers(source, masked, identifierAuthority)
{
    const initializers = []
    const expression = new RegExp(`(?:^|[^$#@\\p{ID_Continue}_])(${identifierAuthority.grammar})\\s*\\{[\\t ]*(?:(?:get|init|set)\\s*;[\\t ]*)+\\}\\s*=\\s*([^;\\n\\r\\u2028\\u2029]+)`, 'dgmu')
    let match
    while ((match = expression.exec(masked)) !== null)
    {
        const identifier = decodeEscapedIdentifier(match[1], identifierAuthority.language)
        if (identifier === null) continue
        const valueRange = match.indices[2]
        initializers.push({
            identifier,
            valueText: source.slice(valueRange[0], valueRange[1]),
            index: match.index
        })
    }
    return initializers
}

function scanEcmaScriptAst(source, context, parser, locationPrefix, lineAt, isExactDeclaration)
{
    const scriptKind = /\.(?:jsx|tsx)$/iu.test(context.file)
        ? (/\.tsx$/iu.test(context.file) ? parser.ScriptKind.TSX : parser.ScriptKind.JSX)
        : (/\.(?:ts|mts|cts)$/iu.test(context.file) ? parser.ScriptKind.TS : parser.ScriptKind.JS)
    const sourceFile = parser.createSourceFile(context.file, source, parser.ScriptTarget.Latest, true, scriptKind)
    const identifierText = (name) =>
    {
        if (parser.isIdentifier(name)) return name.text
        if (parser.isPrivateIdentifier?.(name)) return String(name.text).replace(/^#/u, '')
        if (parser.isStringLiteralLike(name)) return name.text
        return null
    }
    const constantText = (node) =>
    {
        if (!node) return ''
        if (parser.isStringLiteralLike(node) || parser.isNoSubstitutionTemplateLiteral(node)) return node.text
        if (parser.isParenthesizedExpression(node)) return constantText(node.expression)
        if ((parser.isAsExpression?.(node) || parser.isTypeAssertionExpression?.(node)
            || parser.isSatisfiesExpression?.(node) || parser.isNonNullExpression?.(node))) return constantText(node.expression)
        if (parser.isBinaryExpression(node) && node.operatorToken.kind === parser.SyntaxKind.PlusToken)
        {
            return `${constantText(node.left)}${constantText(node.right)}`
        }
        return source.slice(node.getStart(sourceFile), node.getEnd())
    }
    const constantString = (node) =>
    {
        if (!node) return null
        if (parser.isStringLiteralLike(node) || parser.isNoSubstitutionTemplateLiteral(node)) return node.text
        if (parser.isParenthesizedExpression(node)) return constantString(node.expression)
        if ((parser.isAsExpression?.(node) || parser.isTypeAssertionExpression?.(node)
            || parser.isSatisfiesExpression?.(node) || parser.isNonNullExpression?.(node))) return constantString(node.expression)
        if (parser.isBinaryExpression(node) && node.operatorToken.kind === parser.SyntaxKind.PlusToken)
        {
            const left = constantString(node.left)
            const right = constantString(node.right)
            return left === null || right === null ? null : `${left}${right}`
        }
        return null
    }
    const scanOwned = (identifier, valueText, node) =>
    {
        if (identifier === null) return
        const index = node.getStart(sourceFile)
        if (isExactDeclaration(index)) return
        scanIdentifier(identifier, valueText, {
            ...context,
            location: `${locationPrefix}:line:${lineAt(index)}`
        })
    }
    const assignedName = (node) =>
    {
        if (parser.isIdentifier(node) || parser.isPrivateIdentifier?.(node) || parser.isStringLiteralLike(node)) return identifierText(node)
        if (parser.isPropertyAccessExpression(node)) return identifierText(node.name)
        if (parser.isElementAccessExpression(node) && parser.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
        return null
    }
    const visit = (node) =>
    {
        if (parser.isVariableDeclaration(node)
            || parser.isPropertyDeclaration(node)
            || parser.isPropertySignature(node)
            || parser.isPropertyAssignment(node))
        {
            scanOwned(identifierText(node.name), constantText(node.initializer), node)
        }
        else if (parser.isClassDeclaration(node)
            || parser.isInterfaceDeclaration(node)
            || parser.isTypeAliasDeclaration(node)
            || parser.isEnumDeclaration(node)
            || parser.isFunctionDeclaration(node))
        {
            scanOwned(identifierText(node.name), '', node)
        }
        else if (parser.isBinaryExpression(node) && node.operatorToken.kind === parser.SyntaxKind.EqualsToken)
        {
            scanOwned(assignedName(node.left), constantText(node.right), node)
        }
        else if (parser.isCallExpression(node))
        {
            const invocation = assignedName(node.expression)
            const invocationContext = {
                ...context,
                location: `${locationPrefix}:line:${lineAt(node.getStart(sourceFile))}`
            }
            if (invocation !== null)
            {
                scanIdentifier(invocation, '', invocationContext)
                for (const argument of node.arguments)
                {
                    const argumentText = constantString(argument)
                    if (argumentText === null) continue
                    scanValueResidue(invocation, argumentText, invocationContext)
                    if (legacySurfaceName(argumentText, invocationContext))
                    {
                        addFinding(context.findings, context.file, context.pathClasses,
                            `forbidden-legacy-surface:${argumentText}`, invocationContext.location)
                    }
                }
            }
        }
        parser.forEachChild(node, visit)
    }
    visit(sourceFile)
}

function exactScannerDeclarationRange(source, masked, context)
{
    if (context.file !== scannerImplementationPath) return null
    const exportName = ['zero', 'Legacy', 'Scan', 'Schema'].join('')
    const declarationPrefix = `export const ${exportName} = `
    const expectedDeclaration = `export const ${exportName} = '${zeroLegacyScanSchema}'`
    const candidates = []
    for (let start = source.indexOf(expectedDeclaration); start >= 0; start = source.indexOf(expectedDeclaration, start + 1))
    {
        if (masked.slice(start, start + declarationPrefix.length) === declarationPrefix) candidates.push(start)
    }
    if (candidates.length !== 1) return null
    return { start: candidates[0], end: candidates[0] + expectedDeclaration.length }
}

function scannerSchemaValue()
{
    return zeroLegacyScanSchema
}

function scanMachineShebang(source, context, locationPrefix)
{
    if (!source.startsWith('#!')) return
    const terminator = findSourceLineTerminator(source, 2)
    const command = source.slice(2, terminator)
    const shebangContext = { ...context, location: `${locationPrefix}:line:1` }
    scanValueResidue('command', command, shebangContext)
    if (legacySurfaceName(command, shebangContext))
    {
        addFinding(context.findings, context.file, context.pathClasses, `forbidden-legacy-surface:${command.trim()}`, shebangContext.location)
    }
}

function assertAcyclicMachineDocument(value, ancestors = new Set())
{
    if (!value || typeof value !== 'object') return
    if (ancestors.has(value)) throw new TypeError('YAML alias cycle is unsupported')
    ancestors.add(value)
    for (const nested of Array.isArray(value) ? value : Object.values(value))
    {
        assertAcyclicMachineDocument(nested, ancestors)
    }
    ancestors.delete(value)
}

function scanMachineYaml(source, context, parser, location = '$')
{
    const document = parser.parseDocument(source, {
        merge: true,
        prettyErrors: false,
        uniqueKeys: true
    })
    if (document.errors.length > 0) throw new SyntaxError(document.errors[0].message)
    const value = document.toJS({ maxAliasCount: 100 })
    assertAcyclicMachineDocument(value)
    scanObjectKeys(value, { ...context, jsonSchemaDocument: false }, false, location, 'value')
}

function scanMachineSource(source, context, locationPrefix = 'source')
{
    const commentStyle = /\.sh$/iu.test(context.file) || /^fence:(?:sh|shell):/u.test(locationPrefix)
        ? 'shell'
        : /\.ps1$/iu.test(context.file) || /^fence:(?:powershell|ps1|toml):/u.test(locationPrefix)
            ? (/\.ps1$/iu.test(context.file) || /^fence:(?:powershell|ps1):/u.test(locationPrefix) ? 'powershell' : 'hash')
            : null
    const identifierAuthority = sourceIdentifierAuthority(context.file, locationPrefix)
    scanMachineShebang(source, context, locationPrefix)
    const masked = maskSourceLiteralsAndComments(source, commentStyle)
    const exactDeclaration = exactScannerDeclarationRange(source, masked, context)
    const isExactDeclaration = (index) => exactDeclaration !== null
        && index >= exactDeclaration.start
        && index < exactDeclaration.end
    const lineStarts = [0]
    for (let index = 0; index < source.length; index += 1)
    {
        const terminatorLength = sourceLineTerminatorAt(source, index)
        if (terminatorLength === 0) continue
        lineStarts.push(index + terminatorLength)
        index += terminatorLength - 1
    }
    const lineAt = (target) => {
        let low = 0
        let high = lineStarts.length
        while (low < high)
        {
            const middle = Math.floor((low + high) / 2)
            if (lineStarts[middle] <= target) low = middle + 1
            else high = middle
        }
        return low
    }
    if ((/\.(?:js|jsx|mjs|ts|tsx)$/iu.test(context.file)
        || /^fence:(?:javascript|js|typescript|ts):/u.test(locationPrefix)) && !/\.vue$/iu.test(context.file))
    {
        scanEcmaScriptAst(source, context, context.jsoncParser(), locationPrefix, lineAt, isExactDeclaration)
        return
    }
    for (const assignment of sourceAssignments(source, masked, commentStyle, identifierAuthority))
    {
        if (isExactDeclaration(assignment.index)) continue
        scanIdentifier(assignment.identifier, assignment.valueText, {
            ...context,
            location: `${locationPrefix}:line:${lineAt(assignment.index)}`
        })
    }
    for (const declaration of declaredIdentifiers(masked, identifierAuthority))
    {
        if (isExactDeclaration(declaration.index)) continue
        scanIdentifier(declaration.identifier, '', {
            ...context,
            location: `${locationPrefix}:line:${lineAt(declaration.index)}`
        })
    }
    for (const initializer of autoPropertyInitializers(source, masked, identifierAuthority))
    {
        scanIdentifier(initializer.identifier, initializer.valueText, {
            ...context,
            location: `${locationPrefix}:line:${lineAt(initializer.index)}`
        })
    }
    for (const invocation of sourceInvocations(source, masked, identifierAuthority))
    {
        const invocationContext = {
            ...context,
            location: `${locationPrefix}:line:${lineAt(invocation.index)}`
        }
        scanIdentifier(invocation.identifier, '', invocationContext)
        for (const argument of invocation.stringArguments)
        {
            scanValueResidue(invocation.identifier, argument, invocationContext)
            if (legacySurfaceName(argument, invocationContext))
            {
                addFinding(context.findings, context.file, context.pathClasses, `forbidden-legacy-surface:${argument}`, invocationContext.location)
            }
        }
    }
}

function scanDocumentFences(source, context)
{
    const normalized = source.replace(/\r\n|\r|\u2028|\u2029/gu, '\n')
    machineFencePattern.lastIndex = 0
    let match
    while ((match = machineFencePattern.exec(normalized)) !== null)
    {
        const line = normalized.slice(0, match.index).split('\n').length
        const language = match[1].toLowerCase()
        const location = `fence:${language}:line:${line}`
        if (language === 'yaml' || language === 'yml')
        {
            const parser = context.yamlParser()
            try
            {
                scanMachineYaml(match[2], { ...context, qualification: true }, parser, location)
            }
            catch
            {
                addFinding(context.findings, context.file, context.pathClasses, 'invalid-machine-yaml', location)
            }
        }
        else
        {
            scanMachineSource(match[2], { ...context, qualification: true }, location)
        }
    }
}

function scanPackageScripts(manifest, context)
{
    if (!manifest?.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) return
    for (const [scriptName, command] of Object.entries(manifest.scripts))
    {
        const location = `$.scripts.${scriptName}`
        scanIdentifier(scriptName, command, { ...context, qualification: true, location })
        scanMachineSource(String(command), { ...context, qualification: true }, `package-script:${scriptName}`)
        for (const token of String(command).split(/\s+/u))
        {
            if (legacySurfaceName(token, { ...context, location }))
            {
                addFinding(context.findings, context.file, context.pathClasses, `forbidden-legacy-surface:${token}`, location)
            }
            const selectionField = evidenceSelectionField(token)
            if (selectionField) addFinding(context.findings, context.file, context.pathClasses, `forbidden-evidence-selection:${selectionField}`, location)
            const authorityField = authorityResidueField(token)
            if (authorityField) addFinding(context.findings, context.file, context.pathClasses, `forbidden-self-authority:${authorityField}`, location)
        }
    }
}

function walkFiles(repositoryRoot, relative, output, predicate = () => true)
{
    const absolute = path.join(repositoryRoot, relative)
    if (!fs.existsSync(absolute)) return
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) return
    if (stat.isFile())
    {
        const normalized = relative.replaceAll(path.sep, '/').replace(/^\.\//u, '')
        if (predicate(normalized)) output.push(normalized)
        return
    }
    if (!stat.isDirectory()) return
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }))
    {
        if (ignoredDirectoryNames.has(entry.name.toLowerCase())) continue
        walkFiles(repositoryRoot, path.join(relative, entry.name), output, predicate)
    }
}

function gitBlobOid(content)
{
    return createHash('sha1')
        .update(Buffer.from(`blob ${content.length}\0`, 'ascii'))
        .update(content)
        .digest('hex')
}

function gitBlobContents(gitAuthority, entries)
{
    const oids = [...new Set(entries.map((entry) => entry.oid))]
    if (oids.length === 0) return new Map()
    const batch = runGitRepository(gitAuthority, ['cat-file', '--batch'], {
        encoding: null,
        input: `${oids.join('\n')}\n`,
        maxBuffer: 256 * 1024 * 1024
    })
    const blobs = new Map()
    let offset = 0
    for (const expectedOid of oids)
    {
        const headerEnd = batch.indexOf(0x0a, offset)
        if (headerEnd < 0) zeroLegacyFail(`git blob header is missing for ${expectedOid}`)
        const [oid, type, sizeText] = batch.subarray(offset, headerEnd).toString('ascii').split(' ')
        const size = Number.parseInt(sizeText, 10)
        if (oid !== expectedOid || type !== 'blob' || !Number.isSafeInteger(size) || size < 0)
        {
            zeroLegacyFail(`git index blob identity is invalid for ${expectedOid}`)
        }
        const contentStart = headerEnd + 1
        const contentEnd = contentStart + size
        if (contentEnd >= batch.length || batch[contentEnd] !== 0x0a)
        {
            zeroLegacyFail(`git index blob is truncated for ${expectedOid}`)
        }
        const content = Buffer.from(batch.subarray(contentStart, contentEnd))
        if (gitBlobOid(content) !== expectedOid)
        {
            zeroLegacyFail(`git index blob content digest is invalid for ${expectedOid}`)
        }
        blobs.set(expectedOid, content)
        offset = contentEnd + 1
    }
    if (offset !== batch.length) zeroLegacyFail('git blob batch has trailing output')
    return blobs
}

function trackedRepositoryFiles(repositoryRoot)
{
    let gitAuthority
    try
    {
        gitAuthority = resolveGitRepositoryAuthority(repositoryRoot)
    }
    catch (error)
    {
        if (fs.existsSync(path.join(repositoryRoot, '.git'))) throw error
        return null
    }
    const flags = new Map(runGitRepository(gitAuthority, ['ls-files', '-t', '-z'])
        .split('\0')
        .filter(Boolean)
        .map((record) => [record.slice(2).replaceAll(path.sep, '/'), record[0]]))
    const files = []
    const gitlinks = []
    for (const record of runGitRepository(gitAuthority, ['ls-files', '-s', '-z'])
        .split('\0')
        .filter(Boolean))
    {
        const tab = record.indexOf('\t')
        if (tab < 0) zeroLegacyFail('git index record is malformed')
        const [mode, oid, stage] = record.slice(0, tab).split(' ')
        const file = record.slice(tab + 1).replaceAll(path.sep, '/')
        if (stage !== '0') zeroLegacyFail(`unmerged git index entry is unsupported: ${file}`)
        if (!/^[0-9a-f]{40}$/u.test(oid)) zeroLegacyFail(`git index OID is invalid: ${file}`)
        if (mode === '160000')
        {
            gitlinks.push(file)
            continue
        }
        if (mode !== '100644' && mode !== '100755' && mode !== '120000') zeroLegacyFail(`git index mode is unsupported: ${file} (${mode})`)
        files.push({ file, mode, oid, skipWorktree: flags.get(file) === 'S' })
    }
    const blobs = gitBlobContents(gitAuthority, files)
    const materialized = files.map((entry) => ({ ...entry, indexContent: blobs.get(entry.oid) }))
    return {
        files: materialized.filter((entry) => entry.mode !== '120000'),
        symlinks: materialized.filter((entry) => entry.mode === '120000'),
        gitAuthority,
        gitlinks
    }
}

function collectScanFiles(repositoryRoot)
{
    const tracked = trackedRepositoryFiles(repositoryRoot)
    if (tracked)
    {
        const inScope = (file) => scanRoots.some((entry) => file === entry.path || file.startsWith(`${entry.path}/`))
            || path.posix.basename(file) === 'package.json'
        return {
            files: tracked.files.filter((entry) => inScope(entry.file)),
            gitAuthority: tracked.gitAuthority,
            symlinks: tracked.symlinks.filter((entry) => inScope(entry.file)),
            gitlinks: tracked.gitlinks.filter(inScope)
        }
    }
    const files = []
    for (const entry of scanRoots) walkFiles(repositoryRoot, entry.path, files)
    walkFiles(repositoryRoot, '.', files, (file) => path.posix.basename(file) === 'package.json')
    return { files: files.map((file) => ({ file, indexContent: null })), gitAuthority: null, symlinks: [], gitlinks: [] }
}

function inspectTrackedSymlink(repositoryRoot, entry, findings)
{
    const pathClasses = pathClassesFor(entry.file)
    const location = `git-index:${entry.oid}`
    const absolute = path.join(repositoryRoot, entry.file)
    let stat
    try
    {
        stat = fs.lstatSync(absolute)
    }
    catch
    {
        if (!entry.skipWorktree)
        {
            addFinding(findings, entry.file, pathClasses, 'tracked-worktree-index-split:missing', location)
        }
        addFinding(findings, entry.file, pathClasses, 'unsupported-tracked-symlink', location)
        return
    }
    if (!stat.isSymbolicLink())
    {
        addFinding(findings, entry.file, pathClasses, 'tracked-worktree-index-split:mode', `${location}:120000`)
    }
    else if (!fs.readlinkSync(absolute, { encoding: 'buffer' }).equals(entry.indexContent))
    {
        addFinding(findings, entry.file, pathClasses, 'tracked-worktree-index-split:oid', location)
    }
    addFinding(findings, entry.file, pathClasses, 'unsupported-tracked-symlink', location)
    let target = ''
    try
    {
        target = new TextDecoder('utf-8', { fatal: true }).decode(entry.indexContent)
    }
    catch
    {
        addFinding(findings, entry.file, pathClasses, 'unsupported-machine-encoding', location)
    }
    if (legacySurfaceName(entry.file, { file: entry.file }) || legacySurfaceName(target, { file: entry.file }))
    {
        addFinding(findings, entry.file, pathClasses, `forbidden-legacy-surface:${target || path.posix.basename(entry.file)}`, 'symlink-target')
    }
}

function inventoryFileContent(repositoryRoot, entry, findings, pathClasses)
{
    if (entry.indexContent === null) return fs.readFileSync(path.join(repositoryRoot, entry.file))
    const absolute = path.join(repositoryRoot, entry.file)
    let stat
    try
    {
        stat = fs.lstatSync(absolute)
    }
    catch
    {
        if (!entry.skipWorktree)
        {
            addFinding(findings, entry.file, pathClasses, 'tracked-worktree-index-split:missing', `git-index:${entry.oid}`)
        }
        return entry.indexContent
    }
    if (!stat.isFile())
    {
        addFinding(findings, entry.file, pathClasses, 'tracked-worktree-index-split:mode', `git-index:${entry.mode}:${entry.oid}`)
        return entry.indexContent
    }
    const executable = (stat.mode & 0o111) !== 0
    if ((entry.mode === '100755') !== executable)
    {
        addFinding(findings, entry.file, pathClasses, 'tracked-worktree-index-split:mode', `git-index:${entry.mode}:${entry.oid}`)
    }
    const worktreeContent = fs.readFileSync(absolute)
    if (!worktreeContent.equals(entry.indexContent))
    {
        addFinding(findings, entry.file, pathClasses, 'tracked-worktree-index-split:oid', `git-index:${entry.oid}`)
        return worktreeContent
    }
    return entry.indexContent
}

function decodeMachineText(content)
{
    if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe)
    {
        return new TextDecoder('utf-16le', { fatal: true }).decode(content)
    }
    if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff)
    {
        return new TextDecoder('utf-16be', { fatal: true }).decode(content)
    }
    const utf8 = content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
        ? content.subarray(3)
        : content
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(utf8)
    if (decoded.includes('\0')) throw new TypeError('machine text encoding is ambiguous without a BOM')
    return decoded
}

export function validateZeroLegacyScan(scan)
{
    if (scan?.schema !== zeroLegacyScanSchema) zeroLegacyFail('scan schema mismatch')
    if (JSON.stringify(scan.scanRoots) !== JSON.stringify(scanRoots)) zeroLegacyFail('scan roots are incomplete')
    const pathClassKeys = Object.keys(scan.pathClassCounts ?? {}).sort()
    if (JSON.stringify(pathClassKeys) !== JSON.stringify([...zeroLegacyRequiredPathClasses].sort())) zeroLegacyFail('path classes are incomplete')
    if (!Number.isInteger(scan.scannedFileCount) || scan.scannedFileCount < 0) zeroLegacyFail('scanned file count is invalid')
    if (pathClassKeys.some((key) => !Number.isInteger(scan.pathClassCounts[key]) || scan.pathClassCounts[key] < 0)) zeroLegacyFail('path class count is invalid')
    if (!Array.isArray(scan.findings)) zeroLegacyFail('findings are invalid')
    for (const finding of scan.findings)
    {
        if (!finding || typeof finding.file !== 'string' || finding.file.length === 0
            || !Array.isArray(finding.pathClasses) || finding.pathClasses.length === 0
            || finding.pathClasses.some((entry) => !zeroLegacyRequiredPathClasses.includes(entry))
            || typeof finding.rule !== 'string' || finding.rule.length === 0
            || typeof finding.location !== 'string' || finding.location.length === 0)
        {
            zeroLegacyFail('finding shape is invalid')
        }
    }
    return scan
}

export function scanZeroLegacyGovernance(repositoryRoot = root)
{
    repositoryRoot = fs.realpathSync(path.resolve(repositoryRoot))
    const inventory = collectScanFiles(repositoryRoot)
    let admittedYamlParser = null
    let admittedJsoncParser = null
    const loadYamlParser = () =>
    {
        admittedYamlParser ??= canonicalYamlParser(repositoryRoot, inventory)
        return admittedYamlParser
    }
    const loadJsoncParser = () =>
    {
        admittedJsoncParser ??= canonicalJsoncParser(repositoryRoot, inventory)
        return admittedJsoncParser
    }
    const uniqueFiles = [...new Map(inventory.files.map((entry) => [entry.file, entry])).values()]
        .sort((left, right) => left.file.localeCompare(right.file))
    const pathClassCounts = Object.fromEntries(zeroLegacyRequiredPathClasses.map((pathClass) => [pathClass, 0]))
    const findings = []
    for (const entry of [...new Map(inventory.symlinks.map((item) => [item.file, item])).values()]
        .sort((left, right) => left.file.localeCompare(right.file)))
    {
        inspectTrackedSymlink(repositoryRoot, entry, findings)
    }
    for (const file of [...new Set(inventory.gitlinks)].sort())
    {
        addFinding(findings, file, pathClassesFor(file), 'unsupported-tracked-gitlink', 'git-index')
    }
    for (const entry of uniqueFiles)
    {
        const file = entry.file
        const pathClasses = pathClassesFor(file)
        pathClasses.forEach((pathClass) => { pathClassCounts[pathClass] += 1 })
        const context = {
            file,
            findings,
            pathClasses,
            qualification: isQualificationPath(file),
            jsoncParser: loadJsoncParser,
            yamlParser: loadYamlParser
        }
        const content = inventoryFileContent(repositoryRoot, entry, findings, pathClasses)
        const markdownDocument = pathClasses.includes('docs') && /\.md$/iu.test(file)
        const yamlDocument = /\.ya?ml$/iu.test(file)
        const scansContent = /\.jsonc?$/iu.test(file) || markdownDocument || machineSourceExtensions.test(file)
        let source = null
        if (scansContent)
        {
            try
            {
                source = decodeMachineText(content)
            }
            catch
            {
                addFinding(findings, file, pathClasses, 'unsupported-machine-encoding', 'content')
                continue
            }
        }
        if (/\.jsonc?$/iu.test(file))
        {
            const parser = loadJsoncParser()
            try
            {
                const document = parseMachineJson(source, file, parser)
                const jsonSchemaDocument = file.endsWith('.schema.json')
                    && typeof document?.$schema === 'string'
                    && jsonSchemaDialectPattern.test(document.$schema)
                scanObjectKeys(document, { ...context, jsonSchemaDocument })
                if (pathClasses.includes('package-scripts')) scanPackageScripts(document, context)
            }
            catch
            {
                addFinding(findings, file, pathClasses, 'invalid-machine-json', '$')
            }
        }
        if (yamlDocument)
        {
            const parser = loadYamlParser()
            try
            {
                scanMachineYaml(source, context, parser)
            }
            catch
            {
                addFinding(findings, file, pathClasses, 'invalid-machine-yaml', '$')
            }
        }
        if (markdownDocument)
        {
            scanDocumentFences(source, context)
        }
        if (machineSourceExtensions.test(file) && !yamlDocument)
        {
            scanMachineSource(source, context)
        }
        if (legacySurfaceName(file, { file }))
        {
            addFinding(findings, file, pathClasses, `forbidden-legacy-surface:${path.posix.basename(file)}`, 'path')
        }
    }
    const uniqueFindings = [...new Map(findings.map((finding) => [
        `${finding.file}\0${finding.rule}\0${finding.location}`,
        finding
    ])).values()].sort((left, right) => `${left.file}\0${left.rule}\0${left.location}`.localeCompare(`${right.file}\0${right.rule}\0${right.location}`))
    return validateZeroLegacyScan({
        schema: scannerSchemaValue(),
        scanRoots: scanRoots.map((entry) => ({ ...entry })),
        scannedFileCount: uniqueFiles.length,
        pathClassCounts,
        findings: uniqueFindings
    })
}

const stable = (value) => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
        : value
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`
const withoutDigest = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contentDigest'))
const normalizeDigest = (value) => String(value ?? '').replace(/^sha256:/u, '')
const loadJson = (value) => typeof value === 'string' ? JSON.parse(fs.readFileSync(value, 'utf8')) : structuredClone(value)

function fail(message)
{
    throw new Error(`[behavior-document-consistency-final] ${message}`)
}

function validateSealed(receipt, label, { requireOk = true } = {})
{
    if (!receipt || typeof receipt !== 'object') fail(`${label} is missing`)
    const actual = normalizeDigest(receipt.contentDigest)
    const candidates = [
        normalizeDigest(digest(withoutDigest(receipt))),
        normalizeDigest(digest({ ...receipt, contentDigest: null }))
    ]
    if (!candidates.includes(actual))
    {
        fail(`${label} contentDigest mismatch`)
    }
    if (requireOk && receipt.status !== 'ok') fail(`${label} status is not ok`)
    return receipt
}

function stronglyConnectedComponents(tiers)
{
    const graph = new Map(tiers.map((tier) => [tier.id, tier.executionDependsOn ?? []]))
    let nextIndex = 0
    const indices = new Map()
    const low = new Map()
    const stack = []
    const onStack = new Set()
    const components = []
    const visit = (id) => {
        indices.set(id, nextIndex)
        low.set(id, nextIndex)
        nextIndex += 1
        stack.push(id)
        onStack.add(id)
        for (const dependency of graph.get(id) ?? [])
        {
            if (!graph.has(dependency)) continue
            if (!indices.has(dependency))
            {
                visit(dependency)
                low.set(id, Math.min(low.get(id), low.get(dependency)))
            }
            else if (onStack.has(dependency))
            {
                low.set(id, Math.min(low.get(id), indices.get(dependency)))
            }
        }
        if (low.get(id) === indices.get(id))
        {
            const component = []
            let member
            do
            {
                member = stack.pop()
                onStack.delete(member)
                component.push(member)
            }
            while (member !== id)
            if (component.length > 1 || (graph.get(id) ?? []).includes(id)) components.push(component.sort())
        }
    }
    for (const id of graph.keys()) if (!indices.has(id)) visit(id)
    return components.sort((left, right) => left[0].localeCompare(right[0]))
}

function duplicateSummaryAuthorities(tiers)
{
    const owners = new Map()
    for (const tier of tiers)
    {
        if (!tier.summaryAuthority) continue
        const entries = owners.get(tier.summaryAuthority) ?? []
        entries.push(tier.id)
        owners.set(tier.summaryAuthority, entries)
    }
    return [...owners.entries()]
        .filter(([, tierIds]) => tierIds.length > 1)
        .map(([authority, tierIds]) => ({ authority, tierIds: tierIds.sort() }))
        .sort((left, right) => left.authority.localeCompare(right.authority))
}

export function validateFinalReport(report)
{
    if (report?.schema !== finalReportSchema) fail('report schema mismatch')
    validateZeroLegacyScan(report.zeroLegacyScan)
    if (report.contentDigest !== digest(withoutDigest(report))) fail('report contentDigest mismatch')
    if (!['ok', 'failed'].includes(report.status)) fail('report status is invalid')
    if (report.status === 'ok' && report.failureReasons.length > 0) fail('ok report has failures')
    if (report.status === 'failed' && report.failureReasons.length === 0) fail('failed report lacks failures')
    return report
}

export function buildFinalConsistencyReport({
    staticAdmissionReceipt,
    preRuntimeReceipt,
    postRuntimeReceipt,
    ownerReceipt,
    factObservationReceipts = [],
    docClaimParseReceipt,
    docClaimVerificationReceipt,
    generatedSectionReceipt,
    catalog,
    migrationLedger,
    matrix
} = {})
{
    const admission = validateSealed(loadJson(staticAdmissionReceipt), 'static admission')
    const pre = assertPreRuntimeQualified(loadJson(preRuntimeReceipt))
    const post = validatePostRuntimeReceipt(loadJson(postRuntimeReceipt))
    if (post.status !== 'ok') fail('post-runtime receipt status is not ok')
    const owner = validateSealed(loadJson(ownerReceipt), 'owner receipt')
    const claims = validateSealed(loadJson(docClaimParseReceipt), 'DocClaim parse receipt', { requireOk: false })
    const claimVerification = validateSealed(loadJson(docClaimVerificationReceipt), 'DocClaim verification receipt')
    const generated = validateSealed(loadJson(generatedSectionReceipt), 'generated section receipt')
    const facts = factObservationReceipts.map((entry, index) => validateSealed(loadJson(entry), `fact receipt ${index}`))
    const behaviorCatalog = loadJson(catalog)
    const ledger = loadJson(migrationLedger)
    const parsedMatrix = typeof matrix === 'string' && matrix.endsWith('.yml')
        ? parseMatrix(fs.readFileSync(matrix, 'utf8'))
        : loadJson(matrix)
    const failures = []
    const sourceCommit = admission.source?.commit
    const sourceFingerprint = normalizeDigest(admission.source?.worktreeFingerprint)
    const identities = [
        ['pre-runtime', pre.sourceIdentity?.commit, pre.sourceIdentity?.worktreeFingerprint, pre.runIdentity],
        ['post-runtime', post.sourceIdentity?.commit, post.sourceIdentity?.worktreeFingerprint, post.runIdentity]
    ]
    for (const [label, commit, fingerprint, runIdentity] of identities)
    {
        if (commit !== sourceCommit || normalizeDigest(fingerprint) !== sourceFingerprint) failures.push(`${label} source/worktree identity mismatch`)
        if (runIdentity !== admission.run?.id) failures.push(`${label} run identity mismatch`)
    }
    const catalogDigest = digestCatalog(behaviorCatalog)
    if (normalizeDigest(admission.authorityDigests?.catalog) !== catalogDigest
        || normalizeDigest(pre.catalogDigest) !== catalogDigest
        || normalizeDigest(post.catalogDigest) !== catalogDigest)
    {
        failures.push('catalog digest mismatch across final inputs')
    }
    const factByBehavior = new Map()
    for (const receipt of facts)
    {
        if (receipt.sourceCommit !== sourceCommit || normalizeDigest(receipt.worktreeFingerprint) !== sourceFingerprint) failures.push(`${receipt.extractorId} source identity mismatch`)
        for (const behaviorId of receipt.behaviorIds ?? [])
        {
            const entries = factByBehavior.get(behaviorId) ?? []
            entries.push(receipt.extractorId)
            factByBehavior.set(behaviorId, entries)
        }
    }
    const ownerByBehavior = new Map((owner.bindings ?? []).map((binding) => [binding.behaviorId, binding]))
    const claimsByBehavior = new Map()
    for (const claim of claims.claims ?? [])
    {
        const behaviorId = claim.declaration?.behaviorId
        const entries = claimsByBehavior.get(behaviorId) ?? []
        entries.push(claim.declaration.claimId)
        claimsByBehavior.set(behaviorId, entries)
    }
    const ledgerEntries = (ledger.scopes ?? []).flatMap((scope) => scope.entries ?? [])
    const ledgerBehaviorIds = [...new Set(ledgerEntries.map((entry) => entry.behaviorId))].sort()
    const activeContracts = behaviorCatalog.contracts.filter((contract) => contract.status === 'active' && contract.releaseQualification === true)
    const behaviorNodes = activeContracts.map((contract) => {
        const required = pre.requiredTestKinds?.[contract.id] ?? contract.requiredTestKinds ?? []
        const observed = pre.observedTestKinds?.[contract.id] ?? []
        const runtime = post.observedBehaviorResults?.find((entry) => entry.behaviorId === contract.id)
        const mutation = pre.mutationStatus?.[contract.id] ?? null
        const nodeFailures = []
        if (!ownerByBehavior.has(contract.id)) nodeFailures.push('owner')
        if ((factByBehavior.get(contract.id) ?? []).length !== 1) nodeFailures.push('fact')
        if (contract.documentationPolicy === 'required' && (claimsByBehavior.get(contract.id) ?? []).length === 0) nodeFailures.push('docs')
        if (contract.evidenceStage === 'pre-runtime' && required.some((kind) => !observed.includes(kind))) nodeFailures.push('tests')
        if (contract.mutationPolicy?.mutationRequired === true && mutation?.qualified !== true) nodeFailures.push('mutation')
        if (contract.evidenceStage === 'post-runtime' && runtime?.status !== 'ok') nodeFailures.push('runtime')
        if (nodeFailures.length > 0) failures.push(`${contract.id} incomplete edges: ${nodeFailures.join(',')}`)
        return {
            behaviorId: contract.id,
            evidenceStage: contract.evidenceStage,
            owner: ownerByBehavior.get(contract.id)?.sourcePath ?? null,
            factExtractors: [...new Set(factByBehavior.get(contract.id) ?? [])].sort(),
            requiredTestKinds: [...required].sort(),
            observedTestKinds: [...observed].sort(),
            docClaimIds: [...new Set(claimsByBehavior.get(contract.id) ?? [])].sort(),
            mutationStatus: mutation?.mutationStatus ?? (contract.mutationPolicy?.mutationRequired === true ? 'missing' : 'not-required'),
            runtimeStatus: runtime?.status ?? (contract.evidenceStage === 'post-runtime' ? 'missing' : 'not-required'),
            status: nodeFailures.length === 0 ? 'ok' : 'failed'
        }
    }).sort((left, right) => left.behaviorId.localeCompare(right.behaviorId))
    const activeIds = behaviorNodes.map((node) => node.behaviorId)
    const missingLedgerBehaviorIds = activeIds.filter((id) => behaviorCatalog.contracts.find((contract) => contract.id === id)?.documentationPolicy === 'required' && !ledgerBehaviorIds.includes(id))
    const orphanLedgerBehaviorIds = ledgerBehaviorIds.filter((id) => !activeIds.includes(id))
    if (missingLedgerBehaviorIds.length > 0) failures.push(`migration ledger missing behaviors: ${missingLedgerBehaviorIds.join(',')}`)
    if (orphanLedgerBehaviorIds.length > 0) failures.push(`migration ledger orphan behaviors: ${orphanLedgerBehaviorIds.join(',')}`)
    const sccs = stronglyConnectedComponents(parsedMatrix.tiers)
    const authorityDuplicates = duplicateSummaryAuthorities(parsedMatrix.tiers)
    if (sccs.length > 0) failures.push(`matrix dependency SCCs: ${sccs.map((entry) => entry.join('+')).join(',')}`)
    if (authorityDuplicates.length > 0) failures.push(`duplicate summary authorities: ${authorityDuplicates.map((entry) => entry.authority).join(',')}`)
    const admittedSourceRoot = String(admission.worktree?.root ?? '')
    if (!path.isAbsolute(admittedSourceRoot)
        || !fs.existsSync(admittedSourceRoot)
        || !fs.statSync(admittedSourceRoot).isDirectory())
    {
        fail('zero-legacy source root is not an absolute existing directory')
    }
    const sourceRoot = fs.realpathSync(admittedSourceRoot)
    let sourceGitAuthority
    try
    {
        sourceGitAuthority = resolveGitRepositoryAuthority(sourceRoot)
    }
    catch (error)
    {
        fail(`zero-legacy source root cannot resolve git top-level: ${error.message}`)
    }
    if (sourceRoot !== sourceGitAuthority.workTree)
    {
        fail('zero-legacy source root must equal the git top-level')
    }
    const sourceIdentityBeforeScan = sealSourceIdentity(sourceRoot)
    if (sourceIdentityBeforeScan.sourceCommit !== sourceCommit
        || normalizeDigest(sourceIdentityBeforeScan.worktreeFingerprint) !== sourceFingerprint)
    {
        fail('zero-legacy source/worktree identity mismatch before scan')
    }
    const legacy = scanZeroLegacyGovernance(sourceRoot)
    const sourceIdentityAfterScan = sealSourceIdentity(sourceRoot)
    if (sourceIdentityAfterScan.sourceCommit !== sourceCommit
        || normalizeDigest(sourceIdentityAfterScan.worktreeFingerprint) !== sourceFingerprint
        || JSON.stringify(sourceIdentityAfterScan) !== JSON.stringify(sourceIdentityBeforeScan))
    {
        fail('zero-legacy source/worktree identity changed during scan')
    }
    if (legacy.findings.length > 0) failures.push(`zero-legacy scan found ${legacy.findings.length} active residue(s)`)
    if (admission.candidateSpawnCountBeforeReceipt !== 0 || pre.runtimeCandidateSpawnCountBeforeReceipt !== 0 || post.releaseFinalSpawnCountBeforeReceipt !== 0)
    {
        failures.push('spawn-before-receipt counters must all be zero')
    }
    const uniqueFailures = [...new Set(failures)].sort()
    const report = {
        schema: finalReportSchema,
        sourceIdentity: { commit: sourceCommit, worktreeFingerprint: `sha256:${sourceFingerprint}` },
        worktreeIdentity: { root: admission.worktree?.root ?? null },
        buildIdentity: {
            minimalContractBuildDigest: admission.minimalContractBuild?.contentDigest ? `sha256:${normalizeDigest(admission.minimalContractBuild.contentDigest)}` : null,
            candidateBuildReceiptDigest: post.candidateIdentity?.buildReceiptDigest ?? null
        },
        toolchainIdentity: admission.toolchain,
        runtimeIdentity: { runId: admission.run?.id, candidate: post.candidateIdentity },
        authorityDigests: Object.fromEntries(Object.entries(admission.authorityDigests ?? {}).map(([key, value]) => [key, `sha256:${normalizeDigest(value)}`])),
        receiptDigests: {
            staticAdmission: `sha256:${normalizeDigest(admission.contentDigest)}`,
            preRuntime: pre.contentDigest.startsWith('sha256:') ? pre.contentDigest : `sha256:${pre.contentDigest}`,
            postRuntime: post.contentDigest,
            owner: `sha256:${normalizeDigest(owner.contentDigest)}`,
            docClaimParse: `sha256:${normalizeDigest(claims.contentDigest)}`,
            docClaimVerification: `sha256:${normalizeDigest(claimVerification.contentDigest)}`,
            generatedSection: `sha256:${normalizeDigest(generated.contentDigest)}`,
            facts: facts.map((receipt) => `sha256:${normalizeDigest(receipt.contentDigest)}`).sort()
        },
        behaviorNodes,
        edges: behaviorNodes.flatMap((node) => [
            { behaviorId: node.behaviorId, kind: 'owner', targets: node.owner ? [node.owner] : [] },
            { behaviorId: node.behaviorId, kind: 'fact', targets: node.factExtractors },
            { behaviorId: node.behaviorId, kind: 'test', targets: node.observedTestKinds },
            { behaviorId: node.behaviorId, kind: 'doc', targets: node.docClaimIds },
            { behaviorId: node.behaviorId, kind: 'mutation', targets: [node.mutationStatus] },
            { behaviorId: node.behaviorId, kind: 'runtime', targets: [node.runtimeStatus] }
        ]),
        migrationLedger: {
            contentDigest: digest(ledger),
            scopeCount: ledger.scopes?.length ?? 0,
            entryCount: ledgerEntries.length,
            behaviorIds: ledgerBehaviorIds,
            missingBehaviorIds: missingLedgerBehaviorIds,
            orphanBehaviorIds: orphanLedgerBehaviorIds
        },
        singleMutationCoverage: Object.fromEntries(behaviorNodes.map((node) => [node.behaviorId, node.mutationStatus])),
        zeroLegacyScan: legacy,
        dagAudit: {
            tierCount: parsedMatrix.tiers.length,
            edgeCount: parsedMatrix.tiers.reduce((count, tier) => count + (tier.executionDependsOn?.length ?? 0), 0),
            stronglyConnectedComponents: sccs,
            authorityDuplicates
        },
        spawnBeforeReceipt: {
            staticCandidate: admission.candidateSpawnCountBeforeReceipt,
            runtimeCandidate: pre.runtimeCandidateSpawnCountBeforeReceipt,
            releaseFinal: post.releaseFinalSpawnCountBeforeReceipt
        },
        status: uniqueFailures.length === 0 ? 'ok' : 'failed',
        failureReasons: uniqueFailures,
        contentDigest: null
    }
    report.contentDigest = digest(withoutDigest(report))
    return report
}

function parseArgs(argv)
{
    const options = { facts: [] }
    for (let index = 0; index < argv.length; index += 1)
    {
        const value = argv[index + 1]
        switch (argv[index])
        {
            case '--static-admission': options.staticAdmissionReceipt = value; break
            case '--pre-runtime': options.preRuntimeReceipt = value; break
            case '--post-runtime': options.postRuntimeReceipt = value; break
            case '--owner': options.ownerReceipt = value; break
            case '--fact': options.facts.push(value); break
            case '--doc-claim-parse': options.docClaimParseReceipt = value; break
            case '--doc-claim-verification': options.docClaimVerificationReceipt = value; break
            case '--generated-section': options.generatedSectionReceipt = value; break
            case '--catalog': options.catalog = value; break
            case '--migration-ledger': options.migrationLedger = value; break
            case '--matrix': options.matrix = value; break
            case '--out': options.out = value; break
            default: fail(`unknown argument ${argv[index]}`)
        }
        index += 1
    }
    return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const options = parseArgs(process.argv.slice(2))
        const report = buildFinalConsistencyReport({ ...options, factObservationReceipts: options.facts })
        validateFinalReport(report)
        if (options.out)
        {
            fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
            fs.writeFileSync(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`)
        }
        if (report.status !== 'ok') fail(report.failureReasons.join('; '))
        console.log(`[behavior-document-consistency-final] ok behaviors=${report.behaviorNodes.length}`)
    }
    catch (error)
    {
        console.error(error.message)
        process.exitCode = 1
    }
}
