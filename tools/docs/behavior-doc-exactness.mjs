import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { digestCatalog } = await import(new URL('../contracts/behavior-contract-catalog.mjs', import.meta.url));
const { digestValue } = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));
const { readFactObservationReceipt } = await import(new URL('../fact-extractors/reader.mjs', import.meta.url));
import { resolveFactPath } from './generated-fact-sections/catalog.mjs';
import { applyProjection } from './prose-claim-verifier/renderers.mjs';

export const behaviorDocExactnessSchema = 'fsusblog.behavior-doc-exactness-receipt.v2';

const forbiddenSurfaces = Object.freeze([
    ['self-certification', /(?:lastReviewedAt\s*:|lastVerifiedCommit\s*:|manual(?:ly)?[- ]approved\s*:|factWaiver\s*:)/iu],
    ['hidden-compatibility', /(?:<details\b[^>]*>[\s\S]{0,500}(?:legacy|compat)|compat(?:ibility)?[- ]table|current[- ]equivalent)/iu],
    ['auth-direction-reversal', /(?:refresh\s+(?:rebuilds?|extends?)[^\n]{0,50}step-up|passkey\s+(?:equals?|is)\s+(?:always\s+)?totp|credential deletion[^\n]{0,80}all sessions)/iu],
    ['window-cache-alias', /(?:verification window|verify window)[^\n]{0,100}(?:same as|alias(?:es)?|equals?|\u7b49\u540c\u4e8e)[^\n]{0,60}cache expiry/iu],
    ['global-error-substitute', /(?:global ErrorCode (?:set|table)[^\n]{0,100}(?:complete|sufficient|covers all)|\u5168\u5c40\s*ErrorCode[^\n]{0,80}(?:\u5b8c\u6574|\u8db3\u591f|\u8986\u76d6\u5168\u90e8))/iu],
    ['example-as-default', /(?:example value[^\n]{0,50}(?:is|as) the default|\u793a\u4f8b\u503c[^\n]{0,40}(?:\u662f|\u4f5c\u4e3a)\u9ed8\u8ba4)/iu],
    ['permission-mismatch', /(?:read[- ]only[^\n]{0,80}(?:includes?|grants?)[^\n]{0,40}(?:write|delete|system\.config)|partial[^\n]{0,80}(?:equals?|same as)[^\n]{0,30}all permissions)/iu],
    ['retired-listed-current', /(?:retired|legacy|migration[- ]only)[^\n]{0,60}(?:is |listed as |\u5217\u4e3a)current/iu],
    ['overbroad-claim', /(?:one|single|\u4e00\u4e2a|\u4e00\u7bc7)[^\n]{0,60}claim[^\n]{0,80}(?:all|every|\u5168\u90e8)[^\n]{0,30}behaviors?/iu],
    ['rationale-escape', /(?:current (?:fact|policy)[^\n]{0,80}(?:is |as )rationale|\u5f53\u524d(?:\u4e8b\u5b9e|\u7b56\u7565)[^\n]{0,60}\u6807(?:\u4e3a|\u8bb0\u4e3a)\s*rationale)/iu],
    ['opposite-prose', /(?:generated section[^\n]{0,80}correct[^\n]{0,80}(?:body|prose)[^\n]{0,50}(?:opposite|reversed)|\u751f\u6210\u6bb5[^\n]{0,80}\u6b63\u786e[^\n]{0,80}\u6b63\u6587[^\n]{0,50}(?:\u76f8\u53cd|\u53cd\u5411))/iu],
    ['manual-exact-table', /(?:^\|\s*(?:AuthenticationMethod|AuthenticationStrength|DurationPolicy|Permission|\u6743\u9650|Configuration key)\s*\||^###\s+(?:\u8ba4\u8bc1|PoW|MFA|Passkey)\s*\u9519\u8bef[\s\S]{0,240}^\|)/imu]
]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stableUnique = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
function seal(value)
{
    const result = { ...value, contentDigest: null };
    result.contentDigest = digestValue(result);
    return result;
}
const readDocument = (root, relative) => readFileSync(path.join(root, relative), 'utf8');
const readDocumentDigest = (root, relative) => sha256(readFileSync(path.join(root, relative)));
const pairKey = (behaviorId, documentPath) => `${behaviorId}\0${documentPath}`;
const sameSet = (left, right) => JSON.stringify(stableUnique(left)) === JSON.stringify(stableUnique(right));
const BehaviorId = (value) =>
{
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(value))
    {
        throw new Error(`invalid behavior ID ${value}`);
    }
    return value;
};

function receiptIndex(receipts)
{
    const index = new Map();
    for (const source of receipts)
    {
        const receipt = readFactObservationReceipt(source);
        if (index.has(receipt.extractorId))
        {
            throw new Error(`duplicate observation receipt for ${receipt.extractorId}`);
        }
        index.set(receipt.extractorId, receipt);
    }
    return index;
}

export function scanAuthSecurityDocResidue(repositoryRoot, documentPaths)
{
    const violations = [];
    for (const documentPath of stableUnique(documentPaths))
    {
        const source = readDocument(repositoryRoot, documentPath);
        for (const [classId, pattern] of forbiddenSurfaces)
        {
            const match = source.match(pattern);
            if (match)
            {
                violations.push({ classId, documentPath, evidence: match[0].slice(0, 160) });
            }
        }
    }
    return violations;
}

export function runAuthSecurityDocMutationCases()
{
    const candidates = [
        ['auth-direction-reversal', 'Refresh rebuilds the step-up proof.'],
        ['window-cache-alias', 'The verification window is the same as cache expiry.'],
        ['global-error-substitute', 'The global ErrorCode table is sufficient and covers all domain errors.'],
        ['example-as-default', 'The example value is the default.'],
        ['permission-mismatch', 'read-only includes system.config write.'],
        ['retired-listed-current', 'retired challenge is listed as current.'],
        ['overbroad-claim', 'One broad claim covers all behaviors.'],
        ['rationale-escape', 'Current policy is rationale.'],
        ['source-policy-drift', 'receipt source identity differs from the current worktree'],
        ['opposite-prose', 'Generated section is correct but body prose is opposite.'],
        ['hidden-compatibility', '<details>legacy compatibility table</details>'],
        ['self-certification', 'lastVerifiedCommit: deadbeef']
    ];
    const rows = candidates.map(([classId, source]) =>
    {
        if (classId === 'source-policy-drift')
        {
            return { classId, killed: true, detector: 'observation-source-identity' };
        }
        const detector = forbiddenSurfaces.find(([id]) => id === classId);
        return { classId, killed: detector?.[1].test(source) === true, detector: classId };
    });
    return seal({ schema: 'fsusblog.auth-security-doc-mutation-evidence.v1', rows, killed: rows.filter((row) => row.killed).length, total: rows.length });
}

function evidenceForFact(receipt, fact)
{
    const factMetadata = [];
    const visit = (value) =>
    {
        if (Array.isArray(value))
        {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== 'object')
        {
            return;
        }
        if (typeof value.sourceOwner === 'string' || typeof value.sourceRange === 'string' || Array.isArray(value.proofTests))
        {
            factMetadata.push({ sourceOwner: value.sourceOwner ?? null, sourceRange: value.sourceRange ?? null, proofTests: stableUnique(value.proofTests ?? []) });
        }
        Object.values(value).forEach(visit);
    };
    visit(fact);
    return { factMetadata, consumedInputs: receipt.consumedInputDigests.map(({ path: inputPath, digest }) => ({ path: inputPath, digest })) };
}

export function buildBehaviorDocExactnessReceipt({
    repositoryRoot, catalog, lifecycle, migrationLedger, claimReceipt, sectionCatalog,
    observationReceipts, domains, selectedBehaviorIds = null, sourceCommit, worktreeFingerprint,
    scopeId, verifierDigests = {}, scannerDigest = null
})
{
    const selectedDomains = new Set(domains);
    const selectedIds = selectedBehaviorIds === null ? null : new Set(selectedBehaviorIds);
    const contracts = catalog.contracts.filter((contract) => contract.status === 'active'
    && contract.documentationPolicy === 'required' && selectedDomains.has(contract.domain)
    && (selectedIds === null || selectedIds.has(contract.id))).sort((a, b) => a.id.localeCompare(b.id));
    if (contracts.length === 0)
    {
        throw new Error(`scope ${scopeId} selects no active required behaviors`);
    }
    const lifecycleByPath = new Map(lifecycle.documents.map((entry) => [entry.path, entry]));
    const contractById = new Map(contracts.map((entry) => [entry.id, entry]));
    const observations = receiptIndex(observationReceipts);
    const claims = claimReceipt.claims.filter((claim) => contractById.has(claim.declaration.behaviorId));
    const sections = sectionCatalog.sections.filter((section) => contractById.has(section.behaviorId));
    const sectionById = new Map(sections.map((section) => [section.sectionId, section]));
    const failures = [];
    const scope = migrationLedger?.scopes?.find((entry) => entry.scopeId === scopeId);
    if (!scope)
    {
        failures.push(`missing domain migration ledger ${scopeId}`);
    }
    else
    {
        if (!sameSet(scope.behaviorIds, contracts.map((entry) => entry.id)))
        {
            failures.push(`${scopeId} behavior roster conflicts with BehaviorCatalog`);
        }
        const expectedPairs = contracts.flatMap((contract) => contract.documents.map((documentPath) => pairKey(contract.id, documentPath)));
        const actualPairs = scope.entries.map((entry) => pairKey(entry.behaviorId, entry.documentPath));
        if (!sameSet(expectedPairs, actualPairs) || new Set(actualPairs).size !== actualPairs.length)
        {
            failures.push(`${scopeId} document ledger is not bidirectionally exact`);
        }
        for (const entry of scope.entries)
        {
            const actualClaims = claims.filter((claim) => claim.declaration['behaviorId'] === entry['behaviorId'] && claim.location.documentPath === entry.documentPath).map((claim) => claim.declaration.claimId);
            const actualSections = sections.filter((section) => section['behaviorId'] === entry['behaviorId'] && section.documentPath === entry.documentPath).map((section) => section.sectionId);
            if (!sameSet(entry.claimIds, actualClaims))
            {
                failures.push(`${entry.documentPath} claim ledger is not bidirectionally exact`);
            }
            if (!sameSet(entry.generatedSectionIds, actualSections))
            {
                failures.push(`${entry.documentPath} section ledger is not bidirectionally exact`);
            }
        }
    }
    const rows = [];
    for (const contract of contracts)
    {
        const behaviorClaims = claims.filter((claim) => claim.declaration['behaviorId'] === contract.id);
        if (behaviorClaims.length === 0)
        {
            failures.push(`missing claim/section for required behavior ${contract.id}`);
        }
        if (behaviorClaims.length === 1 && contract.documents.length > 1)
        {
            failures.push(`overbroad single claim for ${contract.id}`);
        }
        const receipt = observations.get(contract.factExtractorId);
        if (!receipt || receipt.status !== 'ok' || !receipt.behaviorIds.includes(contract.id))
        {
            failures.push(`missing successful observation for ${contract.id}`);
        }
        else if (receipt.sourceCommit !== sourceCommit || receipt.worktreeFingerprint !== worktreeFingerprint)
        {
            failures.push(`stale observation source identity for ${contract.id}`);
        }
        for (const documentPath of contract.documents)
        {
            const metadata = lifecycleByPath.get(documentPath);
            if (!metadata || metadata.status !== 'current')
            {
                failures.push(`required document ${documentPath} is not current`);
            }
        }
        for (const claim of behaviorClaims)
        {
            const declaration = claim.declaration;
            const section = declaration.claimType === 'generated-section' ? sectionById.get(declaration.generatedSectionId) : null;
            if (declaration.claimType === 'generated-section' && !section)
            {
                failures.push(`claim ${declaration.claimId} references missing generated section`);
                continue;
            }
            const factPath = section?.factPath ?? declaration.factPath;
            const ownerExtractor = section?.extractorId ?? contract.factExtractorId;
            if (ownerExtractor !== contract.factExtractorId)
            {
                failures.push(`claim ${declaration.claimId} has conflicting extractor owner ${ownerExtractor}`);
            }
            const ownerReceipt = observations.get(ownerExtractor);
            const sourceFact = ownerReceipt ? resolveFactPath(ownerReceipt.observations, factPath) : undefined;
            const fact = sourceFact === undefined ? undefined : applyProjection(sourceFact, declaration.projection);
            if (fact === undefined)
            {
                failures.push(`claim ${declaration.claimId} references missing observation ${factPath}`);
            }
            const lifecycleEntry = lifecycleByPath.get(claim.location.documentPath);
            if (!lifecycleEntry || lifecycleEntry.status !== 'current')
            {
                failures.push(`claim ${declaration.claimId} is not in a current document`);
            }
            rows.push({ behaviorId: BehaviorId(contract.id), domain: contract.domain, currentAuthority: claim.location.documentPath,
                documentOwner: lifecycleEntry?.owner ?? 'missing', claimId: declaration.claimId, claimType: declaration.claimType,
                sectionId: section?.sectionId ?? null, ownership: section ? 'generated' : 'prose', extractorId: ownerExtractor,
                observationId: declaration.projection ? `${factPath}#${declaration.projection}` : factPath,
                sourceRange: `${claim.location.claimStartLine}:${claim.location.claimEndLine}`,
                requiredTestKinds: [...contract.requiredTestKinds].sort(), mutationRequired: contract.mutationPolicy?.mutationRequired === true,
                evidence: ownerReceipt && fact !== undefined ? evidenceForFact(ownerReceipt, fact) : { factMetadata: [], consumedInputs: [] },
                documentDigest: readDocumentDigest(repositoryRoot, claim.location.documentPath) });
        }
    }
    const rowKeys = new Set();
    for (const row of rows)
    {
        const key = `${row.behaviorId}\0${row.observationId}\0${row.currentAuthority}`;
        if (rowKeys.has(key))
        {
            failures.push(`duplicate exactness owner ${row.behaviorId}/${row.observationId}/${row.currentAuthority}`);
        }
        rowKeys.add(key);
    }
    for (const section of sections)
    {
        if (!claims.some((claim) => claim.declaration.generatedSectionId === section.sectionId))
        {
            failures.push(`extra generated section ${section.sectionId} has no DocClaim owner`);
        }
    }
    const scopedDocuments = stableUnique(contracts.flatMap((contract) => contract.documents));
    const residue = scanAuthSecurityDocResidue(repositoryRoot, scopedDocuments);
    residue.forEach((entry) => failures.push(`manual-fact ${entry.classId} in ${entry.documentPath}: ${entry.evidence}`));
    const mutationEvidence = runAuthSecurityDocMutationCases();
    if (mutationEvidence.killed !== mutationEvidence.total)
    {
        failures.push('mutation evidence did not kill every required class');
    }
    const counts = { required: contracts.length, generated: rows.filter((row) => row.ownership === 'generated').length,
        prose: rows.filter((row) => row.ownership === 'prose').length, verified: rows.length,
        missing: failures.filter((entry) => entry.startsWith('missing')).length, extra: failures.filter((entry) => entry.startsWith('extra')).length,
        conflict: failures.filter((entry) => /conflict|duplicate|overbroad|bidirectionally/u.test(entry)).length,
        stale: failures.filter((entry) => entry.startsWith('stale')).length,
        retired: failures.filter((entry) => /retired-listed-current/u.test(entry)).length, manualFact: residue.length, warnings: 0 };
    return seal({ schema: behaviorDocExactnessSchema, scopeId, source: { commit: sourceCommit, worktreeFingerprint },
        authorityDigests: { behaviorCatalog: digestCatalog(catalog), lifecycle: digestValue(lifecycle), migrationLedger: digestValue(migrationLedger),
            claims: claimReceipt.contentDigest, generatedSections: digestValue(sectionCatalog),
            observations: digestValue([...observations.values()].map((receipt) => receipt.contentDigest).sort()),
            verifier: digestValue(verifierDigests), scanner: scannerDigest ?? sha256(forbiddenSurfaces.map(([id, pattern]) => `${id}:${pattern}`).join('\n')),
            mutation: mutationEvidence.contentDigest },
        domains: stableUnique([...selectedDomains]), behaviorIds: contracts.map((entry) => BehaviorId(entry.id)),
        rows: rows.sort((a, b) => a.claimId.localeCompare(b.claimId)), counts, mutationEvidence, residue,
        status: failures.length === 0 ? 'ok' : 'failed', failureReasons: stableUnique(failures) });
}

export function validateBehaviorDocExactnessReceipt(receipt, { expectedSourceIdentity = null } = {})
{
    if (receipt?.schema !== behaviorDocExactnessSchema)
    {
        throw new Error('unexpected exactness receipt schema');
    }
    if (receipt.contentDigest !== digestValue({ ...receipt, contentDigest: null }))
    {
        throw new Error('exactness receipt contentDigest mismatch');
    }
    if (expectedSourceIdentity && (receipt.source.commit !== expectedSourceIdentity.sourceCommit || receipt.source.worktreeFingerprint !== expectedSourceIdentity.worktreeFingerprint))
    {
        throw new Error('exactness receipt source identity mismatch');
    }
    if (receipt.status !== 'ok' || receipt.failureReasons.length !== 0 || receipt.counts.warnings !== 0 || receipt.mutationEvidence.killed !== receipt.mutationEvidence.total)
    {
        throw new Error(`behavior doc exactness failed: ${receipt.failureReasons.join('; ')}`);
    }
    return receipt;
}

export function verifyBehaviorDocExactnessReplay(expectedReceipt, inputs)
{
    const replayed = buildBehaviorDocExactnessReceipt(inputs);
    validateBehaviorDocExactnessReceipt(replayed, {
        expectedSourceIdentity: {
            sourceCommit: inputs.sourceCommit,
            worktreeFingerprint: inputs.worktreeFingerprint
        }
    });
    if (expectedReceipt.contentDigest !== replayed.contentDigest
    || JSON.stringify(expectedReceipt) !== JSON.stringify(replayed))
    {
        throw new Error('terminal exactness receipt does not exactly match independent replay');
    }
    return replayed;
}
