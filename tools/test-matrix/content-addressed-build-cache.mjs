#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    atomicJson,
    buildCacheDomainEvidenceSchema,
    buildCacheSummarySchema,
    cachePaths,
    canonicalize,
    computeBuildCacheIdentity,
    contentDigest,
    defaultRoot,
    dependencyEvidenceFile,
    loadBuildCacheConfiguration,
    readJson,
    resolveBuildCacheEvidenceLayout,
    sha256,
    verifyBuildCacheObject
} from './content-addressed-build-cache-contract.mjs';
import {
    acquireLock,
    materializeObject,
    publishObject,
    quarantineObject,
    releaseLock
} from './content-addressed-build-cache-storage.mjs';

export {
    buildCacheConfigSchema,
    buildCacheReceiptSchema,
    buildCacheDomainEvidenceSchema,
    buildCacheSummarySchema,
    computeBuildCacheIdentity,
    loadBuildCacheConfiguration,
    verifyBuildCacheObject
} from './content-addressed-build-cache-contract.mjs';

const summaryWaitArray = new Int32Array(new SharedArrayBuffer(4));
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function sameCanonical(left, right)
{
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function evidencePaths(root, runRoot, config, domainId, runId, env)
{
    const layout = resolveBuildCacheEvidenceLayout({ root, runRoot, runId, config, env });
    return {
        layout,
        dependency: dependencyEvidenceFile(runRoot, domainId, { root, runId, config, env }),
        domain: path.join(layout.domainRoot, `${domainId}.json`),
        summary: layout.summary,
        summaryLock: layout.summaryLock
    };
}

function validateDomainEvidence(evidence, domainId, runId, config, expectedSourceState = null)
{
    const errors = [];
    if (evidence.schema !== buildCacheDomainEvidenceSchema)
    {
        errors.push('schema');
    }
    if (!['success', 'failure'].includes(evidence.status))
    {
        errors.push('status');
    }
    if (evidence.runId !== runId)
    {
        errors.push('run id');
    }
    if (evidence.domain !== domainId || !config.domains[domainId])
    {
        errors.push('domain');
    }
    if (evidence.phase !== config.domains[domainId]?.phase)
    {
        errors.push('phase');
    }
    if (!digestPattern.test(String(evidence.key ?? '')))
    {
        errors.push('key');
    }
    if (evidence.status === 'success' && !digestPattern.test(String(evidence.receiptContentDigest ?? '')))
    {
        errors.push('receipt content digest');
    }
    if (evidence.dynamicFactsCached !== false
    || !sameCanonical(evidence.dynamicFacts, config.dynamicFacts))
    {
        errors.push('dynamic facts');
    }
    if (evidence.contentDigest !== contentDigest(evidence))
    {
        errors.push('content digest');
    }
    if (expectedSourceState
    && !sameCanonical(evidence.consumerSourceState, expectedSourceState))
    {
        errors.push('consumer source state');
    }
    if (errors.length > 0)
    {
        throw new Error(`production build cache domain evidence is invalid: ${domainId}: ${errors.join('; ')}`);
    }
    return evidence;
}

function readDomainEvidenceSet(layout, config, runId)
{
    const expected = Object.keys(config.domains).sort();
    const names = fs.existsSync(layout.domainRoot) ? fs.readdirSync(layout.domainRoot).sort() : [];
    const expectedNames = expected.map(domain => `${domain}.json`);
    if (JSON.stringify(names) !== JSON.stringify(expectedNames))
    {
        throw new Error(
            `production build cache domain evidence inventory mismatch: actual=${names.join(',') || '<none>'}`
      + ` expected=${expectedNames.join(',')}`
        );
    }
    return expected.map(domain => validateDomainEvidence(
        readJson(path.join(layout.domainRoot, `${domain}.json`), `production build cache domain ${domain}`),
        domain,
        runId,
        config,
        layout.sourceState
    ));
}

export function validateBuildCacheSummary({
    root = defaultRoot,
    runRoot = null,
    runId,
    env = process.env,
    config = loadBuildCacheConfiguration(root)
})
{
    const layout = resolveBuildCacheEvidenceLayout({ root, runRoot, runId, config, env });
    const file = layout.summary;
    const summary = readJson(file, 'production build cache summary');
    const expected = Object.keys(config.domains).sort();
    const completed = [...new Set(summary.completedDomains ?? [])].sort();
    const errors = [];
    if (summary.schema !== buildCacheSummarySchema)
    {
        errors.push('summary schema');
    }
    if (summary.status !== 'complete')
    {
        errors.push(`summary status=${summary.status ?? '<missing>'}`);
    }
    if (summary.runId !== runId)
    {
        errors.push('summary run id');
    }
    if (JSON.stringify(summary.expectedDomains) !== JSON.stringify(expected))
    {
        errors.push('summary expected domains');
    }
    if (JSON.stringify(completed) !== JSON.stringify(expected))
    {
        errors.push('summary completed domains');
    }
    if (summary.dynamicFactsCached !== false)
    {
        errors.push('summary dynamic facts');
    }
    if (summary.contentDigest !== contentDigest(summary))
    {
        errors.push('summary content digest');
    }
    if (layout.sourceState && !sameCanonical(summary.sourceState, layout.sourceState))
    {
        errors.push('summary source state');
    }
    if (!Array.isArray(summary.domains) || summary.domains.some(result => result.schema !== buildCacheDomainEvidenceSchema || result.status !== 'success'))
    {
        errors.push('summary domain evidence');
    }
    let domainResults = null;
    try
    {
        domainResults = readDomainEvidenceSet(layout, config, runId);
        if (!sameCanonical(summary.domains, domainResults))
        {
            errors.push('summary/domain evidence mismatch');
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (errors.length > 0)
    {
        throw new Error(`production build cache summary is invalid: ${errors.join('; ')}`);
    }
    return { ...summary, evidenceLayout: layout, domainResults };
}

export function waitForBuildCacheSummary({
    root = defaultRoot,
    runRoot = null,
    runId,
    env = process.env,
    config = loadBuildCacheConfiguration(root)
})
{
    const layout = resolveBuildCacheEvidenceLayout({ root, runRoot, runId, config, env });
    while (true)
    {
        try
        {
            return validateBuildCacheSummary({ root, runRoot, runId, env, config });
        }
        catch (error)
        {
            const file = layout.summary;
            if (fs.existsSync(file))
            {
                const summary = readJson(file, 'production build cache summary');
                if (summary.runId === runId && ['complete', 'failure'].includes(summary.status))
                {
                    throw error;
                }
            }
            Atomics.wait(summaryWaitArray, 0, 0, 100);
        }
    }
}

function assertReadOnly(file, label)
{
    if ((fs.statSync(file).mode & 0o222) !== 0)
    {
        throw new Error(`${label} is writable: ${file}`);
    }
}

export function validatePublishedBuildCacheEvidence({
    root = defaultRoot,
    runRoot,
    runId,
    env = process.env,
    config = loadBuildCacheConfiguration(root),
    expectedCoordinationDigest = null
})
{
    const layout = resolveBuildCacheEvidenceLayout({ root, runRoot, runId, config, env });
    if (layout.mode !== 'production-fresh')
    {
        throw new Error('published build cache evidence is only defined for Production Fresh');
    }
    const summary = readJson(layout.finalSummary, 'published production build cache summary');
    const errors = [];
    const expectedDomains = Object.keys(config.domains).sort();
    if (summary.schema !== buildCacheSummarySchema || summary.status !== 'complete')
    {
        errors.push('summary schema/status');
    }
    if (summary.runId !== runId || summary.attemptId !== layout.attemptId)
    {
        errors.push('run/attempt identity');
    }
    if (!sameCanonical(summary.sourceState, layout.sourceState))
    {
        errors.push('source identity');
    }
    if (!sameCanonical(summary.expectedDomains, expectedDomains)
    || !sameCanonical(summary.completedDomains, expectedDomains))
    {
        errors.push('domain inventory');
    }
    if (summary.dynamicFactsCached !== false)
    {
        errors.push('dynamic facts');
    }
    if (summary.producer?.bundleId !== 'build-static'
    || summary.producer?.stepId !== 'production-build-artifacts')
    {
        errors.push('producer identity');
    }
    if (!digestPattern.test(String(summary.coordinationSummaryDigest ?? ''))
    || (expectedCoordinationDigest && summary.coordinationSummaryDigest !== expectedCoordinationDigest))
    {
        errors.push('coordination summary digest');
    }
    if (summary.contentDigest !== contentDigest(summary))
    {
        errors.push('summary content digest');
    }

    let domains = [];
    try
    {
        const names = fs.readdirSync(layout.finalDomainRoot).sort();
        const expectedNames = expectedDomains.map(domain => `${domain}.json`);
        if (!sameCanonical(names, expectedNames))
        {
            throw new Error(`published domain inventory mismatch: ${names.join(',') || '<none>'}`);
        }
        assertReadOnly(layout.finalDomainRoot, 'published build cache domain root');
        domains = expectedDomains.map(domain =>
        {
            const file = path.join(layout.finalDomainRoot, `${domain}.json`);
            assertReadOnly(file, `published build cache domain ${domain}`);
            return validateDomainEvidence(
                readJson(file, `published production build cache domain ${domain}`),
                domain,
                runId,
                config,
                layout.sourceState
            );
        });
        const evidenceFiles = domains.map(domain =>
        {
            const file = path.join(layout.finalDomainRoot, `${domain.domain}.json`);
            return {
                domain: domain.domain,
                path: path.relative(layout.releaseEvidenceRoot, file).replaceAll(path.sep, '/'),
                fileDigest: sha256(fs.readFileSync(file)),
                contentDigest: domain.contentDigest,
                key: domain.key,
                receiptContentDigest: domain.receiptContentDigest
            };
        });
        if (!sameCanonical(summary.domains, domains))
        {
            errors.push('published domain documents');
        }
        if (!sameCanonical(summary.evidenceFiles, evidenceFiles))
        {
            errors.push('published domain file bindings');
        }
    }
    catch (error)
    {
        errors.push(error.message);
    }
    try
    {
        assertReadOnly(layout.finalSummary, 'published build cache summary');
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (errors.length > 0)
    {
        throw new Error(`published production build cache evidence is invalid: ${errors.join('; ')}`);
    }
    return { ...summary, evidenceLayout: layout, domainResults: domains };
}

export function publishBuildCacheEvidence({
    root = defaultRoot,
    runRoot,
    runId,
    env = process.env,
    config = loadBuildCacheConfiguration(root)
})
{
    const layout = resolveBuildCacheEvidenceLayout({ root, runRoot, runId, config, env });
    if (layout.mode !== 'production-fresh')
    {
        throw new Error('final build cache evidence publication requires Production Fresh');
    }
    if (String(env.FSUSBLOG_PHYSICAL_BUNDLE_ID ?? '').trim() !== 'build-static'
    || String(env.FSUSBLOG_STEP_ID ?? '').trim() !== 'production-build-artifacts')
    {
        throw new Error('final build cache evidence publication requires the production-build-artifacts owner');
    }

    const validated = validateBuildCacheSummary({ root, runRoot, runId, env, config });
    const { domainResults } = validated;
    const coordinationSummary = { ...validated };
    delete coordinationSummary.evidenceLayout;
    delete coordinationSummary.domainResults;
    if (fs.existsSync(layout.finalSummary) || fs.existsSync(layout.finalDomainRoot))
    {
        if (!fs.existsSync(layout.finalSummary) || !fs.existsSync(layout.finalDomainRoot))
        {
            throw new Error('published production build cache evidence is incomplete');
        }
        return validatePublishedBuildCacheEvidence({
            root,
            runRoot,
            runId,
            env,
            config,
            expectedCoordinationDigest: coordinationSummary.contentDigest
        });
    }

    const temporaryDomainRoot = `${layout.finalDomainRoot}.next-${process.pid}-${randomUUID()}`;
    fs.mkdirSync(temporaryDomainRoot, { recursive: true, mode: 0o700 });
    try
    {
        for (const domain of domainResults)
        {
            const source = path.join(layout.domainRoot, `${domain.domain}.json`);
            const destination = path.join(temporaryDomainRoot, `${domain.domain}.json`);
            fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(destination, 0o444);
        }
        fs.chmodSync(temporaryDomainRoot, 0o555);
        fs.mkdirSync(path.dirname(layout.finalDomainRoot), { recursive: true });
        fs.renameSync(temporaryDomainRoot, layout.finalDomainRoot);
    }
    catch (error)
    {
        if (fs.existsSync(temporaryDomainRoot))
        {
            fs.chmodSync(temporaryDomainRoot, 0o700);
            for (const name of fs.readdirSync(temporaryDomainRoot))
            {
                fs.chmodSync(path.join(temporaryDomainRoot, name), 0o600);
            }
            fs.rmSync(temporaryDomainRoot, { recursive: true, force: true });
        }
        throw error;
    }

    const evidenceFiles = domainResults.map(domain =>
    {
        const file = path.join(layout.finalDomainRoot, `${domain.domain}.json`);
        return {
            domain: domain.domain,
            path: path.relative(layout.releaseEvidenceRoot, file).replaceAll(path.sep, '/'),
            fileDigest: sha256(fs.readFileSync(file)),
            contentDigest: domain.contentDigest,
            key: domain.key,
            receiptContentDigest: domain.receiptContentDigest
        };
    });
    const publishedPayload = {
        ...coordinationSummary,
        attemptId: layout.attemptId,
        sourceState: layout.sourceState,
        producer: {
            bundleId: 'build-static',
            stepId: 'production-build-artifacts'
        },
        coordinationSummaryDigest: coordinationSummary.contentDigest,
        domains: domainResults,
        evidenceFiles
    };
    delete publishedPayload.contentDigest;
    const published = {
        ...publishedPayload,
        contentDigest: contentDigest(publishedPayload)
    };
    atomicJson(layout.finalSummary, published);
    fs.chmodSync(layout.finalSummary, 0o444);
    return validatePublishedBuildCacheEvidence({
        root,
        runRoot,
        runId,
        env,
        config,
        expectedCoordinationDigest: coordinationSummary.contentDigest
    });
}

function writeSummary(root, config, runId, paths)
{
    fs.mkdirSync(path.dirname(paths.summaryLock), { recursive: true });
    let owned = false;
    for (let attempt = 0; attempt < 200 && !owned; attempt += 1)
    {
        try
        {
            fs.mkdirSync(paths.summaryLock);
            owned = true;
        }
        catch (error)
        {
            if (error.code !== 'EEXIST')
            {
                throw error;
            }
            Atomics.wait(summaryWaitArray, 0, 0, 10);
        }
    }
    if (!owned)
    {
        throw new Error('could not acquire production build cache evidence lock');
    }
    try
    {
        const results = fs.existsSync(paths.layout.domainRoot)
            ? fs.readdirSync(paths.layout.domainRoot)
        .filter(name => name.endsWith('.json'))
        .sort()
        .map(name => readJson(path.join(paths.layout.domainRoot, name)))
            : [];
        const expected = Object.keys(config.domains).sort();
        const actual = results.map(result => result.domain).sort();
        const summaryPayload = {
            schema: buildCacheSummarySchema,
            status: results.some(result => result.status !== 'success')
                ? 'failure'
                : sameCanonical(actual, expected) ? 'complete' : 'partial',
            runId,
            sourceState: paths.layout.sourceState ?? results[0]?.consumerSourceState ?? null,
            expectedDomains: expected,
            completedDomains: actual,
            dynamicFactsCached: false,
            domains: results,
            totals: {
                hits: results.filter(result => ['hit', 'race-hit'].includes(result.decision)).length,
                misses: results.filter(result => result.decision === 'miss').length,
                reusedBytes: results.reduce((sum, result) => sum + Number(result.metrics?.reusedBytes ?? 0), 0),
                builtBytes: results.reduce((sum, result) => sum + Number(result.metrics?.builtBytes ?? 0), 0),
                compilerInvocations: results.reduce((sum, result) => sum + Number(result.metrics?.compilerInvocations ?? 0), 0)
            }
        };
        const summary = { ...summaryPayload, contentDigest: contentDigest(summaryPayload) };
        atomicJson(paths.summary, summary);
    }
    finally
    {
        fs.rmSync(paths.summaryLock, { recursive: true, force: true });
    }
}

function writeEvidence({ root, runRoot, config, domainId, runId, env, evidence })
{
    const paths = evidencePaths(root, runRoot, config, domainId, runId, env);
    const sealedEvidence = { ...evidence, contentDigest: contentDigest(evidence) };
    atomicJson(paths.dependency, sealedEvidence);
    if (path.resolve(paths.domain) !== path.resolve(paths.dependency))
    {
        atomicJson(paths.domain, sealedEvidence);
    }
    writeSummary(root, config, runId, paths);
    return sealedEvidence;
}

function makeWritableTree(target)
{
    if (!fs.existsSync(target))
    {
        return;
    }
    const visit = current =>
    {
        const stat = fs.statSync(current);
        fs.chmodSync(current, stat.mode | 0o200);
        if (stat.isDirectory())
        {
            for (const entry of fs.readdirSync(current, { withFileTypes: true }))
            {
                visit(path.join(current, entry.name));
            }
        }
    };
    visit(path.resolve(target));
}

async function runCommand(command, env, cwd = defaultRoot)
{
    return await new Promise((resolve, reject) =>
    {
        const child = spawn(command[0], command.slice(1), { cwd, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`build command failed code=${code ?? '<null>'} signal=${signal ?? '<none>'}`)));
    });
}

export async function executeBuildCacheDomain({ root = defaultRoot, runRoot, domainId, command, env = process.env, execute = runCommand })
{
    const startedAt = Date.now();
    const repositoryRoot = path.resolve(root);
    const buildRoot = path.resolve(runRoot);
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? path.basename(buildRoot)).trim();
    const sourceState = {
        commit: String(env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim() || null,
        worktreeFingerprint: String(env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim() || null
    };
    const config = loadBuildCacheConfiguration(repositoryRoot);
    resolveBuildCacheEvidenceLayout({
        root: repositoryRoot,
        runRoot: buildRoot,
        runId,
        config,
        env
    });
    const computed = computeBuildCacheIdentity({
        root: repositoryRoot,
        runRoot: buildRoot,
        domainId,
        command,
        env,
        config
    });
    let verified;
    try
    {
        verified = verifyBuildCacheObject({
            root: repositoryRoot,
            runRoot: buildRoot,
            domainId,
            command,
            env,
            config
        });
    }
    catch (error)
    {
        const badPaths = error.cachePaths ?? cachePaths(repositoryRoot, computed.config, domainId, computed.key);
        const quarantine = quarantineObject(badPaths, error.message);
        throw new Error(`${error.message}; quarantined=${quarantine ?? '<none>'}`, { cause: error });
    }
    if (verified.hit)
    {
        const materialization = materializeObject({ root: repositoryRoot, objectRoot: verified.paths.objectRoot, runRoot: buildRoot, domain: verified.domain, receipt: verified.receipt, runId, sourceState, env });
        const evidence = {
            schema: buildCacheDomainEvidenceSchema,
            status: 'success',
            runId,
            domain: domainId,
            phase: verified.domain.phase,
            decision: 'hit',
            reason: verified.reason,
            key: verified.key,
            receiptContentDigest: verified.receipt.contentDigest,
            producerSourceState: verified.receipt.producerSourceState,
            consumerSourceState: sourceState,
            dynamicFactsCached: false,
            dynamicFacts: verified.config.dynamicFacts,
            metrics: {
                reusedBytes: materialization.byteCount,
                builtBytes: 0,
                compilerInvocations: 0,
                materializationMode: materialization.mode,
                materializationFallbackReason: materialization.fallbackReason,
                relocatedFiles: materialization.relocatedFiles,
                relocationReplacements: materialization.replacements,
                receiptsResealed: materialization.receiptsResealed,
                postMaterialization: materialization.postMaterialization,
                durationMs: Date.now() - startedAt
            }
        };
        return writeEvidence({
            root: repositoryRoot,
            runRoot: buildRoot,
            config: verified.config,
            domainId,
            runId,
            env,
            evidence
        });
    }
    const paths = verified.paths;
    const lock = await acquireLock(paths, verified.config, runId);
    if (!lock.owned)
    {
        const raced = verifyBuildCacheObject({ root: repositoryRoot, runRoot: buildRoot, domainId, command, env, config: verified.config });
        if (!raced.hit)
        {
            throw new Error('concurrent build cache producer completed without an object');
        }
        const materialization = materializeObject({ root: repositoryRoot, objectRoot: raced.paths.objectRoot, runRoot: buildRoot, domain: raced.domain, receipt: raced.receipt, runId, sourceState, env });
        const evidence = {
            schema: buildCacheDomainEvidenceSchema, status: 'success', runId, domain: domainId, phase: raced.domain.phase,
            decision: 'race-hit', reason: 'concurrent-producer', key: raced.key, receiptContentDigest: raced.receipt.contentDigest,
            producerSourceState: raced.receipt.producerSourceState, consumerSourceState: sourceState,
            dynamicFactsCached: false, dynamicFacts: raced.config.dynamicFacts,
            metrics: { reusedBytes: materialization.byteCount, builtBytes: 0, compilerInvocations: 0, materializationMode: materialization.mode, materializationFallbackReason: materialization.fallbackReason, relocatedFiles: materialization.relocatedFiles, relocationReplacements: materialization.replacements, receiptsResealed: materialization.receiptsResealed, postMaterialization: materialization.postMaterialization, durationMs: Date.now() - startedAt }
        };
        return writeEvidence({
            root: repositoryRoot,
            runRoot: buildRoot,
            config: raced.config,
            domainId,
            runId,
            env,
            evidence
        });
    }
    try
    {
        try
        {
            await execute(command, env, repositoryRoot);
        }
        catch (error)
        {
            const failureEvidence = {
                schema: buildCacheDomainEvidenceSchema,
                status: 'failure',
                runId,
                domain: domainId,
                phase: verified.domain.phase,
                decision: 'miss',
                reason: 'producer-command-failed',
                key: verified.key,
                receiptContentDigest: null,
                producerSourceState: sourceState,
                consumerSourceState: sourceState,
                dynamicFactsCached: false,
                dynamicFacts: verified.config.dynamicFacts,
                error: error instanceof Error ? error.message : String(error),
                metrics: {
                    reusedBytes: 0,
                    builtBytes: 0,
                    compilerInvocations: 1,
                    materializationMode: null,
                    receiptsResealed: 0,
                    postMaterialization: [],
                    durationMs: Date.now() - startedAt
                }
            };
            writeEvidence({
                root: repositoryRoot,
                runRoot: buildRoot,
                config: verified.config,
                domainId,
                runId,
                env,
                evidence: failureEvidence
            });
            throw error;
        }
        const receipt = publishObject({ root: repositoryRoot, runRoot: buildRoot, computed: verified, paths, command, sourceState });
        const evidence = {
            schema: buildCacheDomainEvidenceSchema,
            status: 'success', runId, domain: domainId, phase: verified.domain.phase,
            decision: 'miss', reason: verified.reason, key: verified.key, receiptContentDigest: receipt.contentDigest,
            producerSourceState: sourceState, consumerSourceState: sourceState,
            dynamicFactsCached: false, dynamicFacts: verified.config.dynamicFacts,
            metrics: {
                reusedBytes: 0,
                builtBytes: receipt.artifactTree.byteCount,
                compilerInvocations: 1,
                materializationMode: null,
                receiptsResealed: 0,
                postMaterialization: [],
                publicationMode: receipt.publication.mode,
                publicationFallbackReason: receipt.publication.fallbackReason,
                durationMs: Date.now() - startedAt
            }
        };
        return writeEvidence({
            root: repositoryRoot,
            runRoot: buildRoot,
            config: verified.config,
            domainId,
            runId,
            env,
            evidence
        });
    }
    finally
    {
        if (fs.existsSync(paths.stagingRoot))
        {
            makeWritableTree(paths.stagingRoot);
            fs.rmSync(paths.stagingRoot, { recursive: true, force: true });
        }
        if (fs.existsSync(paths.lockRoot))
        {
            makeWritableTree(paths.lockRoot);
            releaseLock(paths);
        }
        else
        {
            releaseLock(paths);
        }
    }
}

function parseCli(argv)
{
    const [verb, ...rest] = argv;
    if (['check-summary', 'wait-summary', 'publish-summary'].includes(verb))
    {
        return { verb };
    }
    if (verb !== 'run')
    {
        throw new Error('content-addressed build cache command must be run, check-summary, wait-summary, or publish-summary');
    }
    const separator = rest.indexOf('--');
    if (separator < 0)
    {
        throw new Error('content-addressed build cache run requires -- before the command');
    }
    const options = rest.slice(0, separator);
    const command = rest.slice(separator + 1);
    const domainIndex = options.indexOf('--domain');
    if (domainIndex < 0 || !options[domainIndex + 1])
    {
        throw new Error('--domain is required');
    }
    if (command.length === 0)
    {
        throw new Error('build command is required');
    }
    return { verb, domainId: options[domainIndex + 1], command };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = parseCli(process.argv.slice(2));
    const runRoot = String(process.env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '').trim();
    if (!runRoot)
    {
        throw new Error('FSUSBLOG_PRODUCTION_BUILD_ROOT is required');
    }
    if (['check-summary', 'wait-summary', 'publish-summary'].includes(args.verb))
    {
        const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? path.basename(runRoot)).trim();
        try
        {
            const summary = args.verb === 'wait-summary'
                ? waitForBuildCacheSummary({ runRoot, runId })
                : args.verb === 'publish-summary'
          ? publishBuildCacheEvidence({ runRoot, runId })
          : validateBuildCacheSummary({ runRoot, runId });
            console.log(`[build-cache] complete domains=${summary.completedDomains.length} hits=${summary.totals.hits} misses=${summary.totals.misses}`);
        }
        catch (error)
        {
            console.error(`[build-cache] fatal: ${error.message}`);
            process.exitCode = 1;
        }
    }
    else
    {
        executeBuildCacheDomain({ runRoot, domainId: args.domainId, command: args.command })
            .then(evidence => console.log(`[build-cache] ${evidence.domain} ${evidence.decision} key=${evidence.key}`))
            .catch(error =>
            {
                console.error(`[build-cache] fatal: ${error.message}`);
                process.exitCode = 1;
            });
    }
}
