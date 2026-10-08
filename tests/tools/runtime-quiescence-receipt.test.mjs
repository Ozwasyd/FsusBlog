import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {runRuntimeQuiescenceBarrier} = await import(new URL('../../tools/test-matrix/runtime-quiescence-barrier.mjs', import.meta.url));
const {generateQuiescenceReceipt, projectRuntimeStateReady, validateQuiescenceReceipt} = await import(new URL('../../tools/test-matrix/runtime-quiescence-receipt.mjs', import.meta.url));

import {authorities, barrierOptions, identity, inventory, modelOwner, reseal} from './runtime-quiescence-model.mjs';

const {createProductionFreshOutputRoot, outputPath, captureProductionFreshOutputInventory, sealTerminalProductionFreshOutputs} =
    await import(new URL('../../tools/test-matrix/production-fresh-run-bound-outputs.mjs', import.meta.url));
const {createProductionFreshOutputLocator} = await import(new URL('../../tools/test-matrix/production-fresh-output-locator.mjs', import.meta.url));
const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function sealedModelOutput(t, receipt)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-quiescence-locator-'));
    t.after(() =>
    {
        const writable = (directory) =>
        {
            for (const item of fs.readdirSync(directory, {withFileTypes: true}))
            {
                const file = path.join(directory, item.name);
                if (item.isDirectory())
                {
                    writable(file);
                }
                else if (item.isFile())
                {
                    fs.chmodSync(file, 0o600);
                }
            }
            fs.chmodSync(directory, 0o700);
        };
        writable(root);
        fs.rmSync(root, {recursive: true, force: true});
    });
    const layout = createProductionFreshOutputRoot({root, runId: receipt.runId});
    const relativePath = 'reports/unit-model-quiescence.json';
    const file = outputPath(layout, relativePath);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(receipt));
    const perOutputDigest = {[relativePath]: bytesDigest(fs.readFileSync(file))};
    const producerId = 'quiescence-model-writer';
    const producer = {schema: 'fsusblog.production-fresh.producer-receipt.v1', runId: layout.runId,
        attemptId: layout.attemptId, producerId, outputRoot: layout.relativeOutputRoot,
        relativeOutputs: [relativePath], perOutputDigest, outputInventoryDigest: bytesDigest(JSON.stringify(perOutputDigest)), status: 'complete'};
    const producerFile = outputPath(layout, `artifacts/producer-receipts/${producerId}.json`);
    fs.mkdirSync(path.dirname(producerFile), {recursive: true});
    fs.writeFileSync(producerFile, JSON.stringify(producer));
    const inventoryDigest = bytesDigest(JSON.stringify(captureProductionFreshOutputInventory(layout)));
    sealTerminalProductionFreshOutputs(layout);
    return {root, locator: createProductionFreshOutputLocator({schema: receipt.schema, runId: receipt.runId,
        attemptId: layout.attemptId, producerId, producerReceiptRef: path.relative(root, producerFile),
        producerReceiptDigest: bytesDigest(fs.readFileSync(producerFile)), outputInventoryDigest: inventoryDigest,
        relativePath, contentDigest: perOutputDigest[relativePath], candidateIdentityDigest: receipt.candidateIdentityDigest})};
}

async function fixture(t)
{
    const model = modelOwner();
    const session = await runRuntimeQuiescenceBarrier(barrierOptions(model.owner, {timeoutMs: 5_000}));
    assert.equal(session.status, 'quiescent');
    t.after(() => session.release());
    return {model, session, validation: {identity, inventory, schema: authorities.schema,
        plan: session.plan, currentLease: model.grant()}};
}

test('independent receipt validator and ready projection require exact explicit sealed evidence', async (t) =>
{
    const {session, validation} = await fixture(t);
    assert.equal(validateQuiescenceReceipt(session.receipt, validation), session.receipt);
    const explicit = sealedModelOutput(t, session.receipt);
    const projection = projectRuntimeStateReady({...explicit, validation});
    assert.equal(projection.receiptDigest, session.receipt.contentDigest);
    assert.equal(projection.kind, 'sealed-quiescence-receipt');
    assert.throws(() => projectRuntimeStateReady({...explicit, locator: {...explicit.locator, runId: 'older-model-run'}, validation}));
    assert.throws(() => projectRuntimeStateReady({...explicit, locator: {...explicit.locator, contentDigest: `sha256:${'f'.repeat(64)}`}, validation}));
    for (const locator of [null, '', 'receipts/latest.json'])
    {
        assert.throws(() => projectRuntimeStateReady({...explicit, locator, validation}), /explicit/u);
    }
});

test('resealed foreign, duplicate, missing, source-only and unsupported receipt facts cannot qualify', async (t) =>
{
    const {session, validation} = await fixture(t);
    const mutations = [
        (receipt) =>
        {
            receipt.namespace = 'other-unit-model-namespace';
        },
        (receipt) =>
        {
            receipt.quiescenceGeneration += 1;
        },
        (receipt) =>
        {
            receipt.domains.pop();
        },
        (receipt) =>
        {
            receipt.domains[1] = receipt.domains[0];
        },
        (receipt) =>
        {
            receipt.domains[0] = reseal({...receipt.domains[0], inFlightCount: 1});
        },
        (receipt) =>
        {
            receipt.status = 'blocked';
        },
        (receipt) =>
        {
            receipt.planDigest = `sha256:${'f'.repeat(64)}`;
        },
        (receipt) =>
        {
            receipt.schema += '.unsupported';
        },
        (receipt) =>
        {
            receipt.extra = 'unsupported';
        },
        (receipt) =>
        {
            receipt.finalStateDigest = `sha256:${'e'.repeat(64)}`;
        }
    ];
    for (const mutate of mutations)
    {
        const copy = structuredClone(session.receipt);
        mutate(copy);
        assert.throws(() => validateQuiescenceReceipt(reseal(copy), validation));
    }
    assert.throws(() => validateQuiescenceReceipt(session.receipt,
        {...validation, currentLease: {...validation.currentLease, remainingLeaseMs: 0}}), /expired/u);
    for (const mutation of [{admissionFenceStatus: 'unfrozen'}, {fenceGeneration: 99},
        {acceptedClaimCount: 1}, {rejectedClaimCount: null}])
    {
        assert.throws(() => validateQuiescenceReceipt(session.receipt,
            {...validation, currentLease: {...validation.currentLease, ...mutation}}), /admission fence/u);
    }
});

test('canonical receipt and state digests ignore domain traversal order but bind semantic state and audit fields', async (t) =>
{
    const {session, validation} = await fixture(t);
    const receipt = session.receipt;
    const regenerated = generateQuiescenceReceipt({identity, inventory, lease: validation.currentLease,
        plan: session.plan, domains: [...receipt.domains].reverse(), startedAt: receipt.startedAt,
        sealedAt: receipt.sealedAt, status: 'quiescent'});
    assert.equal(receipt.contentDigest, regenerated.contentDigest);
    assert.equal(receipt.finalStateDigest, regenerated.finalStateDigest);
    const changed = generateQuiescenceReceipt({identity, inventory, lease: validation.currentLease,
        plan: session.plan, domains: receipt.domains.map((domain, index) => index ? domain : reseal({...domain, inFlightCount: 1})),
        startedAt: receipt.startedAt, sealedAt: receipt.sealedAt, status: 'quiescent'});
    assert.notEqual(changed.finalStateDigest, receipt.finalStateDigest);
    assert.throws(() => validateQuiescenceReceipt(changed, validation));
    const audited = reseal({...receipt, sealedAt: '2099-01-01T00:00:00.000Z'});
    assert.notEqual(audited.contentDigest, receipt.contentDigest);
    assert.equal(audited.finalStateDigest, receipt.finalStateDigest);
});
