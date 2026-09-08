import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const catalogRelative = 'config/contracts/behavior-contracts.json';
export const schemaRelative = 'config/schemas/behavior-contract-catalog.schema.json';
export const allowedTestKinds = new Set(['positive', 'boundary', 'negative', 'concurrency', 'migration', 'mutation']);
export const allowedStatuses = new Set(['active', 'migration-only', 'retired']);
export const allowedDocumentationPolicies = new Set(['required', 'not-public', 'rationale-only']);
export const allowedClaimTypes = new Set(['behavioral', 'safety', 'operational']);
export const contractFieldKeys = [
    'id',
    'domain',
    'risk',
    'status',
    'implementationOwnerCardinality',
    'allowedImplementationOwnerRoles',
    'factExtractorId',
    'requiredTestKinds',
    'documentationPolicy',
    'documentationRationale',
    'allowedClaimTypes',
    'releaseQualification',
    'coverageIds',
    'documents'
];
export const optionalContractFieldKeys = ['evidenceStage', 'runtimeEvidence', 'mutationPolicy', 'documentAuthorities', 'crossDomainReferences'];

const fail = (message) =>
{
    throw new Error(`[behavior-contract-catalog] ${message}`);
};
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys, label) =>
{
    if (!isPlainObject(value))
    {
        fail(`${label} must be an object`);
    }
    const actual = Object.keys(value).sort(); const expected = [...keys].sort();
    if (actual.join('\0') !== expected.join('\0'))
    {
        fail(`${label} has unsupported or missing fields`);
    }
};
const stable = (value) => Array.isArray(value) ? value.map(stable) : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
export const canonicalize = (value) => JSON.stringify(stable(value));
export const digestCatalog = (catalog) => createHash('sha256').update(canonicalize(catalog), 'utf8').digest('hex');
export const documentOwnershipProjection = (catalog, lifecyclePolicy) => ({
    schema: 'fsusblog.behavior-document-ownership.v1',
    domains: [...catalog.domains].sort(),
    behaviors: catalog.contracts
        .filter((contract) => ['protocol', 'release', 'deployment'].includes(contract.domain))
        .map((contract) => ({
            behaviorId: contract.id,
            domain: contract.domain,
            extractorId: contract.factExtractorId,
            documents: structuredClone(contract.documentAuthorities ?? []),
            crossDomainReferences: structuredClone(contract.crossDomainReferences ?? [])
        }))
        .sort((left, right) => left.behaviorId.localeCompare(right.behaviorId)),
    lifecycle: {
        documents: lifecyclePolicy.documents
            .filter((entry) => catalog.contracts.some((contract) => contract.documents.includes(entry.path)))
            .map((entry) => ({ path: entry.path, status: entry.status, owner: entry.owner, supersedes: entry.supersedes, supersededBy: entry.supersededBy }))
            .sort((left, right) => left.path.localeCompare(right.path)),
        pathMigrations: [...(lifecyclePolicy.pathMigrations ?? [])]
            .map((entry) => ({ from: entry.from, to: entry.to, issue: entry.issue ?? null }))
            .sort((left, right) => left.from.localeCompare(right.from))
    }
});
export const digestDocumentOwnership = (catalog, lifecyclePolicy) =>
    createHash('sha256').update(canonicalize(documentOwnershipProjection(catalog, lifecyclePolicy)), 'utf8').digest('hex');
export const loadCatalog = (catalogPath = path.join(root, catalogRelative)) => JSON.parse(readFileSync(catalogPath, 'utf8'));
export const loadSchema = (schemaPath = path.join(root, schemaRelative)) => JSON.parse(readFileSync(schemaPath, 'utf8'));

export function BehaviorId(value)
{
    const catalog = loadCatalog();
    if (typeof value !== 'string' || !catalog.contracts.some((contract) => contract.id === value))
    {
        fail(`unregistered behavior ID ${value}`);
    }
    return value;
}

const readJson = (relative, repositoryRoot) => JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'));
const fileExists = (repositoryRoot, relative) => existsSync(path.join(repositoryRoot, relative));
const isId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]*$/u.test(value) && !/^(?:issue|pr)-\d+/u.test(value);
const uniqueStrings = (values, label, { min = 0 } = {}) =>
{
    if (!Array.isArray(values) || values.length < min || values.some((value) => typeof value !== 'string' || value.length === 0) || new Set(values).size !== values.length)
    {
        fail(`${label} must be a unique non-empty string list`);
    }
};
const exactEnum = (actual, expected, label) =>
{
    if (!Array.isArray(actual) || [...actual].sort().join('\0') !== [...expected].sort().join('\0'))
    {
        fail(`${label} enum drifted from the loader contract`);
    }
};

export function validateSchemaContract(schema)
{
    if (schema?.$id !== 'fsusblog.behavior-contract-catalog.v1' || schema?.additionalProperties !== false)
    {
        fail('schema identity or fail-closed root shape drifted');
    }
    const contract = schema?.$defs?.contract;
    const extractor = schema?.$defs?.extractor;
    if (contract?.additionalProperties !== false || extractor?.additionalProperties !== false)
    {
        fail('schema records must reject unknown fields');
    }
    exactEnum(schema.required, ['schema', 'digestAlgorithm', 'canonicalSerialization', 'domains', 'extractors', 'contracts'], 'catalog required fields');
    exactEnum(extractor.required, ['id', 'path'], 'extractor required fields');
    exactEnum(contract.required, contractFieldKeys, 'contract required fields');
    exactEnum(contract?.properties?.status?.enum, allowedStatuses, 'status');
    exactEnum(contract?.properties?.requiredTestKinds?.items?.enum, allowedTestKinds, 'requiredTestKinds');
    exactEnum(contract?.properties?.documentationPolicy?.enum, allowedDocumentationPolicies, 'documentationPolicy');
    exactEnum(contract?.properties?.allowedClaimTypes?.items?.enum, allowedClaimTypes, 'allowedClaimTypes');
    if (contract?.properties?.implementationOwners !== undefined)
    {
        fail('schema must not declare path-based implementationOwners');
    }
    if (contract?.properties?.allowedImplementationOwnerRoles?.type !== 'array')
    {
        fail('schema must declare allowedImplementationOwnerRoles');
    }
}

export function validateCatalog(catalog, repositoryRoot = root)
{
    const schema = loadSchema(path.join(repositoryRoot, schemaRelative));
    validateSchemaContract(schema);
    exactKeys(catalog, ['schema', 'digestAlgorithm', 'canonicalSerialization', 'domains', 'extractors', 'contracts'], 'catalog');
    if (catalog.schema !== 'fsusblog.behavior-contract-catalog.v1' || catalog.digestAlgorithm !== 'sha256' || catalog.canonicalSerialization !== 'json-utf8-v1')
    {
        fail('unsupported catalog authority contract');
    }
    uniqueStrings(catalog.domains, 'domains', { min: 1 });
    if (catalog.domains.some((domain) => !isId(domain)))
    {
        fail('domains must use stable IDs');
    }
    if (!Array.isArray(catalog.extractors) || catalog.extractors.length === 0)
    {
        fail('extractors must be a non-empty list');
    }
    const extractors = new Map();
    for (const extractor of catalog.extractors)
    {
        exactKeys(extractor, ['id', 'path'], 'extractor');
        if (!isId(extractor.id) || typeof extractor.path !== 'string' || !/^(?:config|tests|tools|src)\//u.test(extractor.path) || !fileExists(repositoryRoot, extractor.path) || extractors.has(extractor.id))
        {
            fail(`invalid or duplicate extractor ${extractor.id ?? '<unknown>'}`);
        }
        extractors.set(extractor.id, extractor);
    }
    const coverage = new Set(readJson('tests/coverage-registry.json', repositoryRoot).entries.map((entry) => entry.id));
    const lifecyclePolicy = readJson('config/development/document-lifecycle.json', repositoryRoot);
    const lifecycle = new Map(lifecyclePolicy.documents.map((document) => [document.path, document]));
    const migratedFromPaths = new Set((lifecyclePolicy.pathMigrations ?? []).map((entry) => entry.from));
    let generatedSectionCatalog = null;
    if (!Array.isArray(catalog.contracts) || catalog.contracts.length === 0)
    {
        fail('contracts must be a non-empty list');
    }
    const ids = new Set();
    for (const contract of catalog.contracts)
    {
        exactKeys(contract, [
            ...contractFieldKeys,
            ...optionalContractFieldKeys.filter((field) => Object.hasOwn(contract, field))
        ], `contract ${contract.id ?? '<unknown>'}`);
        if (Object.prototype.hasOwnProperty.call(contract, 'implementationOwners'))
        {
            fail(`${contract.id ?? '<unknown>'} still declares path-based implementationOwners`);
        }
        if (!isId(contract.id) || ids.has(contract.id))
        {
            fail(`invalid or duplicate behavior ID ${contract.id ?? '<unknown>'}`);
        }
        ids.add(contract.id);
        if (!catalog.domains.includes(contract.domain))
        {
            fail(`${contract.id} references unknown domain ${contract.domain}`);
        }
        if (!['low', 'medium', 'high', 'critical'].includes(contract.risk) || !allowedStatuses.has(contract.status))
        {
            fail(`${contract.id} has invalid risk or status`);
        }
        if (!['one', 'many'].includes(contract.implementationOwnerCardinality))
        {
            fail(`${contract.id} has invalid implementation owner cardinality`);
        }
        if (!Array.isArray(contract.allowedImplementationOwnerRoles) || contract.allowedImplementationOwnerRoles.some((role) => !isId(role)) || new Set(contract.allowedImplementationOwnerRoles).size !== contract.allowedImplementationOwnerRoles.length)
        {
            fail(`${contract.id} allowedImplementationOwnerRoles must be a unique stable role ID list`);
        }
        if (contract.implementationOwnerCardinality === 'one' && contract.allowedImplementationOwnerRoles.length !== 0)
        {
            fail(`${contract.id} one-owner behaviors must use an empty allowedImplementationOwnerRoles list`);
        }
        if (contract.implementationOwnerCardinality === 'many' && contract.allowedImplementationOwnerRoles.length < 2)
        {
            fail(`${contract.id} many-owner behaviors must declare at least two allowed roles`);
        }
        if (!extractors.has(contract.factExtractorId))
        {
            fail(`${contract.id} references unknown fact extractor ${contract.factExtractorId}`);
        }
        uniqueStrings(contract.requiredTestKinds, `${contract.id}.requiredTestKinds`);
        if (contract.requiredTestKinds.some((kind) => !allowedTestKinds.has(kind)))
        {
            fail(`${contract.id} has unknown required test kind`);
        }
        if (!allowedDocumentationPolicies.has(contract.documentationPolicy) || typeof contract.documentationRationale !== 'string' || contract.documentationRationale.trim().length === 0)
        {
            fail(`${contract.id} has invalid documentation policy or rationale`);
        }
        uniqueStrings(contract.allowedClaimTypes, `${contract.id}.allowedClaimTypes`, { min: 1 });
        if (contract.allowedClaimTypes.some((type) => !allowedClaimTypes.has(type)))
        {
            fail(`${contract.id} has invalid claim type`);
        }
        if (typeof contract.releaseQualification !== 'boolean')
        {
            fail(`${contract.id} releaseQualification must be boolean`);
        }
        const evidenceStage = contract.evidenceStage ?? 'pre-runtime';
        if (!['pre-runtime', 'post-runtime'].includes(evidenceStage))
        {
            fail(`${contract.id} evidenceStage is invalid`);
        }
        if (evidenceStage === 'post-runtime')
        {
            if (!isPlainObject(contract.runtimeEvidence)
                || Object.keys(contract.runtimeEvidence).sort().join('\0') !== ['observationSchema', 'producerTierId'].join('\0')
                || !isId(contract.runtimeEvidence.producerTierId)
                || !/^fsusblog\.[a-z0-9.-]+\.v[0-9]+$/u.test(contract.runtimeEvidence.observationSchema))
            {
                fail(`${contract.id} post-runtime behavior requires one stable runtime evidence producer/schema`);
            }
        }
        else if (Object.hasOwn(contract, 'runtimeEvidence'))
        {
            fail(`${contract.id} pre-runtime behavior cannot declare runtimeEvidence`);
        }
        uniqueStrings(contract.coverageIds, `${contract.id}.coverageIds`, { min: 1 });
        if (contract.coverageIds.some((id) => !coverage.has(id)))
        {
            fail(`${contract.id} references unknown coverage ID`);
        }
        uniqueStrings(contract.documents, `${contract.id}.documents`, { min: contract.documentationPolicy === 'not-public' ? 0 : 1 });
        for (const documentPath of contract.documents)
        {
            const document = lifecycle.get(documentPath);
            if (!document)
            {
                fail(`${contract.id} references unknown lifecycle document ${documentPath}`);
            }
            if (contract.status === 'active' && contract.documentationPolicy === 'required' && document.status !== 'current')
            {
                fail(`${contract.id} required documentation must be current`);
            }
            if (contract.status !== 'active' && document.status === 'current')
            {
                fail(`${contract.id} migration-only or retired behavior cannot reference current documentation`);
            }
        }
        if (Object.hasOwn(contract, 'documentAuthorities'))
        {
            if (!Array.isArray(contract.documentAuthorities) || contract.documentAuthorities.length === 0)
            {
                fail(`${contract.id}.documentAuthorities must be non-empty`);
            }
            const authorityPaths = [];
            for (const authority of contract.documentAuthorities)
            {
                exactKeys(authority, ['path', 'owner', 'anchor', 'claimIds', 'sectionIds', 'proofIds'], `${contract.id}.documentAuthority`);
                const lifecycleDocument = lifecycle.get(authority.path);
                if (!lifecycleDocument || lifecycleDocument.status !== 'current' || lifecycleDocument.owner !== authority.owner)
                {
                    fail(`${contract.id} document authority ${authority.path} conflicts with current lifecycle owner`);
                }
                if (!contract.documents.includes(authority.path)) fail(`${contract.id} authority path is outside documents: ${authority.path}`);
                if (migratedFromPaths.has(authority.path)) fail(`${contract.id} archived/moved path cannot remain a current authority: ${authority.path}`);
                if (!/^[a-z][a-z0-9.-]*$/u.test(authority.anchor)) fail(`${contract.id} has invalid authority anchor`);
                uniqueStrings(authority.claimIds, `${contract.id}.${authority.path}.claimIds`);
                uniqueStrings(authority.sectionIds, `${contract.id}.${authority.path}.sectionIds`);
                uniqueStrings(authority.proofIds, `${contract.id}.${authority.path}.proofIds`, { min: 1 });
                if (authority.claimIds.length === 0 && authority.sectionIds.length === 0) fail(`${contract.id} authority ${authority.path} has no required claim/section`);
                authorityPaths.push(authority.path);
            }
            if (new Set(authorityPaths).size !== authorityPaths.length || authorityPaths.sort().join('\0') !== [...contract.documents].sort().join('\0'))
            {
                fail(`${contract.id}.documentAuthorities must exactly own contract documents`);
            }
        }
        else if (['protocol', 'release', 'deployment'].includes(contract.domain))
        {
            fail(`${contract.id} requires exact documentAuthorities in ${contract.domain}`);
        }
        if (Object.hasOwn(contract, 'crossDomainReferences'))
        {
            generatedSectionCatalog ??= readJson('config/contracts/generated-fact-sections.json', repositoryRoot);
            if (!Array.isArray(contract.crossDomainReferences)) fail(`${contract.id}.crossDomainReferences must be a list`);
            for (const reference of contract.crossDomainReferences)
            {
                exactKeys(reference, ['domain', 'behaviorId', 'documentPath', 'factIds'], `${contract.id}.crossDomainReference`);
                if (reference.domain === contract.domain) fail(`${contract.id} cross-domain reference must target another domain`);
                if (!catalog.domains.includes(reference.domain)) fail(`${contract.id} references unknown domain ${reference.domain}`);
                const target = catalog.contracts.find((entry) => entry.id === reference.behaviorId);
                if (!target || target.domain !== reference.domain || !target.documents.includes(reference.documentPath))
                {
                    fail(`${contract.id} cross-domain reference has no exact target owner`);
                }
                const referenceOwners = generatedSectionCatalog.sections.filter((section) =>
                    section.behaviorId === reference.behaviorId
                    && section.documentPath === reference.documentPath
                    && reference.factIds.includes(section.factPath));
                if (referenceOwners.length !== reference.factIds.length
                    || new Set(referenceOwners.map((section) => section.factPath)).size !== reference.factIds.length)
                {
                    fail(`${contract.id} cross-domain facts lack exact-one generated owner`);
                }
                const localSectionIds = new Set((contract.documentAuthorities ?? []).flatMap((authority) => authority.sectionIds));
                if (referenceOwners.some((section) => localSectionIds.has(section.sectionId)))
                {
                    fail(`${contract.id} duplicates cross-domain fact ownership from ${reference.behaviorId}`);
                }
                uniqueStrings(reference.factIds, `${contract.id}.crossDomainReference.factIds`, { min: 1 });
            }
        }
        if (contract.status === 'active')
        {
            if (!contract.factExtractorId || contract.requiredTestKinds.length === 0 && contract.documentationPolicy === 'required')
            {
                fail(`${contract.id} active behavior lacks required extractor or test kind`);
            }
            if (contract.documentationPolicy === 'not-public' && contract.documents.length !== 0)
            {
                fail(`${contract.id} not-public behavior must not list public documents`);
            }
        }
        else if (contract.status === 'migration-only' && (contract.releaseQualification || contract.requiredTestKinds.length !== 1 || contract.requiredTestKinds[0] !== 'migration'))
        {
            fail(`${contract.id} migration-only behavior requires migration proof and cannot qualify a release`);
        }
        else if (contract.status === 'retired' && (contract.releaseQualification || contract.requiredTestKinds.length !== 0))
        {
            fail(`${contract.id} retired behavior cannot qualify a release or require ordinary proof`);
        }
        if (Object.hasOwn(contract, 'mutationPolicy'))
        {
            const policy = contract.mutationPolicy;
            if (!isPlainObject(policy) || Object.keys(policy).sort().join('\0') !== ['allowedEquivalentMutantPolicy', 'minimumMutationScore', 'mutationRequired', 'requireExecutedMutants'].join('\0'))
            {
                fail(`${contract.id} mutationPolicy must use the canonical four-field shape`);
            }
            if (typeof policy.mutationRequired !== 'boolean' || typeof policy.requireExecutedMutants !== 'boolean' || !Number.isFinite(policy.minimumMutationScore) || policy.minimumMutationScore < 0 || policy.minimumMutationScore > 100 || !['none', 'documented'].includes(policy.allowedEquivalentMutantPolicy))
            {
                fail(`${contract.id} mutationPolicy is invalid`);
            }
            if (!policy.mutationRequired && (policy.requireExecutedMutants || policy.minimumMutationScore !== 0 || policy.allowedEquivalentMutantPolicy !== 'none'))
            {
                fail(`${contract.id} non-required mutationPolicy must not declare a qualifying fallback`);
            }
        }
    }
    return { digest: digestCatalog(catalog), ownershipDigest: digestDocumentOwnership(catalog, lifecyclePolicy), ids };
}

const walk = (directory, out = []) =>
{
    for (const entry of readdirSync(directory))
    {
        if (entry === 'node_modules' || entry === '.git' || entry === '.tmp')
        {
            continue;
        }
        const target = path.join(directory, entry); const stat = statSync(target);
        if (stat.isDirectory())
        {
            walk(target, out);
        }
        else if (/\.(?:json|mjs|js|ts|tsx|jsx|cs|ya?ml|md|sh|vue|c|cc|cpp|h|hpp)$/u.test(entry))
        {
            out.push(target);
        }
    }
    return out;
};

export function validateBehaviorReferences(catalog, repositoryRoot = root)
{
    validateCatalog(catalog, repositoryRoot);
    const contracts = new Map(catalog.contracts.map((contract) => [contract.id, contract]));
    const lifecycle = new Map(readJson('config/development/document-lifecycle.json', repositoryRoot).documents.map((document) => [document.path, document]));
    const forbiddenAuthorityFields = new Set([
        'behaviorId',
        'behaviorIds',
        'behaviorAliases',
        'factExtractorId',
        'requiredTestKinds',
        'documentationPolicy',
        'allowedClaimTypes',
        'releaseQualification',
        'implementationOwnerCardinality',
        'allowedImplementationOwnerRoles',
        'implementationOwners',
        'documentAuthorities',
        'crossDomainReferences'
    ]);
    const catalogOnlyFields = new Set([
        'factExtractorId',
        'requiredTestKinds',
        'documentationPolicy',
        'allowedClaimTypes',
        'releaseQualification',
        'implementationOwnerCardinality',
        'allowedImplementationOwnerRoles',
        'implementationOwners',
        'documentAuthorities',
        'crossDomainReferences'
    ]);
    const assertNoBehaviorFields = (value, relative) =>
    {
        if (Array.isArray(value))
        {
            return value.forEach((item) => assertNoBehaviorFields(item, relative));
        }
        if (!isPlainObject(value))
        {
            return;
        }
        for (const [key, nested] of Object.entries(value))
        {
            if (forbiddenAuthorityFields.has(key))
            {
                fail(`${relative} duplicates behavior-contract field ${key}`);
            }
            assertNoBehaviorFields(nested, relative);
        }
    };
    for (const relative of ['tests/coverage-registry.json', 'tests/governance/code-intent-registry.json', 'config/development/document-lifecycle.json'])
    {
        assertNoBehaviorFields(readJson(relative, repositoryRoot), relative);
    }
    const allowedGenerated = new Set([
        'src/frontend/src/contracts/behaviorContractCatalog.ts',
        'src/shared/Contracts/Governance/BehaviorContractCatalog.g.cs',
        'src/shared/Contracts/Governance/BehaviorTestKind.cs',
        'src/shared/Contracts/Governance/CoversBehaviorAttribute.cs',
        'config/schemas/behavior-contract-catalog.schema.json',
        'config/schemas/behavior-test-evidence.schema.json',
        'config/schemas/behavior-graph-receipt.schema.json',
        'config/schemas/behavior-evidence-pre-runtime-receipt.schema.json',
        'config/schemas/behavior-evidence-post-runtime-receipt.schema.json',
        'config/schemas/behavior-document-consistency-final-report.schema.json',
        'tests/tools/behavior-contract-catalog.test.mjs',
        'tests/tools/behavior-mutation-qualification.test.mjs',
        'tests/tools/behavior-owner-binding.test.mjs',
        'tests/tools/behavior-test-binding.test.mjs',
        'tests/tools/behavior-graph-join.test.mjs',
        'tests/tools/behavior-evidence-pre-runtime.test.mjs',
        'tests/tools/support/behavior-evidence-pre-runtime-fixture.mjs',
        'tests/tools/behavior-evidence-post-runtime.test.mjs',
        'tests/tools/behavior-document-consistency-final.test.mjs',
        'tests/tools/changed-critical-mutation.test.mjs',
        'tests/tools/doc-claim.test.mjs',
        'tests/tools/behavior-fact-extractors.test.mjs',
        'tests/tools/generated-fact-sections.test.mjs',
        'tests/tools/document-claim-migration-ledger.test.mjs',
        'tests/tools/test-matrix-topology-observation.test.mjs',
        'tests/tools/ts-ast-adapter.test.mjs',
        'tools/contracts/behavior-contract-catalog.mjs',
        'tools/contracts/cross-authority-dag.mjs',
        'tools/contracts/behavior-owner-binding.mjs',
        'tools/contracts/behavior-test.mjs',
        'tools/contracts/behavior-test-binding.mjs',
        'tools/contracts/behavior-graph-join.mjs',
        'tools/test-matrix/behavior-evidence-pre-runtime.mjs',
        'tools/test-matrix/behavior-evidence-post-runtime.mjs',
        'tools/docs/behavior-document-consistency-final.mjs',
        'tools/test-matrix/behavior-mutation-owner.mjs',
        'tools/test-matrix/produce-behavior-mutation-qualification.mjs',
        'tools/test-matrix/produce-behavior-test-evidence.mjs',
        'tools/test-matrix/verify-behavior-mutation-qualification.mjs',
        'tools/test-matrix/verify-behavior-test-evidence.mjs',
        'tools/contracts/check-behavior-graph.mjs',
        'tools/test/changed-critical-mutation.mjs',
        'tools/test/changed-critical-mutation-attribution.mjs',
        'tools/test/changed-critical-mutation-evidence.mjs',
        'tools/test/mutation-evidence-receipt.mjs',
        'tools/test/run-changed-critical-mutation.mjs',
        'tools/contracts/check-behavior-test-evidence.mjs',
        'tools/contracts/check-behavior-owner-binding.mjs',
        'tools/contracts/generate-behavior-contract-catalog.mjs',
        'tools/docs/doc-claim.mjs',
        'tools/docs/check-doc-claim.mjs',
        'tools/docs/check-document-claim-migration-ledger.mjs',
        'tools/docs/doc-claim-staleness-mutation/fixture.mjs',
        'tools/docs/doc-claim-staleness-mutation/runner.mjs',
        'tools/docs/generated-fact-sections/generator.mjs',
        'tools/docs/prose-claim-verifier/verifier.mjs',
        'tools/fact-extractors/registry.mjs',
        'tools/fact-extractors/receipt.mjs',
        'tools/fact-extractors/runner.mjs',
        'tools/fact-extractors/reader.mjs',
        'tools/fact-extractors/identity.mjs',
        'tools/fact-extractors/governance.mjs',
        'tools/fact-extractors/check-behavior-fact-extractors.mjs',
        'config/schemas/doc-claim.schema.json',
        'config/schemas/behavior-fact-extractor-registry.schema.json',
        'config/schemas/fact-observation-receipt.schema.json',
        'config/contracts/behavior-fact-extractors.json',
        'docs/development/doc-claim-protocol.md'
    ]);
    const validateReference = (id, relative) =>
    {
        const contract = contracts.get(id);
        if (!contract)
        {
            fail(`${relative} references unregistered behavior ID ${id}`);
        }
        const document = lifecycle.get(relative);
        if (relative.startsWith('docs/') && (!document || document.status === 'current') && contract.status !== 'active')
        {
            fail(`${relative} current documentation references ${contract.status} behavior ${id}`);
        }
        if (relative.startsWith('tests/') && contract.status !== 'active')
        {
            fail(`${relative} ordinary correctness references ${contract.status} behavior ${id}`);
        }
    };
    const inspectJsonReferences = (value, relative) =>
    {
        if (Array.isArray(value))
        {
            return value.forEach((item) => inspectJsonReferences(item, relative));
        }
        if (!isPlainObject(value))
        {
            return;
        }
        for (const [key, nested] of Object.entries(value))
        {
            if (key === 'behaviorId')
            {
                // Live references must be registered strings. JSON Schema property
                // definitions (objects under config/schemas/*.json) are not references.
                if (typeof nested === 'string')
                {
                    validateReference(nested, relative);
                }
                else if (isPlainObject(nested) && relative.startsWith('config/schemas/'))
                {
                    // schema field definition — ignore
                }
                else
                {
                    fail(`${relative} behaviorId must be one registered string`);
                }
            }
            else if (key === 'behaviorIds')
            {
                if (Array.isArray(nested))
                {
                    uniqueStrings(nested, `${relative}.behaviorIds`);
                    nested.forEach((id) => validateReference(id, relative));
                }
                else if (isPlainObject(nested) && relative.startsWith('config/schemas/'))
                {
                    // schema field definition — ignore
                }
                else
                {
                    uniqueStrings(nested, `${relative}.behaviorIds`);
                    nested.forEach((id) => validateReference(id, relative));
                }
            }
            inspectJsonReferences(nested, relative);
        }
    };
    for (const directory of ['config', 'tests', 'tools', 'src', 'docs'])
    {
        for (const file of walk(path.join(repositoryRoot, directory)))
        {
            const relative = path.relative(repositoryRoot, file); if (allowedGenerated.has(relative))
            {
                continue;
            }
            const source = readFileSync(file, 'utf8');
            let parsedJson = false;
            if (relative.endsWith('.json'))
            {
                try
                {
                    const document = JSON.parse(source);
                    inspectJsonReferences(document, relative);
                    if (relative !== catalogRelative && relative !== schemaRelative)
                    {
                        const assertNoCatalogFields = (value) =>
                        {
                            if (Array.isArray(value))
                            {
                                return value.forEach(assertNoCatalogFields);
                            }
                            if (!isPlainObject(value))
                            {
                                return;
                            }
                            for (const [key, nested] of Object.entries(value))
                            {
                                if (catalogOnlyFields.has(key))
                                {
                                    fail(`${relative} duplicates behavior-contract field ${key}`);
                                }
                                assertNoCatalogFields(nested);
                            }
                        };
                        assertNoCatalogFields(document);
                        if (typeof document.schema === 'string' && document.schema.startsWith('fsusblog.behavior-contract-catalog.'))
                        {
                            fail(`${relative} declares a second behavior catalog`);
                        }
                        if (typeof document.schema === 'string' && /behavior[_-]?owner/iu.test(document.schema))
                        {
                            fail(`${relative} declares a second owner registry`);
                        }
                    }
                    parsedJson = true;
                }
                catch (error)
                {
                    if (!(error instanceof SyntaxError))
                    {
                        throw error;
                    }
                }
            }
            if (!parsedJson)
            {
                for (const line of source.split(/\r?\n/u))
                {
                    const reference = line.match(/\b(behaviorId|behaviorIds)\b\s*["']?\s*[:=]\s*(.*)$/u);
                    if (!reference)
                    {
                        continue;
                    }
                    if (/\bBehaviorId\b/u.test(reference[2]))
                    {
                        continue;
                    }
                    const literals = [...reference[2].matchAll(/["'`]([a-z][a-z0-9-]*)["'`]/gu)].map((match) => match[1]);
                    const markerLiteral = reference[2].trim().match(/^([a-z][a-z0-9-]*)$/u)?.[1];
                    if (markerLiteral) literals.push(markerLiteral);
                    if (literals.length === 0)
                    {
                        fail(`${relative} contains an untyped or free-string behavior reference`);
                    }
                    literals.forEach((id) => validateReference(id, relative));
                }
            }
            if (/\b(?:behavior[_-]?aliases|deprecated[_-]?behavior[_-]?id|compat(?:ibility)?[_-]?behavior[_-]?catalog|legacy[_-]?behavior[_-]?catalog|path[_-]?based[_-]?owner|owner[_-]?inference|compat(?:ibility)?[_-]?behavior[_-]?owner|legacy[_-]?behavior[_-]?owner|deprecated[_-]?behavior[_-]?owner)\b/iu.test(source))
            {
                fail(`${relative} contains forbidden behavior compatibility surface`);
            }
        }
    }
    for (const relative of ['tests/matrix.yml'])
    {
        const source = readFileSync(path.join(repositoryRoot, relative), 'utf8');
        for (const field of forbiddenAuthorityFields)
        {
            if (new RegExp(`^\\s*${field}:`, 'mu').test(source))
            {
                fail(`${relative} duplicates behavior-contract field ${field}`);
            }
        }
    }
}
