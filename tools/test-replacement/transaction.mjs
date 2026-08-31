import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';

import { contentDigest, REPLACEMENT_TRANSACTION_SCHEMA } from '../test-quality/schema.mjs';

export const REPLACEMENT_RECEIPT_SCHEMA = 'fsusblog.test-replacement-receipt.v1';

const operations = new Set(['delete', 'rename', 'merge', 'parameterize', 'split', 'move-support']);
const dispositions = new Set(['replacement', 'shared-replacement', 'retired']);
const requiredCatalogPaths = new Set([
    'tests/test-retention-replacements.json',
    'tests/backend/Fixtures/backend-test-requirements.json',
    'tests/coverage-registry.json',
    'tests/matrix.yml'
]);

function digest(value)
{
    return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function sortedUnique(values)
{
    return [...new Set((values ?? []).filter((value) => String(value ?? '').trim()).map(String))].sort();
}

function fail(message)
{
    throw new Error(`test replacement transaction: ${message}`);
}

function sourceByPath(inventory)
{
    return new Map((inventory?.sourceFiles ?? []).map((item) => [item.path, item]));
}

function recordById(retention)
{
    return new Map((retention?.testRecords ?? []).map((item) => [item.id, item]));
}

function qualityById(quality)
{
    return new Map((quality?.cases ?? []).map((item) => [item.testId, item]));
}

function caseSnapshot(testCase, inventory, retentionRecord = null, quality = null)
{
    if (!testCase)
    {
        fail('independent inventory is missing a transaction test identity');
    }
    const source = sourceByPath(inventory).get(testCase.ownerFile);
    if (!source)
    {
        fail(`inventory source identity is missing for ${testCase.id}`);
    }
    return {
        testId: testCase.id,
        caseId: testCase.id,
        path: testCase.ownerFile,
        sourceDigest: source.sourceDigest,
        framework: testCase.adapter,
        identity: testCase.identity,
        platform: testCase.platform ?? null,
        fixture: testCase.fixture ?? null,
        runtimeBoundary: retentionRecord?.runtimeBoundary ?? `${testCase.adapter}:${testCase.identity}`,
        productionSymbols: sortedUnique(retentionRecord?.productionSymbols),
        assertionTargets: sortedUnique(retentionRecord?.assertionTargets),
        requirementIds: sortedUnique(retentionRecord?.requirementIds),
        coverageIds: sortedUnique(retentionRecord?.coverageIds),
        tierIds: sortedUnique(retentionRecord?.tierIds),
        evidencePaths: sortedUnique(retentionRecord?.evidencePaths),
        qualityOutcome: quality?.outcome ?? retentionRecord?.qualityOutcome ?? 'unresolved-failed',
        retentionClass: retentionRecord?.retentionClass ?? 'review-candidate'
    };
}

function exactKeys(value, keys, label)
{
    if (value === null || typeof value !== 'object' || Array.isArray(value))
    {
        fail(`${label} must be an object`);
    }
    for (const key of Object.keys(value))
    {
        if (!keys.has(key))
        {
            fail(`${label} contains unknown field ${key}`);
        }
    }
}

function validateChange(change, label)
{
    exactKeys(change, new Set([
        'path',
        'beforeExists',
        'beforeDigest',
        'afterExists',
        'afterDigest',
        'afterContent',
        'kind'
    ]), label);
    if (typeof change.path !== 'string' || change.path.startsWith('/') || change.path.includes('..'))
    {
        fail(`${label}.path must be a safe repository-relative path`);
    }
    if (!['source', 'catalog', 'generated-doc'].includes(change.kind))
    {
        fail(`${label}.kind is invalid`);
    }
    if (typeof change.beforeExists !== 'boolean' || typeof change.afterExists !== 'boolean')
    {
        fail(`${label} existence flags are invalid`);
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(change.beforeDigest)
        || !/^sha256:[0-9a-f]{64}$/u.test(change.afterDigest))
    {
        fail(`${label} digests are invalid`);
    }
    if (typeof change.afterContent !== 'string' || digest(change.afterContent) !== change.afterDigest)
    {
        fail(`${label}.afterContent does not match afterDigest`);
    }
    if (!change.afterExists && change.afterContent !== '')
    {
        fail(`${label}.afterContent must be empty when the path is deleted`);
    }
}

function validateSnapshot(snapshot, label)
{
    exactKeys(snapshot, new Set([
        'testId',
        'caseId',
        'path',
        'sourceDigest',
        'framework',
        'identity',
        'platform',
        'fixture',
        'runtimeBoundary',
        'productionSymbols',
        'assertionTargets',
        'requirementIds',
        'coverageIds',
        'tierIds',
        'evidencePaths',
        'qualityOutcome',
        'retentionClass'
    ]), label);
    for (const key of ['testId', 'caseId', 'path', 'framework', 'identity', 'runtimeBoundary', 'qualityOutcome', 'retentionClass'])
    {
        if (typeof snapshot[key] !== 'string' || snapshot[key].trim() === '')
        {
            fail(`${label}.${key} is required`);
        }
    }
    if (snapshot.testId !== snapshot.caseId || !/^sha256:[0-9a-f]{64}$/u.test(snapshot.sourceDigest))
    {
        fail(`${label} identity or source digest is invalid`);
    }
    for (const key of [
        'productionSymbols',
        'assertionTargets',
        'requirementIds',
        'coverageIds',
        'tierIds',
        'evidencePaths'
    ])
    {
        if (!Array.isArray(snapshot[key])
            || JSON.stringify(snapshot[key]) !== JSON.stringify(sortedUnique(snapshot[key])))
        {
            fail(`${label}.${key} must be a sorted unique array`);
        }
    }
}

function validateMapping(mapping, label)
{
    exactKeys(mapping, new Set([
        'beforeTestId',
        'afterTestIds',
        'disposition',
        'assertionMappings',
        'requirementMappings',
        'coverageMappings',
        'tierMappings',
        'evidenceMappings'
    ]), label);
    if (typeof mapping.beforeTestId !== 'string' || mapping.beforeTestId.trim() === '')
    {
        fail(`${label}.beforeTestId is required`);
    }
    if (!dispositions.has(mapping.disposition))
    {
        fail(`${label}.disposition is invalid`);
    }
    if (!Array.isArray(mapping.afterTestIds)
        || (mapping.disposition !== 'retired' && mapping.afterTestIds.length === 0)
        || (mapping.disposition === 'retired' && mapping.afterTestIds.length !== 0))
    {
        fail(`${label}.afterTestIds do not match disposition`);
    }
    for (const field of [
        'assertionMappings',
        'requirementMappings',
        'coverageMappings',
        'tierMappings',
        'evidenceMappings'
    ])
    {
        if (!Array.isArray(mapping[field]))
        {
            fail(`${label}.${field} must be an array`);
        }
        for (const disposition of mapping[field])
        {
            exactKeys(disposition, new Set(['before', 'after']), `${label}.${field}`);
            if (typeof disposition.before !== 'string'
                || disposition.before.trim() === ''
                || !Array.isArray(disposition.after)
                || new Set(disposition.after).size !== disposition.after.length)
            {
                fail(`${label}.${field} entry is invalid`);
            }
        }
    }
    if (mapping.disposition === 'retired'
        && [
            ...mapping.assertionMappings,
            ...mapping.requirementMappings,
            ...mapping.coverageMappings,
            ...mapping.tierMappings,
            ...mapping.evidenceMappings
        ].some((disposition) => disposition.after.length > 0))
    {
        fail(`${label} cannot retain assertion mappings for a retired test`);
    }
}

function validateOperationShape(transaction)
{
    const beforeCount = transaction.before.length;
    const afterCount = transaction.after.length;
    const mappingAfterIds = sortedUnique(transaction.mappings.flatMap((mapping) => mapping.afterTestIds));
    const declaredAfterIds = sortedUnique(transaction.after.map((item) => item.testId));
    if (JSON.stringify(mappingAfterIds) !== JSON.stringify(declaredAfterIds))
    {
        fail('declared after tests and mapped after tests differ');
    }
    if (transaction.operation === 'delete'
        && (afterCount !== 0 || transaction.mappings.some((mapping) => mapping.disposition !== 'retired')))
    {
        fail('delete requires every before test to be explicitly retired');
    }
    if (transaction.operation === 'rename' && (beforeCount !== 1 || afterCount !== 1))
    {
        fail('rename requires exactly one before and one after test');
    }
    if (transaction.operation === 'merge' && (beforeCount < 2 || afterCount < 1))
    {
        fail('merge requires multiple before tests and at least one after test');
    }
    if (transaction.operation === 'split' && (beforeCount !== 1 || afterCount < 2))
    {
        fail('split requires one before test and multiple after tests');
    }
    if (transaction.operation === 'parameterize' && (beforeCount < 1 || afterCount < 1))
    {
        fail('parameterize requires before and after case identities');
    }
    if (transaction.operation === 'parameterize'
        && transaction.after.some((item) => item.identity === 'dynamic'))
    {
        fail('parameterize requires stable current case identities, not a group-level dynamic owner');
    }
    if (transaction.operation === 'move-support'
        && JSON.stringify(transaction.before.map((item) => item.testId).sort())
            !== JSON.stringify(transaction.after.map((item) => item.testId).sort()))
    {
        fail('move-support must preserve exact test identities');
    }
}

function validateCatalogClosure(transaction)
{
    const changedPaths = new Set(transaction.changes.map((change) => change.path));
    for (const required of requiredCatalogPaths)
    {
        const change = transaction.changes.find((item) => item.path === required);
        if (!changedPaths.has(required) || change?.kind !== 'catalog' || !change.afterExists)
        {
            fail(`catalog change is missing ${required}`);
        }
    }
    if (!transaction.changes.some((change) => change.kind === 'generated-doc' && change.afterExists))
    {
        fail('generated testing docs output is missing');
    }
    const sourceChanges = new Set(transaction.changes
        .filter((change) => change.kind === 'source')
        .map((change) => change.path));
    for (const snapshot of [...transaction.before, ...transaction.after])
    {
        if (!sourceChanges.has(snapshot.path))
        {
            fail(`source change is missing ${snapshot.path}`);
        }
    }
    const ledger = transaction.changes.find((change) => change.path === 'tests/test-retention-replacements.json');
    let parsed;
    try
    {
        parsed = JSON.parse(ledger.afterContent);
    }
    catch (error)
    {
        fail(`replacement ledger afterContent is invalid JSON: ${error.message}`);
    }
    for (const mapping of transaction.mappings)
    {
        const entry = (parsed.deletedTests ?? []).find((item) => item.id === mapping.beforeTestId);
        if (!entry)
        {
            fail(`replacement ledger was not generated for ${mapping.beforeTestId}`);
        }
        if (JSON.stringify(sortedUnique(entry.replacementTestIds)) !== JSON.stringify(sortedUnique(mapping.afterTestIds)))
        {
            fail(`replacement ledger targets differ for ${mapping.beforeTestId}`);
        }
    }
}

function dimensionUnion(records, key)
{
    return new Set(records.flatMap((record) => record[key] ?? []));
}

function assertSubset(beforeValues, afterValues, label)
{
    const after = new Set(afterValues);
    const missing = beforeValues.filter((value) => !after.has(value));
    if (missing.length > 0)
    {
        fail(`${label} lost ${missing.join(', ')}`);
    }
}

function validateCompatibility(before, afterRecords, mapping)
{
    if (mapping.disposition === 'retired')
    {
        return;
    }
    for (const after of afterRecords)
    {
        if (after.qualityOutcome !== 'passed')
        {
            fail(`replacement ${after.testId} is not quality-passed`);
        }
    }
    if (!afterRecords.some((after) => after.framework === before.framework))
    {
        fail(`${before.testId} has no framework-compatible replacement`);
    }
    for (const key of ['platform', 'fixture', 'runtimeBoundary'])
    {
        if (before[key] !== null && !afterRecords.some((after) => after[key] === before[key]))
        {
            fail(`${before.testId} has no ${key}-compatible replacement`);
        }
    }
    assertSubset(
        before.productionSymbols,
        dimensionUnion(afterRecords, 'productionSymbols'),
        `${before.testId} productionSymbols`
    );
}

function validateDimensionMappings(before, afterRecords, mapping)
{
    const dimensions = [
        ['assertionTargets', 'assertionMappings'],
        ['requirementIds', 'requirementMappings'],
        ['coverageIds', 'coverageMappings'],
        ['tierIds', 'tierMappings'],
        ['evidencePaths', 'evidenceMappings']
    ];
    for (const [snapshotField, mappingField] of dimensions)
    {
        const entries = mapping[mappingField];
        const beforeValues = before[snapshotField];
        if (JSON.stringify(entries.map((entry) => entry.before).toSorted())
            !== JSON.stringify(beforeValues.toSorted()))
        {
            fail(`${before.testId} ${mappingField} is duplicated or incomplete`);
        }
        const available = dimensionUnion(afterRecords, snapshotField);
        for (const entry of entries)
        {
            if (mapping.disposition !== 'retired' && entry.after.length === 0)
            {
                fail(`${before.testId} ${mappingField} has no replacement for ${entry.before}`);
            }
            for (const target of entry.after)
            {
                if (!available.has(target))
                {
                    fail(`${before.testId} ${mappingField} points to missing target ${target}`);
                }
            }
        }
    }
}

export function createReplacementTransaction({
    request,
    beforeInventory,
    afterInventory,
    beforeRetention,
    afterRetention,
    afterQuality
})
{
    exactKeys(request, new Set([
        'transactionId',
        'operation',
        'owner',
        'reason',
        'issue',
        'beforeTestIds',
        'afterTestIds',
        'mappings',
        'changes'
    ]), 'request');
    for (const key of ['transactionId', 'owner', 'reason', 'issue'])
    {
        if (typeof request[key] !== 'string' || request[key].trim() === '')
        {
            fail(`request.${key} is required`);
        }
    }
    if (!operations.has(request.operation))
    {
        fail(`unknown operation ${request.operation}`);
    }
    if (!Array.isArray(request.beforeTestIds) || request.beforeTestIds.length === 0
        || !Array.isArray(request.afterTestIds))
    {
        fail('request before/after test IDs are invalid');
    }
    const beforeCaseById = new Map(beforeInventory.testCases.map((item) => [item.id, item]));
    const afterCaseById = new Map(afterInventory.testCases.map((item) => [item.id, item]));
    if (beforeCaseById.size !== beforeInventory.testCases.length
        || afterCaseById.size !== afterInventory.testCases.length)
    {
        fail('before/current inventory contains duplicate test IDs');
    }
    if (request.operation !== 'move-support'
        && request.beforeTestIds.some((id) => afterCaseById.has(id)))
    {
        fail('a before test remains discoverable in the current inventory');
    }
    const beforeRetentionById = recordById(beforeRetention);
    const afterRetentionById = recordById(afterRetention);
    const afterQualityById = qualityById(afterQuality);
    const before = request.beforeTestIds.map((id) =>
    {
        const testCase = beforeCaseById.get(id);
        if (!testCase)
        {
            fail(`before test ID does not exist: ${id}`);
        }
        return caseSnapshot(testCase, beforeInventory, beforeRetentionById.get(id));
    });
    const after = request.afterTestIds.map((id) =>
    {
        const testCase = afterCaseById.get(id);
        if (!testCase)
        {
            fail(`after test ID does not exist in current inventory: ${id}`);
        }
        return caseSnapshot(testCase, afterInventory, afterRetentionById.get(id), afterQualityById.get(id));
    });
    if (!Array.isArray(request.mappings) || request.mappings.length !== before.length)
    {
        fail('every before test requires exactly one mapping');
    }
    request.mappings.forEach((mapping, index) => validateMapping(mapping, `request.mappings[${index}]`));
    const mappingIds = request.mappings.map((mapping) => mapping.beforeTestId);
    if (new Set(mappingIds).size !== mappingIds.length
        || JSON.stringify(mappingIds.toSorted()) !== JSON.stringify(request.beforeTestIds.toSorted()))
    {
        fail('before test mappings are duplicated or incomplete');
    }
    const afterById = new Map(after.map((item) => [item.testId, item]));
    for (const [index, mapping] of request.mappings.entries())
    {
        const unknown = mapping.afterTestIds.filter((id) => !afterById.has(id));
        if (unknown.length > 0)
        {
            fail(`request.mappings[${index}] references non-current replacements: ${unknown.join(', ')}`);
        }
        validateCompatibility(
            before.find((item) => item.testId === mapping.beforeTestId),
            mapping.afterTestIds.map((id) => afterById.get(id)),
            mapping
        );
        validateDimensionMappings(
            before.find((item) => item.testId === mapping.beforeTestId),
            mapping.afterTestIds.map((id) => afterById.get(id)),
            mapping
        );
    }
    if (!Array.isArray(request.changes) || request.changes.length === 0)
    {
        fail('request.changes must be non-empty');
    }
    request.changes.forEach((change, index) => validateChange(change, `request.changes[${index}]`));
    if (new Set(request.changes.map((change) => change.path)).size !== request.changes.length)
    {
        fail('request.changes contains duplicate paths');
    }
    const transaction = {
        schema: REPLACEMENT_TRANSACTION_SCHEMA,
        transactionId: request.transactionId,
        operation: request.operation,
        owner: request.owner,
        reason: request.reason,
        issue: request.issue,
        sourceBefore: {
            inventoryDigest: beforeInventory.inventoryDigest,
            sourceState: beforeInventory.sourceState
        },
        sourceAfter: {
            inventoryDigest: afterInventory.inventoryDigest,
            sourceState: afterInventory.sourceState
        },
        before,
        after,
        mappings: structuredClone(request.mappings),
        changes: structuredClone(request.changes),
        contentDigest: ''
    };
    validateOperationShape(transaction);
    validateCatalogClosure(transaction);
    transaction.contentDigest = contentDigest(transaction);
    return transaction;
}

export function validateReplacementTransaction(transaction, {
    beforeInventory = null,
    afterInventory = null,
    beforeRetention = null,
    afterRetention = null,
    afterQuality = null,
    existingReceipts = []
} = {})
{
    const keys = new Set([
        'schema',
        'transactionId',
        'operation',
        'owner',
        'reason',
        'issue',
        'sourceBefore',
        'sourceAfter',
        'before',
        'after',
        'mappings',
        'changes',
        'contentDigest'
    ]);
    exactKeys(transaction, keys, 'transaction');
    if (transaction.schema !== REPLACEMENT_TRANSACTION_SCHEMA)
    {
        fail(`schema must be ${REPLACEMENT_TRANSACTION_SCHEMA}`);
    }
    if (!operations.has(transaction.operation))
    {
        fail('operation is invalid');
    }
    if (contentDigest(transaction) !== transaction.contentDigest)
    {
        fail('content digest is invalid');
    }
    if (existingReceipts.some((receipt) => receipt.transactionId === transaction.transactionId))
    {
        fail(`transaction ID was already applied: ${transaction.transactionId}`);
    }
    transaction.before.forEach((snapshot, index) => validateSnapshot(snapshot, `transaction.before[${index}]`));
    transaction.after.forEach((snapshot, index) => validateSnapshot(snapshot, `transaction.after[${index}]`));
    const processed = new Set(existingReceipts.flatMap((receipt) => receipt.beforeTestIds ?? []));
    for (const before of transaction.before)
    {
        if (processed.has(before.testId))
        {
            fail(`before test was already processed: ${before.testId}`);
        }
    }
    if (beforeInventory && transaction.sourceBefore.inventoryDigest !== beforeInventory.inventoryDigest)
    {
        fail('before inventory digest is stale');
    }
    if (afterInventory && transaction.sourceAfter.inventoryDigest !== afterInventory.inventoryDigest)
    {
        fail('after inventory digest is stale');
    }
    if (beforeInventory || afterInventory || beforeRetention || afterRetention || afterQuality)
    {
        if (!beforeInventory || !afterInventory || !beforeRetention || !afterRetention || !afterQuality)
        {
            fail('independent verification requires complete before/current inventory, retention and quality authorities');
        }
        if (JSON.stringify(transaction.sourceBefore.sourceState) !== JSON.stringify(beforeInventory.sourceState)
            || JSON.stringify(transaction.sourceAfter.sourceState) !== JSON.stringify(afterInventory.sourceState))
        {
            fail('transaction source state is stale');
        }
        const beforeCases = new Map(beforeInventory.testCases.map((item) => [item.id, item]));
        const afterCases = new Map(afterInventory.testCases.map((item) => [item.id, item]));
        const beforeRecords = recordById(beforeRetention);
        const afterRecords = recordById(afterRetention);
        const qualityRecords = qualityById(afterQuality);
        const recomputedBefore = transaction.before.map((item) => caseSnapshot(
            beforeCases.get(item.testId),
            beforeInventory,
            beforeRecords.get(item.testId)
        ));
        const recomputedAfter = transaction.after.map((item) => caseSnapshot(
            afterCases.get(item.testId),
            afterInventory,
            afterRecords.get(item.testId),
            qualityRecords.get(item.testId)
        ));
        if (JSON.stringify(transaction.before) !== JSON.stringify(recomputedBefore)
            || JSON.stringify(transaction.after) !== JSON.stringify(recomputedAfter))
        {
            fail('transaction snapshots differ from independently recomputed authorities');
        }
    }
    transaction.changes.forEach((change, index) => validateChange(change, `transaction.changes[${index}]`));
    transaction.mappings.forEach((mapping, index) => validateMapping(mapping, `transaction.mappings[${index}]`));
    const beforeById = new Map(transaction.before.map((item) => [item.testId, item]));
    const afterById = new Map(transaction.after.map((item) => [item.testId, item]));
    if (beforeById.size !== transaction.before.length || afterById.size !== transaction.after.length)
    {
        fail('transaction contains duplicate before/after test IDs');
    }
    for (const mapping of transaction.mappings)
    {
        const before = beforeById.get(mapping.beforeTestId);
        if (!before || mapping.afterTestIds.some((id) => !afterById.has(id)))
        {
            fail(`transaction mapping references an unknown test identity: ${mapping.beforeTestId}`);
        }
        const replacements = mapping.afterTestIds.map((id) => afterById.get(id));
        validateCompatibility(before, replacements, mapping);
        validateDimensionMappings(before, replacements, mapping);
    }
    validateOperationShape(transaction);
    validateCatalogClosure(transaction);
    return transaction;
}

export function validateReplacementReceipt(receipt, { transaction = null } = {})
{
    exactKeys(receipt, new Set([
        'schema',
        'transactionId',
        'transactionDigest',
        'beforeTestIds',
        'afterTestIds',
        'sourceDiffs',
        'catalogDiffs',
        'verificationOutcomes',
        'verification',
        'contentDigest'
    ]), 'receipt');
    if (receipt.schema !== REPLACEMENT_RECEIPT_SCHEMA || receipt.verification !== 'passed')
    {
        fail('receipt schema or verification outcome is invalid');
    }
    if (!Array.isArray(receipt.sourceDiffs)
        || !Array.isArray(receipt.catalogDiffs)
        || !Array.isArray(receipt.verificationOutcomes)
        || receipt.verificationOutcomes.some((outcome) => outcome.status !== 'passed'))
    {
        fail('receipt diff or verification outcomes are invalid');
    }
    if (contentDigest(receipt) !== receipt.contentDigest)
    {
        fail('receipt content digest is invalid');
    }
    if (transaction)
    {
        if (receipt.transactionId !== transaction.transactionId
            || receipt.transactionDigest !== transaction.contentDigest
            || JSON.stringify(receipt.beforeTestIds) !== JSON.stringify(transaction.before.map((item) => item.testId))
            || JSON.stringify(receipt.afterTestIds) !== JSON.stringify(transaction.after.map((item) => item.testId)))
        {
            fail('receipt does not match its transaction');
        }
        const projection = (kind) => transaction.changes
            .filter((change) => kind === 'source' ? change.kind === 'source' : change.kind !== 'source')
            .map((change) => ({
                path: change.path,
                beforeDigest: change.beforeDigest,
                afterDigest: change.afterDigest,
                beforeExists: change.beforeExists,
                afterExists: change.afterExists
            }));
        if (JSON.stringify(receipt.sourceDiffs) !== JSON.stringify(projection('source'))
            || JSON.stringify(receipt.catalogDiffs) !== JSON.stringify(projection('catalog')))
        {
            fail('receipt diff projection does not match its transaction');
        }
    }
    return receipt;
}

function currentFileDigest(root, relative)
{
    const absolute = path.join(root, relative);
    return existsSync(absolute) ? digest(readFileSync(absolute)) : digest('');
}

export function applyReplacementTransaction({
    root,
    transaction,
    verifyAfter = null,
    existingReceipts = [],
    receiptPath = null
})
{
    existingReceipts.forEach((receipt) => validateReplacementReceipt(receipt));
    validateReplacementTransaction(transaction, { existingReceipts });
    for (const change of transaction.changes)
    {
        if (existsSync(path.join(root, change.path)) !== change.beforeExists)
        {
            fail(`apply source existence changed before transaction: ${change.path}`);
        }
        if (currentFileDigest(root, change.path) !== change.beforeDigest)
        {
            fail(`apply source changed before transaction: ${change.path}`);
        }
    }
    const originals = new Map(transaction.changes.map((change) => {
        const absolute = path.join(root, change.path);
        return [change.path, existsSync(absolute) ? readFileSync(absolute) : null];
    }));
    const temporaryRoot = mkdtempSync(path.join(root, '.replacement-transaction-'));
    const absoluteReceiptPath = receiptPath === null ? null : path.resolve(root, receiptPath);
    if (absoluteReceiptPath !== null && existsSync(absoluteReceiptPath))
    {
        rmSync(temporaryRoot, { recursive: true, force: true });
        fail(`receipt path already exists: ${path.relative(root, absoluteReceiptPath)}`);
    }
    let receiptWritten = false;
    try
    {
        for (const change of transaction.changes)
        {
            if (!change.afterExists)
            {
                continue;
            }
            const staged = path.join(temporaryRoot, change.path);
            mkdirSync(path.dirname(staged), { recursive: true });
            writeFileSync(staged, change.afterContent);
        }
        for (const change of transaction.changes)
        {
            const target = path.join(root, change.path);
            if (change.afterExists)
            {
                mkdirSync(path.dirname(target), { recursive: true });
                renameSync(path.join(temporaryRoot, change.path), target);
            }
            else
            {
                rmSync(target, { force: true });
            }
        }
        for (const change of transaction.changes)
        {
            if (existsSync(path.join(root, change.path)) !== change.afterExists)
            {
                fail(`apply existence mismatch after write: ${change.path}`);
            }
            if (currentFileDigest(root, change.path) !== change.afterDigest)
            {
                fail(`apply digest mismatch after write: ${change.path}`);
            }
        }
        if (verifyAfter)
        {
            verifyAfter(transaction);
        }
        const receipt = {
            schema: REPLACEMENT_RECEIPT_SCHEMA,
            transactionId: transaction.transactionId,
            transactionDigest: transaction.contentDigest,
            beforeTestIds: transaction.before.map((item) => item.testId),
            afterTestIds: transaction.after.map((item) => item.testId),
            sourceDiffs: transaction.changes
                .filter((change) => change.kind === 'source')
                .map((change) => ({
                    path: change.path,
                    beforeDigest: change.beforeDigest,
                    afterDigest: change.afterDigest,
                    beforeExists: change.beforeExists,
                    afterExists: change.afterExists
                })),
            catalogDiffs: transaction.changes
                .filter((change) => change.kind !== 'source')
                .map((change) => ({
                    path: change.path,
                    beforeDigest: change.beforeDigest,
                    afterDigest: change.afterDigest,
                    beforeExists: change.beforeExists,
                    afterExists: change.afterExists
                })),
            verificationOutcomes: [
                { id: 'transaction-schema', status: 'passed' },
                { id: 'before-source-identity', status: 'passed' },
                { id: 'atomic-file-application', status: 'passed' },
                { id: 'after-source-identity', status: 'passed' },
                { id: 'catalog-closure', status: 'passed' },
                ...(verifyAfter ? [{ id: 'independent-post-apply', status: 'passed' }] : [])
            ],
            verification: 'passed',
            contentDigest: ''
        };
        receipt.contentDigest = contentDigest(receipt);
        validateReplacementReceipt(receipt, { transaction });
        if (absoluteReceiptPath !== null)
        {
            mkdirSync(path.dirname(absoluteReceiptPath), { recursive: true });
            writeFileSync(absoluteReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
            receiptWritten = true;
        }
        return receipt;
    }
    catch (error)
    {
        if (absoluteReceiptPath !== null && receiptWritten)
        {
            rmSync(absoluteReceiptPath, { force: true });
        }
        for (const [relative, bytes] of originals)
        {
            const absolute = path.join(root, relative);
            if (bytes === null)
            {
                rmSync(absolute, { force: true });
            }
            else
            {
                mkdirSync(path.dirname(absolute), { recursive: true });
                writeFileSync(absolute, bytes);
            }
        }
        throw error;
    }
    finally
    {
        rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function isTestSource(file)
{
    return /(?:^|\/)(?:tests\/.*(?:Tests?\.cs|\.(?:test|spec)\.[cm]?[jt]sx?|\.cpp)$|tools\/test\/.*\.(?:sh|mjs|js))$/u.test(file);
}

export function detectReplacementRequiredChanges({ root, base, head = 'HEAD' })
{
    const nameStatus = execFileSync('git', ['diff', '--name-status', '-z', base, head, '--'], {
        cwd: root,
        encoding: 'utf8'
    }).split('\0').filter(Boolean);
    const changes = [];
    for (let index = 0; index < nameStatus.length;)
    {
        const status = nameStatus[index++];
        const oldFile = nameStatus[index++];
        const file = status.startsWith('R') || status.startsWith('C')
            ? nameStatus[index++]
            : oldFile;
        if (!file)
        {
            break;
        }
        if (status.startsWith('D') && isTestSource(file))
        {
            changes.push({ status, path: file, reason: 'test-source-delete-or-rename' });
        }
        else if (status.startsWith('R') && (isTestSource(oldFile) || isTestSource(file)))
        {
            changes.push({ status, path: `${oldFile} -> ${file}`, reason: 'test-source-delete-or-rename' });
        }
    }
    const patch = execFileSync('git', ['diff', '--unified=0', base, head, '--', 'tests'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    if (/^-.*(?:\[(?:Fact|Theory)\]|\b(?:test|it)(?:\.each)?\s*\()/mu.test(patch))
    {
        changes.push({ status: 'M', path: '<diff>', reason: 'discoverable-test-or-case-removal' });
    }
    return changes;
}

export function verifyDiffHasTransaction({ root, base, head = 'HEAD', transaction = null })
{
    const changes = detectReplacementRequiredChanges({ root, base, head });
    if (changes.length > 0 && transaction === null)
    {
        fail(`unregistered test source change: ${changes.map((item) => `${item.path}:${item.reason}`).join(', ')}`);
    }
    if (transaction)
    {
        validateReplacementTransaction(transaction);
    }
    return changes;
}
