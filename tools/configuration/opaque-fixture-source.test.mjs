import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectOpaqueFixtureInputs, validateOpaqueConsumerEvents, validateOpaqueFixtureSourceReceipt } from './check-opaque-fixture-source.mjs';

const authorityRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureFile = 'tests/tools/fixtures/canonical-digest-edge/v3-contract.mjs';
const consumerFile = 'tests/tools/canonical-digest-edge.test.mjs';
const policyFile = 'config/development/opaque-source-fixture-policy.json';
const reporterFile = 'tools/configuration/opaque-fixture-native-reporter.mjs';
const inputs = [policyFile, 'tools/configuration/check-opaque-fixture-source.mjs', reporterFile,
    'tools/configuration/check-solution-source.mjs', 'tests/matrix.yml', fixtureFile, consumerFile];
const environmentKeys = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT', 'NODE_V8_COVERAGE'];

function cleanEnvironment()
{
    const result = { ...process.env };
    for (const key of environmentKeys)
    {
        delete result[key];
    }
    return result;
}

function fixture(action)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-opaque-source-'));
    const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    for (const key of environmentKeys)
    {
        delete process.env[key];
    }
    function write(file, bytes)
    {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), bytes);
    }
    const git = (...argv) => execFileSync('git', ['-C', root, ...argv], { encoding: 'utf8', env: cleanEnvironment() }).trim();
    const commit = () =>
    {
        git('add', '.');
        git('commit', '--quiet', '-m', 'opaque source control');
    };
    try
    {
        git('init', '--quiet');
        git('config', 'user.name', 'Opaque Source Fixture');
        git('config', 'user.email', 'fixture@fsus.invalid');
        for (const file of inputs)
        {
            write(file, fs.readFileSync(path.join(authorityRoot, file)));
        }
        commit();
        return action({ root, write, git, commit });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(saved))
        {
            if (value === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = value;
            }
        }
    }
}

const inspect = root => inspectOpaqueFixtureInputs({ repositoryRoot: root, files: [fixtureFile] });

test('opaque source binds the original complete consumer and raw bytes without importing the fixture', () =>
{
    fixture(({ root, git }) =>
    {
        const result = inspect(root);
        assert.equal(result.head, git('rev-parse', 'HEAD'));
        assert.deepEqual(result.bindings.map(value => value.file), inputs);
        assert.equal(result.node.version, process.version);
        assert.match(result.node.sha256, /^[a-f0-9]{64}$/u);
        assert.equal(result.bindings.find(value => value.file === fixtureFile).mode, '100644');
        assert.equal(fs.existsSync(path.join(root, '.tmp')), false);
        assert.equal(git('status', '--porcelain'), '');
    });
});

test('opaque source refuses unregistered omitted duplicated and normalized-path aliases', () =>
{
    fixture(({ root }) =>
    {
        for (const files of [[], [consumerFile], [fixtureFile, fixtureFile], [`./${fixtureFile}`],
            [fixtureFile.replace('/v3-contract', '/../canonical-digest-edge/v3-contract')]])
        {
            assert.throws(() => inspectOpaqueFixtureInputs({ repositoryRoot: root, files }), /one registered canonical input/u);
        }
    });
});

test('opaque source refuses physical and index changes before source admission', () =>
{
    fixture(({ root, write, git }) =>
    {
        const original = fs.readFileSync(path.join(root, fixtureFile));
        write(fixtureFile, Buffer.concat([original, Buffer.from('\nprocess.exit();\n')]));
        assert.throws(() => inspect(root), /HEAD\/index\/physical/u);
        git('add', fixtureFile);
        assert.throws(() => inspect(root), /HEAD\/index\/physical/u);
    });
});

test('opaque source rejects newly committed fixture or consumer replacements under the old registration', () =>
{
    for (const file of [fixtureFile, consumerFile])
    {
        fixture(({ root, commit }) =>
        {
            fs.appendFileSync(path.join(root, file), '\nprocess.exit();\n');
            commit();
            assert.throws(() => inspect(root), /differs from its reviewed source registration/u);
        });
    }
});

test('opaque source refuses hardlinks symlinks executable inputs and redirected roots', () =>
{
    fixture(({ root, git, commit }) =>
    {
        const absolute = path.join(root, fixtureFile);
        const alias = path.join(root, 'fixture-alias');
        fs.linkSync(absolute, alias);
        assert.throws(() => inspect(root), /single-link/u);
        fs.unlinkSync(alias);
        fs.renameSync(absolute, alias);
        fs.symlinkSync(alias, absolute);
        assert.throws(() => inspect(root));
        fs.unlinkSync(absolute);
        fs.renameSync(alias, absolute);
        fs.chmodSync(absolute, 0o755);
        git('update-index', '--chmod=+x', fixtureFile);
        commit();
        assert.throws(() => inspect(root), /non-executable/u);
        const linkedRoot = `${root}-link`;
        fs.symlinkSync(root, linkedRoot, 'dir');
        try
        {
            assert.throws(() => inspect(linkedRoot), /canonical input/u);
        }
        finally
        {
            fs.unlinkSync(linkedRoot);
        }
    });
});

test('opaque source rejects extra policy fields and altered original consumer rosters', () =>
{
    for (const mutation of ['extra', 'duplicate', 'missing'])
    {
        fixture(({ root, write, commit }) =>
        {
            const policy = JSON.parse(fs.readFileSync(path.join(root, policyFile), 'utf8'));
            if (mutation === 'extra')
            {
                policy.waiver = true;
            }
            else if (mutation === 'duplicate')
            {
                policy.caseNames[0] = policy.caseNames[1];
            }
            else
            {
                policy.caseNames.pop();
            }
            write(policyFile, JSON.stringify(policy));
            commit();
            assert.throws(() => inspect(root), /closed original consumer registration/u);
        });
    }
});

test('native reporter cannot turn consumer stdout into passing assertion events', () =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-opaque-native-'));
    try
    {
        const entry = path.join(root, 'consumer.mjs');
        fs.writeFileSync(entry, `import test from 'node:test';
test('original-one', () => console.log('{"type":"test:pass"}'));
test('original-two', () => {});
`);
        const result = spawnSync(process.execPath, ['--test', '--test-reporter', path.join(authorityRoot, reporterFile), entry],
            { env: cleanEnvironment(), encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const verification = validateOpaqueConsumerEvents(result.stdout,
            { entry, expectedNames: ['original-one', 'original-two'] });
        assert.equal(verification.counts.passed, 2);
        assert.ok(result.stdout.includes('test:stdout'));
        for (const mutation of ['extra', 'duplicate-summary', 'missing', 'skip', 'failure'])
        {
            const events = result.stdout.trim().split('\n').map(line => JSON.parse(line));
            if (mutation === 'extra')
            {
                events[0].waiver = true;
            }
            else if (mutation === 'duplicate-summary')
            {
                events.push(events.find(event => event.type === 'test:summary'));
            }
            else if (mutation === 'missing')
            {
                events.splice(events.findIndex(event => event.type === 'test:pass'), 1);
            }
            else if (mutation === 'skip')
            {
                events.find(event => event.type === 'test:pass').data.skip = true;
            }
            else
            {
                events.push({ type: 'test:fail', data: {} });
            }
            assert.throws(() => validateOpaqueConsumerEvents(`${events.map(event => JSON.stringify(event)).join('\n')}\n`,
                { entry, expectedNames: ['original-one', 'original-two'] }));
        }
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('opaque receipts refuse forged identities and cannot supply additional authority fields', () =>
{
    fixture(({ root }) =>
    {
        const actual = inspect(root);
        for (const receipt of [{}, { schema: 'fsusblog.opaque-fixture-source-evidence.v1', status: 'collected',
            qualificationEligible: true, files: [fixtureFile], inputs: actual, waiver: true }])
        {
            assert.throws(() => validateOpaqueFixtureSourceReceipt({ repositoryRoot: root, files: [fixtureFile],
                expectedHead: actual.head, receipt }), /live original command/u);
        }
    });
});

test('opaque source rejects ambient native and Git execution overrides', () =>
{
    fixture(({ root }) =>
    {
        for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'GIT_INDEX_FILE'])
        {
            process.env[key] = 'untrusted-override';
            try
            {
                assert.throws(() => inspect(root), /ambient Git or Node execution overrides/u);
            }
            finally
            {
                delete process.env[key];
            }
        }
    });
});

test('opaque CLI refuses additional consumer arguments and duplicate options before execution', () =>
{
    for (const argv of [['--test-name-pattern', 'partial'], ['--root', authorityRoot, '--root', authorityRoot],
        ['--verify-receipt'], ['--expected-head', '0'.repeat(40)]])
    {
        const result = spawnSync(process.execPath, [path.join(authorityRoot,
            'tools/configuration/check-opaque-fixture-source.mjs'), ...argv], { env: cleanEnvironment(), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
    }
});

test('opaque receipt CLI drains a real large pipe before applying unchanged live identity refusals', () =>
{
    fixture(({ root, git }) =>
    {
        const result = spawnSync(process.execPath, [path.join(authorityRoot,
            'tools/configuration/check-opaque-fixture-source.mjs'), '--verify-receipt', '--root', root,
        '--file', fixtureFile, '--expected-head', git('rev-parse', 'HEAD'),
        '--expected-attempt-token', 'a'.repeat(64)],
        { input: `${' '.repeat(1024 * 1024)}{}`, env: cleanEnvironment(), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /does not match the live original command/u);
        assert.doesNotMatch(result.stderr, /EAGAIN/u);
    });
});

test('opaque receipt CLI refuses oversized and malformed UTF-8 transports before admission', () =>
{
    for (const [input, error] of [[Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), /sixteen MiB transport limit/u],
        [Buffer.from([0xff]), /exact UTF-8/u]])
    {
        const result = spawnSync(process.execPath, [path.join(authorityRoot,
            'tools/configuration/check-opaque-fixture-source.mjs'), '--verify-receipt', '--root', authorityRoot,
        '--file', fixtureFile, '--expected-head', '0'.repeat(40), '--expected-attempt-token', 'a'.repeat(64)],
        { input, env: cleanEnvironment(), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, error);
    }
});
