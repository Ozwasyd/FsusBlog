import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const resetPostconditionReceiptSchema = 'fsusblog.runtime-reset-postcondition.v1';
export const resetPostconditionAssertionIds = new Set([
    'bootstrap-runtime-ready',
    'release-public-hydration-ready',
    'zap-container-removed'
]);

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fileDigest = (file) => sha256(fs.readFileSync(file));

function safeSegment(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized || !/^[A-Za-z0-9_.-]+$/u.test(normalized) || ['.', '..'].includes(normalized))
    {
        throw new Error(`${label} is not a safe receipt identity`);
    }
    return normalized;
}

function normalizeRunIdentity(identity)
{
    const runId = safeSegment(identity?.runId, 'run id');
    const namespace = safeSegment(identity?.namespace, 'runtime namespace');
    const profileId = safeSegment(identity?.profileId ?? 'production', 'profile id');
    const commit = String(identity?.sourceState?.commit ?? '').trim();
    const worktreeFingerprint = String(identity?.sourceState?.worktreeFingerprint ?? '').trim();
    if (!/^[a-f0-9]{40}$/u.test(commit) || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint))
    {
        throw new Error('reset receipt source identity is incomplete');
    }
    return { runId, namespace, profileId, sourceState: { commit, worktreeFingerprint } };
}

export function resetPostconditionReceiptFile(root, { runId, producer, assertionId })
{
    const outputRoot = String(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim();
    const receiptRoot = outputRoot
        ? path.join(path.resolve(outputRoot), 'runtime', 'runtime-state-reset')
        : path.join(path.resolve(root), '.tmp', 'test-runs', safeSegment(runId, 'run id'), 'runtime-state-reset');
    return path.join(
        receiptRoot,
        safeSegment(producer, 'producer'),
        `${safeSegment(assertionId, 'assertion id')}.json`
    );
}

function parseEnvironment(contents)
{
    const environment = {};
    for (const line of String(contents).split(/\r?\n/u))
    {
        if (!line)
        {
            continue;
        }
        const separator = line.indexOf('=');
        if (separator < 1)
        {
            throw new Error('runtime environment contains a malformed line');
        }
        const key = line.slice(0, separator);
        if (Object.hasOwn(environment, key))
        {
            throw new Error(`runtime environment duplicates ${key}`);
        }
        environment[key] = line.slice(separator + 1);
    }
    return environment;
}

function exactKeys(value, expected)
{
    return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function producerLogFile(root, identity, producerStepId)
{
    const outputRoot = String(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim();
    return outputRoot
        ? path.join(path.resolve(outputRoot), 'bundles', 'runtime-browser', 'steps', `${producerStepId}.log`)
        : path.join(root, `.tmp/local-${identity.profileId}/runtime-browser/steps/${producerStepId}.log`);
}

function runtimeEnvironmentFile(root, namespace)
{
    const environmentRoot = path.resolve(
        process.env.FSUSBLOG_ACCEPTANCE_ENV_ROOT ?? path.join(root, '.tmp/env'));
    return path.join(environmentRoot, `${namespace}.env`);
}

function runtimeFixtureManifest(root, namespace)
{
    const fixtureRoot = path.resolve(
        process.env.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT ?? path.join(root, '.tmp/fixtures'));
    return path.join(fixtureRoot, namespace, 'manifest.json');
}

function requireFileObservation(root, file, label, expectedFile)
{
    const repositoryRoot = path.resolve(root);
    const absolute = path.resolve(file);
    const expectedAbsolute = path.resolve(expectedFile);
    if (absolute !== repositoryRoot && !absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} escapes repository`);
    }
    if (absolute !== expectedAbsolute)
    {
        throw new Error(`${label} does not match its assertion-owned path`);
    }
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size === 0)
    {
        throw new Error(`${label} is missing or empty`);
    }
    return { label, path: path.relative(repositoryRoot, absolute).replaceAll(path.sep, '/'), digest: fileDigest(absolute) };
}

function zapContainerObservation({ root, runIdentity, commandRunner })
{
    const runLabel = `fsusblog.test-run=${runIdentity.runId}`;
    const stepLabel = 'fsusblog.step-id=zap-baseline';
    const inspected = commandRunner('docker', [
        'ps',
        '--all',
        '--quiet',
        '--filter', `label=${runLabel}`,
        '--filter', `label=${stepLabel}`
    ], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (inspected.error || inspected.status !== 0)
    {
        throw new Error('unable to inspect residual ZAP containers');
    }
    const residualContainerIds = String(inspected.stdout ?? '').trim().split(/\s+/u).filter(Boolean);
    if (residualContainerIds.length > 0)
    {
        throw new Error('reset postcondition failed for zap-container-removed: residual ZAP container');
    }
    const qualification = { runLabel, stepLabel, residualContainerIds };
    return {
        label: 'zap-container-filter',
        ...qualification,
        observationDigest: sha256(JSON.stringify(qualification))
    };
}

function observePostcondition({ root, assertionId, runIdentity, producerStep, result, commandRunner })
{
    if (!resetPostconditionAssertionIds.has(assertionId))
    {
        throw new Error(`unknown reset assertion ${assertionId}`);
    }
    if (!result || result.code !== 0 || result.signal || !result.logFile)
    {
        throw new Error(`reset producer ${producerStep.id} did not complete successfully`);
    }
    const observations = [requireFileObservation(
        root,
        result.logFile,
        'producer-log',
        producerLogFile(root, runIdentity, producerStep.id)
    )];
    if (assertionId === 'bootstrap-runtime-ready')
    {
        if (producerStep.id !== 'bootstrap')
        {
            throw new Error('bootstrap reset assertion has the wrong producer');
        }
        const namespace = runIdentity.namespace;
        const environmentFile = runtimeEnvironmentFile(root, namespace);
        const environment = parseEnvironment(fs.readFileSync(environmentFile, 'utf8'));
        if (environment.FSUSBLOG_TEST_RUN_ID !== runIdentity.runId
      || environment.FSUSBLOG_TEST_NAMESPACE !== namespace)
        {
            throw new Error('bootstrap runtime environment is not bound to the current run');
        }
        observations.push(requireFileObservation(root, environmentFile, 'runtime-environment', environmentFile));
        const fixtureManifest = runtimeFixtureManifest(root, namespace);
        observations.push(requireFileObservation(root, fixtureManifest, 'fixture-manifest', fixtureManifest));
    }
    else if (assertionId === 'release-public-hydration-ready')
    {
        if (producerStep.id !== 'release-public-hydration')
        {
            throw new Error('release hydration assertion has the wrong producer');
        }
        const markerFile = path.join(root, '.tmp', 'test-runs', runIdentity.runId, 'release-preview-ready.json');
        const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        if (marker.schema !== 'fsusblog.release-preview-ready.v1'
      || marker.status !== 'ready'
      || marker.schedulerRunId !== runIdentity.runId)
        {
            throw new Error('release hydration marker is stale or invalid');
        }
        observations.push(requireFileObservation(root, markerFile, 'release-preview-ready', markerFile));
    }
    else
    {
        if (producerStep.id !== 'zap-baseline')
        {
            throw new Error('ZAP reset assertion has the wrong producer');
        }
        observations.push(zapContainerObservation({ root, runIdentity, commandRunner }));
    }
    return observations;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(temporary, file);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
}

export function produceResetPostconditionReceipt({
    root,
    assertionId,
    producerStep,
    result,
    runIdentity,
    commandRunner = spawnSync
})
{
    const identity = normalizeRunIdentity(runIdentity);
    const observations = observePostcondition({
        root: path.resolve(root),
        assertionId,
        runIdentity: identity,
        producerStep,
        result,
        commandRunner
    });
    const receipt = {
        schema: resetPostconditionReceiptSchema,
        status: 'ok',
        assertionId,
        producer: {
            stepId: producerStep.id,
            commandDigest: sha256(producerStep.command),
            finishedAtMs: result.finishedAtMs
        },
        schedulerRunId: identity.runId,
        namespace: identity.namespace,
        profileId: identity.profileId,
        sourceState: identity.sourceState,
        observations,
        generatedAt: new Date().toISOString()
    };
    const file = resetPostconditionReceiptFile(root, {
        runId: identity.runId,
        producer: producerStep.id,
        assertionId
    });
    writeJsonAtomic(file, receipt);
    return { file, receipt };
}

function expectedFileObservations(root, assertionId, identity, producerStep)
{
    const producerLog = path.relative(root, producerLogFile(root, identity, producerStep.id)).replaceAll(path.sep, '/');
    if (assertionId === 'bootstrap-runtime-ready')
    {
        return [
            ['producer-log', producerLog],
            ['runtime-environment', path.relative(
                root,
                runtimeEnvironmentFile(root, identity.namespace)).replaceAll(path.sep, '/')],
            ['fixture-manifest', path.relative(
                root,
                runtimeFixtureManifest(root, identity.namespace)).replaceAll(path.sep, '/')]
        ];
    }
    if (assertionId === 'release-public-hydration-ready')
    {
        return [
            ['producer-log', producerLog],
            ['release-preview-ready', `.tmp/test-runs/${identity.runId}/release-preview-ready.json`]
        ];
    }
    return [['producer-log', producerLog]];
}

function validateObservationContract({ root, receipt, identity, producerStep, commandRunner })
{
    const assertionId = receipt.assertionId;
    const expectedFiles = expectedFileObservations(root, assertionId, identity, producerStep);
    const expectedCount = expectedFiles.length + (assertionId === 'zap-container-removed' ? 1 : 0);
    if (!Array.isArray(receipt.observations) || receipt.observations.length !== expectedCount)
    {
        throw new Error(`reset postcondition observation contract is invalid: ${assertionId}`);
    }
    expectedFiles.forEach(([expectedLabel, expectedPath], index) =>
    {
        const observation = receipt.observations[index];
        if (!exactKeys(observation, ['label', 'path', 'digest'])
      || observation.label !== expectedLabel
      || observation.path !== expectedPath
      || !/^sha256:[a-f0-9]{64}$/u.test(observation.digest))
        {
            throw new Error(`reset postcondition observation contract is invalid: ${assertionId} ${expectedLabel}`);
        }
        const absolute = path.resolve(root, observation.path);
        if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)
      || !fs.existsSync(absolute)
      || fileDigest(absolute) !== observation.digest)
        {
            throw new Error(`reset postcondition observation changed: ${assertionId} ${expectedLabel}`);
        }
    });
    if (assertionId === 'bootstrap-runtime-ready')
    {
        const environmentPath = expectedFiles.find(([label]) => label === 'runtime-environment')?.[1];
        const environment = parseEnvironment(fs.readFileSync(path.resolve(root, environmentPath), 'utf8'));
        if (environment.FSUSBLOG_TEST_RUN_ID !== identity.runId
      || environment.FSUSBLOG_TEST_NAMESPACE !== identity.namespace)
        {
            throw new Error('bootstrap runtime environment is not bound to the current run');
        }
    }
    else if (assertionId === 'release-public-hydration-ready')
    {
        const marker = JSON.parse(fs.readFileSync(path.join(root, `.tmp/test-runs/${identity.runId}/release-preview-ready.json`), 'utf8'));
        if (marker.schema !== 'fsusblog.release-preview-ready.v1'
      || marker.status !== 'ready'
      || marker.schedulerRunId !== identity.runId)
        {
            throw new Error('release hydration marker is stale or invalid');
        }
    }
    else if (assertionId === 'zap-container-removed')
    {
        const observation = receipt.observations.at(-1);
        if (!exactKeys(observation, [
            'label',
            'runLabel',
            'stepLabel',
            'residualContainerIds',
            'observationDigest'
        ])
      || observation.label !== 'zap-container-filter'
      || observation.runLabel !== `fsusblog.test-run=${identity.runId}`
      || observation.stepLabel !== 'fsusblog.step-id=zap-baseline'
      || !Array.isArray(observation.residualContainerIds)
      || observation.residualContainerIds.length !== 0
      || observation.observationDigest !== sha256(JSON.stringify({
          runLabel: observation.runLabel,
          stepLabel: observation.stepLabel,
          residualContainerIds: observation.residualContainerIds
      })))
        {
            throw new Error('reset postcondition observation contract is invalid: zap-container-removed');
        }
        const liveObservation = zapContainerObservation({ root, runIdentity: identity, commandRunner });
        if (JSON.stringify(liveObservation) !== JSON.stringify(observation))
        {
            throw new Error('reset postcondition ZAP re-observation does not match receipt');
        }
    }
    else
    {
        throw new Error(`unknown reset assertion ${assertionId}`);
    }
}

export function consumeResetPostconditionReceipt({
    root,
    reset,
    producerStep,
    runIdentity,
    commandRunner = spawnSync
})
{
    const identity = normalizeRunIdentity(runIdentity);
    const file = resetPostconditionReceiptFile(root, {
        runId: identity.runId,
        producer: reset.producer,
        assertionId: reset.assertionId
    });
    if (!fs.existsSync(file))
    {
        throw new Error(`reset postcondition receipt is missing: ${reset.assertionId}`);
    }
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!exactKeys(receipt, [
        'schema',
        'status',
        'assertionId',
        'producer',
        'schedulerRunId',
        'namespace',
        'profileId',
        'sourceState',
        'observations',
        'generatedAt'
    ])
    || !exactKeys(receipt.producer, ['stepId', 'commandDigest', 'finishedAtMs'])
    || !exactKeys(receipt.sourceState, ['commit', 'worktreeFingerprint'])
    || receipt.schema !== reset.receiptSchema
    || receipt.schema !== resetPostconditionReceiptSchema
    || receipt.status !== 'ok'
    || receipt.assertionId !== reset.assertionId
    || receipt.producer?.stepId !== reset.producer
    || receipt.producer?.stepId !== producerStep.id
    || receipt.producer?.commandDigest !== sha256(reset.producerCommand)
    || receipt.producer?.commandDigest !== sha256(producerStep.command)
    || receipt.schedulerRunId !== identity.runId
    || receipt.namespace !== identity.namespace
    || receipt.profileId !== identity.profileId
    || receipt.sourceState?.commit !== identity.sourceState.commit
    || receipt.sourceState?.worktreeFingerprint !== identity.sourceState.worktreeFingerprint
    || !Number.isFinite(receipt.producer?.finishedAtMs)
    || !Number.isFinite(Date.parse(receipt.generatedAt)))
    {
        throw new Error(`reset postcondition receipt is stale or tampered: ${reset.assertionId}`);
    }
    validateObservationContract({ root: path.resolve(root), receipt, identity, producerStep, commandRunner });
    return { file, receipt };
}

export function resetReceiptsProducedByStep({ root, catalog, step, result, runIdentity, commandRunner })
{
    const resets = catalog.steps.flatMap((entry) => [...(entry.resetBefore ?? []), ...(entry.resetAfter ?? [])])
        .filter((reset) => reset.producer === step.id);
    const unique = new Map(resets.map((reset) => [reset.assertionId, reset]));
    return [...unique.values()].map((reset) => produceResetPostconditionReceipt({
        root,
        assertionId: reset.assertionId,
        producerStep: step,
        result,
        runIdentity,
        commandRunner
    }));
}

export function consumeResetReceiptsForStep({
    root,
    catalog,
    steps,
    stepId,
    phase,
    runIdentity,
    commandRunner
})
{
    if (!['resetBefore', 'resetAfter'].includes(phase))
    {
        throw new Error(`unknown reset phase ${phase}`);
    }
    const entry = catalog.steps.find((candidate) => candidate.stepId === stepId);
    if (!entry)
    {
        throw new Error(`runtime state catalog is missing step ${stepId}`);
    }
    const producers = new Map(steps.map((step) => [step.id, step]));
    return (entry[phase] ?? []).map((reset) =>
    {
        const producerStep = producers.get(reset.producer);
        if (!producerStep)
        {
            throw new Error(`reset producer is missing from runtime steps: ${reset.producer}`);
        }
        return consumeResetPostconditionReceipt({ root, reset, producerStep, runIdentity, commandRunner });
    });
}

export function resolveRuntimeResetContext({
    bundleId,
    stepId,
    catalogLoader,
    stepsLoader
})
{
    if (bundleId !== 'runtime-browser')
    {
        return null;
    }
    const catalog = catalogLoader();
    const steps = stepsLoader();
    if (!catalog?.steps?.some((entry) => entry.stepId === stepId)
    || !steps.some((step) => step.id === stepId))
    {
        throw new Error(`runtime reset context requires a registered runtime step: ${stepId}`);
    }
    return { catalog, steps };
}
