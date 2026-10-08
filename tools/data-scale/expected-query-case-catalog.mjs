import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectQueryScenarioApplicability } from './distribution-query-binding.mjs';
import { queryCaseIds } from './query-case-registry.mjs';
import { computeSha256 } from './runtime-plan.mjs';

const { validateJsonSchema } = await import(new URL('../test-matrix/schema-validator/validate.mjs', import.meta.url));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaPath = 'config/schemas/expected-query-case-catalog.schema.json';
const registryPath = 'tools/data-scale/query-case-registry.mjs';
const schemaBytes = fs.readFileSync(path.join(repositoryRoot, schemaPath));
const catalogSchema = JSON.parse(schemaBytes);
const schemaDigest = computeSha256(schemaBytes);
const registryDigest = computeSha256(fs.readFileSync(path.join(repositoryRoot, registryPath)));

/**
 * Consume the original distribution inspector with the original query inventory.
 * Applicability must come from the query owner; no case-name inference, receipt,
 * statistics fabrication or qualification is performed by this consumer.
 * Noncanonical JavaScript inputs retain the original serializer's exceptions.
 */
export function inspectExpectedQueryScenarioApplicability(applicability)
{
    return inspectQueryScenarioApplicability({ caseIds: queryCaseIds, applicability });
}

/** Required semantic kinds are schema vocabulary, never a second case registry. */
export function expectedQueryKinds()
{
    return {
        article: [...catalogSchema.$defs.articleKind.enum],
        comment: [...catalogSchema.$defs.commentKind.enum]
    };
}

/** Seal declarative metadata only; this neither generates expected data nor runs queries. */
export function expectedQueryCatalogDigest(value)
{
    const content = { ...value };
    delete content.contentDigest;
    return computeSha256(content);
}

function same(left, right)
{
    return left !== undefined && right !== undefined && computeSha256(left) === computeSha256(right);
}

function add(violations, ruleId, detail, caseId = null)
{
    violations.push({ ruleId, caseId, detail });
}

function duplicateKeys(rows, selector)
{
    const seen = new Set();
    return rows.flatMap((row) =>
    {
        const key = selector(row);
        if (seen.has(key))
        {
            return [key];
        }
        seen.add(key);
        return [];
    });
}

function exactCases(rows, violations, label)
{
    const ids = rows.map((row) => row.id);
    for (const id of duplicateKeys(rows, (row) => row.id))
    {
        add(violations, 'duplicate-case', `${label} contains duplicate case`, id);
    }
    for (const id of queryCaseIds)
    {
        if (!ids.includes(id))
        {
            add(violations, 'missing-case', `${label} omits canonical query`, id);
        }
    }
    for (const id of ids)
    {
        if (!queryCaseIds.includes(id))
        {
            add(violations, 'unknown-case', `${label} declares a query outside the canonical registry`, id);
        }
    }
}

/**
 * Validate a catalog against independently supplied current owner projections.
 * The intake is a validator contract, not an implementation of missing graph,
 * distribution or query-owner exporters. Missing projections always fail.
 */
export function validateExpectedQueryCaseCatalog(catalog, currentInputs = {})
{
    const violations = validateJsonSchema(catalog, catalogSchema)
        .map((detail) => ({ ruleId: 'closed-schema', caseId: null, detail }));
    if (violations.length)
    {
        return { status: 'failed', violations };
    }
    const projectionSchema = {
        $schema: catalogSchema.$schema,
        $defs: catalogSchema.$defs,
        $ref: '#/$defs/currentInputs'
    };
    const projectionErrors = validateJsonSchema(currentInputs, projectionSchema);
    if (projectionErrors.length)
    {
        return {
            status: 'failed',
            violations: projectionErrors.map((detail) => ({ ruleId: 'closed-input-schema', caseId: null, detail }))
        };
    }
    let { authorityRefs, queryOwners, inputRoles, scenarios } = currentInputs;
    if (catalog.schemaDigest !== schemaDigest)
    {
        add(violations, 'stale-schema', 'catalog is not bound to current closed schema bytes');
    }
    if (catalog.queryRegistry.path !== registryPath || catalog.queryRegistry.contentDigest !== registryDigest)
    {
        add(violations, 'stale-query-registry', 'catalog is not bound to current canonical registry bytes');
    }
    if (catalog.contentDigest !== expectedQueryCatalogDigest(catalog))
    {
        add(violations, 'catalog-tamper', 'catalog digest differs from declarative content');
    }
    exactCases(catalog.cases, violations, 'catalog');
    const kinds = expectedQueryKinds();
    for (const [domain, requiredKinds] of Object.entries(kinds))
    {
        for (const kind of requiredKinds)
        {
            if (!catalog.cases.some((entry) => entry.domain === domain && entry.kind === kind))
            {
                add(violations, 'missing-kind', `${domain}:${kind} lacks a canonical query case`);
            }
        }
    }
    for (const [authority, reference] of Object.entries(catalog.authorities))
    {
        if (!same(reference, authorityRefs?.[authority]))
        {
            add(violations, 'stale-input-authority', `${authority} current canonical reference missing or different`);
        }
    }
    if (!Array.isArray(queryOwners))
    {
        add(violations, 'missing-query-owners', 'independent current query owner projection is required');
        queryOwners = [];
    }
    exactCases(queryOwners, violations, 'owner projection');
    if (!Array.isArray(inputRoles) || !Array.isArray(scenarios))
    {
        add(violations, 'missing-input-projections', 'independent canonical input roles and scenario projections are required');
    }
    inputRoles = Array.isArray(inputRoles) ? inputRoles : [];
    scenarios = Array.isArray(scenarios) ? scenarios : [];
    for (const [label, rows] of [['input role', inputRoles], ['scenario', scenarios]])
    {
        for (const id of duplicateKeys(rows, (row) => row.id))
        {
            add(violations, 'ambiguous-input', `${label} projection contains duplicate ${id}`);
        }
    }
    for (const entry of catalog.cases)
    {
        if (entry.contentDigest !== expectedQueryCatalogDigest(entry))
        {
            add(violations, 'case-tamper', 'case digest differs from declarative content', entry.id);
        }
        const owner = queryOwners.find((row) => row.id === entry.id);
        if (!owner || !same(owner.queryOwner, entry.queryOwner) || owner.domain !== entry.domain
            || owner.kind !== entry.kind || owner.actorClass !== entry.actorClass
            || owner.expectedSchema !== entry.expectedSchema
            || !same(owner.semantics, entry.semantics) || !same(owner.inputs, entry.inputs)
            || !same(owner.scenarioIds, entry.scenarios.map((scenario) => scenario.id)))
        {
            add(violations, 'query-owner-mismatch', 'case semantics differ from independent current query owner', entry.id);
        }
        for (const parameter of duplicateKeys(entry.inputs, (input) => input.parameter))
        {
            add(violations, 'ambiguous-input', `duplicate parameter ${parameter}`, entry.id);
        }
        for (const input of entry.inputs)
        {
            const role = inputRoles.find((row) => row.id === input.roleId);
            if (!role || role.authority !== input.authority || !role.domains?.includes(entry.domain)
                || role.valueType !== input.valueType)
            {
                add(violations, 'input-role-mismatch', `unknown or mismatched role ${input.roleId}`, entry.id);
            }
        }
        if (!inputRoles.some((role) => role.id === entry.actorClass && role.domains?.includes(entry.domain)))
        {
            add(violations, 'actor-role-mismatch', 'permission actor must reference a current canonical role', entry.id);
        }
        if (!entry.semantics.order.some((order) => order.roleId === entry.semantics.tieBreakerRoleId)
            || new Set(entry.semantics.order.map((order) => order.roleId)).size !== entry.semantics.order.length)
        {
            add(violations, 'order-semantics', 'explicit unique order must include its tie-breaker role', entry.id);
        }
        for (const roleId of [...entry.semantics.order.map((order) => order.roleId),
            entry.semantics.visibilityPolicyRef, entry.semantics.permissionPolicyRef])
        {
            if (!inputRoles.some((role) => role.id === roleId && role.domains?.includes(entry.domain)))
            {
                add(violations, 'semantic-role-mismatch', `unknown order/visibility/permission role ${roleId}`, entry.id);
            }
        }
        for (const id of duplicateKeys(entry.scenarios, (scenario) => scenario.id))
        {
            add(violations, 'ambiguous-scenario', `duplicate scenario ${id}`, entry.id);
        }
        for (const scenario of entry.scenarios)
        {
            const current = scenarios.find((row) => row.id === scenario.id);
            if (!current || !same(current.reference, scenario))
            {
                add(violations, 'stale-scenario', 'scenario/assignment/statistics identity differs or is missing', entry.id);
            }
        }
        if (!entry.scenarios.some((scenario) => scenario.releaseEvidenceEligible
            && scenarios.some((row) => row.id === scenario.id && row.distributionClass === 'non-uniform')))
        {
            add(violations, 'uniform-only', 'case requires independently declared eligible non-uniform applicability', entry.id);
        }
    }
    return { status: violations.length ? 'failed' : 'verified', violations };
}

/** Static source isolation control; it is not runtime/package qualification. */
export function scanExpectedQueryProductionIsolation(root = repositoryRoot, { overlays = new Map() } = {})
{
    const sources = new Map();
    const violations = [];
    function walk(relative)
    {
        const absolute = path.join(root, relative);
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true }))
        {
            if (['bin', 'obj', 'node_modules'].includes(entry.name))
            {
                continue;
            }
            const file = path.posix.join(relative, entry.name);
            if (entry.isSymbolicLink())
            {
                add(violations, 'unobservable-production-source', file);
            }
            else if (entry.isDirectory())
            {
                walk(file);
            }
            else if (/\.(?:cs|csproj|mjs|js|ts|vue|json)$/u.test(entry.name))
            {
                sources.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
            }
        }
    }
    walk('src');
    for (const [file, source] of overlays)
    {
        if (!file.startsWith('src/') || file.split('/').includes('..') || file.includes('\\'))
        {
            throw new Error('isolation overlay must be a repository-relative production source');
        }
        sources.set(file, source);
    }
    const forbidden = /ExpectedQueryCaseCatalog|fsusblog\.expected-query\.|expected-query-case-catalog|FSUSBLOG_EXPECTED_QUERY/iu;
    for (const [file, source] of sources)
    {
        if (forbidden.test(source))
        {
            add(violations, 'production-expected-reference', file);
        }
    }
    return { status: violations.length ? 'failed' : 'verified', scannedFiles: sources.size, violations };
}
