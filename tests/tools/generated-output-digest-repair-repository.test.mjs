import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { generatedOutputDigestRepairProducers } = await import(new URL('../../tools/governance/change-contract-registry.mjs', import.meta.url));
const { createGeneratedOutputDigestRepairRepository } = await import(new URL('../../tools/governance/generated-output-digest-repair-repository.mjs', import.meta.url));
const { generatedOutputDigestRepairSchema, verifyGeneratedOutputDigestRepairV2 } = await import(new URL('../../tools/governance/generated-output-digest-repair-v2.mjs', import.meta.url));
const adapterTest = (name, fn) => test(name, {
    skip: process.platform === 'linux' ? false : 'requires Linux Bubblewrap/strace namespace support'
}, fn);

test('canonical registry qualification binds the real merged PR and complete regular-blob closure', () =>
{
    const root = path.resolve(import.meta.dirname, '../..');
    const producer = generatedOutputDigestRepairProducers[0];
    const qualification = producer.qualification;
    const git = (...args) => execFileSync('git', ['-c', 'advice.graftFileDeprecated=false', ...args], {
        cwd: root,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' },
        encoding: 'utf8'
    }).trim();
    const commit = (revision) =>
    {
        const fields = git('show', '-s', '--format=%H%x00%P%x00%s', revision).split('\0');
        return { revision: fields[0], parents: fields[1] ? fields[1].split(' ') : [], subject: fields[2] };
    };
    const source = commit(qualification.sourceCommit);
    const merge = commit(qualification.mergeCommit);
    assert.equal(source.revision, qualification.sourceCommit);
    assert.deepEqual(source.parents, [qualification.sourceParent]);
    assert.equal(merge.revision, qualification.mergeCommit);
    assert.deepEqual(merge.parents, [qualification.outerBaseCommit, qualification.outerHeadCommit]);
    assert.match(merge.subject, /^Merge pull request #3271\b/u);
    const sourceChanges = git('diff', '--name-only', qualification.sourceParent, qualification.sourceCommit)
        .split('\n').filter(Boolean);
    assert.ok(sourceChanges.includes('tests/matrix.yml'));
    assert.ok(sourceChanges.includes('tools/yaml/parse-document.mjs'));
    assert.ok(!sourceChanges.includes(producer.output));
    for (const revision of [qualification.sourceParent, qualification.sourceCommit])
    {
        for (const file of producer.closure)
        {
            const entry = git('ls-tree', revision, '--', file);
            assert.match(entry, /^(100644|100755) blob [0-9a-f]{40}\t/u, `${revision}:${file}`);
        }
    }
});

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

adapterTest('real sparse sandbox reads Git inputs and writes only the output at a fixed point', (t) =>
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

adapterTest('candidate PATH executables cannot replace bwrap, strace or ldd', (t) =>
{
    const { repository, producer, base, root } = fixture(t);
    const executables = path.join(root, 'candidate-bin');
    fs.mkdirSync(executables);
    const marker = path.join(root, 'hijacked');
    for (const name of ['bwrap', 'strace', 'ldd'])
    {
        fs.writeFileSync(path.join(executables, name), `#!/bin/sh\nprintf hijacked > '${marker}'\nexit 97\n`, { mode: 0o755 });
    }
    const previous = process.env.PATH;
    process.env.PATH = `${executables}:${previous}`;
    try
    {
        const result = repository.replay({ revision: base, producer, attempt: 0 });
        assert.equal(result.first.bytes.toString(), 'canonical\n');
        assert.deepEqual(result.first, result.second);
        assert.equal(fs.existsSync(marker), false);
    }
    finally
    {
        if (previous === undefined)
        {
            delete process.env.PATH;
        }
        else
        {
            process.env.PATH = previous;
        }
    }
});

for (const name of ['bwrap', 'strace', 'ldd'])
{
    adapterTest(`trusted ${name} rejects a redirected executable before execution`, (t) =>
    {
        const { repository, producer, base, root } = fixture(t);
        const original = fs.realpathSync;
        t.mock.method(fs, 'realpathSync', (file, ...args) => file === `/usr/bin/${name}`
            ? path.join(root, name) : original(file, ...args));
        assert.throws(() => repository.replay({ revision: base, producer, attempt: 0 }), /replaced or redirected/u);
    });

    adapterTest(`trusted ${name} rejects replacement bytes between fresh replays`, (t) =>
    {
        const { repository, producer, base } = fixture(t);
        repository.replay({ revision: base, producer, attempt: 0 });
        const original = fs.readFileSync;
        // Mutate the filesystem observation, never the machine's executables.
        t.mock.method(fs, 'readFileSync', (file, ...args) => file === `/usr/bin/${name}`
            ? Buffer.from('replacement executable') : original(file, ...args));
        assert.throws(() => repository.replay({ revision: base, producer, attempt: 1 }), /trusted runtime identity drifted/u);
    });
}

adapterTest('trusted executable rejects same-byte inode replacement between fresh replays', (t) =>
{
    const { repository, producer, base } = fixture(t);
    repository.replay({ revision: base, producer, attempt: 0 });
    const original = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) =>
    {
        const stat = original(file, ...args);
        if (file === '/usr/bin/bwrap')
        {
            stat.ino += 1n;
        }
        return stat;
    });
    assert.throws(() => repository.replay({ revision: base, producer, attempt: 1 }), /trusted runtime identity drifted/u);
});

adapterTest('trusted executable rejects adjacent large inode identities with the same Number projection', (t) =>
{
    const { repository, producer, base } = fixture(t);
    const original = fs.lstatSync;
    let inode = 2n ** 63n;
    t.mock.method(fs, 'lstatSync', (file, ...args) =>
    {
        const stat = original(file, ...args);
        if (file === '/usr/bin/bwrap')
        {
            stat.ino = args[0]?.bigint ? inode : Number(inode);
        }
        return stat;
    });
    repository.replay({ revision: base, producer, attempt: 0 });
    assert.equal(Number(inode), Number(inode + 1n));
    inode += 1n;
    assert.throws(() => repository.replay({ revision: base, producer, attempt: 1 }), /trusted runtime identity drifted/u);
});

adapterTest('trusted executable rejects task-owned system path observations', (t) =>
{
    const { repository, producer, base } = fixture(t);
    const original = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) =>
    {
        const stat = original(file, ...args);
        if (file === '/usr/bin/bwrap')
        {
            stat.uid = 1000;
        }
        return stat;
    });
    assert.throws(() => repository.replay({ revision: base, producer, attempt: 0 }), /not system-owned/u);
});

for (const [name, file, syscallResult, accepted, bootstrap = false] of [
    ['exact failed runtime probe', '/sys/devices/system/cpu/cpu0/tsc_freq_khz', '-1 ENOENT (No such file or directory)', true],
    ['successful runtime probe', '/sys/devices/system/cpu/cpu0/tsc_freq_khz', '3</sys/devices/system/cpu/cpu0/tsc_freq_khz>', false],
    ['failed sibling runtime probe', '/sys/devices/system/cpu/cpu0/other_freq_khz', '-1 ENOENT (No such file or directory)', false],
    ['successful unmounted runtime sibling', '/runtime/unmounted-sibling', '3</runtime/unmounted-sibling>', false],
    ['failed unmounted runtime sibling', '/runtime/unmounted-sibling', '-1 ENOENT (No such file or directory)', false],
    ['bootstrap successful unmounted runtime sibling', '/runtime/unmounted-sibling', '3</runtime/unmounted-sibling>', false, true],
    ['bootstrap failed unmounted runtime sibling', '/runtime/unmounted-sibling', '-1 ENOENT (No such file or directory)', false, true],
    ['exact failed cgroup max probe', '/sys/fs/cgroup/memory.max', '-1 ENOENT (No such file or directory)', true],
    ['exact failed cgroup high probe', '/sys/fs/cgroup/memory.high', '-1 ENOENT (No such file or directory)', true],
    ['successful cgroup max probe', '/sys/fs/cgroup/memory.max', '3</sys/fs/cgroup/memory.max>', false],
    ['successful cgroup high probe', '/sys/fs/cgroup/memory.high', '3</sys/fs/cgroup/memory.high>', false],
    ['failed cgroup sibling probe', '/sys/fs/cgroup/memory.current', '-1 ENOENT (No such file or directory)', false]
])
{
    adapterTest(`syscall observation mutation ${name} is ${accepted ? 'accepted' : 'rejected'}`, (t) =>
    {
        const { repository, producer, base } = fixture(t);
        const original = fs.readFileSync;
        t.mock.method(fs, 'readFileSync', (source, ...args) =>
        {
            const result = original(source, ...args);
            if (typeof source !== 'string' || !source.endsWith('.strace'))
            {
                return result;
            }
            const pid = result.match(/^(\d+)\s+execve\("\/runtime\/node"/mu)?.[1];
            assert.ok(pid, 'real trace must identify the canonical Node process');
            const injected = `${pid} openat(AT_FDCWD</work>, "${file}", O_RDONLY|O_CLOEXEC) = ${syscallResult}`;
            return bootstrap ? result.replace(/^(\d+)\s+execve\("\/runtime\/node"[^\n]*$/mu, line => `${line}\n${injected}`)
                : `${result}\n${injected}\n`;
        });
        const replay = () => repository.replay({ revision: base, producer, attempt: 0 });
        if (accepted)
        {
            assert.equal(replay().first.bytes.toString(), 'canonical\n');
        }
        else
        {
            assert.throws(replay, /attempted read outside the sparse runtime/u);
        }
    });
}

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
    adapterTest(`real sparse sandbox rejects caught ${name} attempts`, (t) =>
    {
        const { repository, producer, base } = fixture(t, extra);
        assert.throws(() => repository.replay({ revision: base, producer, attempt: 0 }), /attempted|denied/u);
    });
}

adapterTest('exact Git blobs ignore replacement refs and reject symlink modes', (t) =>
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
    return {
        mode: blob.mode,
        object: blob.object,
        sha256: createHash('sha256').update(blob.bytes).digest('hex')
    };
}

function historyFixture(t, { revertClosure = false, nondeterministic = false } = {})
{
    const state = fixture(t);
    const { root, git } = state;
    const producer = { id: 'correctness-attempt-producers', repairClass: 'digest-refresh',
        manifest: 'repair.json', closure: ['input.txt', 'tools/generate.mjs', 'tools/parser.mjs'],
        output: 'output.json', digestInputs: ['input.txt'], outputSchema: 'fsusblog.correctness-attempt-producers.v1',
        command: { executable: 'node', arguments: ['tools/generate.mjs', '--write'] },
        qualification: {},
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
    git('commit', '-qm', 'multi-file source event including parser\n\nRefs: #3270');
    const sourceCommit = git('rev-parse', 'HEAD');
    git('switch', '-q', initialBranch);
    git('merge', '--no-ff', '-qm', 'Merge pull request #3271 from owner/source', sourceCommit);
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
    producer.qualification = {
        sourceParent,
        sourceCommit,
        mergedPullRequest: 3271,
        mergeCommit,
        outerBaseCommit: sourceParent,
        outerHeadCommit: sourceCommit
    };
    const authorityRoot = path.join(root, 'authority');
    git('worktree', 'add', '--detach', authorityRoot, base);
    const repository = createGeneratedOutputDigestRepairRepository({ root, authorityRoot, base, producer });
    execFileSync(process.execPath, producer.command.arguments, { cwd: root });
    git('add', producer.output);
    git('commit', '-qm', 'repair generated digest output');
    const candidateCommit = git('rev-parse', 'HEAD');
    const expected = identity(repository.blob(candidateCommit, producer.output));
    const evidence = { schema: generatedOutputDigestRepairSchema, producerId: producer.id, repairClass: producer.repairClass,
        sourceParent, sourceCommit, mergedPullRequest: 3271,
        mergeCommit, outerBaseCommit: sourceParent, outerHeadCommit: sourceCommit,
        baseCommit: base, command: producer.command,
        closure: producer.closure.map(file => ({ path: file, parent: identity(repository.blob(sourceParent, file)),
            source: identity(repository.blob(sourceCommit, file)) })),
        output: { path: producer.output, parent: identity(repository.blob(sourceParent, producer.output)),
            source: identity(repository.blob(sourceCommit, producer.output)), base: identity(repository.blob(base, producer.output)),
            expected, candidate: expected } };
    fs.writeFileSync(path.join(root, producer.manifest), JSON.stringify(evidence));
    git('add', producer.manifest);
    git('commit', '-qm', 'repair generated digest manifest');
    const head = git('rev-parse', 'HEAD');
    return { ...state, producer, evidence, repository, base, head,
        options: { producer, evidence, repository, base, head, changedFiles: repository.changedPaths(base, head) } };
}

adapterTest('real Git multi-file source and parser event verifies across all eight fresh replay instances', (t) =>
{
    const { options } = historyFixture(t);
    const result = verifyGeneratedOutputDigestRepairV2(options);
    assert.equal(result.status, 'verified');
    assert.equal(result.replayIsolations, 8);
    assert.equal(result.producerCount, 1);
});

adapterTest('real Git closure change-revert history is rejected before replay', (t) =>
{
    const { options } = historyFixture(t, { revertClosure: true });
    assert.throws(() => verifyGeneratedOutputDigestRepairV2(options), /closure changed after source/u);
});

adapterTest('real replay rejects an omitted imported module from its declared closure', (t) =>
{
    const { root, git, producer, base } = historyFixture(t);
    const incomplete = { ...producer, closure: producer.closure.filter(file => file !== 'tools/parser.mjs') };
    const repository = createGeneratedOutputDigestRepairRepository({ root, authorityRoot: path.join(root, 'authority'), base,
        producer: incomplete });
    assert.throws(() => repository.replay({ revision: git('rev-parse', 'HEAD'), producer: incomplete, attempt: 0 }),
        /outside declared closure|canonical sandbox producer failed/u);
});

adapterTest('real nondeterministic producer fails fixed-point verification', (t) =>
{
    const { options } = historyFixture(t, { nondeterministic: true });
    assert.throws(() => verifyGeneratedOutputDigestRepairV2(options), /not a fixed point/u);
});
