#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildArticleCanonicalPackage,
  canonicalizationVersion,
  evaluateProductionDefault,
  mutationEvidence,
  stableJson,
  verifyArticleCanonicalPackage,
  writeArticleCanonicalPackage
} from './content-credential-lib.mjs'

const toolDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(toolDirectory, '../..')
const defaultFixture = path.join(repositoryRoot, 'tests/fixtures/content-credentials/article.json')
const args = process.argv.slice(2)
const command = args.shift() ?? 'check'
const options = parseOptions(args)

try {
  if (command === 'build') runBuild(options)
  else if (command === 'check') runCheck(options)
  else if (command === 'interop') runInterop(options)
  else throw new Error(`unknown command: ${command}`)
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
}

function runBuild(cliOptions) {
  const fixturePath = path.resolve(cliOptions.fixture ?? defaultFixture)
  const outputDirectory = path.resolve(requiredOption(cliOptions, 'out'))
  const articlePackage = loadPackage(fixturePath)
  writeArticleCanonicalPackage(outputDirectory, articlePackage)
  process.stdout.write(stableJson({ status: 'built', outputDirectory, packageManifest: articlePackage.packageManifest }))
}

function runCheck(cliOptions) {
  const fixturePath = path.resolve(cliOptions.fixture ?? defaultFixture)
  const fixture = readJson(fixturePath)
  const fixtureDirectory = path.dirname(fixturePath)
  const articlePackage = buildArticleCanonicalPackage(fixture, { fixtureDirectory })
  const verification = verifyArticleCanonicalPackage(articlePackage)
  const tamperCases = mutationEvidence(fixture, { fixtureDirectory })
  const productionDecision = evaluateProductionDefault({
    canonicalization: canonicalizationVersion,
    canonicalizationFrozen: true,
    verifiers: [],
    tamperCases,
    staticDownload: false,
    cacheRestore: false,
    redeploy: false,
    noJavaScriptReadable: true,
    keyRotation: false,
    keyRevocation: false,
    privacyReview: true,
    performanceBudget: false
  })
  if (!verification.accepted || tamperCases.some(item => !item.detected)) throw new Error(`prototype self-check failed: ${stableJson({ verification, tamperCases })}`)
  process.stdout.write(stableJson({
    schema: 'fsusblog.c2pa-prototype-check.v1',
    status: 'passed',
    ordinaryDevelopmentRequiresC2paTool: false,
    verification,
    tamperCases,
    productionDecision
  }))
}

function runInterop(cliOptions) {
  const fixturePath = path.resolve(cliOptions.fixture ?? defaultFixture)
  const outputDirectory = path.resolve(cliOptions.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-c2pa-')))
  const c2patool = cliOptions.c2patool ?? process.env.C2PATOOL ?? 'c2patool'
  const version = spawnSync(c2patool, ['--version'], { encoding: 'utf8' })
  if (version.error?.code === 'ENOENT') {
    process.stdout.write(stableJson({
      schema: 'fsusblog.c2pa-interop-report.v1',
      status: 'unavailable',
      productionDefault: false,
      reason: 'c2patool-not-installed',
      expectedVersion: '0.26.60'
    }))
    return
  }
  if (version.status !== 0) throw new Error(`c2patool version check failed: ${version.stderr || version.stdout}`)
  const versionText = `${version.stdout}${version.stderr}`.trim()
  if (!/\b0\.26\.60\b/u.test(versionText)) throw new Error(`c2patool 0.26.60 is required; received: ${versionText}`)

  const articlePackage = loadPackage(fixturePath)
  writeArticleCanonicalPackage(outputDirectory, articlePackage)
  const sourceAsset = path.join(outputDirectory, 'assets', 'cover.svg')
  const signedAsset = path.join(outputDirectory, 'signed-cover.svg')
  const manifestDefinition = path.join(outputDirectory, 'manifest-definition.json')
  const sign = spawn(c2patool, [sourceAsset, '--manifest', manifestDefinition, '--sidecar', '--create', 'digitalArt', '--output', signedAsset, '--force'])
  const verify = spawn(c2patool, [signedAsset, '--detailed'])
  const verifyReport = parseJsonOutput(verify.stdout, 'c2patool verification')
  const validationFailures = collectValidationFailures(verifyReport)
  const verificationEntry = buildVerificationEntry(verifyReport, articlePackage)
  const externalManifest = signedAsset.replace(/\.svg$/u, '.c2pa')
  if (!fs.existsSync(externalManifest)) throw new Error(`c2patool did not emit external manifest: ${externalManifest}`)

  const tamperedAsset = path.join(outputDirectory, 'tampered-cover.svg')
  const signedSvg = fs.readFileSync(signedAsset, 'utf8')
  const tamperedSvg = signedSvg.replace('#172033', '#172034')
  if (tamperedSvg === signedSvg) throw new Error('unable to create deterministic SVG tamper case')
  fs.writeFileSync(tamperedAsset, tamperedSvg)
  const tamperedVerification = spawn(c2patool, [tamperedAsset, '--external-manifest', externalManifest, '--detailed'])
  const tamperedReport = parseJsonOutput(tamperedVerification.stdout, 'c2patool tamper verification')
  const tamperFailures = collectValidationFailures(tamperedReport)
  if (tamperFailures.length === 0) throw new Error('c2patool accepted a tampered asset against the original external manifest')

  const portabilityReceipts = ['static-download', 'cache-restore', 'redeploy'].map(name => {
    const directory = path.join(outputDirectory, 'portability', name)
    fs.mkdirSync(directory, { recursive: true })
    const assetCopy = path.join(directory, 'article-cover.svg')
    const manifestCopy = path.join(directory, 'article-cover.c2pa')
    fs.copyFileSync(signedAsset, assetCopy)
    fs.copyFileSync(externalManifest, manifestCopy)
    const result = spawn(c2patool, [assetCopy, '--external-manifest', manifestCopy, '--detailed'])
    const failures = collectValidationFailures(parseJsonOutput(result.stdout, `${name} verification`))
    return { scenario: name, verified: failures.length === 0, failures }
  })

  const report = {
    schema: 'fsusblog.c2pa-interop-report.v1',
    status: validationFailures.length === 0 ? 'partial' : 'failed',
    productionDefault: false,
    canonicalization: canonicalizationVersion,
    manifestUrl: articlePackage.metadata.manifestUrl,
    primaryVerifier: {
      name: 'c2patool',
      implementationFamily: 'c2pa-rs',
      version: versionText,
      status: validationFailures.length === 0 ? 'passed' : 'failed',
      validationFailures,
      trustStatus: verificationEntry.credentialTrusted ? 'trusted' : 'untrusted-test-certificate'
    },
    secondaryVerifier: {
      status: 'unavailable',
      reason: 'independent-non-c2pa-rs-verifier-not-configured'
    },
    tamperEvidence: {
      case: 'cover',
      detected: tamperFailures.length > 0,
      validationFailures: tamperFailures
    },
    portabilityReceipts,
    signedAsset: path.relative(outputDirectory, signedAsset),
    externalManifest: path.relative(outputDirectory, externalManifest),
    verificationEntry: 'verification-entry.json',
    limitation: 'A second implementation family plus key rotation, revocation, privacy approval, and performance receipts are required before production-default.'
  }
  fs.writeFileSync(path.join(outputDirectory, 'verification-entry.json'), stableJson(verificationEntry))
  fs.writeFileSync(path.join(outputDirectory, 'interop-report.json'), stableJson(report))
  if (report.status === 'failed') throw new Error(`c2patool verification failed: ${stableJson(report)}`)
  process.stdout.write(stableJson(report))
}

function buildVerificationEntry(report, articlePackage) {
  const manifestId = report.active_manifest
  const manifest = manifestId ? report.manifests?.[manifestId] : null
  const successes = report.validation_results?.activeManifest?.success ?? []
  const failures = report.validation_results?.activeManifest?.failure ?? []
  const article = manifest?.assertion_store?.['org.fsusblog.article']?.article ?? articlePackage.assertion.article
  const signature = manifest?.signature ?? {}
  return {
    schema: 'fsusblog.content-credential-verification.v1',
    status: !manifest
      ? 'manifest_unavailable'
      : failures.some(item => item.code === 'assertion.dataHash.mismatch')
        ? 'digest_mismatch'
        : failures.some(item => item.code === 'signingCredential.untrusted')
          ? 'credential_untrusted'
          : 'verified',
    manifestPresent: Boolean(manifest),
    manifestId: manifestId ?? null,
    signatureValid: successes.some(item => item.code === 'claimSignature.validated'),
    contentBindingValid: successes.some(item => item.code === 'assertion.dataHash.match'),
    credentialTrusted: !failures.some(item => item.code === 'signingCredential.untrusted'),
    signer: {
      algorithm: signature.alg ?? null,
      issuer: signature.issuer ?? null,
      commonName: signature.common_name ?? null
    },
    publishedAt: article.publishedAt,
    articleId: article.articleId,
    revisionId: article.revisionId,
    actions: manifest?.assertion_store?.['c2pa.actions.v2']?.actions?.map(item => item.action) ?? [],
    errorCodes: failures.map(item => item.code).sort()
  }
}

function loadPackage(fixturePath) {
  return buildArticleCanonicalPackage(readJson(fixturePath), { fixtureDirectory: path.dirname(fixturePath) })
}

function spawn(command, argv) {
  const result = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`)
  return result
}

function collectValidationFailures(report) {
  const failures = []
  visit(report)
  return failures

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    if (typeof value.code === 'string' && /(?:mismatch|invalid|missing|error|failure)/iu.test(value.code)) failures.push(value.code)
    Object.values(value).forEach(visit)
  }
}

function parseJsonOutput(value, name) {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${name} did not return JSON: ${error.message}\n${value.slice(0, 1000)}`)
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function requiredOption(cliOptions, name) {
  if (!cliOptions[name]) throw new Error(`--${name} is required`)
  return cliOptions[name]
}

function parseOptions(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const name = token.slice(2)
    const value = values[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${token} requires a value`)
    parsed[name] = value
    index += 1
  }
  return parsed
}
