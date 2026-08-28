#!/usr/bin/env node
/**
 * Unique fixture orchestrator CLI (#1709 + #1710 FixtureReceipt).
 * Dev, acceptance, browser-contract, diagnostics, and scale share this entry.
 * No compat wrappers, feature flags, dual legacy receipts, or second lifecycle.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    resolveSourceCommit,
    resolveWorktreeFingerprint
} from '../fact-extractors/identity.mjs';
import {
    writeFixtureProfileReceipt
} from '../testing/fixture-catalog.mjs';

import {
    cleanup,
    plan as planOrchestration,
    prepare,
    verify
} from './orchestrator.mjs';
import { createDefaultProducerPorts, createPortsForProducerIds } from './producers/catalog-ports.mjs';
import {
    digestCanonical,
    FIXTURE_PREPARE_STATE_SCHEMA,
    FIXTURE_RECEIPT_SCHEMA,
    readFixtureReceipt,
    writePreparedPublicIdProjection,
    writeFixtureReceipt,
    writePrivateJson
} from './receipt/index.mjs';

function parseArgs(argv)
{
    const options = { _: [] };
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        if (arg === '--')
        {
            options._.push(...argv.slice(index + 1));
            break;
        }
        if (arg.startsWith('--'))
        {
            const eq = arg.indexOf('=');
            if (eq >= 0)
            {
                options[arg.slice(2, eq)] = arg.slice(eq + 1);
            }
            else
            {
                const key = arg.slice(2);
                const next = argv[index + 1];
                if (next != null && !next.startsWith('--'))
                {
                    options[key] = next;
                    index += 1;
                }
                else
                {
                    options[key] = true;
                }
            }
        }
        else
        {
            options._.push(arg);
        }
    }
    return options;
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrepareState(file, value)
{
    return writePrivateJson(file, value, { label: 'fixture-prepare-state' });
}

function parseVariantIds(value, label)
{
    if (value == null || value === '')
    {
        return null;
    }
    if (Array.isArray(value))
    {
        return value.map(String);
    }
    const text = String(value).trim();
    if (!text)
    {
        return null;
    }
    if (text.startsWith('['))
    {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
        {
            throw new Error(`${label} must be a JSON array or comma-separated ids`);
        }
        return parsed.map(String);
    }
    return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function buildProfileIdentity(options)
{
    const profileId = options.profile ?? options['profile-id'];
    if (!profileId)
    {
        throw new Error('--profile is required');
    }
    const profileSource = options.source ?? options['profile-source'] ?? 'dev-cli';
    const executionClass = options['execution-class'] ?? null;
    const requestedVariantIds = parseVariantIds(options['variant-ids'], '--variant-ids');
    const sealedVariantIds = parseVariantIds(
        options['sealed-variant-ids'] ?? process.env.FSUSBLOG_SEALED_FIXTURE_VARIANT_IDS,
        '--sealed-variant-ids'
    );
    const sealed = profileSource === 'matrix'
        ? {
      fixtureProfileId: options['sealed-profile-id'] ?? profileId,
      fixtureCatalogDigest: options['sealed-catalog-digest'],
      expandedCapabilityDigest: options['sealed-capability-digest'],
      fixtureVariantIds: sealedVariantIds,
      fixtureVariantPlanDigest: options['sealed-variant-plan-digest']
        ?? process.env.FSUSBLOG_SEALED_FIXTURE_VARIANT_PLAN_DIGEST,
      executionClass: options['sealed-execution-class'] ?? executionClass
    }
        : null;
    return {
        profileId,
        profileSource,
        executionClass,
        variantIds: requestedVariantIds ?? sealedVariantIds,
        sealed
    };
}

function buildExecutionIdentity(options)
{
    const handles = {};
    if (options['base-url'])
    {
        handles.baseUrl = options['base-url'];
    }
    if (options['debug-backend-url'])
    {
        handles.debugBackendUrl = options['debug-backend-url'];
    }
    if (options['frontend-url'])
    {
        handles.frontendUrl = options['frontend-url'];
    }
    if (options['pg-container'])
    {
        handles.pgContainer = options['pg-container'];
    }
    if (options['redis-container'])
    {
        handles.redisContainer = options['redis-container'];
    }
    if (options['pg-user'])
    {
        handles.pgUser = options['pg-user'];
    }
    if (options['pg-db'])
    {
        handles.pgDb = options['pg-db'];
    }
    if (options['scale-tier'])
    {
        handles.scaleTier = options['scale-tier'];
    }
    if (options['service-generation'])
    {
        handles.serviceGeneration = options['service-generation'];
    }
    return {
        runId: options['run-id'] ?? process.env.FSUSBLOG_TEST_RUN_ID ?? null,
        namespace: options.namespace ?? process.env.FSUSBLOG_TEST_NAMESPACE ?? null,
        sourceIdentity: options['source-commit']
            ? {
        commit: options['source-commit'],
        worktreeFingerprint: options['source-fingerprint'] ?? null
      }
            : null,
        handles
    };
}

function buildPrivateRuntimeHandles()
{
    const handles = {};
    if (process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET)
    {
        handles.localAuthFixtureSecret = process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET;
    }
    if (process.env.FSUSBLOG_LOCAL_MESSAGING_FIXTURE_SECRET)
    {
        handles.localMessagingFixtureSecret = process.env.FSUSBLOG_LOCAL_MESSAGING_FIXTURE_SECRET;
    }
    return Object.freeze(handles);
}

function comparableExecutionIdentity(value)
{
    return {
        runId: value?.runId ?? null,
        namespace: value?.namespace ?? null,
        source: value?.source ?? value?.sourceIdentity ?? null,
        serviceGeneration: value?.serviceGeneration ?? value?.handles?.serviceGeneration ?? null
    };
}

export function classifyDevFixtureReceiptTransition(previousReceipt, {
    profileId,
    executionIdentity
} = {})
{
    if (typeof profileId !== 'string' || !profileId.trim())
    {
        throw new Error('dev demo transition requires the selected profile id');
    }
    const currentIdentity = comparableExecutionIdentity(executionIdentity);
    if (!currentIdentity.runId
    || !currentIdentity.namespace
    || !/^[a-f0-9]{40}$/u.test(String(currentIdentity.source?.commit ?? ''))
    || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(String(currentIdentity.source?.worktreeFingerprint ?? ''))
    || !/^sha256:[a-f0-9]{64}$/u.test(String(currentIdentity.serviceGeneration ?? '')))
    {
        throw new Error('dev demo transition requires exact run, namespace, source, and service generation identity');
    }
    if (previousReceipt == null)
    {
        return Object.freeze({ action: 'none', reason: 'no-previous-demo-receipt' });
    }
    if (previousReceipt.schema !== FIXTURE_RECEIPT_SCHEMA
    || previousReceipt.terminalStatus !== 'verified'
    || previousReceipt.profileIdentity?.profileId !== 'demo-public')
    {
        throw new Error('dev demo transition requires a verified demo-public FixtureReceipt v2');
    }
    if (profileId === 'demo-public'
    && previousReceipt.profileIdentity?.executionClass === 'development'
    && digestCanonical(comparableExecutionIdentity(previousReceipt.executionIdentity))
      === digestCanonical(currentIdentity))
    {
        return Object.freeze({ action: 'reuse', reason: 'same-execution-identity' });
    }
    return Object.freeze({
        action: 'cleanup',
        reason: profileId !== 'demo-public'
            ? 'profile-changed'
            : previousReceipt.profileIdentity?.executionClass !== 'development'
        ? 'profile-evidence-changed'
        : 'execution-identity-changed'
    });
}

function resolvePorts(planDocument, options)
{
    if (options['ports-module'])
    {
        throw new Error('--ports-module is not supported; inject ports in-process or use default catalog ports');
    }
    if (Object.keys(options).some((key) => key.startsWith('legacy-')))
    {
        throw new Error('dual/legacy receipt paths were deleted; FixtureReceipt v2 is the sole authority (#1710)');
    }
    const ids = planDocument.producers
    ?? planDocument.order
    ?? planDocument.producerIds
    ?? planDocument.producerReceipts?.map((item) => item.producerId)
    ?? [];
    if (ids.length === 0)
    {
        return [];
    }
    if (options['all-ports'] === true)
    {
        return createDefaultProducerPorts();
    }
    return createPortsForProducerIds(ids);
}

function writeAuthoritativeOut(file, document)
{
    if (!file)
    {
        return;
    }
    if (document?.schema === FIXTURE_RECEIPT_SCHEMA)
    {
        writeFixtureReceipt(file, document);
        return;
    }
    if (document?.schema === FIXTURE_PREPARE_STATE_SCHEMA)
    {
        writePrepareState(file, document);
        return;
    }
    writePrivateJson(file, document, { label: 'fixture-out' });
}

async function main(argv = process.argv.slice(2))
{
    const options = parseArgs(argv);
    const command = options._[0];
    if (!command || command === 'help' || options.help === true)
    {
        process.stdout.write(`Usage:
  node tools/test-fixtures/cli.mjs plan --profile <id> --source dev-cli|matrix [--variant-ids <ids>] [sealed opts] [--out plan.json]
  node tools/test-fixtures/cli.mjs prepare --plan plan.json [--out prepare-state.json] [--previous-fixture-receipt path]
  node tools/test-fixtures/cli.mjs verify --receipt prepare-state.json [--out fixture-receipt.json]
  node tools/test-fixtures/cli.mjs cleanup --receipt prepare-state|fixture-receipt.json [--out out.json]
  node tools/test-fixtures/cli.mjs run --profile <id> --source ... [--out fixture-receipt.json] [--previous-fixture-receipt path]
  node tools/test-fixtures/cli.mjs dev-transition --receipt fixture-receipt.json --profile <id> [execution identity opts]
  node tools/test-fixtures/cli.mjs source-identity [--repository-root path]
  node tools/test-fixtures/cli.mjs receipt-digest --file fixture-receipt.json
`);
        return;
    }

    if (command === 'source-identity')
    {
        const repositoryRoot = path.resolve(options['repository-root'] ?? process.cwd());
        process.stdout.write(`${JSON.stringify({
            commit: resolveSourceCommit(repositoryRoot),
            worktreeFingerprint: `sha256:${resolveWorktreeFingerprint(repositoryRoot)}`
        })}\n`);
        return;
    }

    if (command === 'dev-transition')
    {
        const receiptFile = options.receipt ?? options['receipt-file'];
        if (!receiptFile)
        {
            throw new Error('dev-transition requires --receipt');
        }
        const previousReceipt = readFixtureReceipt(receiptFile, { requireVerified: true });
        const transition = classifyDevFixtureReceiptTransition(previousReceipt, {
            profileId: options.profile ?? options['profile-id'],
            executionIdentity: buildExecutionIdentity(options)
        });
        process.stdout.write(`${JSON.stringify(transition)}\n`);
        return;
    }

    if (command === 'plan')
    {
        const planDocument = planOrchestration(buildProfileIdentity(options), buildExecutionIdentity(options));
        if (options.out)
        {
            writePrivateJson(options.out, planDocument, { label: 'fixture-plan' });
        }
        // Planned-profile receipt (profile selection identity only — not fixture completeness).
        if (options['planned-profile-out'])
        {
            writeFixtureProfileReceipt(options['planned-profile-out'], {
                profileId: planDocument.profileIdentity.profileId,
                profileSource: planDocument.profileIdentity.profileSource,
                catalogDigest: planDocument.catalogDigest,
                expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
                variantIds: planDocument.variantIds,
                variantPlanDigest: planDocument.variantPlanDigest,
                capabilities: planDocument.capabilities,
                producers: planDocument.producers,
                mutationPolicy: planDocument.mutationPolicy,
                executionClass: planDocument.profileIdentity.executionClass,
                requiresLocalAuthBypass: planDocument.requiresLocalAuthBypass,
                requiresAuthFixtures: planDocument.requiresAuthFixtures,
                requiresPublicFixtures: planDocument.requiresPublicFixtures,
                requiresDemoSeed: planDocument.requiresDemoSeed
            }, { kind: 'planned-profile' });
        }
        process.stdout.write(`${JSON.stringify(planDocument)}\n`);
        return;
    }

    if (command === 'prepare')
    {
        const planFile = options.plan ?? options['plan-file'];
        if (!planFile)
        {
            throw new Error('prepare requires --plan');
        }
        const planDocument = readJson(planFile);
        const ports = resolvePorts(planDocument, options);
        const previousFixtureReceipt = options['previous-fixture-receipt']
            ? readFixtureReceipt(options['previous-fixture-receipt'])
            : null;
        const controller = new AbortController();
        const onSignal = () => controller.abort(new Error('fixture prepare cancelled'));
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
        try
        {
            const prepareState = await prepare(
                planDocument,
                ports,
                controller.signal,
                { previousFixtureReceipt, handles: buildPrivateRuntimeHandles() });
            if (options.out)
            {
                writeAuthoritativeOut(options.out, prepareState);
            }
            // Optional explicit prepare-state path alias.
            if (options['prepare-state'])
            {
                writeAuthoritativeOut(options['prepare-state'], prepareState);
            }
            // --fixture-receipt without verify only allowed for none zero-mutation (still requires verify for verified status).
            if (options['fixture-receipt'])
            {
                throw new Error('prepare cannot write FixtureReceipt; run verify (or run without --skip-verify)');
            }
            process.stdout.write(`${JSON.stringify(prepareState)}\n`);
        }
        catch (error)
        {
            if (error?.receipt && options.out)
            {
                writeAuthoritativeOut(options.out, error.receipt);
            }
            if (error?.fixtureReceipt && options['fixture-receipt'])
            {
                writeAuthoritativeOut(options['fixture-receipt'], error.fixtureReceipt);
            }
            throw error;
        }
        finally
        {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
        }
        return;
    }

    if (command === 'verify')
    {
        const receiptFile = options.receipt ?? options['receipt-file'] ?? options['prepare-state'];
        if (!receiptFile)
        {
            throw new Error('verify requires --receipt (prepare-state)');
        }
        const prepareState = readJson(receiptFile);
        const ports = resolvePorts(prepareState.plan ?? prepareState, options);
        const next = await verify(prepareState, ports, {
            handles: buildPrivateRuntimeHandles()
        });
        const out = options.out ?? options['fixture-receipt'];
        if (out)
        {
            writeAuthoritativeOut(out, next);
        }
        process.stdout.write(`${JSON.stringify(next)}\n`);
        return;
    }

    if (command === 'project-prepared-public')
    {
        const prepareStateFile = options['prepare-state'] ?? options.receipt;
        const out = options.out;
        if (!prepareStateFile || !out)
        {
            throw new Error('project-prepared-public requires --prepare-state and --out');
        }
        const projection = writePreparedPublicIdProjection(out, readJson(prepareStateFile));
        process.stdout.write(`${JSON.stringify(projection)}\n`);
        return;
    }

    if (command === 'cleanup')
    {
        const receiptFile = options.receipt ?? options['receipt-file'];
        if (!receiptFile)
        {
            throw new Error('cleanup requires --receipt');
        }
        const rawReceipt = readJson(receiptFile);
        const receipt = rawReceipt.schema === FIXTURE_RECEIPT_SCHEMA
            ? readFixtureReceipt(receiptFile)
            : rawReceipt;
        const ports = resolvePorts(receipt.plan ?? receipt, options);
        const controller = new AbortController();
        const onSignal = () => controller.abort(new Error('fixture cleanup cancelled'));
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
        try
        {
            const next = await cleanup(
                receipt,
                ports,
                controller.signal,
                { handles: buildExecutionIdentity(options).handles });
            if (options.out)
            {
                writePrivateJson(options.out, next, { label: 'fixture-cleanup-state' });
            }
            process.stdout.write(`${JSON.stringify(next)}\n`);
        }
        finally
        {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
        }
        return;
    }

    if (command === 'run')
    {
        const planDocument = planOrchestration(buildProfileIdentity(options), buildExecutionIdentity(options));
        if (options['plan-out'])
        {
            writePrivateJson(options['plan-out'], planDocument, { label: 'fixture-plan' });
        }
        if (options['planned-profile-out'])
        {
            writeFixtureProfileReceipt(options['planned-profile-out'], {
                profileId: planDocument.profileIdentity.profileId,
                profileSource: planDocument.profileIdentity.profileSource,
                catalogDigest: planDocument.catalogDigest,
                expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
                variantIds: planDocument.variantIds,
                variantPlanDigest: planDocument.variantPlanDigest,
                capabilities: planDocument.capabilities,
                producers: planDocument.producers,
                mutationPolicy: planDocument.mutationPolicy,
                executionClass: planDocument.profileIdentity.executionClass,
                requiresLocalAuthBypass: planDocument.requiresLocalAuthBypass,
                requiresAuthFixtures: planDocument.requiresAuthFixtures,
                requiresPublicFixtures: planDocument.requiresPublicFixtures,
                requiresDemoSeed: planDocument.requiresDemoSeed
            }, { kind: 'planned-profile' });
        }
        const ports = resolvePorts(planDocument, options);
        const controller = new AbortController();
        const onSignal = () => controller.abort(new Error('fixture run cancelled'));
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
        const prepareOut = options['prepare-state'] ?? options['prepare-out'] ?? null;
        const fixtureReceiptOut = options['fixture-receipt'] ?? options.out ?? null;
        const previousFixtureReceiptFile = options['previous-fixture-receipt'] ?? null;
        const previousFixtureReceipt = previousFixtureReceiptFile
            ? readFixtureReceipt(previousFixtureReceiptFile)
            : null;
        try
        {
            let prepareState = await prepare(
                planDocument,
                ports,
                controller.signal,
                { previousFixtureReceipt, handles: buildPrivateRuntimeHandles() });
            if (prepareOut)
            {
                writeAuthoritativeOut(prepareOut, prepareState);
            }

            const skipVerify = options.verify === false || options['skip-verify'] === true;
            if (skipVerify)
            {
                // Honest partial land: prepare-state is not verified evidence.
                if (fixtureReceiptOut)
                {
                    throw new Error(
                        'cannot write FixtureReceipt with --skip-verify; omit --fixture-receipt or run verify'
                    );
                }
                if (options.out && options.out !== prepareOut)
                {
                    writeAuthoritativeOut(options.out, prepareState);
                }
                process.stdout.write(`${JSON.stringify(prepareState)}\n`);
                return;
            }

            const fixtureReceipt = await verify(prepareState, ports, {
                signal: controller.signal,
                handles: buildPrivateRuntimeHandles()
            });
            if (fixtureReceiptOut)
            {
                writeAuthoritativeOut(fixtureReceiptOut, fixtureReceipt);
            }
            else if (options.out)
            {
                writeAuthoritativeOut(options.out, fixtureReceipt);
            }
            process.stdout.write(`${JSON.stringify(fixtureReceipt)}\n`);
        }
        catch (error)
        {
            if (error?.receipt && prepareOut)
            {
                writeAuthoritativeOut(prepareOut, error.receipt);
            }
            const fixtureOutputReplacesPrevious = fixtureReceiptOut
        && previousFixtureReceiptFile
        && path.resolve(fixtureReceiptOut) === path.resolve(previousFixtureReceiptFile);
            if (error?.fixtureReceipt && fixtureReceiptOut && !fixtureOutputReplacesPrevious)
            {
                writeAuthoritativeOut(fixtureReceiptOut, error.fixtureReceipt);
            }
            else if (error?.receipt && options.out && !fixtureReceiptOut)
            {
                writeAuthoritativeOut(options.out, error.receipt);
            }
            throw error;
        }
        finally
        {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
        }
        return;
    }

    if (command === 'receipt-digest')
    {
        const file = options.file ?? options._[1];
        if (!file)
        {
            throw new Error('receipt-digest requires --file');
        }
        const receipt = readFixtureReceipt(file);
        process.stdout.write(`${receipt.receiptDigest}\n`);
        return;
    }

    throw new Error(`unknown fixture orchestrator command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        process.stderr.write(`${error?.stack ?? error?.message ?? error}\n`);
        process.exit(1);
    });
}

export { main as runFixtureOrchestratorCli };
