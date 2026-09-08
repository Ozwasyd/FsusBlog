import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { digestValue } from '../../../tools/fact-extractors/lib/canonicalize.mjs'
import { sealBrowserContractReceipt } from '../../../tools/release/test-evidence-receipts.mjs'
import { deriveBrowserObservedRawFacts } from '../../../tools/test-evidence/browser-contract-observed-facts.mjs'
import { selectBrowserContractScenarios } from '../../browser-contract/contract-core.mjs'
import { createReleaseRolloutEvidenceFixture } from './release-rollout-evidence-fixture.mjs'
import { createCanonicalPreparedFixture, createCanonicalProbeSourceFixture,
    createCanonicalAotSourceFixture, createCanonicalHydrationFixtureObservation } from './canonical-post-runtime-source-fixture.mjs'
import { authorityDigest, identityAuthoritySchema, loadPostRuntimeProducerRegistry, root,
    sourceReceiptSchema } from '../../../tools/test-matrix/post-runtime-producer-registry.mjs'

const digest = (character) => `sha256:${character.repeat(64)}`

/** Synthetic observations reuse the registry tests' canonical builders.
 * All classes share one admitted build and candidate; no runtime is executed. */
export function createCanonicalPostRuntimeJoinObservations(receiptRepositoryRoot, expectedSource)
{
    const registry = loadPostRuntimeProducerRegistry(root)
    const previewQuality = JSON.parse(fs.readFileSync(path.join(root, 'docs/assets/visual-evidence/public-preview-quality.json'), 'utf8'))
    const commonIdentity = { sourceCommit: expectedSource.commit,
        worktreeFingerprint: `sha256:${expectedSource.worktreeFingerprint}`,
        releaseId: `20260830123456-${expectedSource.commit.slice(0, 12)}` }
    const manifest = `${JSON.stringify({ 'src/main.ts': { file: 'assets/main.js', isEntry: true } }, null, 2)}\n`
    const canonicalBuild = seal({ schema: 'fsusblog.ci-production-build-receipt.v1',
        sourceState: { commit: commonIdentity.sourceCommit, worktreeFingerprint: commonIdentity.worktreeFingerprint },
        artifacts: [{ path: 'frontend-dist/.vite/manifest.json',
            sha256: `sha256:${createHash('sha256').update(manifest).digest('hex')}` }] })
    fs.mkdirSync(path.join(receiptRepositoryRoot, '.tmp/current-run'), { recursive: true })
    function seal(receipt)
    {
        const value = structuredClone(receipt)
        delete value.contentDigest
        return { ...value, contentDigest: `sha256:${digestValue(value)}` }
    }

    function producerReceipt(classId)
    {
        const producer = registry.producers[0]
        const definition = registry.observationClasses[classId]
        const requiredModes = Object.entries(producer.requiredObservations)
            .filter(([, classes]) => classes.includes(classId))
            .map(([mode]) => mode)
            .sort()
        const allSourceState = {
            sourceCommit: 'a'.repeat(40),
            worktreeFingerprint: digest('b'),
            buildIdentity: digest('c'),
            artifactDigest: digest('2'),
            candidateId: 'run-1:candidate',
            runtimeId: 'run-1:runtime',
            browserIdentity: 'run-1:browser-contract',
            releaseId: '20260830123456-abcdef123456',
            rolloutId: 'run-1-rollout',
            runId: 'run-1',
            attemptId: 'attempt-0001',
            fixtureId: 'run-1:fixture',
            profileId: 'acceptance-representative'
        }
        Object.assign(allSourceState, commonIdentity, { buildIdentity: canonicalBuild.contentDigest })
        const sourceState = Object.fromEntries(definition.requiredIdentityFields
            .filter((field) => !['producerId', 'toolVersion', 'contentDigest'].includes(field))
            .map((field) => [field, allSourceState[field]]))
        const rawFieldFor = (field) => field.endsWith('Digest') ? field.slice(0, -'Digest'.length) : field
        const rawFacts = Object.fromEntries(definition.requiredSemanticFactFields.map((field) =>
        {
            const rawField = rawFieldFor(field)
            const value = field === 'responseStatus'
                ? 200
                : sourceState[field] ?? `${rawField}-raw-value`
            return [rawField, value]
        }))
        const semanticFacts = Object.fromEntries(definition.requiredSemanticFactFields.map((field) =>
            [field, field.endsWith('Digest') ? authorityDigest(rawFacts[rawFieldFor(field)]) : rawFacts[field]]))
        const writeDependency = (relative, document, role = null) =>
        {
            const absolute = path.join(receiptRepositoryRoot, relative)
            fs.mkdirSync(path.dirname(absolute), { recursive: true })
            fs.writeFileSync(absolute, `${JSON.stringify(document, null, 2)}\n`)
            const reference = {
                path: relative,
                fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`,
                contentDigest: document.contentDigest ?? null,
                schema: document.schema
            }
            if (role !== null) reference.role = role
            return reference
        }
        const embeddedDocument = (contract) =>
        {
            if (contract.schema === 'fsusblog.ci-production-build-receipt.v1') return canonicalBuild
            if (contract.schema === 'fsusblog.fixture-prepare-state.v1') return createCanonicalPreparedFixture(sourceState)
            if (contract.schema === 'fsusblog.release-rollout-evidence.v1')
            {
                const base = path.join(receiptRepositoryRoot, '.tmp/release-rollout')
                fs.mkdirSync(base, { recursive: true })
                return createReleaseRolloutEvidenceFixture({
                    rolloutId: sourceState.rolloutId ?? `${sourceState.runId}-rollout`,
                    target: { ...createReleaseRolloutEvidenceFixture().target, releaseId: sourceState.releaseId }
                }).createFinalEvidence(fs.mkdtempSync(path.join(base, `${classId}-`))).value
            }
            const source = {
                commit: sourceState.sourceCommit,
                worktreeFingerprint: sourceState.worktreeFingerprint
            }
            const bySchema = {
                'fsusblog.ci-production-build-receipt.v1': { sourceState: source },
                'fsusblog.fixture-receipt.v2': {
                    executionIdentity: { runId: sourceState.runId, source },
                    profileIdentity: { profileId: sourceState.profileId }
                },
                'fsusblog.post-runtime-candidate-plan.v1': {
                    executionIdentity: { runId: sourceState.runId, source },
                    candidate: { candidateId: sourceState.candidateId }
                },
                'fsusblog.spa-manifest-descriptor.v1': {
                    sourceCommit: sourceState.sourceCommit,
                    worktreeFingerprint: sourceState.worktreeFingerprint,
                    buildReceiptDigest: sourceState.buildIdentity
                },
                'fsusblog.browser-contract-receipt.v2': {
                    sourceState: source,
                    runIdentity: { runId: sourceState.runId }
                },
                'fsusblog.public-preview-screenshot-verification.v1': {
                    status: 'ok', sourceCommit: sourceState.sourceCommit,
                    releaseId: `20260718000000-${sourceState.sourceCommit.slice(0, 12)}`,
                    manifestSchema: 'fsusblog.public-preview-screenshot-manifest.v1',
                    visualInputDigest: 'c'.repeat(64), runtimeAudit: true, layoutAudit: true,
                    sanitizationCheck: true, differences: [], commandVersion: 'd'.repeat(64),
                    qualityAudit: true, qualityPolicyDigest: previewQuality.policyDigest, quality: structuredClone(previewQuality),
                    images: Object.fromEntries(Array.from({ length: 9 }, (_, index) =>
                        [`screenshot-${index + 1}`, `${index + 1}`.repeat(64)]))
                },
                'fsusblog.runtime-role-observation.v1': { observationDigest: digest('1') }
            }
            const document = { schema: contract.schema, ...bySchema[contract.schema] }
            return contract.schema === 'fsusblog.public-preview-screenshot-verification.v1' ? document : seal(document)
        }
        const embeddedReference = (field, contract) =>
        {
            const receiptPaths = {
                'fsusblog.ci-production-build-receipt.v1': '.tmp/ci-production-build/receipt.json',
                'fsusblog.fixture-prepare-state.v1': '.tmp/fixtures/run-1/prepare-state.json',
                'fsusblog.post-runtime-candidate-plan.v1': '.tmp/post-runtime-plan/run-1/attempt-0001/candidate-plan.json',
                'fsusblog.spa-manifest-descriptor.v1': '.tmp/aot-manifest/spa-manifest-descriptor.json',
                'fsusblog.browser-contract-receipt.v2': '.tmp/browser-contract/receipt.json',
                'fsusblog.public-preview-screenshot-verification.v1': '.tmp/release-evidence/public-preview-screenshots.json',
                'fsusblog.release-rollout-evidence.v1': `.tmp/release-rollout/${classId}.json`,
                'fsusblog.runtime-role-observation.v1': '.tmp/behavior-doc-static-admission/runtime-role-observation.json'
            }
            return writeDependency(
                receiptPaths[contract.schema]
                    ?? `.tmp/post-runtime-dependencies/${classId}-${field.replaceAll('.', '-')}.json`,
                embeddedDocument(contract),
                contract.role)
        }
        let canonicalRerunCommand = 'node tools/test-evidence/runtime-observation-probes.mjs route'
        let independentVerifyCommand = 'node tools/test-evidence/runtime-observation-raw.mjs verify'
        const upstreamBody = {
            schema: definition.sourceReceipt.schema,
            producerId: producer.producerId,
            toolVersion: producer.toolVersion,
            sourceState,
            rawFacts,
            canonicalRerunCommand,
            independentVerifyCommand
        }
        if (definition.sourceReceipt.discriminator !== null)
        {
            upstreamBody[definition.sourceReceipt.discriminator.field] =
                definition.sourceReceipt.discriminator.value
        }
        for (const field of definition.sourceReceipt.requiredReferenceFields)
        {
            upstreamBody[field] = embeddedReference(field,
                definition.sourceReceipt.referenceContracts[field])
        }
        if (definition.sourceReceipt.referenceMap !== null)
        {
            const map = definition.sourceReceipt.referenceMap
            upstreamBody[map.field] = Object.fromEntries(map.keys.map((key) =>
            {
                const referenceKey = `${map.field}.${key}`
                return [key, embeddedReference(referenceKey,
                    definition.sourceReceipt.referenceContracts[referenceKey])]
            }))
        }
        for (const field of definition.sourceReceipt.requiredFields)
        {
            if (field in upstreamBody || field === 'contentDigest') continue
            upstreamBody[field] = {
                status: 'passed',
                identity: `${classId}-${field}`
            }
        }
        const upstream = seal(upstreamBody)
        const upstreamRelative = definition.sourceReceipt.role === 'probe'
            ? `.tmp/runtime-observation-probes/run-1/attempt-0001/${classId}.json`
            : definition.sourceReceipt.role === 'browser'
                ? '.tmp/browser-contract/receipt.json'
                : `.tmp/post-runtime-sources/run-1/attempt-0001/${classId}.json`
        const upstreamRef = writeDependency(upstreamRelative, upstream)
        Object.assign(upstreamRef, {
            contentDigest: upstream.contentDigest,
            schema: definition.sourceReceipt.schema,
            role: definition.sourceReceipt.role
        })
        const refs = {}
        for (const [field, role, identityField] of [
            ['candidatePlanRef', 'plan', 'runId'],
            ['attemptAuthorityRef', 'attempt', 'attemptId'],
            ['fixtureAuthorityRef', 'fixture', 'fixtureId'],
            ['profileAuthorityRef', 'profile', 'profileId']
        ])
        {
            const authority = seal({
                schema: identityAuthoritySchema,
                role,
                authorityId: sourceState[identityField],
                sourceState: Object.fromEntries([
                    'sourceCommit', 'worktreeFingerprint', 'runId', 'attemptId', 'fixtureId', 'profileId'
                ].map((identity) => [identity, allSourceState[identity]]))
            })
            const relative = `.tmp/current-run/${role}-authority.json`
            const absolute = path.join(receiptRepositoryRoot, relative)
            fs.writeFileSync(absolute, `${JSON.stringify(authority, null, 2)}\n`)
            refs[field] = {
                path: relative,
                fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`,
                contentDigest: authority.contentDigest,
                schema: identityAuthoritySchema,
                role
            }
        }
        if (definition.sourceReceipt.role === 'probe')
        {
            const canonicalSource = { commit: sourceState.sourceCommit, worktreeFingerprint: sourceState.worktreeFingerprint }
            const buildReceipt = canonicalBuild
            const buildRef = writeDependency('.tmp/ci-production-build/receipt.json', buildReceipt, 'production-build')
            sourceState.buildIdentity = buildReceipt.contentDigest
            const prepared = createCanonicalPreparedFixture(sourceState)
            const fixtureRef = writeDependency('.tmp/fixtures/run-1/prepare-state.json', prepared, 'fixture')
            const plan = seal({
                schema: 'fsusblog.post-runtime-candidate-plan.v1', producerId: producer.producerId,
                status: 'planned', sourceState: canonicalSource,
                build: { receipt: '.tmp/ci-production-build/receipt.json', receiptContentDigest: canonicalBuild.contentDigest,
                    sourceState: canonicalSource, profile: 'production' },
                candidate: { candidateId: allSourceState.candidateId, runtimeId: allSourceState.runtimeId,
                    browserId: allSourceState.browserIdentity, runId: allSourceState.runId,
                    attemptId: allSourceState.attemptId, fixtureId: allSourceState.fixtureId,
                    profileId: allSourceState.profileId, releaseId: allSourceState.releaseId },
                observations: Object.keys(registry.observationClasses).sort().map((id) =>
                    ({ classId: id, receiptPath: `.tmp/current-run/${id}.json` })),
                identityAuthorityRefs: { plan: refs.candidatePlanRef, attempt: refs.attemptAuthorityRef,
                    fixture: refs.fixtureAuthorityRef, profile: refs.profileAuthorityRef }
            })
            const planRef = writeDependency('.tmp/post-runtime-plan/run-1/attempt-0001/candidate-plan.json', plan, 'candidate-plan')
            const { upstream: probe, sourceState: probeIdentity } = createCanonicalProbeSourceFixture(classId, {
                candidatePlan: { relative: planRef.path, fileDigest: planRef.fileDigest, value: plan },
                build: { ref: { path: buildRef.path, contentDigest: buildRef.fileDigest }, value: buildReceipt },
                fixture: { ref: { path: fixtureRef.path, contentDigest: fixtureRef.fileDigest }, value: prepared },
                output: upstreamRelative
            }, { producer, sourceState })
            Object.assign(sourceState, probeIdentity)
            canonicalRerunCommand = probe.canonicalRerunCommand
            independentVerifyCommand = probe.independentVerifyCommand
            for (const field of definition.requiredSemanticFactFields)
                semanticFacts[field] = field.endsWith('Digest')
                    ? authorityDigest(probe.rawFacts[rawFieldFor(field)]) : probe.rawFacts[field]
            Object.assign(upstreamRef, writeDependency(upstreamRelative, probe, 'probe'))
        }
        if (['browser-behavior-contract', 'aot-spa-hydration'].includes(classId))
        {
            const canonicalSource = {
                commit: sourceState.sourceCommit,
                worktreeFingerprint: sourceState.worktreeFingerprint
            }
            const assetRoot = path.join(receiptRepositoryRoot, '.tmp/retained-assets', allSourceState.releaseId)
            const manifestRelative = path.relative(receiptRepositoryRoot, path.join(assetRoot, '.vite/manifest.json'))
            const manifestRef = writeDependency(manifestRelative, { 'src/main.ts': { file: 'assets/main.js', isEntry: true } })
            const inventoryRef = writeDependency(path.relative(receiptRepositoryRoot, path.join(assetRoot, 'asset-manifest.json')),
                { schema: 'fsusblog.release-assets.v1', releaseId: allSourceState.releaseId, files: [] })
            const buildReceipt = canonicalBuild
            const buildRef = writeDependency('.tmp/ci-production-build/receipt.json', buildReceipt)
            sourceState.buildIdentity = buildReceipt.contentDigest
            const build = { receipt: buildRef.path, receiptContentDigest: buildReceipt.contentDigest,
                sourceState: canonicalSource, profile: 'production' }
            const candidatePlan = seal({
                schema: 'fsusblog.post-runtime-candidate-plan.v1', producerId: producer.producerId,
                status: 'planned', sourceState: canonicalSource,
                build: { receipt: '.tmp/ci-production-build/receipt.json', receiptContentDigest: canonicalBuild.contentDigest,
                    sourceState: canonicalSource, profile: 'production' },
                candidate: { candidateId: allSourceState.candidateId, runtimeId: allSourceState.runtimeId,
                    browserId: allSourceState.browserIdentity, runId: allSourceState.runId,
                    attemptId: allSourceState.attemptId, fixtureId: allSourceState.fixtureId,
                    profileId: allSourceState.profileId, releaseId: allSourceState.releaseId },
                observations: Object.keys(registry.observationClasses).sort().map((id) =>
                    ({ classId: id, receiptPath: `.tmp/current-run/${id}.json` })),
                identityAuthorityRefs: { plan: refs.candidatePlanRef, attempt: refs.attemptAuthorityRef,
                    fixture: refs.fixtureAuthorityRef, profile: refs.profileAuthorityRef }
            })
            const candidatePlanRef = writeDependency('.tmp/post-runtime-plan/run-1/attempt-0001/candidate-plan.json',
                candidatePlan, 'candidate-plan')
            const browserPlan = seal({
                schema: 'fsusblog.playwright-browser-identity.v1', executionClass: 'correctness',
                evidenceClass: 'browser-contract', qualificationEligible: true, managedExecutable: true,
                browserName: 'chromium', browserVersion: '140.0.0', revision: '123456',
                executablePath: '/managed/chromium/chrome', executableSha256: digest('f'),
                playwright: { package: '@playwright/test', version: '1.59.1' },
                launchOptions: { headless: true }, rendering: {
                    fontSetDigest: digest('1'), localeDataDigest: digest('2'), locale: 'zh-CN',
                    deviceScaleFactor: 1, renderingMode: 'headless', colorScheme: 'light', gpuMode: 'software'
                }
            })
            const browserActual = seal({ ...browserPlan, schema: 'fsusblog.playwright-browser-actual.v1',
                planDigest: browserPlan.contentDigest, renderingObservation: {
                    locale: 'zh-CN', deviceScaleFactor: 1, colorScheme: 'light', renderer: 'SwiftShader fixture renderer'
                } })
            const publicPreviewRef = upstreamBody.publicPreviewRef ?? embeddedReference('publicPreviewRef', {
                schema: 'fsusblog.public-preview-screenshot-verification.v1', role: 'public-preview'
            })
            const preview = JSON.parse(fs.readFileSync(path.join(receiptRepositoryRoot, publicPreviewRef.path), 'utf8'))
            const browserBody = { producerId: producer.producerId, toolVersion: producer.toolVersion,
                canonicalRerunCommand: 'node tools/test-evidence/runtime-observation-probes.mjs route',
                independentVerifyCommand: 'node tools/test-evidence/runtime-observation-raw.mjs verify' }
            for (const field of registry.observationClasses['browser-behavior-contract'].sourceReceipt.requiredFields)
                if (!(field in browserBody) && field !== 'contentDigest') browserBody[field] = { status: 'passed', identity: `browser-behavior-contract-${field}` }
            let browser = sealBrowserContractReceipt({
                ...browserBody,
                sourceState: canonicalSource,
                status: 'success', classification: 'clean', error: null,
                wallClockMs: 2000,
                finalization: { state: 'complete', primary: { status: 'success' },
                    cleanup: { status: 'success' }, persistence: { attemptCount: 1 } },
                playwright: { chromiumRevision: '123456', browserIdentity: { plan: browserPlan, actual: browserActual } },
                topology: { browserLaunchCount: 1, maxConcurrentBrowserRoots: 1, retries: 0, contextCount: selectBrowserContractScenarios().length },
                build,
                fixture: { namespace: 'run-1', lifecycle: { identity: { runId: sourceState.runId, attemptId: sourceState.attemptId } } },
                runIdentity: { commit: sourceState.sourceCommit, runId: sourceState.runId,
                    attemptId: sourceState.attemptId, namespace: 'run-1' },
                scenarios: selectBrowserContractScenarios().map(({ id, capability }) => ({
                    id, capability, status: 'success', classification: 'clean', issues: [], artifacts: [],
                    startedAt: '2026-09-07T00:00:00.000Z', finishedAt: '2026-09-07T00:00:00.001Z',
                    durationMs: 1, error: null,
                    ...(id === 'public-hydration-history-reload' ? { observation: createCanonicalHydrationFixtureObservation(allSourceState.releaseId) } : {})
                })),
                schema: 'fsusblog.browser-contract-receipt.v2',
                publicPreview: { ...preview, captureContextCount: 9, evidencePath: publicPreviewRef.path,
                    evidenceFileDigest: publicPreviewRef.fileDigest },
                publicPreviewRef,
                candidatePlanRef
            })
            browser = sealBrowserContractReceipt({ ...browser, rawFacts: deriveBrowserObservedRawFacts(browser, preview) })
            if (classId === 'aot-spa-hydration')
            {
                const descriptor = seal({ schema: 'fsusblog.spa-manifest-descriptor.v1',
                    releaseId: allSourceState.releaseId, sourceCommit: sourceState.sourceCommit,
                    worktreeFingerprint: sourceState.worktreeFingerprint, buildReceiptDigest: buildReceipt.contentDigest,
                    assetRoot, manifestPath: path.join(assetRoot, '.vite/manifest.json'),
                    manifestDigest: manifestRef.fileDigest, assetInventoryDigest: inventoryRef.fileDigest })
                const inputs = {
                    manifest: { value: descriptor, ref: writeDependency('.tmp/aot-manifest/spa-manifest-descriptor.json', descriptor, 'spa-manifest') },
                    browserContract: { value: browser, ref: writeDependency('.tmp/browser-contract/receipt.json', browser, 'browser-contract') }
                }
                const readBytes = (file) => fs.readFileSync(file)
                const { upstream: aot } = createCanonicalAotSourceFixture({ candidate: { ref: candidatePlanRef },
                    plan: candidatePlan, inputs, producer, readBytes }, buildReceipt)
                for (const field of definition.requiredSemanticFactFields)
                    semanticFacts[field] = field.endsWith('Digest')
                        ? authorityDigest(aot.rawFacts[rawFieldFor(field)]) : aot.rawFacts[field]
                canonicalRerunCommand = aot.canonicalRerunCommand
                independentVerifyCommand = aot.independentVerifyCommand
                Object.assign(upstreamRef, writeDependency(upstreamRelative, aot, 'aot'))
                sourceState.artifactDigest = manifestRef.fileDigest
            }
            else
            {
            for (const field of definition.requiredSemanticFactFields)
                semanticFacts[field] = field.endsWith('Digest')
                    ? authorityDigest(browser.rawFacts[rawFieldFor(field)]) : browser.rawFacts[field]
            const browserRef = writeDependency(upstreamRelative, browser, 'browser')
            Object.assign(upstreamRef, browserRef)
            sourceState.artifactDigest = browserRef.fileDigest
            }
        }
        const sourceReceipt = seal({
            schema: sourceReceiptSchema,
            role: 'source',
            classId,
            producerId: producer.producerId,
            toolVersion: producer.toolVersion,
            sourceState,
            candidatePlanRef: refs.candidatePlanRef,
            upstreamRef,
            canonicalRerunCommand,
            independentVerifyCommand
        })
        const sourceReceiptRelative = `.tmp/post-runtime-source-receipts/run-1/attempt-0001/${classId}.json`
        const sourceReceiptAbsolute = path.join(receiptRepositoryRoot, sourceReceiptRelative)
        fs.mkdirSync(path.dirname(sourceReceiptAbsolute), { recursive: true })
        fs.writeFileSync(sourceReceiptAbsolute, `${JSON.stringify(sourceReceipt, null, 2)}\n`)
        return seal({
            schema: definition.schema,
            producerId: producer.producerId,
            toolVersion: producer.toolVersion,
            registryDigest: authorityDigest(registry),
            observationSchemaDigest: authorityDigest(JSON.parse(fs.readFileSync(
                path.join(root, 'config/schemas/post-runtime-observation-result.schema.json'), 'utf8'))),
            sourceState,
            executionClass: 'correctness',
            evidenceClass: 'correctness',
            qualificationEligible: true,
            planned: true,
            executed: true,
            outcome: 'passed',
            recovered: false,
            modes: requiredModes,
            terminal: {
                timeout: false,
                cancelled: false,
                processTreeTerminated: false,
                priorAttemptDigest: null
            },
            semanticFacts,
            ...refs,
            sourceReceiptRef: {
                path: sourceReceiptRelative,
                fileDigest: `sha256:${createHash('sha256').update(fs.readFileSync(sourceReceiptAbsolute)).digest('hex')}`,
                contentDigest: sourceReceipt.contentDigest,
                schema: sourceReceiptSchema,
                role: 'source'
            },
            canonicalRerunCommand,
            independentVerifyCommand
        })
    }


    const receipts = Object.keys(registry.observationClasses).sort().map(producerReceipt)
    return { receipts, build: canonicalBuild }
}
