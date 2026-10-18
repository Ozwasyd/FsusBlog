import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const {
    getSemanticOutcomeSchemaPaths,
    validateAggregateRunOutcomeData,
    validateProducerSemanticOutcomeData
} = await import(new URL('../../tools/test-matrix/outcomes/semantic-outcome-contract.mjs', import.meta.url));

const source = (relative) => JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8'));
const digest = (digit) => `sha256:${digit.repeat(64)}`;

// These are explicit DATA_ONLY fixture expectations, not results of an outcome canonicalizer.
function fixture()
{
    const materials = {
        producerSchema: source('config/schemas/producer-semantic-outcome.schema.json'),
        aggregateSchema: source('config/schemas/aggregate-run-outcome.schema.json'),
        fieldDispositions: source('config/testing/outcome-field-dispositions.json'),
        failureTaxonomy: source('config/testing/outcome-failure-taxonomy.json'),
        producerCatalog: source('config/testing/correctness-attempt-producers.json')
    };
    const producerId = materials.producerCatalog.entries[0].producerId;
    const expectedContractDigests = Object.fromEntries(Object.entries(materials).map(([key, value]) => [key, digestCanonical(value)]));
    const options = {
        ...materials,
        expectedContractDigests,
        hostExpectedLimits: { maxDepth: 32, maxNodes: 100000, maxStringBytes: 65536, maxArrayItems: 10000, maxObjectKeys: 10000 },
        expected: {
            identity: { producerId, producerAuthorityId: 'fixture-authority', sourceCommit: '1'.repeat(40),
                worktreeFingerprint: digest('2'), schedulerRunId: 'fixture-run',
                executionEnvelopeDigest: digest('3'), replayPlanDigest: digest('4'), temporalContextDigest: digest('5') },
            plannedTestIds: ['test:one'],
            assertionIds: ['assertion:one'],
            scenarioIds: ['scenario:one'],
            coverageIds: ['coverage:one'],
            policyDigests: [{ policyId: 'fixture-policy', digest: digest('6') }],
            artifactSemanticDigests: [{ semanticId: 'artifact:one', owner: 'fixture-owner', digest: digest('7') }],
            stateSemanticDigests: [{ semanticId: 'state:one', owner: 'fixture-owner', digest: digest('8') }],
            projectionReceipts: [{ projectionId: 'projection:one', producerAuthorityId: 'fixture-authority',
                schema: 'fixture.projection.v1', contentDigest: digest('9'), semanticPayloadDigest: digest('a') }],
            redactedSecrets: [{ semanticId: 'secret:fixture', present: true, type: 'string', contextDigest: digest('b') }],
            semanticPayloadDigest: digest('c'),
            outcomeFingerprint: digest('d')
        }
    };
    const outcome = sealContentDigest({
        schema: 'fsusblog.producer-semantic-outcome.v1', schemaVersion: '1',
        fingerprintAlgorithmVersion: 'registry-canonical-json-sha256-v2',
        fieldDispositionDigest: expectedContractDigests.fieldDispositions,
        failureTaxonomyDigest: expectedContractDigests.failureTaxonomy,
        producerCatalogDigest: expectedContractDigests.producerCatalog,
        ...options.expected.identity,
        policyDigests: options.expected.policyDigests,
        plannedTestIds: ['test:one'], executedTestIds: ['test:one'], passedTestIds: ['test:one'],
        failedTestIds: [], skippedTestIds: [], blockedTestIds: [],
        assertions: [{ id: 'assertion:one', testId: 'test:one', status: 'passed',
            failureClass: null, failureKind: null, failureIdentity: null }],
        failures: [], scenarioIds: options.expected.scenarioIds, coverageIds: options.expected.coverageIds,
        artifactSemanticDigests: options.expected.artifactSemanticDigests,
        stateSemanticDigests: options.expected.stateSemanticDigests,
        projectionReceipts: options.expected.projectionReceipts,
        redactedSecrets: options.expected.redactedSecrets,
        cleanFirstAttempt: true, qualificationEligible: true, producerStatus: 'success',
        semanticPayloadDigest: options.expected.semanticPayloadDigest, outcomeFingerprint: options.expected.outcomeFingerprint
    });
    return { outcome, options };
}

function mutate(outcome, change)
{
    const value = structuredClone(outcome);
    change(value);
    return sealContentDigest(value);
}

function aggregateFixture(member = fixture())
{
    const outcome = member.outcome;
    const options = {
        ...member.options,
        expected: {
            runId: outcome.schedulerRunId, sourceCommit: outcome.sourceCommit,
            worktreeFingerprint: outcome.worktreeFingerprint,
            requiredProducerIds: [outcome.producerId], requiredCoverageIds: ['coverage:one'],
            stateSemanticDigests: outcome.stateSemanticDigests,
            artifactSemanticDigests: outcome.artifactSemanticDigests,
            aggregateOutcomeFingerprint: digest('e')
        }
    };
    const value = sealContentDigest({
        schema: 'fsusblog.aggregate-run-outcome.v1', schemaVersion: '1',
        fingerprintAlgorithmVersion: 'registry-canonical-json-sha256-v2',
        fieldDispositionDigest: outcome.fieldDispositionDigest, failureTaxonomyDigest: outcome.failureTaxonomyDigest,
        producerCatalogDigest: outcome.producerCatalogDigest,
        ...options.expected,
        producerOutcomeRefs: [{ producerId: outcome.producerId, producerAuthorityId: outcome.producerAuthorityId,
            schema: outcome.schema, contentDigest: outcome.contentDigest,
            semanticPayloadDigest: outcome.semanticPayloadDigest, outcomeFingerprint: outcome.outcomeFingerprint }],
        plannedTestIds: outcome.plannedTestIds, executedTestIds: outcome.executedTestIds,
        passedTestIds: outcome.passedTestIds, failedTestIds: outcome.failedTestIds,
        skippedTestIds: outcome.skippedTestIds, blockedTestIds: outcome.blockedTestIds,
        observedCoverageIds: outcome.coverageIds, failureTopology: outcome.failures,
        producerStatusVector: [{ producerId: outcome.producerId, status: outcome.producerStatus }],
        completenessStatus: outcome.producerStatus === 'success' ? 'complete' : 'incomplete'
    });
    return { value, options, members: [member] };
}

function failurePairContractFixture(pairs)
{
    const member = fixture();
    const ids = pairs.map(([testId]) => testId).sort();
    member.outcome = mutate(member.outcome, (value) =>
    {
        Object.assign(value, { plannedTestIds: ids, executedTestIds: ids, passedTestIds: [], failedTestIds: ids,
            qualificationEligible: false, producerStatus: 'failed' });
        value.assertions = pairs.map(([testId, id]) => ({ id, testId, status: 'failed',
            failureClass: 'product', failureKind: 'product.assertion',
            failureIdentity: { producerId: value.producerId, testId, assertionId: id } }))
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        value.failures = pairs.map(([testId, assertionId]) => ({ producerId: value.producerId, testId, assertionId,
            failureClass: 'product', failureKind: 'product.assertion',
            identity: { producerId: value.producerId, testId, assertionId } }));
    });
    member.options.expected.plannedTestIds = ids;
    member.options.expected.assertionIds = member.outcome.assertions.map((entry) => entry.id);
    return member;
}

test('contracts distinguish slash tuples while refusing duplicate unsorted and unsealed failure data', () =>
{
    const member = failurePairContractFixture([['a', 'b/c'], ['a/b', 'c']]);
    assert.equal(validateProducerSemanticOutcomeData(member.outcome, member.options), member.outcome);
    assert.throws(() => validateProducerSemanticOutcomeData(mutate(member.outcome, (value) =>
    {
        value.failures.push(value.failures[0]);
    }), member.options), /duplicate member|sorted and unique/u);
    assert.throws(() => validateProducerSemanticOutcomeData(mutate(member.outcome, (value) =>
    {
        value.failures.reverse();
    }), member.options), /sorted and unique/u);
    assert.throws(() => validateProducerSemanticOutcomeData({ ...member.outcome, contentDigest: digest('f') },
        member.options), /content digest/u);
    const aggregate = aggregateFixture(member);
    assert.equal(validateAggregateRunOutcomeData(aggregate.value, aggregate.options, aggregate.members), aggregate.value);
    for (const change of [
        (value) => value.failureTopology.reverse(),
        (value) => value.failureTopology.push(value.failureTopology[0])
    ])
    {
        assert.throws(() => validateAggregateRunOutcomeData(mutate(aggregate.value, change),
            aggregate.options, aggregate.members), /failure topology|duplicate member/u);
    }
});

test('contract failure ordering retains the legacy slash key before tuple tie breaking', () =>
{
    const member = failurePairContractFixture([['a/b', 'c'], ['a', 'z']]);
    assert.equal(validateProducerSemanticOutcomeData(member.outcome, member.options), member.outcome);
    assert.throws(() => validateProducerSemanticOutcomeData(mutate(member.outcome, (value) =>
    {
        value.failures.reverse();
    }), member.options), /sorted and unique/u);
    const aggregate = aggregateFixture(member);
    assert.equal(validateAggregateRunOutcomeData(aggregate.value, aggregate.options, aggregate.members), aggregate.value);
});

test('complete producer and legitimate catalog subset aggregate are DATA_ONLY contracts', () =>
{
    const member = fixture();
    assert.equal(validateProducerSemanticOutcomeData(member.outcome, member.options), member.outcome);
    const aggregate = aggregateFixture(member);
    assert.equal(validateAggregateRunOutcomeData(aggregate.value, aggregate.options, aggregate.members), aggregate.value);
    assert.ok(aggregate.options.producerCatalog.entries.length > aggregate.value.requiredProducerIds.length);
});

test('producer refuses every missing strong field and unknown field rather than treating it as volatile', () =>
{
    const { outcome, options } = fixture();
    for (const key of Object.keys(outcome))
    {
        const missing = structuredClone(outcome);
        delete missing[key];
        assert.throws(() => validateProducerSemanticOutcomeData(missing, options));
    }
    assert.throws(() => validateProducerSemanticOutcomeData(mutate(outcome, (value) =>
    {
        value.generatedAt = 'ignored';
    }), options), /unknown/u);
    assert.throws(() => validateProducerSemanticOutcomeData({ producerStatus: 'success' }, options));
});

test('schema algorithm registry identity and expected semantic digest are mandatory and exact', () =>
{
    const { outcome, options } = fixture();
    for (const field of ['schema', 'schemaVersion', 'fingerprintAlgorithmVersion', 'producerId',
        'producerAuthorityId', 'sourceCommit', 'worktreeFingerprint', 'schedulerRunId',
        'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest',
        'fieldDispositionDigest', 'failureTaxonomyDigest', 'producerCatalogDigest', 'semanticPayloadDigest', 'outcomeFingerprint'])
    {
        const changed = mutate(outcome, (value) =>
        {
            value[field] = field.endsWith('Digest') || field === 'outcomeFingerprint'
            || field === 'worktreeFingerprint' ? digest('f') : 'different';
        });
        assert.throws(() => validateProducerSemanticOutcomeData(changed, options));
    }
    const missing = structuredClone(options);
    delete missing.expected.semanticPayloadDigest;
    assert.throws(() => validateProducerSemanticOutcomeData(outcome, missing), /expectations/u);
    assert.throws(() => validateProducerSemanticOutcomeData({ ...outcome, contentDigest: digest('f') }, options), /content digest/u);
});

test('test sets are canonical disjoint exact partitions and assertions have exact membership', () =>
{
    const { outcome, options } = fixture();
    for (const change of [
        (value) =>
        {
            value.plannedTestIds.push('test:one');
        },
        (value) =>
        {
            value.executedTestIds = [];
        },
        (value) =>
        {
            value.failedTestIds = ['test:one'];
        },
        (value) =>
        {
            value.skippedTestIds = ['test:one'];
        },
        (value) =>
        {
            value.blockedTestIds = ['test:one'];
        },
        (value) =>
        {
            value.assertions = [];
        },
        (value) =>
        {
            value.assertions[0].testId = 'test:extra';
        },
        (value) =>
        {
            value.assertions[0].status = 'failed';
        }
    ])
    {
        assert.throws(() => validateProducerSemanticOutcomeData(mutate(outcome, change), options));
    }
});

test('owned policy scenario coverage state artifact and projection material cannot silently drift', () =>
{
    const { outcome, options } = fixture();
    for (const field of ['policyDigests', 'scenarioIds', 'coverageIds', 'stateSemanticDigests',
        'artifactSemanticDigests', 'projectionReceipts', 'redactedSecrets'])
    {
        assert.throws(() => validateProducerSemanticOutcomeData(mutate(outcome, (value) =>
        {
            value[field] = [];
        }), options));
    }
    assert.throws(() => validateProducerSemanticOutcomeData(mutate(outcome, (value) =>
    {
        value.stateSemanticDigests[0].owner = '';
    }), options));
});

test('non-success structured failures are closed and success cannot carry failed topology', () =>
{
    const { outcome, options } = fixture();
    const identity = { producerId: outcome.producerId, testId: 'test:one', assertionId: 'assertion:one' };
    const failed = mutate(outcome, (value) =>
    {
        value.producerStatus = 'failed';
        value.qualificationEligible = false;
        value.passedTestIds = [];
        value.failedTestIds = ['test:one'];
        value.assertions[0] = { id: 'assertion:one', testId: 'test:one', status: 'failed',
            failureClass: 'product', failureKind: 'product.assertion', failureIdentity: identity };
        value.failures = [{ producerId: value.producerId, testId: 'test:one', assertionId: 'assertion:one',
            failureClass: 'product', failureKind: 'product.assertion', identity }];
    });
    assert.equal(validateProducerSemanticOutcomeData(failed, options), failed);
    for (const change of [
        (value) =>
        {
            value.producerStatus = 'success';
        },
        (value) =>
        {
            value.qualificationEligible = true;
        },
        (value) =>
        {
            value.failures = [];
        },
        (value) =>
        {
            value.failures[0].failureKind = 'text.timeout';
        },
        (value) =>
        {
            value.failures[0].failureClass = 'infra';
        },
        (value) =>
        {
            delete value.failures[0].identity.assertionId;
        },
        (value) =>
        {
            value.failures[0].identity.message = 'timeout';
        },
        (value) =>
        {
            value.failures[0].testId = 'test:extra';
        }
    ])
    {
        assert.throws(() => validateProducerSemanticOutcomeData(mutate(failed, change), options));
    }
    const recovered = mutate(outcome, (value) =>
    {
        value.cleanFirstAttempt = false;
    });
    assert.throws(() => validateProducerSemanticOutcomeData(recovered, options), /eligibility/u);
});

test('secret metadata preserves presence type and context digest but never plaintext', () =>
{
    const { outcome, options } = fixture();
    for (const change of [
        (value) =>
        {
            value.redactedSecrets[0].value = 'credential';
        },
        (value) =>
        {
            delete value.redactedSecrets[0].contextDigest;
        },
        (value) =>
        {
            value.redactedSecrets[0].type = 'absent';
        },
        (value) =>
        {
            value.redactedSecrets[0].present = false;
        }
    ])
    {
        assert.throws(() => validateProducerSemanticOutcomeData(mutate(outcome, change), options));
    }
});

test('unregistered schema fields disposition category duplicates ownership and taxonomy drift refuse', () =>
{
    const { outcome, options } = fixture();
    for (const change of [
        (value) =>
        {
            delete value.fieldDispositions.canonicalization.schemas;
        },
        (value) =>
        {
            value.fieldDispositions.canonicalization.schemas.find((entry) => entry.schema === 'fsusblog.producer-semantic-outcome.v1').fields.pop();
        },
        (value) =>
        {
            value.fieldDispositions.canonicalization.schemas.find((entry) => entry.schema === 'fsusblog.producer-semantic-outcome.v1').fields.push(value.fieldDispositions.canonicalization.schemas.find((entry) => entry.schema === 'fsusblog.producer-semantic-outcome.v1').fields[0]);
        },
        (value) =>
        {
            value.fieldDispositions.canonicalization.schemas.find((entry) => entry.schema === 'fsusblog.producer-semantic-outcome.v1').fields[0].category = 'unknown';
        },
        (value) =>
        {
            value.fieldDispositions.canonicalization.schemas.find((entry) => entry.schema === 'fsusblog.producer-semantic-outcome.v1').fields[0].owner = '';
        },
        (value) =>
        {
            value.failureTaxonomy.kinds[0].requiredIdentity = [];
        },
        (value) =>
        {
            value.failureTaxonomy.kinds[0].errorTextClassifier = 'timeout';
        }
    ])
    {
        const altered = structuredClone(options);
        change(altered);
        // Even independently matching whole registry identity cannot excuse an invalid registry contract.
        altered.expectedContractDigests.fieldDispositions = digestCanonical(altered.fieldDispositions);
        altered.expectedContractDigests.failureTaxonomy = digestCanonical(altered.failureTaxonomy);
        const resealed = mutate(outcome, (value) =>
        {
            value.fieldDispositionDigest = altered.expectedContractDigests.fieldDispositions;
            value.failureTaxonomyDigest = altered.expectedContractDigests.failureTaxonomy;
        });
        assert.throws(() => validateProducerSemanticOutcomeData(resealed, altered));
    }
    const tampered = structuredClone(options);
    tampered.failureTaxonomy.kinds.pop();
    assert.throws(() => validateProducerSemanticOutcomeData(outcome, tampered), /expected digest/u);
});

test('bounded JSON refuses Map Set cycles symbols accessors hidden fields and oversized data before hashing', () =>
{
    const { outcome, options } = fixture();
    const malformed = [
        new Map(), new Set(), Object.assign(Object.create({ inherited: true }), outcome),
        { ...outcome, unbounded: 'x'.repeat(options.hostExpectedLimits.maxStringBytes + 1) }
    ];
    const cyclic = { ...outcome };
    cyclic.loop = cyclic;
    malformed.push(cyclic);
    const symbol = { ...outcome };
    symbol[Symbol('hidden')] = true;
    malformed.push(symbol);
    const hidden = { ...outcome };
    Object.defineProperty(hidden, 'hidden', { value: true });
    malformed.push(hidden);
    let reads = 0;
    const accessor = { ...outcome };
    Object.defineProperty(accessor, 'producerId', { enumerable: true, get()
    {
        reads += 1;
        return outcome.producerId;
    } });
    malformed.push(accessor);
    for (const value of malformed)
    {
        assert.throws(() => validateProducerSemanticOutcomeData(value, options));
    }
    assert.equal(reads, 0);
    const absentLimits = { ...options };
    delete absentLimits.hostExpectedLimits;
    assert.throws(() => validateProducerSemanticOutcomeData(outcome, absentLimits));
});

test('aggregate refuses missing extra duplicate stale references status coverage topology and completeness', () =>
{
    const { value, options, members } = aggregateFixture();
    for (const change of [
        (item) =>
        {
            item.requiredProducerIds = [];
        },
        (item) =>
        {
            item.requiredProducerIds.push('unknown-producer');
        },
        (item) =>
        {
            item.producerOutcomeRefs = [];
        },
        (item) =>
        {
            item.producerOutcomeRefs.push(item.producerOutcomeRefs[0]);
        },
        (item) =>
        {
            item.producerOutcomeRefs[0].contentDigest = digest('f');
        },
        (item) =>
        {
            item.producerStatusVector[0].status = 'failed';
        },
        (item) =>
        {
            item.observedCoverageIds = [];
        },
        (item) =>
        {
            item.stateSemanticDigests = [];
        },
        (item) =>
        {
            item.artifactSemanticDigests = [];
        },
        (item) =>
        {
            item.completenessStatus = 'incomplete';
        },
        (item) =>
        {
            item.aggregateOutcomeFingerprint = digest('f');
        }
    ])
    {
        assert.throws(() => validateAggregateRunOutcomeData(mutate(value, change), options, members));
    }
    assert.throws(() => validateAggregateRunOutcomeData(value, options, []), /exactness/u);
    assert.throws(() => validateAggregateRunOutcomeData(value, options, [...members, ...members]), /unique/u);
});

test('failed and blocked partial aggregates preserve exact structured topology without becoming complete', () =>
{
    for (const status of ['failed', 'blocked', 'partial'])
    {
        const member = fixture();
        const assertionStatus = status === 'failed' ? 'failed' : 'blocked';
        const identity = { producerId: member.outcome.producerId, testId: 'test:one', assertionId: 'assertion:one' };
        member.outcome = mutate(member.outcome, (value) =>
        {
            value.producerStatus = status;
            value.qualificationEligible = false;
            value.passedTestIds = [];
            value.executedTestIds = status === 'failed' ? ['test:one'] : [];
            value[`${assertionStatus}TestIds`] = ['test:one'];
            value.assertions[0] = { id: 'assertion:one', testId: 'test:one', status: assertionStatus,
                failureClass: 'product', failureKind: 'product.assertion', failureIdentity: identity };
            value.failures = [{ producerId: value.producerId, testId: 'test:one', assertionId: 'assertion:one',
                failureClass: 'product', failureKind: 'product.assertion', identity }];
        });
        const aggregate = aggregateFixture(member);
        assert.equal(validateAggregateRunOutcomeData(aggregate.value, aggregate.options, aggregate.members), aggregate.value);
        assert.equal(aggregate.value.completenessStatus, 'incomplete');
        for (const change of [
            (value) =>
            {
                value.failureTopology = [];
            },
            (value) =>
            {
                value.failureTopology[0].failureKind = 'contract.schema';
            },
            (value) =>
            {
                value.completenessStatus = 'complete';
            }
        ])
        {
            assert.throws(() => validateAggregateRunOutcomeData(mutate(aggregate.value, change), aggregate.options, aggregate.members));
        }
    }
});

test('contract schema failures preserve legal root paths in both actual identity carriers', () =>
{
    const member = fixture();
    const identity = { producerId: member.outcome.producerId, testId: 'test:one',
        assertionId: 'assertion:one', schemaPath: '$.schema' };
    member.outcome = mutate(member.outcome, (value) =>
    {
        value.producerStatus = 'failed';
        value.qualificationEligible = false;
        value.passedTestIds = [];
        value.failedTestIds = ['test:one'];
        value.assertions[0] = { id: 'assertion:one', testId: 'test:one', status: 'failed',
            failureClass: 'contract', failureKind: 'contract.schema', failureIdentity: { ...identity } };
        value.failures = [{ producerId: value.producerId, testId: 'test:one', assertionId: 'assertion:one',
            failureClass: 'contract', failureKind: 'contract.schema', identity: { ...identity } }];
    });
    assert.equal(validateProducerSemanticOutcomeData(member.outcome, member.options), member.outcome);
    const aggregate = aggregateFixture(member);
    assert.equal(validateAggregateRunOutcomeData(aggregate.value, aggregate.options, aggregate.members), aggregate.value);
    for (const path of ['schema', '.schema', '\\$.schema', '$schema'])
    {
        for (const carrier of ['assertion', 'failure', 'both'])
        {
            const value = mutate(member.outcome, (item) =>
            {
                if (carrier !== 'failure')
                {
                    item.assertions[0].failureIdentity.schemaPath = path;
                }
                if (carrier !== 'assertion')
                {
                    item.failures[0].identity.schemaPath = path;
                }
            });
            assert.throws(() => validateProducerSemanticOutcomeData(value, member.options), {
                message: carrier === 'failure'
                    ? 'semantic outcome contract: $.failures[].identity.schemaPath grammar mismatch'
                    : 'semantic outcome contract: $.assertions[].failureIdentity has no allowed type'
            });
        }
    }
});

test('transparent and trapped proxies are refused before outcome options limits or member reflection', () =>
{
    for (const trapped of [false, true])
    {
        for (const location of ['outcome', 'options', 'limits', 'expected-identity', 'taxonomy',
            'nested-outcome', 'members', 'member', 'member-outcome', 'member-options'])
        {
            const member = fixture();
            const aggregate = aggregateFixture(member);
            let traps = 0;
            const handler = trapped ? Object.fromEntries(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'get']
                .map((name) => [name, () =>
{
    traps += 1;
    throw new Error('proxy trap must not execute');
}])) : {};
            const proxy = (value) => new Proxy(value, handler);
            let outcome = member.outcome;
            let options = member.options;
            let members = aggregate.members;
            if (location === 'outcome')
            {
                outcome = proxy(outcome);
            }
            if (location === 'options')
            {
                options = proxy(options);
            }
            if (location === 'limits')
            {
                options = { ...options, hostExpectedLimits: proxy(options.hostExpectedLimits) };
            }
            if (location === 'expected-identity')
            {
                options = { ...options,
                    expected: { ...options.expected, identity: proxy(options.expected.identity) } };
            }
            if (location === 'taxonomy')
            {
                options = { ...options, failureTaxonomy: proxy(options.failureTaxonomy) };
            }
            if (location === 'nested-outcome')
            {
                outcome = { ...outcome, assertions: proxy(outcome.assertions) };
            }
            if (location === 'members')
            {
                members = proxy(members);
            }
            if (location === 'member')
            {
                members = [proxy(member)];
            }
            if (location === 'member-outcome')
            {
                members = [{ ...member, outcome: proxy(outcome) }];
            }
            if (location === 'member-options')
            {
                members = [{ ...member, options: proxy(options) }];
            }
            if (location.startsWith('member'))
            {
                assert.throws(() => validateAggregateRunOutcomeData(aggregate.value, aggregate.options, members),
                    /semantic outcome contract: proxy data is forbidden/u);
            }
            else
            {
                assert.throws(() => validateProducerSemanticOutcomeData(outcome, options),
                    /semantic outcome contract: (?:proxy data is forbidden|(?:contract options|host limits) must have plain own data properties)/u);
            }
            assert.equal(traps, 0, location);
        }
    }
});

test('taxonomy owner and proof remain nonblank strings even with independently matched whole material digests', () =>
{
    const { outcome, options } = fixture();
    assert.equal(validateProducerSemanticOutcomeData(outcome, options), outcome);
    for (const field of ['owner', 'proofTestId'])
    {
        for (const invalid of [1, {}, '', ' \t\n', null])
        {
            const changed = structuredClone(options);
            changed.failureTaxonomy.kinds.find((entry) => entry.kind === 'contract.schema')[field] = invalid;
            changed.expectedContractDigests.failureTaxonomy = digestCanonical(changed.failureTaxonomy);
            const value = mutate(outcome, (item) =>
            {
                item.failureTaxonomyDigest = changed.expectedContractDigests.failureTaxonomy;
            });
            assert.throws(() => validateProducerSemanticOutcomeData(value, changed),
                { message: 'semantic outcome contract: failure kind missing identity/owner/proof' });
        }
    }
});

test('catalog authority artifact and execution owners require the original nonblank string grammar', () =>
{
    const { outcome, options } = fixture();
    assert.equal(validateProducerSemanticOutcomeData(outcome, options), outcome);
    for (const field of ['sourceAuthority', 'artifactOwner', 'executionOwner'])
    {
        for (const invalid of [1, {}, '', ' \t\n', null])
        {
            const changed = structuredClone(options);
            changed.producerCatalog.entries.find((entry) => entry.producerId === outcome.producerId)[field] = invalid;
            changed.expectedContractDigests.producerCatalog = digestCanonical(changed.producerCatalog);
            const value = mutate(outcome, (item) =>
            {
                item.producerCatalogDigest = changed.expectedContractDigests.producerCatalog;
            });
            assert.throws(() => validateProducerSemanticOutcomeData(value, changed),
                { message: 'semantic outcome contract: producer catalog missing owner' });
        }
    }
});

function schemaQueryFixture()
{
    return {
        schemas: {
            producerSchema: source('config/schemas/producer-semantic-outcome.schema.json'),
            aggregateSchema: source('config/schemas/aggregate-run-outcome.schema.json')
        },
        limits: { maxDepth: 32, maxNodes: 100000, maxStringBytes: 65536, maxArrayItems: 10000, maxObjectKeys: 10000 }
    };
}

test('bounded schema paths reuse the original rules and allow shared nonrecursive definitions', () =>
{
    const { schemas, limits } = schemaQueryFixture();
    for (const id of ['fsusblog.producer-semantic-outcome.v1', 'fsusblog.aggregate-run-outcome.v1'])
    {
        const paths = getSemanticOutcomeSchemaPaths(id, schemas, limits);
        assert.deepEqual(paths, [...new Set(paths)].sort());
        assert.ok(paths.includes('$.schema'));
        assert.ok(paths.includes(id === 'fsusblog.producer-semantic-outcome.v1'
            ? '$.failures[].identity.schemaPath' : '$.failureTopology[].identity.schemaPath'));
        assert.ok(paths.includes(id === 'fsusblog.producer-semantic-outcome.v1'
            ? '$.assertions[].failureIdentity.schemaPath' : '$.producerOutcomeRefs[].contentDigest'));
    }
    const oldPaths = getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', schemas, limits);
    const shared = structuredClone(schemas);
    shared.producerSchema.properties.sharedOne = { $ref: '#/$defs/ids' };
    shared.producerSchema.properties.sharedTwo = { $ref: '#/$defs/ids' };
    assert.deepEqual(getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', shared, limits),
        [...oldPaths, '$.sharedOne', '$.sharedOne[]', '$.sharedTwo', '$.sharedTwo[]'].sort());
});

test('schema path queries refuse unresolved foreign and recursive semantic references without rejecting shared definitions', () =>
{
    const { schemas, limits } = schemaQueryFixture();
    for (const ref of ['other.schema.json#/$defs/ids', 'https://example.invalid/schema#/$defs/ids',
        '#/$defs/missing', '#/properties/schema', '#/$defs/__proto__', '', 1])
    {
        const changed = structuredClone(schemas);
        changed.producerSchema.properties.loop = { $ref: ref };
        assert.throws(() => getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', changed, limits),
            /semantic outcome contract: (?:unknown|unresolved) schema reference/u);
    }
    for (const cycle of ['root', 'reference-chain', 'properties', 'external-properties'])
    {
        const changed = structuredClone(schemas);
        let id = 'fsusblog.producer-semantic-outcome.v1';
        if (cycle === 'root')
        {
            changed.producerSchema.properties.loop = { $ref: '#' };
        }
        if (cycle === 'reference-chain')
        {
            changed.producerSchema.$defs.loop = { $ref: '#/$defs/loop' };
            changed.producerSchema.properties.loop = { $ref: '#/$defs/loop' };
        }
        if (cycle === 'properties')
        {
            changed.producerSchema.$defs.loop = { type: 'object', properties: { child: { $ref: '#/$defs/loop' } } };
            changed.producerSchema.properties.loop = { $ref: '#/$defs/loop' };
        }
        if (cycle === 'external-properties')
        {
            id = 'fsusblog.aggregate-run-outcome.v1';
            changed.producerSchema.properties.loop = { $ref: '#' };
            changed.aggregateSchema.properties.loop = { $ref: 'producer-semantic-outcome.schema.json#' };
        }
        assert.throws(() => getSemanticOutcomeSchemaPaths(id, changed, limits),
            /semantic outcome contract: (?:invalid or cyclic schema reference|cyclic resolved schema traversal)/u);
    }
});

test('schema path queries require exact identities independent limits and plain data before proxy reflection', () =>
{
    const { schemas, limits } = schemaQueryFixture();
    assert.throws(() => getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', schemas), /host limits/u);
    assert.throws(() => getSemanticOutcomeSchemaPaths('unknown', schemas, limits), /schema query identity mismatch/u);
    assert.throws(() => getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1',
        { ...schemas, hostExpectedLimits: limits }, limits), /schema query materials fields/u);
    const wrongIdentity = structuredClone(schemas);
    wrongIdentity.aggregateSchema.properties.schema.const = 'other';
    assert.throws(() => getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', wrongIdentity, limits),
        /schema query materials identity mismatch/u);
    for (const trapped of [false, true])
    {
        for (const location of ['materials', 'limits', 'schema', 'nested-rule'])
        {
            let traps = 0;
            const handler = trapped ? Object.fromEntries(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'get']
                .map((name) => [name, () =>
{
    traps += 1;
    throw new Error('schema proxy trap must not execute');
}])) : {};
            let materials = structuredClone(schemas);
            let budget = limits;
            if (location === 'materials')
            {
                materials = new Proxy(materials, handler);
            }
            if (location === 'limits')
            {
                budget = new Proxy(limits, handler);
            }
            if (location === 'schema')
            {
                materials.producerSchema = new Proxy(materials.producerSchema, handler);
            }
            if (location === 'nested-rule')
            {
                materials.producerSchema.$defs.ids = new Proxy(materials.producerSchema.$defs.ids, handler);
            }
            assert.throws(() => getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', materials, budget),
                /semantic outcome contract: (?:proxy data is forbidden|(?:schema query materials|host limits) must have plain own data properties)/u);
            assert.equal(traps, 0, location);
        }
    }
});

test('semantic expansion has finite node depth path-count and path-byte budgets beyond physical JSON bounds', () =>
{
    const schemas = {
        producerSchema: { type: 'object', properties: {
            schema: { const: 'fsusblog.producer-semantic-outcome.v1' }, tree: { $ref: '#/$defs/level8' }
        }, $defs: { level0: { type: 'string' } } },
        aggregateSchema: { type: 'object', properties: { schema: { const: 'fsusblog.aggregate-run-outcome.v1' } } }
    };
    for (let level = 1; level <= 8; level += 1)
    {
        schemas.producerSchema.$defs[`level${level}`] = { type: 'object', properties: {
            left: { $ref: `#/$defs/level${level - 1}` }, right: { $ref: `#/$defs/level${level - 1}` }
        } };
    }
    const limits = { maxDepth: 64, maxNodes: 10000, maxStringBytes: 65536, maxArrayItems: 10000, maxObjectKeys: 10000 };
    assert.ok(getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', schemas, limits).includes('$.tree.left.right'));
    for (const changed of [{ ...limits, maxNodes: 512 }, { ...limits, maxDepth: 8 }])
    {
        assert.throws(() => getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', schemas, changed),
            { message: 'semantic outcome contract: schema traversal node/depth budget exceeded' });
    }
    assert.throws(() => getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', schemas,
        { ...limits, maxArrayItems: 3 }), { message: 'semantic outcome contract: schema path count budget exceeded' });
    const longPath = structuredClone(schemas);
    const segment = 'x'.repeat(40);
    longPath.producerSchema.properties.tree = { type: 'object', properties: {
        [segment]: { type: 'object', properties: { [segment]: { type: 'string' } } }
    } };
    assert.throws(() => getSemanticOutcomeSchemaPaths('fsusblog.producer-semantic-outcome.v1', longPath,
        { ...limits, maxStringBytes: 64 }), { message: 'semantic outcome contract: schema path byte budget exceeded' });
});

test('the original producer validator shares semantic schema cycle refusal before shape recursion', () =>
{
    const { outcome, options } = fixture();
    options.producerSchema.properties.loop = { $ref: '#' };
    options.expectedContractDigests.producerSchema = digestCanonical(options.producerSchema);
    assert.throws(() => validateProducerSemanticOutcomeData(outcome, options),
        { message: 'semantic outcome contract: cyclic resolved schema traversal' });
});
