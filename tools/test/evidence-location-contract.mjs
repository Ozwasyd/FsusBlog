import crypto from 'node:crypto';

export const CURRENT_RUN_CONTEXT_SCHEMA = 'fsusblog.current-run-evidence-context.v1';
export const EVIDENCE_LOCATOR_REGISTRY_SCHEMA = 'fsusblog.evidence-locator-registry.v1';
export const EVIDENCE_LOCATION_LEDGER_SCHEMA = 'fsusblog.evidence-location-migration-ledger.v1';
export const locatorModes = Object.freeze(['content-addressed-reference', 'explicit-run-path']);

const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const unsafePathPattern = /(?:^|\/)(?:\.\.?)(?:\/|$)|[*?[\]{}!]/u;
const forbiddenSelectionKey = /(?:age|ctime|fallback|glob|latest|mtime|newest|priority|scan|search|ttl)/iu;
const requiredContextIdentity = Object.freeze([
    'attemptId',
    'buildIdentity',
    'candidateIdentity',
    'schedulerRunId',
    'sourceCommit',
    'worktreeFingerprint'
]);

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonicalize(value[key])]));
}

export function governanceContentDigest(document)
{
    const payload = { ...document };
    delete payload.contentDigest;
    return `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(payload))).digest('hex')}`;
}

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function assertString(value, field)
{
    assert(typeof value === 'string' && value.length > 0, `${field} must be a non-empty string`);
}

function assertDigest(value, field)
{
    assert(typeof value === 'string' && sha256Pattern.test(value), `${field} must be a sha256 digest`);
}

function assertSealed(document, label)
{
    assertDigest(document.contentDigest, `${label}.contentDigest`);
    assert(document.contentDigest === governanceContentDigest(document), `${label}.contentDigest mismatch`);
}

function assertSafeRoot(root, field)
{
    assertString(root, field);
    assert(!root.startsWith('/') && !unsafePathPattern.test(root), `${field} must be an exact repository-relative root`);
}

function assertIdentity(identity, field)
{
    assert(identity && typeof identity === 'object' && !Array.isArray(identity), `${field} must be an object`);
    assertString(identity.id, `${field}.id`);
    assertDigest(identity.digest, `${field}.digest`);
}

export function validateCurrentRunEvidenceContext(context)
{
    assert(context?.schema === CURRENT_RUN_CONTEXT_SCHEMA, 'current-run context schema mismatch');
    assertString(context.schedulerRunId, 'schedulerRunId');
    assertString(context.attemptId, 'attemptId');
    assert(/^[0-9a-f]{40}$/u.test(context.sourceCommit ?? ''), 'sourceCommit must be a full lowercase commit SHA');
    assertDigest(context.worktreeFingerprint, 'worktreeFingerprint');
    assertIdentity(context.candidateIdentity, 'candidateIdentity');
    assertIdentity(context.buildIdentity, 'buildIdentity');
    assert(Array.isArray(context.ownedRoots) && context.ownedRoots.length > 0, 'ownedRoots must be non-empty');
    assert(new Set(context.ownedRoots).size === context.ownedRoots.length, 'ownedRoots must be unique');
    context.ownedRoots.forEach((root, index) => assertSafeRoot(root, `ownedRoots[${index}]`));
    assertSealed(context, 'current-run context');
    return context;
}

export function completeEvidenceLocatorRegistryEntry(entry)
{
    const outputBindingKey = entry.outputBindingKey ?? 'FSUSBLOG_TEST_EVIDENCE_PATH';
    return {
        publicationMode: 'embedded',
        producerSource: 'tools/test/current-run-evidence-locator.mjs',
        producerCallsite: 'tools/test/current-run-evidence-locator.mjs',
        producerBindingClass: 'cli',
        producerExecutable: entry.producerCommand ?? 'node tools/test/current-run-evidence-locator.mjs',
        handoffBindingKey: outputBindingKey.replace(/_PATH$/u, '_HANDOFF_PATH'),
        checkpointCommand: `node tools/test/attach-current-run-evidence-checkpoint.mjs --consumer ${entry.consumerId}`,
        outputBindingKey,
        ...entry
    };
}

export function validateEvidenceLocatorRegistry(registry)
{
    assert(registry?.schema === EVIDENCE_LOCATOR_REGISTRY_SCHEMA, 'evidence locator registry schema mismatch');
    assert(registry.version === 1, 'evidence locator registry version must be 1');
    assert(Array.isArray(registry.entries), 'evidence locator registry entries must be an array');
    const consumers = new Set();
    const authorities = new Set();
    for (const [index, entry] of registry.entries.entries())
    {
        const field = `entries[${index}]`;
        for (const name of ['consumerId', 'authorityId', 'producerId', 'receiptSchema', 'publicationMode',
            'producerSource', 'producerCallsite', 'producerExecutable', 'producerCommand',
            'producerBindingClass', 'outputBindingKey', 'handoffBindingKey', 'checkpointCommand'])
        {
            assertString(entry[name], `${field}.${name}`);
        }
        assert(['embedded', 'hooked', 'parent'].includes(entry.publicationMode),
            `${field}.publicationMode is unsupported`);
        assert(['cli', 'library-caller', 'workflow'].includes(entry.producerBindingClass),
            `${field}.producerBindingClass is unsupported`);
        if (entry.publicationMode === 'hooked')
        {
            assertString(entry.payloadBindingKey, `${field}.payloadBindingKey`);
            assert(entry.receiptSchema === 'fsusblog.current-run-evidence-reference.v1',
                `${field}.hooked receiptSchema must be the current-run reference schema`);
        }
        assert(!consumers.has(entry.consumerId), `${field}.consumerId duplicates ${entry.consumerId}`);
        assert(!authorities.has(entry.authorityId), `${field}.authorityId duplicates ${entry.authorityId}`);
        consumers.add(entry.consumerId);
        authorities.add(entry.authorityId);
        assert(locatorModes.includes(entry.locatorMode), `${field}.locatorMode is unsupported`);
        assert(entry.expectedCardinality === 'exact-one', `${field}.expectedCardinality must be exact-one`);
        assert(Array.isArray(entry.requiredIdentityFields), `${field}.requiredIdentityFields must be an array`);
        assert(requiredContextIdentity.every((name) => entry.requiredIdentityFields.includes(name)),
            `${field}.requiredIdentityFields omit current-run identity`);
        assert(Array.isArray(entry.requiredDigestFields)
            && entry.requiredDigestFields.includes('contentDigest')
            && entry.requiredDigestFields.includes('producerReceiptDigest'),
        `${field}.requiredDigestFields must include contentDigest and producerReceiptDigest`);
        assert(Array.isArray(entry.allowedRoots) && entry.allowedRoots.length > 0, `${field}.allowedRoots must be non-empty`);
        assert(new Set(entry.allowedRoots).size === entry.allowedRoots.length, `${field}.allowedRoots must be unique`);
        entry.allowedRoots.forEach((root, rootIndex) => assertSafeRoot(root, `${field}.allowedRoots[${rootIndex}]`));
        for (const key of Object.keys(entry))
        {
            assert(!forbiddenSelectionKey.test(key), `${field}.${key} encodes forbidden selection policy`);
        }
    }
    assertSealed(registry, 'evidence locator registry');
    return registry;
}

export function validateEvidenceLocationMigrationLedger(ledger, { scan = null } = {})
{
    assert(ledger?.schema === EVIDENCE_LOCATION_LEDGER_SCHEMA, 'evidence location migration ledger schema mismatch');
    assert(ledger.version === 1, 'evidence location migration ledger version must be 1');
    assert(ledger.scannerSchema === 'fsusblog.evidence-location-scan.v1', 'migration ledger scanner schema mismatch');
    assert(Array.isArray(ledger.scannerRuleIds), 'migration ledger scannerRuleIds must be an array');
    assert(Array.isArray(ledger.entries), 'migration ledger entries must be an array');
    const findingIds = new Set();
    for (const [index, entry] of ledger.entries.entries())
    {
        const field = `entries[${index}]`;
        assert(/^[0-9a-f]{16}$/u.test(entry.findingId ?? ''), `${field}.findingId is invalid`);
        assert(!findingIds.has(entry.findingId), `${field}.findingId duplicates ${entry.findingId}`);
        findingIds.add(entry.findingId);
        for (const name of ['consumerId', 'location', 'oldSelectionRule', 'action', 'owner', 'proofTest'])
        {
            assertString(entry[name], `${field}.${name}`);
        }
        assert(/^[^:*?[\]]+:[1-9][0-9]*$/u.test(entry.location), `${field}.location must be exact file:line`);
        assert(['correctness-selection', 'diagnostic-only', 'not-evidence'].includes(entry.classification),
            `${field}.classification is unsupported`);
        if (entry.classification === 'not-evidence')
        {
            assert(entry.newAuthorityId === null && entry.locatorMode === 'not-applicable',
                `${field} not-evidence disposition must not name a locator authority`);
        }
        else
        {
            assertString(entry.newAuthorityId, `${field}.newAuthorityId`);
            assert(locatorModes.includes(entry.locatorMode), `${field}.locatorMode is unsupported`);
        }
    }
    if (scan)
    {
        assert(ledger.scanDigest === scan.contentDigest, 'migration ledger scanDigest mismatch');
        const scannedIds = new Set(scan.findings.map((finding) => finding.findingId));
        assert(scannedIds.size === scan.findings.length, 'scanner emitted duplicate finding IDs');
        for (const findingId of scannedIds)
        {
            assert(findingIds.has(findingId), `scanner finding ${findingId} is missing from migration ledger`);
        }
        for (const findingId of findingIds)
        {
            assert(scannedIds.has(findingId), `migration ledger finding ${findingId} is orphaned`);
        }
        const ruleIds = [...new Set(scan.rules.map((rule) => rule.id))].sort();
        assert(JSON.stringify(ledger.scannerRuleIds) === JSON.stringify(ruleIds), 'migration ledger scannerRuleIds mismatch');
    }
    assertSealed(ledger, 'evidence location migration ledger');
    return ledger;
}

export function verifyEvidenceLocationGovernance({ registry, ledger, scan = null })
{
    validateEvidenceLocatorRegistry(registry);
    validateEvidenceLocationMigrationLedger(ledger, { scan });
    const authorities = new Map(registry.entries.map((entry) => [entry.authorityId, entry]));
    for (const entry of ledger.entries)
    {
        if (entry.classification === 'not-evidence')
        {
            continue;
        }
        const authority = authorities.get(entry.newAuthorityId);
        assert(authority, `migration ledger authority ${entry.newAuthorityId} is not registered`);
        assert(authority.consumerId === entry.consumerId,
            `migration ledger consumer ${entry.consumerId} does not match ${entry.newAuthorityId}`);
        assert(authority.locatorMode === entry.locatorMode,
            `migration ledger locator mode does not match ${entry.newAuthorityId}`);
    }
    return { registry, ledger, scan };
}
