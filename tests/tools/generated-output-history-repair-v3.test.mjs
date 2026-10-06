import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { generatedOutputHistoryRepairSchema, inspectGeneratedOutputHistoryV3, verifyGeneratedOutputHistoryRepairV3 } =
    await import(new URL('../../tools/governance/generated-output-history-repair-v3.mjs', import.meta.url));
const { buildGeneratedOutputHistoryRepairManifest } =
    await import(new URL('../../tools/governance/generate-generated-output-history-repair-manifest.mjs', import.meta.url));
const { changeContract, validatePrContract } =
    await import(new URL('../../tools/governance/change-contract.mjs', import.meta.url));
const { createGeneratedOutputDigestRepairRepository } =
    await import(new URL('../../tools/governance/generated-output-digest-repair-repository.mjs', import.meta.url));
const { parseYamlDocument } =
    await import(new URL('../../tools/yaml/parse-document.mjs', import.meta.url));

function hash(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

function blob(bytes, mode = '100644')
{
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return { mode, object: createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex'), bytes: content };
}

function identity(value)
{
    return { mode: value.mode, object: value.object, sha256: hash(value.bytes) };
}

// A controlled adapter proves verifier decisions, not real Git or Linux replay.
function fixture()
{
    const ids = Object.fromEntries(['anchor', 'first', 'second', 'third', 'frontier', 'base', 'head', 'extra']
        .map((name, index) => [name, (index + 1).toString(16).padStart(40, '0')]));
    const policy = 'tools/governance/change-contract.mjs';
    const newPolicy = 'tools/governance/generated-output-history-repair-v3.mjs';
    const matrix = 'tests/matrix.yml';
    const requirements = 'tests/backend/Fixtures/backend-test-requirements.json';
    const producer = {
        id: 'backend-evidence-path-authority',
        repairClass: 'sealed-history-digest-refresh',
        manifest: 'artifacts/change-contract/backend-evidence-history-repair.json',
        command: { executable: 'node', arguments: ['tools/test/generate-backend-evidence-path-authority.mjs', '--write'] },
        closure: [requirements, matrix, 'tools/test-matrix/parse-matrix.mjs', 'tools/test/backend-evidence-path-authority.mjs',
            'tools/test/generate-backend-evidence-path-authority.mjs', 'tools/yaml/parse-document.mjs'],
        output: 'tests/backend/Fixtures/backend-evidence-path-authority.generated.json',
        outputSchema: 'fsusblog.backend-evidence-path-authority.v1',
        historicalPolicyPaths: [policy],
        protectedPolicyPaths: [policy, newPolicy],
        qualification: { kind: 'reviewed-mainline-history', anchor: ids.anchor, frontier: ids.frontier,
            sourceEvents: [ids.first, ids.second, ids.third], historySha256: '0'.repeat(64) }
    };
    const initial = new Map(producer.closure.map((file) => [file, blob(`source ${file}\n`)]));
    initial.set(requirements, blob('{"requirements":[]}\n'));
    initial.set(matrix, blob('tiers: []\n'));
    initial.set(policy, blob('old trusted policy\n'));
    const files = new Map();
    const commits = new Map();
    const sequence = ['anchor', 'first', 'second', 'third', 'frontier', 'base', 'head'];
    let previous = initial;
    for (const [index, name] of sequence.entries())
    {
        const entries = new Map(previous);
        if (['first', 'second', 'third'].includes(name))
        {
            entries.set(matrix, blob(`${previous.get(matrix).bytes.toString('utf8')}# ${name}\n`));
        }
        if (name === 'base')
        {
            entries.set(policy, blob('new trusted policy\n'));
            entries.set(newPolicy, blob('new reviewed verifier\n'));
        }
        files.set(ids[name], entries);
        commits.set(ids[name], { commit: ids[name], parents: index === 0 ? [] : [ids[sequence[index - 1]]],
            subject: name, message: `${name}\n\nRefs: #3520\n` });
        previous = entries;
    }
    const canonical = (revision) => Buffer.from(`${JSON.stringify({ schema: producer.outputSchema,
        generatedBy: producer.command.arguments[0], sources: {
            [matrix]: `sha256:${hash(files.get(revision).get(matrix).bytes)}`,
            [requirements]: `sha256:${hash(`${JSON.stringify(JSON.parse(files.get(revision).get(requirements).bytes), null, 4)}\n`)}`
        }, entries: [{ path: '.tmp/backend/receipt.json', owners: ['unit'] }] }, null, 4)}\n`);
    const original = blob(canonical(ids.anchor));
    for (const [revision, entries] of files)
    {
        entries.set(producer.output, revision === ids.head ? blob(canonical(revision)) : original);
    }
    files.get(ids.head).set(producer.manifest, blob('manifest metadata\n'));
    const ancestors = (revision, seen = new Set()) =>
    {
        if (!seen.has(revision))
        {
            seen.add(revision);
            for (const parent of commits.get(revision).parents)
            {
                ancestors(parent, seen);
            }
        }
        return seen;
    };
    const calls = [];
    const repository = {
        authorityRevision: ids.base,
        blob(revision, file)
        {
            const value = files.get(revision)?.get(file);
            assert.ok(value, `missing fixture blob ${revision}:${file}`);
            return value;
        },
        optionalBlob(revision, file)
        {
            return files.get(revision)?.get(file) ?? null;
        },
        commit(revision)
        {
            return commits.get(revision);
        },
        isAncestor(ancestor, descendant)
        {
            return ancestors(descendant).has(ancestor);
        },
        revisionsBetween(ancestor, descendant)
        {
            const excluded = ancestors(ancestor);
            const result = [];
            const visit = (revision) =>
            {
                if (!excluded.has(revision) && !result.includes(revision))
                {
                    for (const parent of commits.get(revision).parents)
                    {
                        visit(parent);
                    }
                    result.push(revision);
                }
            };
            visit(descendant);
            return result;
        },
        firstParentRevisions(ancestor, descendant)
        {
            const result = [];
            for (let revision = descendant; revision !== ancestor; revision = commits.get(revision).parents[0])
            {
                result.unshift(revision);
            }
            return result;
        },
        changedPaths(ancestor, descendant)
        {
            const before = files.get(ancestor);
            const after = files.get(descendant);
            return [...new Set([...before.keys(), ...after.keys()])].filter((file) =>
                before.get(file)?.object !== after.get(file)?.object || before.get(file)?.mode !== after.get(file)?.mode).sort();
        },
        replay({ revision, attempt })
        {
            calls.push({ revision, attempt });
            const value = { mode: '100644', bytes: canonical(revision) };
            return { revision, isolationId: `${revision}-${attempt}`, first: value, second: value,
                readPaths: [...producer.closure], writePaths: [producer.output],
                changedPaths: revision === ids.anchor || revision === ids.head ? [] : [producer.output] };
        }
    };
    producer.qualification.historySha256 = inspectGeneratedOutputHistoryV3({ producer, repository }).historySha256;
    const evidence = { schema: generatedOutputHistoryRepairSchema, producerId: producer.id, repairClass: producer.repairClass,
        qualification: structuredClone(producer.qualification), baseCommit: ids.base, command: structuredClone(producer.command),
        closure: producer.closure.map((path) => ({ path, anchor: identity(repository.blob(ids.anchor, path)),
            frontier: identity(repository.blob(ids.frontier, path)), base: identity(repository.blob(ids.base, path)) })),
        output: { path: producer.output, anchor: identity(original), base: identity(original),
            candidate: identity(repository.blob(ids.head, producer.output)) } };
    const args = { evidence, producer, repository, base: ids.base, head: ids.head,
        changedFiles: [producer.manifest, producer.output] };
    return { args, ids, files, commits, calls, policy, newPolicy, matrix, requirements, canonical };
}

test('v3 verifies three sealed source events and a one-way trusted policy bootstrap before generated-only repair', () =>
{
    const state = fixture();
    const result = verifyGeneratedOutputHistoryRepairV3(state.args);
    assert.equal(result.status, 'verified');
    assert.equal(result.replayIsolations, 14);
    assert.equal(state.calls.length, 14);
    assert.equal(result.candidateCommit, state.ids.head);
});

test('history inspection is reproducible and performs zero producer executions', () =>
{
    const state = fixture();
    const first = inspectGeneratedOutputHistoryV3(state.args);
    const second = inspectGeneratedOutputHistoryV3(state.args);
    assert.deepEqual(first, second);
    assert.equal(first.history.nodes.length, 5);
    assert.equal(first.history.edges.length, 4);
    assert.equal(state.calls.length, 0);
});

test('manifest preparation binds exact Git identities but does not claim producer execution', () =>
{
    const state = fixture();
    assert.deepEqual(buildGeneratedOutputHistoryRepairManifest(state.args), state.args.evidence);
    assert.equal(state.calls.length, 0);
    assert.throws(() => buildGeneratedOutputHistoryRepairManifest({ ...state.args, base: 'master' }), /exact distinct/u);
});

const preflightMutations = [
    ['unknown manifest field', (state) =>
    {
        state.args.evidence.approved = true;
    }],
    ['wrong schema', (state) =>
    {
        state.args.evidence.schema = 'fsusblog.post-merge-generated-output-repair.v2';
    }],
    ['untrusted adapter base', (state) =>
    {
        state.args.repository.authorityRevision = state.ids.head;
    }],
    ['wrong external base', (state) =>
    {
        state.args.base = state.ids.frontier;
    }],
    ['manifest-selected provenance', (state) =>
    {
        state.args.evidence.qualification.kind = 'merged-pr';
    }],
    ['manifest-selected anchor', (state) =>
    {
        state.args.evidence.qualification.anchor = state.ids.first;
    }],
    ['unregistered history seal', (state) =>
    {
        state.args.producer.qualification.historySha256 = 'f'.repeat(64);
        state.args.evidence.qualification.historySha256 = 'f'.repeat(64);
    }],
    ['omitted source event', (state) =>
    {
        state.args.evidence.qualification.sourceEvents.pop();
    }],
    ['reordered source events', (state) =>
    {
        state.args.evidence.qualification.sourceEvents.reverse();
    }],
    ['duplicate source event', (state) =>
    {
        state.args.evidence.qualification.sourceEvents.push(state.ids.first);
    }],
    ['extra source event', (state) =>
    {
        state.args.evidence.qualification.sourceEvents.push(state.ids.frontier);
    }],
    ['missing closure binding', (state) =>
    {
        state.args.evidence.closure.pop();
    }],
    ['forged closure digest', (state) =>
    {
        state.args.evidence.closure[0].base.sha256 = 'f'.repeat(64);
    }],
    ['wrong command', (state) =>
    {
        state.args.evidence.command.arguments[0] = 'tools/untrusted.mjs';
    }],
    ['wrong output', (state) =>
    {
        state.args.evidence.output.path = 'tests/other.json';
    }],
    ['unchanged output', (state) =>
    {
        state.args.changedFiles = [state.args.producer.manifest];
    }],
    ['candidate policy mutation', (state) =>
    {
        state.args.changedFiles.push(state.policy);
    }],
    ['truncated history enumeration', (state) =>
    {
        state.args.repository.revisionsBetween = () => [state.ids.frontier];
    }],
    ['duplicate history enumeration', (state) =>
    {
        const read = state.args.repository.revisionsBetween;
        state.args.repository.revisionsBetween = (...values) => [...read(...values), state.ids.frontier];
    }],
    ['wrong source parent', (state) =>
    {
        state.commits.get(state.ids.second).parents = [state.ids.anchor];
    }],
    ['wrong first-parent chain', (state) =>
    {
        state.args.repository.firstParentRevisions = () => [state.ids.first, state.ids.third, state.ids.frontier];
    }],
    ['historical generator change-revert', (state) =>
    {
        state.files.get(state.ids.second).set('tools/yaml/parse-document.mjs', blob('drift then revert\n'));
    }],
    ['historical policy change-revert', (state) =>
    {
        state.files.get(state.ids.second).set(state.policy, blob('unreviewed then reverted\n'));
    }],
    ['historical output change-revert', (state) =>
    {
        state.files.get(state.ids.second).set(state.args.producer.output, blob('wrong output\n'));
    }],
    ['historical executable drift', (state) =>
    {
        const entries = state.files.get(state.ids.second);
        entries.set(state.matrix, { ...entries.get(state.matrix), mode: '100755' });
    }],
    ['historical symlink', (state) =>
    {
        state.files.get(state.ids.second).set(state.matrix, blob('/outside\n', '120000'));
    }],
    ['forged Git object bytes', (state) =>
    {
        const entries = state.files.get(state.ids.second);
        entries.set(state.matrix, { ...entries.get(state.matrix), object: 'f'.repeat(40) });
    }],
    ['closure drift after frontier', (state) =>
    {
        state.files.get(state.ids.base).set(state.matrix, blob('unreviewed matrix\n'));
    }],
    ['premature output repair', (state) =>
    {
        state.files.get(state.ids.base).set(state.args.producer.output, blob(state.canonical(state.ids.base)));
    }],
    ['new policy hiding in old epoch', (state) =>
    {
        state.files.get(state.ids.frontier).set(state.newPolicy, blob('unsealed policy\n'));
    }],
    ['candidate source mutation', (state) =>
    {
        state.files.get(state.ids.head).set(state.matrix, blob('candidate changes source\n'));
    }],
    ['candidate policy rollback', (state) =>
    {
        state.files.get(state.ids.head).set(state.policy, state.files.get(state.ids.anchor).get(state.policy));
    }],
    ['candidate unrelated file', (state) =>
    {
        state.files.get(state.ids.head).set('unrelated.txt', blob('unrelated\n'));
    }],
    ['external head disagrees with manifest', (state) =>
    {
        state.args.head = state.ids.base;
    }]
];

for (const [name, mutate] of preflightMutations)
{
    test(`v3 rejects ${name} before any producer execution`, () =>
    {
        const state = fixture();
        mutate(state);
        assert.throws(() => verifyGeneratedOutputHistoryRepairV3(state.args), /generated history repair v3:/u);
        assert.equal(state.calls.length, 0);
    });
}

const replayMutations = [
    ['extra replay field', (result) => ({ ...result, approved: true })],
    ['wrong revision', (result) => ({ ...result, revision: 'f'.repeat(40) })],
    ['reused isolation', (result) => ({ ...result, isolationId: 'shared' })],
    ['undeclared read', (result) => ({ ...result, readPaths: [...result.readPaths, 'outside.json'] })],
    ['missing read', (result) => ({ ...result, readPaths: result.readPaths.slice(1) })],
    ['extra output write', (result) => ({ ...result, writePaths: [...result.writePaths, 'outside.json'] })],
    ['ignored output write', (result) => ({ ...result, changedPaths: ['.tmp/hidden.json'] })],
    ['not fixed point', (result) => ({ ...result, second: { ...result.second, bytes: Buffer.from('{}\n') } })],
    ['output executable drift', (result) => ({ ...result, first: { ...result.first, mode: '100755' },
        second: { ...result.second, mode: '100755' } })],
    ['output symlink', (result) => ({ ...result, first: { mode: '120000', bytes: Buffer.from('/outside') } })],
    ['missing source digest', (result) =>
    {
        const document = JSON.parse(result.first.bytes);
        delete document.sources['tests/matrix.yml'];
        const value = { ...result.first, bytes: Buffer.from(JSON.stringify(document)) };
        return { ...result, first: value, second: value };
    }],
    ['forged requirements digest', (result) =>
    {
        const document = JSON.parse(result.first.bytes);
        document.sources['tests/backend/Fixtures/backend-test-requirements.json'] = `sha256:${'f'.repeat(64)}`;
        const value = { ...result.first, bytes: Buffer.from(JSON.stringify(document)) };
        return { ...result, first: value, second: value };
    }]
];

for (const [name, mutate] of replayMutations)
{
    test(`v3 rejects ${name}`, () =>
    {
        const state = fixture();
        const replay = state.args.repository.replay;
        state.args.repository.replay = (request) => mutate(replay(request));
        assert.throws(() => verifyGeneratedOutputHistoryRepairV3(state.args), /generated history repair v3:/u);
    });
}

test('v3 rejects a semantic transition even if final source digests are correct', () =>
{
    const state = fixture();
    const replay = state.args.repository.replay;
    state.args.repository.replay = (request) =>
    {
        const result = replay(request);
        if (request.revision !== state.ids.anchor)
        {
            const document = JSON.parse(result.first.bytes);
            document.entries.push({ path: '.tmp/extra.json', owners: ['extra'] });
            result.first = { ...result.first, bytes: Buffer.from(`${JSON.stringify(document, null, 4)}\n`) };
            result.second = result.first;
        }
        return result;
    };
    assert.throws(() => verifyGeneratedOutputHistoryRepairV3(state.args), /non-digest producer semantics/u);
});

test('v3 rejects nondeterministic fresh replay with semantically equivalent bytes', () =>
{
    const state = fixture();
    const replay = state.args.repository.replay;
    state.args.repository.replay = (request) =>
    {
        const result = replay(request);
        if (request.attempt === 1)
        {
            result.first = { ...result.first, bytes: Buffer.from(`${result.first.bytes.toString('utf8')}\n`) };
            result.second = result.first;
        }
        return result;
    };
    assert.throws(() => verifyGeneratedOutputHistoryRepairV3(state.args), /nondeterministic/u);
});

test('v3 rejects noncanonical candidate bytes despite equivalent JSON', () =>
{
    const state = fixture();
    const value = blob(`${state.canonical(state.ids.head).toString('utf8')}\n`);
    state.files.get(state.ids.head).set(state.args.producer.output, value);
    state.args.evidence.output.candidate = identity(value);
    assert.throws(() => verifyGeneratedOutputHistoryRepairV3(state.args), /not the canonical current output/u);
});

for (const [name, rollback] of [['unregistered intermediate policy', false], ['policy rollback before base', true]])
{
    test(`v3 rejects ${name} even when the final policy matches the trusted base`, () =>
    {
        const state = fixture();
        const entries = new Map(state.files.get(state.ids.frontier));
        entries.set(state.policy, rollback ? state.files.get(state.ids.base).get(state.policy) : blob('unregistered epoch\n'));
        state.files.set(state.ids.extra, entries);
        state.commits.set(state.ids.extra, { commit: state.ids.extra, parents: [state.ids.frontier], subject: name, message: name });
        if (rollback)
        {
            const reverted = '9'.padStart(40, '0');
            state.files.set(reverted, new Map(state.files.get(state.ids.frontier)));
            state.commits.set(reverted, { commit: reverted, parents: [state.ids.extra], subject: 'rollback', message: 'rollback' });
            state.commits.get(state.ids.base).parents = [reverted];
        }
        else
        {
            state.commits.get(state.ids.base).parents = [state.ids.extra];
        }
        assert.throws(() => verifyGeneratedOutputHistoryRepairV3(state.args), /unknown policy identity|policy rollback/u);
        assert.equal(state.calls.length, 0);
    });
}

test('v3 rejects candidate source change-revert hidden on a side parent', () =>
{
    const state = fixture();
    const entries = new Map(state.files.get(state.ids.base));
    entries.set(state.matrix, blob('side-parent drift\n'));
    state.files.set(state.ids.extra, entries);
    state.commits.set(state.ids.extra, { commit: state.ids.extra, parents: [state.ids.base], subject: 'side branch', message: 'side branch' });
    state.commits.get(state.ids.head).parents.push(state.ids.extra);
    assert.throws(() => verifyGeneratedOutputHistoryRepairV3(state.args), /source closure changed/u);
    assert.equal(state.calls.length, 0);
});

function gitFixture(t)
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-history-policy-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'candidate');
    const authorityRoot = path.join(temporary, 'authority');
    fs.mkdirSync(root);
    fs.mkdirSync(authorityRoot);
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'History fixture');
    git('config', 'user.email', 'history-fixture@example.invalid');
    const write = (directory, file, text) =>
    {
        const target = path.join(directory, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
    };
    for (const file of changeContract.generatedOutputHistoryRepairPolicyFiles)
    {
        write(root, file, 'candidate replacement\n');
        write(authorityRoot, file, 'trusted original\n');
    }
    write(authorityRoot, 'config/development/native-tooling-style-exceptions.json', '{"exceptions":[]}\n');
    git('add', '.');
    git('commit', '-qm', 'fixture policy candidate');
    return { root, authorityRoot, git };
}

test('shared PR gate protects every new v3 policy file without changing the legacy historical roster', (t) =>
{
    const state = gitFixture(t);
    for (const file of changeContract.generatedOutputHistoryRepairPolicyFiles)
    {
        assert.ok(!changeContract.trustedPolicyFiles.includes(file));
        const errors = validatePrContract({ title: 'feat(governance): bind reviewed history', body: '',
            changedFiles: [file], root: state.root, authorityRoot: state.authorityRoot });
        assert.ok(errors.some((error) => error === `pull request cannot replace trusted change-contract policy source: ${file}`));
    }
});

test('real optional Git reads distinguish absence from symlinks and disable replacement refs', (t) =>
{
    const state = gitFixture(t);
    const initial = state.git('rev-parse', 'HEAD');
    fs.symlinkSync('/outside', path.join(state.root, 'linked'));
    state.git('add', 'linked');
    state.git('commit', '-qm', 'fixture nonregular object');
    const base = state.git('rev-parse', 'HEAD');
    const producer = changeContract.generatedOutputHistoryRepairProducers[0];
    const repository = createGeneratedOutputDigestRepairRepository({ root: state.root, authorityRoot: state.root, base, producer });
    assert.equal(repository.optionalBlob(base, 'missing.json'), null);
    assert.throws(() => repository.optionalBlob(base, 'linked'), /not one exact regular blob/u);
    state.git('replace', initial, base);
    assert.equal(repository.optionalBlob(initial, 'linked'), null);
    assert.throws(() => repository.blob(initial, 'missing.json'), /not one exact regular blob/u);
});

function readHistoryWorkflow()
{
    return parseYamlDocument(fs.readFileSync(new URL('../../.github/workflows/change-contract.yml', import.meta.url), 'utf8'));
}

function assertHistoryWorkflowIsolation(workflow)
{
    const gate = workflow.jobs['change-contract'];
    const regression = workflow.jobs['history-repair-regression'];
    assert.deepEqual(workflow.permissions, { contents: 'read', 'pull-requests': 'read' });
    assert.equal(gate.permissions, undefined);
    assert.equal(regression?.permissions, undefined);
    assert.equal(regression?.needs, undefined);
    assert.equal(regression?.if, undefined);
    assert.ok(regression, 'candidate regression must have a separate job workspace');
    const trustedTests = gate.steps.filter((step) => step.name.startsWith('Exercise trusted'));
    assert.equal(trustedTests.length, 2);
    for (const step of trustedTests)
    {
        assert.equal(step['working-directory'], 'trusted');
        assert.equal(step.run, 'node --test tests/tools/change-contract.test.mjs');
    }
    assert.ok(gate.steps.every((step) => !step.run?.includes('generated-output-history-repair-v3.test.mjs')),
        'candidate regression cannot execute in the trusted gate job');
    const candidateCheckout = gate.steps.find((step) => step.name === 'Checkout candidate with full review history');
    assert.equal(regression.steps.length, 3);
    assert.deepEqual(regression.steps[0], candidateCheckout);
    assert.deepEqual(regression.steps[1], gate.steps.find((step) => step.name === 'Set up Node.js'));
    assert.deepEqual(regression.steps[2], {
        name: 'Exercise candidate history repair regressions',
        'working-directory': 'candidate',
        run: 'node --test tests/tools/generated-output-history-repair-v3.test.mjs'
    });
    return { trustedTests, candidateTest: regression.steps[2] };
}

test('history repair workflow isolates candidate regressions from the trusted checker job', () =>
{
    const workflow = readHistoryWorkflow();
    assertHistoryWorkflowIsolation(workflow);
    const mutations = [
        (value) =>
        {
            value.jobs['change-contract'].steps.find((step) => step.name === 'Exercise trusted pre-push checker').run
                += ' tests/tools/generated-output-history-repair-v3.test.mjs';
        },
        (value) =>
        {
            value.jobs['change-contract'].steps.push(value.jobs['history-repair-regression'].steps[2]);
        },
        (value) =>
        {
            value.jobs['history-repair-regression'].steps[2]['working-directory'] = 'trusted';
        },
        (value) =>
        {
            value.jobs['history-repair-regression'].steps[0].with.ref = 'master';
        },
        (value) =>
        {
            value.jobs['history-repair-regression'].needs = 'change-contract';
        },
        (value) =>
        {
            value.jobs['history-repair-regression'].permissions = { contents: 'write' };
        }
    ];
    for (const mutate of mutations)
    {
        const invalid = structuredClone(workflow);
        mutate(invalid);
        assert.throws(() => assertHistoryWorkflowIsolation(invalid), assert.AssertionError);
    }
});

test('history repair workflow starts old trusted tests and new candidate tests without a cross-version fallback', (t) =>
{
    const workflow = readHistoryWorkflow();
    const trustedTests = workflow.jobs['change-contract'].steps.filter((step) => step.name.startsWith('Exercise trusted'));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-history-workflow-test-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const trustedRoot = path.join(temporary, 'trusted');
    const candidateRoot = path.join(temporary, 'candidate');
    const sharedTest = 'tests/tools/change-contract.test.mjs';
    const historyTest = 'tests/tools/generated-output-history-repair-v3.test.mjs';
    // These controlled fixtures exercise the actual workflow shell commands,
    // not the historical checker's policy decisions or Linux replay.
    for (const [directory, file, label] of [
        [trustedRoot, sharedTest, 'old trusted startup'],
        [candidateRoot, historyTest, 'new candidate startup']
    ])
    {
        const destination = path.join(directory, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, [
            'import assert from "node:assert/strict";',
            'import { existsSync } from "node:fs";',
            'import test from "node:test";',
            `test(${JSON.stringify(label)}, () => {`,
            `    assert.equal(process.cwd(), ${JSON.stringify(directory)});`,
            `    assert.equal(existsSync(${JSON.stringify(historyTest)}), ${directory === candidateRoot});`,
            '});',
            ''
        ].join('\n'));
    }
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const run = (step) => execFileSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], {
        cwd: path.join(temporary, step['working-directory']), env: environment, encoding: 'utf8', stdio: 'pipe', timeout: 10_000
    });
    assert.equal(trustedTests.length, 2);
    for (const step of trustedTests)
    {
        assert.match(run(step), /old trusted startup/u);
    }
    const { candidateTest } = assertHistoryWorkflowIsolation(workflow);
    assert.match(run(candidateTest), /new candidate startup/u);
    fs.rmSync(path.join(trustedRoot, sharedTest));
    assert.throws(() => run(trustedTests[0]), (error) => error.status !== 0
        && /Could not find|Cannot find/u.test(error.stderr.toString()));
    assert.equal(fs.existsSync(path.join(trustedRoot, historyTest)), false);
});
