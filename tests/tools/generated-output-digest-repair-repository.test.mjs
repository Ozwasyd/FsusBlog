import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGeneratedOutputDigestRepairRepository } from '../../tools/governance/generated-output-digest-repair-repository.mjs';
import { generatedOutputDigestRepairSchema, verifyGeneratedOutputDigestRepairV2 } from '../../tools/governance/generated-output-digest-repair-v2.mjs';

function fixture(t, extra = '')
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-repair-adapter-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
    git('init', '-q');
    git('config', 'user.email', 'repair-test@example.invalid');
    git('config', 'user.name', 'Repair adapter test');
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools/generate.mjs'), `import fs from 'node:fs';\n${extra}\nfs.writeFileSync('output.json', fs.readFileSync('input.txt'));\n`);
    fs.writeFileSync(path.join(root, 'input.txt'), 'canonical\n');
    fs.writeFileSync(path.join(root, 'output.json'), 'old\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    const base = git('rev-parse', 'HEAD');
    const producer = { closure: ['input.txt', 'tools/generate.mjs'], output: 'output.json',
        command: { executable: 'node', arguments: ['tools/generate.mjs', '--write'] } };
    const repository = createGeneratedOutputDigestRepairRepository({ root, authorityRoot: root, base, producer });
    return { root, git, base, producer, repository };
}

test('real sparse sandbox reads Git inputs and writes only the output at a fixed point', (t) =>
{
    const { repository, producer, base, root } = fixture(t);
    const result = repository.replay({ revision: base, producer, attempt: 0 });
    assert.deepEqual(result.readPaths, producer.closure);
    assert.deepEqual(result.writePaths, [producer.output]);
    assert.deepEqual(result.changedPaths, [producer.output]);
    assert.deepEqual(result.first, result.second);
    assert.equal(result.first.bytes.toString(), 'canonical\n');
    assert.equal(fs.readFileSync(path.join(root, producer.output), 'utf8'), 'old\n');
    assert.equal(fs.existsSync(result.isolationId), false);
});

for (const [name, extra] of [
    ['undeclared source read', "try { fs.readFileSync('unregistered.txt'); } catch {}"],
    ['extra output write', "try { fs.writeFileSync('unregistered.txt', 'bad'); } catch {}"],
    ['ignored output write', "try { fs.writeFileSync('.ignored-output', 'bad'); } catch {}"],
    ['external write', "try { fs.writeFileSync('/dev/null', 'bad'); } catch {}"],
    ['source write', "try { fs.writeFileSync('input.txt', 'bad'); } catch {}"],
    ['source chmod', "try { fs.chmodSync('input.txt', 0o777); } catch {}"],
    ['symlink', "try { fs.symlinkSync('output.json', 'alias'); } catch {}"],
    ['hardlink', "try { fs.linkSync('output.json', 'alias'); } catch {}"],
    ['network', "const net = await import('node:net'); const server = net.createServer(); server.on('error', () => {}); server.listen(0); server.unref();"]
])
{
    test(`real sparse sandbox rejects caught ${name} attempts`, (t) =>
    {
        const { repository, producer, base } = fixture(t, extra);
        assert.throws(() => repository.replay({ revision: base, producer, attempt: 0 }), /attempted|denied/u);
    });
}

test('exact Git blobs ignore replacement refs and reject symlink modes', (t) =>
{
    const { repository, git, base, root } = fixture(t);
    fs.writeFileSync(path.join(root, 'input.txt'), 'replacement\n');
    git('add', '.');
    git('commit', '-qm', 'replacement');
    const replacement = git('rev-parse', 'HEAD');
    git('replace', base, replacement);
    assert.equal(repository.blob(base, 'input.txt').bytes.toString(), 'canonical\n');
    assert.equal(repository.commit(base).subject, 'initial');
    fs.symlinkSync('input.txt', path.join(root, 'alias'));
    git('add', '.');
    git('commit', '-qm', 'symlink');
    assert.throws(() => repository.blob(git('rev-parse', 'HEAD'), 'alias'), /exact regular blob/u);
});

function identity(blob)
{
    return { mode: blob.mode, sha256: createHash('sha256').update(blob.bytes).digest('hex') };
}

function historyFixture(t, { revertClosure = false, nondeterministic = false } = {})
{
    const state = fixture(t);
    const { root, git } = state;
    const producer = { id: 'correctness-attempt-producers', repairClass: 'digest-refresh',
        manifest: 'repair.json', closure: ['input.txt', 'tools/generate.mjs', 'tools/parser.mjs'],
        output: 'output.json', digestInputs: ['input.txt'], outputSchema: 'fsusblog.correctness-attempt-producers.v1',
        command: { executable: 'node', arguments: ['tools/generate.mjs', '--write'] },
        protectedPolicyPaths: ['policy.mjs'] };
    fs.writeFileSync(path.join(root, 'tools/parser.mjs'), 'export const parse = value => value.trim();\n');
    fs.writeFileSync(path.join(root, 'tools/generate.mjs'), `
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from './parser.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    return value;
}
const input = fs.readFileSync('input.txt');
const payload = { schema: '${producer.outputSchema}', generatedBy: 'tools/generate.mjs',
    sourceDigests: { 'input.txt': 'sha256:' + hash(input) }, entries: [{ producerId: parse(input.toString()) }] };
fs.writeFileSync('output.json', JSON.stringify({ ...payload, contentDigest: 'sha256:' + hash(JSON.stringify(sorted(payload))) }, null, 4) + '\\n');
${nondeterministic ? "fs.appendFileSync('output.json', String(Math.random()));" : ''}
`);
    execFileSync(process.execPath, producer.command.arguments, { cwd: root });
    git('add', '.');
    git('commit', '-qm', 'synchronized parent');
    const sourceParent = git('rev-parse', 'HEAD');
    const initialBranch = git('branch', '--show-current');
    git('switch', '-qc', 'source');
    fs.writeFileSync(path.join(root, 'input.txt'), '  canonical\n');
    fs.writeFileSync(path.join(root, 'tools/parser.mjs'), 'export const parse = value => value.trimStart().trimEnd();\n');
    fs.writeFileSync(path.join(root, 'unrelated.md'), 'source event also owns documentation\n');
    git('add', '.');
    git('commit', '-qm', 'multi-file source event including parser');
    const sourceCommit = git('rev-parse', 'HEAD');
    git('switch', '-q', initialBranch);
    git('merge', '--no-ff', '-qm', 'Merge pull request #42 from owner/source', sourceCommit);
    const mergeCommit = git('rev-parse', 'HEAD');
    if (revertClosure)
    {
        fs.writeFileSync(path.join(root, 'input.txt'), 'temporary mutation\n');
        git('add', '.');
        git('commit', '-qm', 'temporary closure mutation');
        fs.writeFileSync(path.join(root, 'input.txt'), '  canonical\n');
        git('add', '.');
        git('commit', '-qm', 'restore closure');
    }
    fs.writeFileSync(path.join(root, 'policy.mjs'), 'export const policy = 2;\n');
    git('add', '.');
    git('commit', '-qm', 'trusted policy bootstrap');
    const base = git('rev-parse', 'HEAD');
    const authorityRoot = path.join(root, 'authority');
    git('worktree', 'add', '--detach', authorityRoot, base);
    const repository = createGeneratedOutputDigestRepairRepository({ root, authorityRoot, base, producer });
    execFileSync(process.execPath, producer.command.arguments, { cwd: root });
    const expected = identity({ mode: '100644', bytes: fs.readFileSync(path.join(root, producer.output)) });
    const evidence = { schema: generatedOutputDigestRepairSchema, producerId: producer.id, repairClass: producer.repairClass,
        sourceParent, sourceCommit, mergedPullRequest: 42, mergeCommit, baseCommit: base, command: producer.command,
        closure: producer.closure.map(file => ({ path: file, parent: identity(repository.blob(sourceParent, file)),
            source: identity(repository.blob(sourceCommit, file)) })),
        output: { path: producer.output, parent: identity(repository.blob(sourceParent, producer.output)),
            source: identity(repository.blob(sourceCommit, producer.output)), base: identity(repository.blob(base, producer.output)),
            expected, candidate: expected } };
    fs.writeFileSync(path.join(root, producer.manifest), JSON.stringify(evidence));
    git('add', producer.output, producer.manifest);
    git('commit', '-qm', 'repair generated digest only');
    const head = git('rev-parse', 'HEAD');
    return { ...state, producer, evidence, repository, base, head,
        options: { producer, evidence, repository, base, head, changedFiles: repository.changedPaths(base, head) } };
}

test('real Git multi-file source and parser event verifies across all eight fresh replay instances', (t) =>
{
    const { options } = historyFixture(t);
    const result = verifyGeneratedOutputDigestRepairV2(options);
    assert.equal(result.status, 'verified');
    assert.equal(result.replayIsolations, 8);
    assert.equal(result.producerCount, 1);
});

test('real Git closure change-revert history is rejected before replay', (t) =>
{
    const { options } = historyFixture(t, { revertClosure: true });
    assert.throws(() => verifyGeneratedOutputDigestRepairV2(options), /closure changed after source/u);
});

test('real replay rejects an omitted imported module from its declared closure', (t) =>
{
    const { root, git, producer, base } = historyFixture(t);
    const incomplete = { ...producer, closure: producer.closure.filter(file => file !== 'tools/parser.mjs') };
    const repository = createGeneratedOutputDigestRepairRepository({ root, authorityRoot: path.join(root, 'authority'), base,
        producer: incomplete });
    assert.throws(() => repository.replay({ revision: git('rev-parse', 'HEAD'), producer: incomplete, attempt: 0 }),
        /outside declared closure|canonical sandbox producer failed/u);
});

test('real nondeterministic producer fails fixed-point verification', (t) =>
{
    const { options } = historyFixture(t, { nondeterministic: true });
    assert.throws(() => verifyGeneratedOutputDigestRepairV2(options), /not a fixed point/u);
});
