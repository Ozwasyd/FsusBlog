import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { createReleaseRolloutEvidenceFixture } from './support/release-rollout-evidence-fixture.mjs';

const cli = fileURLToPath(new URL('../../tools/deployment/release-rollout-evidence.mjs', import.meta.url));
const fixtureOwner = createReleaseRolloutEvidenceFixture();

function metadata(file)
{
    const bytes = fs.readFileSync(file);
    return { path: file, bytes: bytes.length, sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` };
}

function verify(file)
{
    const result = spawnSync(process.execPath, [cli, 'verify', '--evidence', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    return { exitCode: result.status, value: JSON.parse(result.stdout) };
}

function prepared(t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-rollout-physical-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { file, value } = fixtureOwner.createFinalEvidence(directory);
    const stage = value.stages[0];
    const parsed = JSON.parse(fs.readFileSync(stage.evidence.path, 'utf8'));
    parsed.output = {};
    for (const stream of ['stdout', 'stderr'])
    {
        const output = path.join(directory, `${stream}.log`);
        fs.writeFileSync(output, `fixture ${stream}\n`);
        parsed.output[stream] = metadata(output);
    }
    fs.writeFileSync(stage.evidence.path, JSON.stringify(parsed));
    stage.evidence = metadata(stage.evidence.path);
    const attemptFile = path.join(directory, 'attempt.json');
    fs.writeFileSync(attemptFile, JSON.stringify(parsed));
    stage.attemptEvidence[0].evidence = metadata(attemptFile);
    const recoveryFile = path.join(directory, 'recovery.json');
    fs.writeFileSync(recoveryFile, JSON.stringify({ status: 'ok', action: 'fixture-recovery' }));
    value.recoveries.push({ status: 'ok', action: 'fixture-recovery', evidence: metadata(recoveryFile) });
    fs.writeFileSync(file, JSON.stringify(value));
    const inputs = {
        final: file,
        stage: stage.evidence.path,
        attempt: attemptFile,
        stdout: parsed.output.stdout.path,
        stderr: parsed.output.stderr.path,
        recovery: recoveryFile,
        artifact: value.artifacts.publicTraffic.path,
        auxiliary: value.auxiliary.releaseManifest.path
    };
    return { file, directory, inputs };
}

test('physical rollout reader replays a complete owned file fixture and rejects leaf aliases and sealed drift', t =>
{
    const { file, inputs } = prepared(t);
    assert.equal(verify(file).value.status, 'pass');
    for (const [name, input] of Object.entries(inputs))
    {
        const bytes = fs.readFileSync(input);
        const retained = `${input}.retained`;
        fs.renameSync(input, retained);
        fs.symlinkSync(retained, input);
        try
        {
            const result = verify(file);
            assert.equal(result.exitCode, 1, `${name} symlink must refuse`);
            assert.equal(result.value.status, 'fail');
            assert.match(result.value.errors.join('\n'), /ELOOP|symbolic|symlink/u);
        }
        finally
        {
            fs.unlinkSync(input);
            fs.renameSync(retained, input);
        }
        try
        {
            if (name === 'final')
            {
                const changed = JSON.parse(bytes);
                changed.status = 'fail';
                fs.writeFileSync(input, JSON.stringify(changed));
            }
            else
            {
                fs.appendFileSync(input, ' ');
            }
            assert.equal(verify(file).value.status, 'fail', `${name} drift must refuse`);
        }
        finally
        {
            fs.writeFileSync(input, bytes);
        }
        assert.equal(verify(file).value.status, 'pass', `${name} restored fixture must pass`);
    }
});

test('physical rollout reader rejects a nonregular final input', t =>
{
    const { directory } = prepared(t);
    const result = verify(directory);
    assert.equal(result.exitCode, 1);
    assert.match(result.value.errors.join('\n'), /regular non-symlink file/u);
});

async function mutateHeldFile(file, mode)
{
    const child = spawn(process.execPath, [cli, 'verify', '--evidence', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk =>
    {
        stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', chunk =>
    {
        stderr += chunk;
    });
    const completion = new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('close', code => resolve({ code, stdout, stderr }));
    });
    let observed = false;
    const deadline = Date.now() + 10000;
    try
    {
        while (child.exitCode === null && Date.now() < deadline)
        {
            try
            {
                const descriptors = fs.readdirSync(`/proc/${child.pid}/fd`);
                observed = descriptors.some(descriptor =>
                {
                    try
                    {
                        return fs.readlinkSync(`/proc/${child.pid}/fd/${descriptor}`) === file;
                    }
                    catch
                    {
                        return false;
                    }
                });
            }
            catch
            {
                observed = false;
            }
            if (observed)
            {
                if (mode === 'replace')
                {
                    fs.renameSync(file, `${file}.old`);
                    fs.copyFileSync(`${file}.old`, file);
                }
                else
                {
                    const descriptor = fs.openSync(file, 'r+');
                    try
                    {
                        fs.writeSync(descriptor, Buffer.from(' '), 0, 1, 0);
                    }
                    finally
                    {
                        fs.closeSync(descriptor);
                    }
                }
                break;
            }
            await setTimeout(1);
        }
        if (!observed)
        {
            child.kill();
        }
        const result = await completion;
        assert.equal(observed, true, `must observe the actual held descriptor (${mode})`);
        assert.equal(result.code, 1, result.stderr || result.stdout);
        assert.match(JSON.parse(result.stdout).errors.join('\n'), /changed while reading/u);
    }
    finally
    {
        if (child.exitCode === null)
        {
            child.kill();
            await completion;
        }
    }
}

for (const mode of ['in-place', 'replace'])
{
    test(`physical rollout reader rejects ${mode} mutation during the actual held descriptor read`, async t =>
    {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-rollout-physical-race-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const file = path.join(directory, 'large-final.json');
        // Real disposable bytes widen the physical read window; no production fs double or runtime receipt is used.
        fs.writeFileSync(file, Buffer.alloc(64 * 1024 * 1024, 0x20));
        fs.appendFileSync(file, '{}');
        await mutateHeldFile(file, mode);
    });
}

test('physical CLI delegation retains current strong semantic guards after fixture metadata is refreshed', t =>
{
    const { file } = prepared(t);
    const original = fs.readFileSync(file);
    const cases = [
        ['artifacts', 'publicTraffic', payload =>
        {
            payload.finalBinding.payloadSha256 = `sha256:${'0'.repeat(64)}`;
        }, /binding/u],
        ['artifacts', 'assetCompatibility', payload =>
        {
            payload.browser.afterGc.status = 'fail';
        }, /browser/u],
        ['artifacts', 'assetCompatibility', payload =>
        {
            payload.browserBinding.payloadSha256 = `sha256:${'0'.repeat(64)}`;
        }, /binding/u],
        ['auxiliary', 'releaseManifest', payload =>
        {
            payload.schema = 'fsusblog.release-manifest.v1';
        }, /immutable target identity/u],
        ['auxiliary', 'challengeKindCutoverReceipt', payload =>
        {
            payload.dryRun = true;
        }, /applied receipt/u],
        ['auxiliary', 'challengeKindCutoverAcceptance', payload =>
        {
            payload.accepted = false;
        }, /verifier acceptance/u],
        ['auxiliary', 'challengeKindCutoverGate', payload =>
        {
            payload.bindings.perceptionCharacterV3 = false;
        }, /target binding gate/u],
        ['auxiliary', 'perceptionCharacterV3Cutover', payload =>
        {
            payload.generation += 1;
        }, /V3 cutover/u],
        ['auxiliary', 'publicAotWarm', payload =>
        {
            payload.generatedAtUtc = new Date(Date.now() + 120000).toISOString();
        }, /publicAotWarm/u]
    ];
    for (const [section, name, mutate, expected] of cases)
    {
        const evidence = JSON.parse(original);
        const input = evidence[section][name].path;
        const bytes = fs.readFileSync(input);
        try
        {
            const payload = JSON.parse(bytes);
            mutate(payload);
            fs.writeFileSync(input, JSON.stringify(payload));
            evidence[section][name] = { ...evidence[section][name], ...metadata(input) };
            fs.writeFileSync(file, JSON.stringify(evidence));
            const result = verify(file);
            assert.equal(result.value.status, 'fail', `${name} current semantic refusal`);
            assert.match(result.value.errors.join('\n'), expected);
            assert.doesNotMatch(result.value.errors.join('\n'), /changed after seal/u);
        }
        finally
        {
            fs.writeFileSync(input, bytes);
            fs.writeFileSync(file, original);
        }
    }
    const unresolved = JSON.parse(original);
    unresolved.recoveries[0].status = 'failed';
    fs.writeFileSync(file, JSON.stringify(unresolved));
    assert.match(verify(file).value.errors.join('\n'), /unresolved failed recovery/u);
    fs.writeFileSync(file, original);
    assert.equal(verify(file).value.status, 'pass');
});
