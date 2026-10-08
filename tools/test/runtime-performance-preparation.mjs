import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const {quiescenceDigest} = await import(new URL('../test-matrix/quiescence-contract.mjs', import.meta.url));
const {assertQuiescenceIdentity, projectRuntimeStateReady} = await import(new URL('../test-matrix/runtime-quiescence-receipt.mjs', import.meta.url));
const {createProductionFreshRunBoundLocator, readProductionFreshJsonOutput} = await import(new URL('../test-matrix/production-fresh-output-locator.mjs', import.meta.url));
const {captureProductionFreshOutputInventory, outputPath, resolveProductionFreshOutputAttempt,
    verifyProducerOutputDelta, verifyTerminalProductionFreshOutputs} = await import(new URL('../test-matrix/production-fresh-run-bound-outputs.mjs', import.meta.url));
const {readResidentLeaseDocument, validateResidentLeaseInventory, validateResidentLeaseHandoff,
    reconcileResidentLeaseInventory, productionResidentServiceIds} = await import(new URL('../test-matrix/resident-resource-leases.mjs', import.meta.url));
const {validateRunBoundMarker} = await import(new URL('../test-matrix/run-bound-marker.mjs', import.meta.url));
const {readRuntimeEnvironment} = await import(new URL('./bundles/runtime-environment.mjs', import.meta.url));

export const performancePreparationProducerId = 'runtime-performance-preparation';
export const performancePreparationReceiptSchema = 'fsusblog.runtime-performance-preparation.v1';
export const legacyPerformancePreparationStepIds = Object.freeze([
    'data-scale-xs', 'data-scale-s', 'data-scale-summary', 'fault-injection'
]);

// These are preparation responsibilities, not a replacement physical catalog.
// The existing source owners must supply prepare-only ports and physical custody.
export const performancePreparationOperations = Object.freeze([
    Object.freeze({id: 'fixture-data', responsibility: 'fixture/data preparation',
        owner: 'tools/test-fixtures/orchestrator.mjs#prepare'}),
    Object.freeze({id: 'scale-xs', responsibility: 'scale preparation',
        owner: 'tools/data-scale/runtime-provisioner.mjs#provisionLaneRuntime'}),
    Object.freeze({id: 'scale-s', responsibility: 'scale preparation',
        owner: 'tools/data-scale/runtime-provisioner.mjs#provisionLaneRuntime'}),
    Object.freeze({id: 'fault-setup', responsibility: 'fault preparation',
        owner: 'tools/test/lanes/fault-injection.sh'})
]);

function refusal(message)
{
    return Object.assign(new Error(message), {classification: 'infra.preparation-precondition', producerSpawnCount: 0});
}

export function assertProductionPerformancePreparationAvailable()
{
    // Do not turn an env file, a source declaration or a caller JSON into a
    // protected scheduler/holder/mutation/publisher capability.
    throw refusal('production preparation catalog registration, protected holder transport, prepare-only mutation/fault ports and append-only locator publisher unavailable');
}

export function assertNotLegacyPerformancePreparation(stepId)
{
    if (legacyPerformancePreparationStepIds.includes(stepId))
    {
        throw refusal(`legacy performance-evidence preparation disabled: ${stepId}; require ${performancePreparationProducerId}`);
    }
}

export function createPerformancePreparationPlan({identity, attemptId, sourceState, fixtureInputs, timeoutMs})
{
    assertQuiescenceIdentity(identity, identity);
    if (!attemptId || !sourceState?.commit || !sourceState.worktreeFingerprint ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Array.isArray(fixtureInputs) || !fixtureInputs.length ||
        new Set(fixtureInputs.map((entry) => entry.inputId)).size !== fixtureInputs.length ||
        fixtureInputs.some((entry) => !entry.inputId || !entry.marker || !entry.locator ||
            entry.locator.runId !== identity.runId || entry.locator.attemptId !== attemptId ||
            entry.locator.candidateIdentityDigest !== identity.candidateIdentityDigest ||
            !Array.isArray(entry.forOperations) || !entry.forOperations.length ||
            entry.forOperations.some((id) => !performancePreparationOperations.some((operation) => operation.id === id))))
    {
        throw refusal('explicit current-run/attempt/source fixture inputs and original preparation budget required');
    }
    const operations = performancePreparationOperations.map((operation) => ({...operation,
        inputIds: fixtureInputs.filter((entry) => entry.forOperations.includes(operation.id)).map((entry) => entry.inputId)}));
    if (operations.some((operation) => !operation.inputIds.length))
    {
        throw refusal('every preparation operation requires exact fixture input reasons');
    }
    const inputReasons = [
        {inputId: 'current-runtime', authority: 'runtime identity and namespace environment',
            reason: 'Bind the exact live runtime endpoints and source; process exit cannot supply identity.'},
        {inputId: 'sealed-quiescence', authority: 'existing barrier/explicit locator/held consumer',
            reason: 'Require committed quiescent state and the same active lease generation throughout preparation.'},
        {inputId: 'resident-handoff', authority: 'existing resident inventory/handoff owner',
            reason: 'Consume only the exact current-run/source/namespace resident generation and recipient.'},
        ...operations.flatMap((operation) => operation.inputIds.map((inputId) => ({inputId, operationId: operation.id,
            authority: 'explicit fixture marker locator', reason: `${operation.responsibility} consumes this exact fixture input.`})))
    ];
    const payload = {schema: 'fsusblog.runtime-performance-preparation-plan.v1', producerId: performancePreparationProducerId,
        identity: structuredClone(identity), attemptId, sourceState: structuredClone(sourceState), timeoutMs,
        operations, fixtureInputs: structuredClone(fixtureInputs), inputReasons,
        resources: {exclusiveResources: []}, unrelatedTerminalInputs: []};
    return {...payload, contentDigest: quiescenceDigest(payload)};
}

function assertPlan(plan)
{
    const rebuilt = createPerformancePreparationPlan(plan);
    if (quiescenceDigest(rebuilt) !== quiescenceDigest(plan))
    {
        throw refusal('preparation plan, input reasons or operation roster changed');
    }
}

// Read real existing ports. resident handoff is already consumed by its sole
// owner; this producer never transfers/reclaims a lease or invents a recipient.
export function readPerformancePreparationInputs({root, plan, quiescence, resident})
{
    assertPlan(plan);
    const validation = quiescence.validation;
    assertQuiescenceIdentity(validation?.identity, plan.identity);
    if (quiescence.locator?.attemptId !== plan.attemptId)
    {
        throw refusal('preparation quiescence attempt mismatch');
    }
    const projection = projectRuntimeStateReady({root, locator: quiescence.locator, validation});
    const runtime = readRuntimeEnvironment(root, plan.identity.namespace);
    if (runtime.FSUSBLOG_TEST_RUN_ID !== plan.identity.runId)
    {
        throw refusal('runtime environment belongs to another run');
    }
    const inventory = readResidentLeaseDocument(resident.inventoryFile);
    validateResidentLeaseInventory(inventory, {runId: plan.identity.runId, namespace: plan.identity.namespace,
        sourceState: plan.sourceState, ownerBundleId: 'runtime-browser', requiredServiceIds: productionResidentServiceIds});
    const handoff = readResidentLeaseDocument(resident.handoffFile);
    validateResidentLeaseHandoff(handoff, {inventory, consumerBundleId: performancePreparationProducerId, requireConsumed: true});
    const live = reconcileResidentLeaseInventory(inventory);
    if (!live.healthy)
    {
        throw refusal('resident identity is no longer live');
    }
    const fixtures = plan.fixtureInputs.map((entry) =>
    {
        const output = readProductionFreshJsonOutput({root, locator: entry.locator,
            expectedCandidateIdentityDigest: plan.identity.candidateIdentityDigest});
        validateRunBoundMarker(output.json, {...entry.marker, root, runId: plan.identity.runId, sourceState: plan.sourceState});
        return {inputId: entry.inputId, locator: output.locator, contentDigest: output.contentDigest};
    });
    return {quiescence: projection, runtimeEnvironmentDigest: quiescenceDigest(runtime),
        resident: {inventoryDigest: inventory.digest, handoffDigest: handoff.digest, generation: inventory.generation}, fixtures};
}

async function executePreparation({root, plan, quiescenceLocator, readValidation,
    resident, consumers, operations, publisher, signal})
{
    assertPlan(plan);
    const deadline = performance.now() + plan.timeoutMs;
    if (typeof readValidation !== 'function' || typeof consumers?.run !== 'function' || typeof consumers.validate !== 'function' ||
        typeof consumers.close !== 'function' ||
        typeof publisher?.appendAndSeal !== 'function' || !operations ||
        Object.keys(operations).length !== plan.operations.length || plan.operations.some((operation) =>
        operations[operation.id]?.owner !== operation.owner ||
        typeof operations[operation.id]?.start !== 'function' || typeof operations[operation.id]?.cancelAndObserveTerminal !== 'function'))
    {
        throw refusal('canonical held consumer, complete prepare-only operation custody and append-only publisher ports required');
    }
    signal?.throwIfAborted();
    let inputs = null;
    let active = null;
    let execution = null;
    const outputs = [];
    const guard = () =>
    {
        signal?.throwIfAborted();
        if (performance.now() >= deadline)
        {
            throw refusal('original preparation deadline exhausted');
        }
    };
    const check = async () =>
    {
        guard();
        const validation = await readValidation();
        const current = readPerformancePreparationInputs({root, plan,
            quiescence: {locator: quiescenceLocator, validation}, resident});
        const held = await consumers.validate();
        guard();
        if (quiescenceDigest(held) !== quiescenceDigest(current.quiescence) ||
            inputs && quiescenceDigest(inputs) !== quiescenceDigest(current))
        {
            throw refusal('preparation runtime, resident, fixture or held generation drift');
        }
        inputs ??= current;
        return current;
    };
    await check();
    const result = await consumers.run({consumerId: performancePreparationProducerId,
        timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())), signal,
        producer: {start(context)
        {
            execution = (async () =>
            {
                for (const operation of plan.operations)
                {
                    context.signal.throwIfAborted();
                    await check();
                    context.signal.throwIfAborted();
                    active = operations[operation.id];
                    const output = await active.start({signal: context.signal, plan: structuredClone(plan),
                        inputIds: [...operation.inputIds], inputs: structuredClone(inputs)});
                    active = null;
                    context.signal.throwIfAborted();
                    if (output?.status !== 'prepared' || output.measurementSpawnCount !== 0 || output.benchmarkWindowHeld !== false)
                    {
                        throw refusal(`prepare-only postcondition failed: ${operation.id}`);
                    }
                    outputs.push({operationId: operation.id, owner: operation.owner, outputDigest: quiescenceDigest(output)});
                    await check();
                }
                return {exitCode: 0};
            })();
            return execution;
        }, async cancelAndObserveTerminal(request)
        {
            const terminal = active ? await active.cancelAndObserveTerminal(request) : {status: 'terminal'};
            if (terminal?.status !== 'terminal')
            {
                return terminal;
            }
            await execution?.catch(() =>
            {});
            return {status: 'terminal'};
        }}});
    if (result.status !== 'completed')
    {
        await consumers.close('preparation failed');
        return {...result, qualificationEligible: false};
    }
    // A preparation-only roster releases early and cannot hand state to a later
    // measurement. The existing holder owner must retain the declared consumers.
    if (result.release !== null)
    {
        throw refusal('preparation requires the existing shared holder roster to retain downstream consumers');
    }
    const endInputs = await check();
    const payload = {schema: performancePreparationReceiptSchema, producerId: performancePreparationProducerId,
        ...plan.identity, attemptId: plan.attemptId, sourceState: plan.sourceState, status: 'sealed', planDigest: plan.contentDigest,
        inputReasons: plan.inputReasons, startInputs: inputs, endInputs, operations: outputs,
        consumerReceipt: result.receipt, measurementSpawnCount: 0, benchmarkWindowHeld: false};
    const receipt = {...payload, contentDigest: quiescenceDigest(payload)};
    guard();
    const publication = await publisher.appendAndSeal({receipt, plan, inputs: endInputs, consumerReceipt: result.receipt});
    guard();
    await check();
    readPerformancePreparationReceipt({root, locator: publication?.locator, plan, inputs: endInputs, consumerReceipt: result.receipt});
    return {status: 'prepared', receipt, publication, qualificationEligible: false,
        qualificationLimit: 'Source protocol requires actual physical-catalog, shared holder, prepare-only mutation and protected publisher acceptance.'};
}

export async function runRuntimePerformancePreparation(options)
{
    try
    {
        return await executePreparation(options);
    }
    catch (error)
    {
        await options.consumers?.close?.(error.message);
        throw error;
    }
}

// This owns only the preparation output. The existing run/attempt and delta
// owners supply its root and producer envelope. It is not a scheduler registrar.
export function createPerformancePreparationReceiptPublisher({layout})
{
    const resolved = resolveProductionFreshOutputAttempt({root: layout.repositoryRoot,
        runId: layout.runId, attemptId: layout.attemptId});
    if (resolved.outputRoot !== layout.outputRoot)
    {
        throw refusal('preparation output layout differs from the canonical explicit attempt');
    }
    const append = (relativePath, document) =>
    {
        const file = outputPath(layout, relativePath);
        fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
        const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
            (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        try
        {
            fs.writeFileSync(descriptor, JSON.stringify(document) + '\n');
            fs.fchmodSync(descriptor, 0o444);
            fs.fsyncSync(descriptor);
        }
        finally
        {
            fs.closeSync(descriptor);
        }
        const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
        try
        {
            fs.fsyncSync(directory);
        }
        finally
        {
            fs.closeSync(directory);
        }
    };
    return {appendAndSeal({receipt, plan, inputs, consumerReceipt})
    {
        validatePerformancePreparationReceipt(receipt, {plan, inputs, consumerReceipt});
        if (layout.runId !== plan.identity.runId || layout.attemptId !== plan.attemptId ||
            verifyTerminalProductionFreshOutputs(layout, {allowCurrentAttempt: true}).attempts.some((entry) => entry.attemptId === layout.attemptId))
        {
            throw refusal('preparation publication requires its own current, non-terminal explicit output attempt');
        }
        const relativePath = 'reports/runtime-performance-preparation/sealed.json';
        const producerReceiptRef = 'artifacts/producer-receipts/runtime-performance-preparation.json';
        const before = captureProductionFreshOutputInventory(layout);
        append(relativePath, receipt);
        const envelope = verifyProducerOutputDelta({layout, producerId: performancePreparationProducerId,
            before, relativeOutputs: [relativePath], ownedOutputRoots: ['reports/runtime-performance-preparation']});
        append(producerReceiptRef, {schema: 'fsusblog.production-fresh.producer-receipt.v1', status: 'complete', ...envelope});
        const {locator} = createProductionFreshRunBoundLocator({repositoryRoot: layout.repositoryRoot,
            runId: layout.runId, attemptId: layout.attemptId, outputRoot: layout.outputRoot,
            producerId: performancePreparationProducerId, relativePath, schema: performancePreparationReceiptSchema,
            receiptRef: path.relative(layout.repositoryRoot, outputPath(layout, producerReceiptRef)).replaceAll(path.sep, '/'),
            candidateIdentityDigest: plan.identity.candidateIdentityDigest});
        return {locator};
    }};
}

export function readPerformancePreparationReceipt({root, locator, plan, inputs, consumerReceipt})
{
    if (locator?.runId !== plan.identity.runId || locator.attemptId !== plan.attemptId ||
        locator.producerId !== performancePreparationProducerId || locator.schema !== performancePreparationReceiptSchema)
    {
        throw refusal('preparation output requires an exact current-run sealed producer locator');
    }
    // Preserve the canonical protected terminal-output requirement. The missing
    // live-stage locator handoff is a production blocker, not a read waiver.
    const output = readProductionFreshJsonOutput({root, locator,
        expectedCandidateIdentityDigest: plan.identity.candidateIdentityDigest});
    return validatePerformancePreparationReceipt(output.json, {plan, inputs, consumerReceipt});
}

export function validatePerformancePreparationReceipt(receipt, {plan, inputs, consumerReceipt})
{
    assertPlan(plan);
    const {contentDigest, ...payload} = receipt ?? {};
    const {contentDigest: consumerDigest, ...consumerPayload} = consumerReceipt ?? {};
    assertQuiescenceIdentity(receipt, plan.identity);
    if (receipt.schema !== performancePreparationReceiptSchema || receipt.producerId !== performancePreparationProducerId ||
        receipt.status !== 'sealed' || receipt.attemptId !== plan.attemptId || receipt.planDigest !== plan.contentDigest ||
        contentDigest !== quiescenceDigest(payload) || receipt.measurementSpawnCount !== 0 || receipt.benchmarkWindowHeld !== false ||
        quiescenceDigest(receipt.startInputs) !== quiescenceDigest(inputs) || quiescenceDigest(receipt.endInputs) !== quiescenceDigest(inputs) ||
        quiescenceDigest(receipt.consumerReceipt) !== quiescenceDigest(consumerReceipt) ||
        consumerDigest !== quiescenceDigest(consumerPayload) ||
        quiescenceDigest(consumerReceipt?.startCheck) !== quiescenceDigest(inputs.quiescence) ||
        quiescenceDigest(consumerReceipt?.endCheck) !== quiescenceDigest(inputs.quiescence) ||
        receipt.consumerReceipt?.consumerId !== performancePreparationProducerId || receipt.consumerReceipt.outcome !== 'success' ||
        receipt.consumerReceipt.producerTerminal !== true || receipt.consumerReceipt.releaseResult?.status !== 'held-for-declared-consumers' ||
        quiescenceDigest(receipt.inputReasons) !== quiescenceDigest(plan.inputReasons) ||
        quiescenceDigest(receipt.sourceState) !== quiescenceDigest(plan.sourceState) ||
        !Array.isArray(receipt.operations) || receipt.operations.length !== plan.operations.length ||
        receipt.operations.some((operation, index) => operation.operationId !== plan.operations[index].id ||
            operation.owner !== plan.operations[index].owner || !/^sha256:[a-f0-9]{64}$/u.test(operation.outputDigest ?? '')))
    {
        throw refusal('sealed preparation receipt/input/holder binding invalid');
    }
    return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
{
    try
    {
        assertProductionPerformancePreparationAvailable();
    }
    catch (error)
    {
        console.error(JSON.stringify({status: 'blocked', classification: error.classification,
            producerSpawnCount: error.producerSpawnCount, error: error.message}));
        process.exitCode = 1;
    }
}
