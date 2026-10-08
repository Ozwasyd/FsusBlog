import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
    expectedQueryCatalogDigest,
    expectedQueryKinds,
    scanExpectedQueryProductionIsolation,
    validateExpectedQueryCaseCatalog
} = await import(new URL('../../tools/data-scale/expected-query-case-catalog.mjs', import.meta.url));
const { buildQueryCaseInventory, queryCaseIds } = await import(new URL('../../tools/data-scale/query-case-registry.mjs', import.meta.url));
const { computeSha256 } = await import(new URL('../../tools/data-scale/runtime-plan.mjs', import.meta.url));
const { validateJsonSchema } = await import(new URL('../../tools/test-matrix/schema-validator/validate.mjs', import.meta.url));

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemaBytes = fs.readFileSync(path.join(repositoryRoot, 'config/schemas/expected-query-case-catalog.schema.json'));
const catalogSchema = JSON.parse(schemaBytes);
const registryPath = 'tools/data-scale/query-case-registry.mjs';
const syntheticDigest = (label) => computeSha256({ syntheticSchemaControl: label });

function seal(value)
{
    value.contentDigest = expectedQueryCatalogDigest(value);
    return value;
}

// Valid synthetic identity only invokes inventory declarations; it is not a seed/query receipt.
const syntheticInventoryBinding = {
    sourceCommit: 'a'.repeat(40),
    dataScaleRunId: 'synthetic-schema-control',
    fixtureGeneration: 'synthetic-schema-control',
    seedReceiptDigest: syntheticDigest('inventory-seed'),
    expectedModelDigest: syntheticDigest('inventory-model'),
    businessEpochUtc: '2024-02-29T23:59:59.000Z'
};
const declaredInventory = buildQueryCaseInventory(syntheticInventoryBinding);

function caseDomainAndKind(id)
{
    const declared = declaredInventory.cases.find((entry) => entry.id === id);
    assert.ok(declared, `original query authority lacks a declaration for ${id}`);
    return { domain: declared.domain, kind: declared.kind };
}

/** Synthetic validator declarations only; no plan, generator, query, or receipt is exercised. */
function syntheticFixture()
{
    const authorityRefs = Object.fromEntries([
        'articleGraph', 'commentGraph', 'distributionCatalog', 'assignments', 'statistics'
    ].map((authority) => [authority, {
        path: `tests/fixtures/synthetic-query-control/${authority}.json`,
        contentDigest: syntheticDigest(authority)
    }]));
    const inputRoles = ['article', 'comment'].flatMap((domain) => [
        { id: `${domain}-coordinate`, authority: `${domain}Graph`, domains: [domain], valueType: 'semantic-id' },
        { id: `${domain}-actor`, authority: `${domain}Graph`, domains: [domain], valueType: 'semantic-id' },
        { id: `${domain}-order`, authority: `${domain}Graph`, domains: [domain], valueType: 'temporal-ref' },
        { id: `${domain}-visibility`, authority: `${domain}Graph`, domains: [domain], valueType: 'semantic-id' },
        { id: `${domain}-permission`, authority: `${domain}Graph`, domains: [domain], valueType: 'semantic-id' }
    ]);
    const scenarioReference = {
        id: 'synthetic-skewed',
        scenarioDigest: syntheticDigest('scenario'),
        assignmentDigest: syntheticDigest('assignment'),
        statisticsDigest: syntheticDigest('statistics'),
        releaseEvidenceEligible: true
    };
    const scenarios = [{
        id: scenarioReference.id,
        distributionClass: 'non-uniform',
        reference: structuredClone(scenarioReference)
    }];
    function declaration(id)
    {
        const { domain, kind } = caseDomainAndKind(id);
        return {
            id, domain, kind,
            queryOwner: {
                path: 'tests/fixtures/synthetic-query-control/owner.mjs',
                contentDigest: syntheticDigest(`owner:${id}`),
                entrypoint: 'Tests.Control',
                version: 'control-v1'
            },
            inputs: [{
                parameter: 'coordinate', roleId: `${domain}-coordinate`,
                authority: `${domain}Graph`, valueType: 'semantic-id'
            }],
            actorClass: `${domain}-actor`,
            semantics: {
                order: [{ roleId: `${domain}-order`, direction: 'desc', nulls: 'forbidden' }],
                tieBreakerRoleId: `${domain}-order`,
                pagination: kind === 'detail' ? 'none' : 'cursor',
                visibilityPolicyRef: `${domain}-visibility`,
                permissionPolicyRef: `${domain}-permission`
            }
        };
    }
    const cases = queryCaseIds.map((id) => seal({
        ...declaration(id),
        scenarios: [structuredClone(scenarioReference)],
        expectedSchema: `fsusblog.expected-query.${caseDomainAndKind(id).domain}.v1`
    }));
    // Construct a separate projection from synthetic declarations, never from validated catalog state.
    // This tests equality controls only; it is not a real independently exported query owner.
    const queryOwners = queryCaseIds.map((id) => ({
        ...declaration(id),
        scenarioIds: [scenarioReference.id],
        expectedSchema: `fsusblog.expected-query.${caseDomainAndKind(id).domain}.v1`
    }));
    const catalog = seal({
        schema: 'fsusblog.expected-query-case-catalog.v1',
        version: 1,
        productionReadable: false,
        consumers: ['test', 'evidence'],
        queryRegistry: {
            path: registryPath,
            contentDigest: computeSha256(fs.readFileSync(path.join(repositoryRoot, registryPath)))
        },
        authorities: structuredClone(authorityRefs),
        cases,
        schemaDigest: computeSha256(schemaBytes)
    });
    return { catalog, projections: { authorityRefs, queryOwners, inputRoles, scenarios } };
}

function resultFor(fixture)
{
    return validateExpectedQueryCaseCatalog(fixture.catalog, fixture.projections);
}

function rejects(fixture, ruleId, caseId)
{
    const result = resultFor(fixture);
    assert.equal(result.status, 'failed');
    assert.ok(result.violations.some((violation) => violation.ruleId === ruleId
        && (caseId === undefined || violation.caseId === caseId)), JSON.stringify(result.violations));
    return result;
}

function reseal(fixture)
{
    fixture.catalog.cases.forEach(seal);
    seal(fixture.catalog);
}

test('original case authority stays exact while clean synthetic bindings remain incomplete', () =>
{
    const fixture = syntheticFixture();
    assert.deepEqual(fixture.catalog.cases.map((entry) => entry.id), queryCaseIds);
    assert.deepEqual(validateJsonSchema(fixture.catalog, catalogSchema), []);
    const result = resultFor(fixture);
    assert.equal(result.status, 'failed');
    assert.ok(result.violations.length > 0);
    assert.ok(result.violations.every((violation) => violation.ruleId === 'missing-kind'));
    const requiredKinds = expectedQueryKinds();
    const missing = Object.entries(requiredKinds).flatMap(([domain, kinds]) => kinds
        .filter((kind) => !fixture.catalog.cases.some((entry) => entry.domain === domain && entry.kind === kind))
        .map((kind) => `${domain}:${kind} lacks a canonical query case`));
    assert.deepEqual(result.violations.map((violation) => violation.detail), missing);
    assert.ok(missing.length > 0, 'closed schema acceptance must never qualify incomplete inventory');
});

test('kind vocabulary is independently returned from the closed schema', () =>
{
    const kinds = expectedQueryKinds();
    assert.deepEqual(kinds.article, catalogSchema.$defs.articleKind.enum);
    assert.deepEqual(kinds.comment, catalogSchema.$defs.commentKind.enum);
    kinds.article.length = 0;
    assert.deepEqual(expectedQueryKinds().article, catalogSchema.$defs.articleKind.enum);
});

test('catalog and case seals ignore their own contentDigest but bind all other fields', () =>
{
    const { catalog } = syntheticFixture();
    const original = catalog.contentDigest;
    catalog.contentDigest = syntheticDigest('changed-seal');
    assert.equal(expectedQueryCatalogDigest(catalog), original);
    catalog.consumers = ['test'];
    assert.notEqual(expectedQueryCatalogDigest(catalog), original);
    const entry = catalog.cases[0];
    const caseDigest = entry.contentDigest;
    entry.contentDigest = syntheticDigest('changed-case-seal');
    assert.equal(expectedQueryCatalogDigest(entry), caseDigest);
    entry.actorClass = 'other-actor';
    assert.notEqual(expectedQueryCatalogDigest(entry), caseDigest);
});

for (const [name, mutate, ruleId] of [
    ['missing canonical case', (f) => f.catalog.cases.pop(), 'missing-case'],
    ['duplicate canonical case', (f) => f.catalog.cases.push(structuredClone(f.catalog.cases[0])), 'duplicate-case'],
    ['unknown case', (f) =>
    {
        f.catalog.cases[0].id = 'synthetic-unregistered';
    }, 'unknown-case'],
    ['unowned case', (f) => f.projections.queryOwners.pop(), 'query-owner-mismatch'],
    ['double owner', (f) => f.projections.queryOwners.push(structuredClone(f.projections.queryOwners[0])), 'duplicate-case'],
    ['unknown owner', (f) =>
    {
        f.projections.queryOwners[0].id = 'synthetic-unregistered';
    }, 'unknown-case'],
    ['no owners', (f) =>
    {
        delete f.projections.queryOwners;
    }, 'closed-input-schema'],
    ['no input roles', (f) =>
    {
        delete f.projections.inputRoles;
    }, 'closed-input-schema'],
    ['no scenarios', (f) =>
    {
        delete f.projections.scenarios;
    }, 'closed-input-schema']
])
{
    test(`inventory fails closed for ${name}`, () =>
    {
        const fixture = syntheticFixture();
        mutate(fixture);
        reseal(fixture);
        rejects(fixture, ruleId);
    });
}

for (const authority of ['articleGraph', 'commentGraph', 'distributionCatalog', 'assignments', 'statistics'])
{
    for (const mutation of ['missing', 'digest', 'path'])
    {
        test(`current ${authority} projection rejects ${mutation} drift after valid catalog sealing`, () =>
        {
            const fixture = syntheticFixture();
            if (mutation === 'missing')
            {
                delete fixture.projections.authorityRefs[authority];
            }
            else if (mutation === 'digest')
            {
                fixture.projections.authorityRefs[authority].contentDigest = syntheticDigest('drift');
            }
            else
            {
                fixture.projections.authorityRefs[authority].path = 'tests/fixtures/synthetic-query-control/other.json';
            }
            rejects(fixture, mutation === 'missing' ? 'closed-input-schema' : 'stale-input-authority');
        });
    }
}

for (const [name, mutate, ruleId] of [
    ['schema bytes', (f) =>
    {
        f.catalog.schemaDigest = syntheticDigest('stale-schema');
    }, 'stale-schema'],
    ['registry bytes', (f) =>
    {
        f.catalog.queryRegistry.contentDigest = syntheticDigest('stale-registry');
    }, 'stale-query-registry'],
    ['case contents', (f) =>
    {
        f.catalog.cases[0].actorClass = 'other-actor';
    }, 'case-tamper'],
    ['catalog contents', (f) =>
    {
        f.catalog.consumers = ['test'];
    }, 'catalog-tamper']
])
{
    test(`sealing control rejects changed ${name}`, () =>
    {
        const fixture = syntheticFixture();
        mutate(fixture);
        if (name === 'schema bytes' || name === 'registry bytes')
        {
            reseal(fixture);
        }
        rejects(fixture, ruleId);
    });
}

for (const [name, mutate] of [
    ['domain', (owner) =>
    {
        owner.domain = 'comment';
        owner.kind = 'public-list';
        owner.expectedSchema = 'fsusblog.expected-query.comment.v1';
    }],
    ['kind', (owner) =>
    {
        owner.kind = 'top-list';
    }],
    ['entrypoint', (owner) =>
    {
        owner.queryOwner.entrypoint = 'Tests.Other';
    }],
    ['owner version', (owner) =>
    {
        owner.queryOwner.version = 'control-v2';
    }],
    ['owner digest', (owner) =>
    {
        owner.queryOwner.contentDigest = syntheticDigest('other-owner');
    }],
    ['actor', (owner) =>
    {
        owner.actorClass = 'other-actor';
    }],
    ['order direction', (owner) =>
    {
        owner.semantics.order[0].direction = 'asc';
    }],
    ['pagination', (owner) =>
    {
        owner.semantics.pagination = 'page';
    }],
    ['visibility', (owner) =>
    {
        owner.semantics.visibilityPolicyRef = 'other-visibility';
    }],
    ['permission', (owner) =>
    {
        owner.semantics.permissionPolicyRef = 'other-permission';
    }],
    ['input coordinate', (owner) =>
    {
        owner.inputs[0].roleId = 'other-coordinate';
    }],
    ['scenario applicability', (owner) =>
    {
        owner.scenarioIds = ['other-scenario'];
    }]
])
{
    test(`independent synthetic query projection rejects ${name} drift on its exact case`, () =>
    {
        const fixture = syntheticFixture();
        const owner = fixture.projections.queryOwners[0];
        mutate(owner);
        rejects(fixture, 'query-owner-mismatch', owner.id);
    });
}

for (const [name, mutate, ruleId] of [
    ['missing coordinate role', (f) =>
    {
        f.projections.inputRoles = f.projections.inputRoles.filter((role) => role.id !== 'article-coordinate');
    }, 'input-role-mismatch'],
    ['coordinate authority', (f) =>
    {
        f.projections.inputRoles[0].authority = 'assignments';
    }, 'input-role-mismatch'],
    ['coordinate type', (f) =>
    {
        f.projections.inputRoles[0].valueType = 'cursor-ref';
    }, 'input-role-mismatch'],
    ['coordinate domain', (f) =>
    {
        f.projections.inputRoles[0].domains = ['comment'];
    }, 'input-role-mismatch'],
    ['missing actor role', (f) =>
    {
        f.projections.inputRoles = f.projections.inputRoles.filter((role) => role.id !== 'article-actor');
    }, 'actor-role-mismatch'],
    ['missing order role', (f) =>
    {
        f.projections.inputRoles = f.projections.inputRoles.filter((role) => role.id !== 'article-order');
    }, 'semantic-role-mismatch'],
    ['missing visibility role', (f) =>
    {
        f.projections.inputRoles = f.projections.inputRoles.filter((role) => role.id !== 'article-visibility');
    }, 'semantic-role-mismatch'],
    ['missing permission role', (f) =>
    {
        f.projections.inputRoles = f.projections.inputRoles.filter((role) => role.id !== 'article-permission');
    }, 'semantic-role-mismatch'],
    ['ambiguous role', (f) => f.projections.inputRoles.push(structuredClone(f.projections.inputRoles[0])), 'ambiguous-input'],
    ['ambiguous parameter', (f) => f.catalog.cases[0].inputs.push(structuredClone(f.catalog.cases[0].inputs[0])), 'ambiguous-input'],
    ['ambiguous canonical scenario', (f) => f.projections.scenarios.push(structuredClone(f.projections.scenarios[0])), 'ambiguous-input'],
    ['ambiguous case scenario', (f) => f.catalog.cases[0].scenarios.push(structuredClone(f.catalog.cases[0].scenarios[0])), 'ambiguous-scenario'],
    ['missing tie breaker', (f) =>
    {
        f.catalog.cases[0].semantics.tieBreakerRoleId = 'other-order';
    }, 'order-semantics'],
    ['duplicate order role', (f) => f.catalog.cases[0].semantics.order.push(structuredClone(f.catalog.cases[0].semantics.order[0])), 'order-semantics'],
    ['uniform-only applicability', (f) =>
    {
        f.projections.scenarios[0].distributionClass = 'uniform';
    }, 'uniform-only'],
    ['ineligible applicability', (f) =>
    {
        f.catalog.cases[0].scenarios[0].releaseEvidenceEligible = false;
        f.projections.scenarios[0].reference.releaseEvidenceEligible = false;
    }, 'uniform-only']
])
{
    test(`canonical input control rejects ${name}`, () =>
    {
        const fixture = syntheticFixture();
        mutate(fixture);
        reseal(fixture);
        rejects(fixture, ruleId);
    });
}

for (const field of ['scenarioDigest', 'assignmentDigest', 'statisticsDigest'])
{
    test(`scenario binding rejects current ${field} drift`, () =>
    {
        const fixture = syntheticFixture();
        fixture.projections.scenarios[0].reference[field] = syntheticDigest(`drift:${field}`);
        rejects(fixture, 'stale-scenario', fixture.catalog.cases[0].id);
    });
}

for (const [name, mutate] of [
    ['production readable', (catalog) =>
    {
        catalog.productionReadable = true;
    }],
    ['production consumer', (catalog) =>
    {
        catalog.consumers = ['production'];
    }],
    ['raw database ID', (catalog) =>
    {
        catalog.cases[0].inputs[0].databaseId = '123';
    }],
    ['title expected', (catalog) =>
    {
        catalog.cases[0].title = 'copied title';
    }],
    ['SQL expected', (catalog) =>
    {
        catalog.cases[0].sql = 'SELECT 1';
    }],
    ['actual output copied', (catalog) =>
    {
        catalog.cases[0].actualOutput = [];
    }],
    ['inline expected', (catalog) =>
    {
        catalog.cases[0].expected = [];
    }],
    ['environment selector', (catalog) =>
    {
        catalog.environment = 'FSUSBLOG_EXPECTED_QUERY';
    }],
    ['wrong domain expected schema', (catalog) =>
    {
        catalog.cases[0].expectedSchema = 'fsusblog.expected-query.comment.v1';
    }],
    ['wrong domain kind', (catalog) =>
    {
        catalog.cases[0].kind = 'public-thread';
    }],
    ['missing input declaration', (catalog) =>
    {
        catalog.cases[0].inputs = [];
    }]
])
{
    test(`closed catalog schema rejects ${name}`, () =>
    {
        const fixture = syntheticFixture();
        mutate(fixture.catalog);
        reseal(fixture);
        rejects(fixture, 'closed-schema');
    });
}

for (const [name, mutate] of [
    ['null authority', (p) =>
    {
        p.authorityRefs.articleGraph = null;
    }],
    ['null owner', (p) =>
    {
        p.queryOwners[0] = null;
    }],
    ['null role', (p) =>
    {
        p.inputRoles[0] = null;
    }],
    ['null scenario', (p) =>
    {
        p.scenarios[0] = null;
    }],
    ['string role domains', (p) =>
    {
        p.inputRoles[0].domains = 'article';
    }],
    ['unknown owner field', (p) =>
    {
        p.queryOwners[0].actual = [];
    }],
    ['unknown role field', (p) =>
    {
        p.inputRoles[0].databaseId = 123;
    }],
    ['unknown scenario field', (p) =>
    {
        p.scenarios[0].actualStatistics = {};
    }],
    ['missing owner expected schema', (p) =>
    {
        delete p.queryOwners[0].expectedSchema;
    }],
    ['wrong owner expected schema', (p) =>
    {
        p.queryOwners[0].expectedSchema = 'fsusblog.expected-query.comment.v1';
    }]
])
{
    test(`closed input schema rejects ${name} without dereferencing malformed projections`, () =>
    {
        const fixture = syntheticFixture();
        mutate(fixture.projections);
        assert.doesNotThrow(() => rejects(fixture, 'closed-input-schema'));
    });
}

for (const field of ['sql', 'secondCatalog', 'actual'])
{
    test(`closed input schema rejects top-level ${field} before dropping unknown fields`, () =>
    {
        const fixture = syntheticFixture();
        fixture.projections[field] = {};
        const result = rejects(fixture, 'closed-input-schema');
        assert.ok(result.violations.every((violation) => violation.ruleId === 'closed-input-schema'));
        assert.ok(result.violations.some((violation) => violation.detail.includes(`/${field}`)));
    });
}

for (const value of [null, undefined, [], '', 'synthetic', 0, true])
{
    test(`malformed current inputs ${JSON.stringify(value)} return a closed failure without throwing`, () =>
    {
        const { catalog } = syntheticFixture();
        let result;
        assert.doesNotThrow(() =>
        {
            result = validateExpectedQueryCaseCatalog(catalog, value);
        });
        assert.equal(result.status, 'failed');
        assert.ok(result.violations.length > 0);
        assert.ok(result.violations.every((violation) => violation.ruleId === 'closed-input-schema'));
    });
}

for (const value of [null, undefined, {}, [], '', 0, { cases: [] }])
{
    test(`malformed catalog ${JSON.stringify(value)} returns a closed failure without throwing`, () =>
    {
        let result;
        assert.doesNotThrow(() =>
        {
            result = validateExpectedQueryCaseCatalog(value);
        });
        assert.equal(result.status, 'failed');
        assert.ok(result.violations.length > 0);
        assert.ok(result.violations.every((violation) => violation.ruleId === 'closed-schema'));
    });
}

/** Schema samples only: these documents are not plan-derived expected cases. */
function syntheticExpectedDocument(domain)
{
    const fixture = syntheticFixture();
    const entry = fixture.catalog.cases.find((row) => row.domain === domain);
    const scenario = entry.scenarios[0];
    const permission = { policyRef: `${domain}-permission`, actorClass: `${domain}-actor`, outcome: 'allowed' };
    const visibility = { policyRef: `${domain}-visibility`, outcome: 'visible' };
    const item = {
        semanticId: `${domain}:synthetic-one`,
        status: 'published',
        coordinates: { sourceRef: `${domain}:source`, publicationRef: `${domain}:publication`, revisionRef: `${domain}:revision`, edgeRefs: [`${domain}:edge`] },
        permission: structuredClone(permission),
        visibility: structuredClone(visibility),
        semanticDigest: syntheticDigest(`${domain}:item`)
    };
    if (domain === 'comment')
    {
        item.articleRef = 'article:synthetic-one';
        item.thread = { parentRef: null, rootRef: item.semanticId, depth: 0, deletedPlaceholder: false };
    }
    return {
        schema: `fsusblog.expected-query.${domain}.v1`,
        version: 1,
        productionReadable: false,
        binding: {
            caseId: entry.id, scenarioId: scenario.id, scenarioDigest: scenario.scenarioDigest,
            assignmentDigest: scenario.assignmentDigest, statisticsDigest: scenario.statisticsDigest,
            actorClass: entry.actorClass,
            catalogDigest: fixture.catalog.contentDigest,
            caseDigest: entry.contentDigest,
            schemaDigest: fixture.catalog.schemaDigest
        },
        authorities: structuredClone(fixture.catalog.authorities),
        orderedSemanticIds: [item.semanticId],
        items: [item],
        counts: { matched: 1, total: 1 },
        pagination: {
            mode: 'cursor', pageSize: 10, pageIndex: null, offset: 0,
            currentCursorRef: null, nextCursorRef: null, previousCursorRef: null,
            hasNext: false, hasPrevious: false
        },
        status: 'published', permission, visibility,
        semanticDigest: syntheticDigest(`${domain}:document`),
        contentDigest: syntheticDigest(`${domain}:schema-sample`)
    };
}

function expectedSchemaFor(domain)
{
    return { $ref: `#/$defs/${domain}Expected`, $defs: catalogSchema.$defs };
}

for (const domain of ['article', 'comment'])
{
    test(`${domain} synthetic expected sample has all closed result dimensions`, () =>
    {
        assert.deepEqual(validateJsonSchema(syntheticExpectedDocument(domain), expectedSchemaFor(domain)), []);
    });
    for (const field of ['binding', 'authorities', 'orderedSemanticIds', 'items', 'counts', 'pagination', 'status', 'permission', 'visibility', 'semanticDigest', 'contentDigest'])
    {
        test(`${domain} expected schema rejects missing ${field}`, () =>
        {
            const sample = syntheticExpectedDocument(domain);
            delete sample[field];
            assert.ok(validateJsonSchema(sample, expectedSchemaFor(domain)).length > 0);
        });
    }
    for (const [name, mutate] of [
        ['wrong domain schema', (sample) =>
        {
            sample.schema = `fsusblog.expected-query.${domain === 'article' ? 'comment' : 'article'}.v1`;
        }],
        ['production readable', (sample) =>
        {
            sample.productionReadable = true;
        }],
        ['raw ordered ID', (sample) =>
        {
            sample.orderedSemanticIds[0] = '123';
        }],
        ['duplicate ordered ID', (sample) =>
        {
            sample.orderedSemanticIds.push(sample.orderedSemanticIds[0]);
        }],
        ['raw item ID', (sample) =>
        {
            sample.items[0].semanticId = '123';
        }],
        ['title field', (sample) =>
        {
            sample.items[0].title = 'actual title';
        }],
        ['database ID field', (sample) =>
        {
            sample.items[0].databaseId = '123';
        }],
        ['actual-copy field', (sample) =>
        {
            sample.actual = [];
        }],
        ['SQL field', (sample) =>
        {
            sample.sql = 'SELECT 1';
        }],
        ['serialized production cursor', (sample) =>
        {
            sample.pagination.nextCursor = 'eyJpZCI6MTIzfQ==';
        }],
        ['negative count', (sample) =>
        {
            sample.counts.total = -1;
        }],
        ['unsafe count', (sample) =>
        {
            sample.counts.total = Number.MAX_SAFE_INTEGER + 1;
        }],
        ['unknown permission', (sample) =>
        {
            sample.permission.outcome = 'unknown';
        }],
        ['unknown visibility', (sample) =>
        {
            sample.visibility.outcome = 'unknown';
        }],
        ['unclosed coordinates', (sample) =>
        {
            sample.items[0].coordinates.rowId = 123;
        }],
        ['missing coordinates', (sample) =>
        {
            delete sample.items[0].coordinates;
        }],
        ['missing item permission', (sample) =>
        {
            delete sample.items[0].permission;
        }],
        ['missing item visibility', (sample) =>
        {
            delete sample.items[0].visibility;
        }],
        ['missing scenario assignment', (sample) =>
        {
            delete sample.binding.assignmentDigest;
        }],
        ['unclosed scenario binding', (sample) =>
        {
            sample.binding.actualCase = {};
        }]
    ])
    {
        test(`${domain} expected schema rejects ${name}`, () =>
        {
            const sample = syntheticExpectedDocument(domain);
            mutate(sample);
            assert.ok(validateJsonSchema(sample, expectedSchemaFor(domain)).length > 0);
        });
    }
}

for (const [name, mutate] of [
    ['missing article reference', (sample) =>
    {
        delete sample.items[0].articleRef;
    }],
    ['missing thread', (sample) =>
    {
        delete sample.items[0].thread;
    }],
    ['missing root', (sample) =>
    {
        delete sample.items[0].thread.rootRef;
    }],
    ['negative depth', (sample) =>
    {
        sample.items[0].thread.depth = -1;
    }],
    ['raw parent ID', (sample) =>
    {
        sample.items[0].thread.parentRef = '123';
    }],
    ['unclosed thread', (sample) =>
    {
        sample.items[0].thread.rootDatabaseId = '123';
    }]
])
{
    test(`comment expected schema rejects ${name}`, () =>
    {
        const sample = syntheticExpectedDocument('comment');
        mutate(sample);
        assert.ok(validateJsonSchema(sample, expectedSchemaFor('comment')).length > 0);
    });
}

test('real production source has no static expected catalog references', () =>
{
    const result = scanExpectedQueryProductionIsolation(repositoryRoot);
    assert.equal(result.status, 'verified', JSON.stringify(result.violations));
    assert.ok(result.scannedFiles > 0);
    // Static source inspection is not runtime or package isolation evidence.
});

for (const source of [
    'using ExpectedQueryCaseCatalog;',
    'const schema = "fsusblog.expected-query.article.v1";',
    'import catalog from "../../tools/data-scale/expected-query-case-catalog.mjs";',
    'process.env.FSUSBLOG_EXPECTED_QUERY;',
    '<Content Include="expected-query-case-catalog.json" />'
])
{
    test(`static production isolation rejects overlay reference ${source}`, () =>
    {
        const file = 'src/synthetic-isolation-control.mjs';
        const result = scanExpectedQueryProductionIsolation(repositoryRoot, { overlays: new Map([[file, source]]) });
        assert.equal(result.status, 'failed');
        assert.ok(result.violations.some((violation) => violation.ruleId === 'production-expected-reference' && violation.detail === file));
    });
}

for (const file of ['tests/overlay.mjs', '../src/overlay.mjs', 'src/../overlay.mjs', 'src\\overlay.mjs', '/src/overlay.mjs'])
{
    test(`static isolation rejects outside production overlay ${file}`, () =>
    {
        assert.throws(() => scanExpectedQueryProductionIsolation(repositoryRoot, {
            overlays: new Map([[file, 'const safe = true;']])
        }), /repository-relative production source/u);
    });
}
