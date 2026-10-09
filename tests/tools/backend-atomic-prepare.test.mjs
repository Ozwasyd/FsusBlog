import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

// Explicit allowlist: static reads only; never import an authority fixture or
// invoke compilation, preparation, execution, callbacks or publication here.
const allowedControls = Object.freeze([
    'backend preparation preserves the published pre-executor prefix',
    'backend preparation preserves the single executor and terminal implementation',
    'backend preparation retains the actual framework source dependency',
    'backend preparation real-input identity and no-dispatch control'
]);
const sourceCommit = '9690f0924509d665748afd5310c3b074ebcc03d6';
// Complete inspected source combinations, never a per-file arbitrary fallback.
const supportedFrameworkCommits = Object.freeze([
    '2eda290cc6098971b685b3fb1465d7193bd3dde2',
    '39466f9a3a4714b5b58cd4c75a8baa69588e9c9e'
]);
const repositoryRoot = new URL('../../', import.meta.url);
const bridgePath = 'tools/test/backend-atomic-bridge.mjs';

function publishedSource(commit, file)
{
    return execFileSync('git', ['--no-replace-objects', 'show', `${commit}:${file}`], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    });
}

function between(source, start, end)
{
    const offset = source.indexOf(start);
    assert.ok(offset >= 0, `missing start: ${start}`);
    const limit = source.indexOf(end, offset + start.length);
    assert.ok(limit >= 0, `missing end: ${end}`);
    return source.slice(offset + start.length, limit);
}

test(allowedControls[0], () =>
{
    const original = publishedSource(sourceCommit, bridgePath);
    const current = fs.readFileSync(new URL(bridgePath, repositoryRoot), 'utf8');
    const originalPrefix = between(original,
        'export async function executeBackendAtomicBridge(binding, input, options)\n{\n',
        '    let vector;');
    const extractedPrefix = between(current,
        'export function prepareBackendAtomicBridge(binding, input, options)\n{\n',
        '    const producerIds =');
    assert.equal(extractedPrefix, originalPrefix);
});

test(allowedControls[1], () =>
{
    const original = publishedSource(sourceCommit, bridgePath);
    const current = fs.readFileSync(new URL(bridgePath, repositoryRoot), 'utf8');
    const executionSignature = 'export async function executeBackendAtomicBridge(binding, input, options)\n{\n';
    assert.equal(between(current, executionSignature, '    let vector;'),
        '    prepareBackendAtomicBridge(binding, input, options);\n');
    assert.equal(current.slice(current.indexOf('    let vector;')),
        original.slice(original.indexOf('    let vector;')));
    assert.equal(current.slice(0, current.indexOf('/** Validate the original pre-execution')),
        original.slice(0, original.indexOf('/** Run the exact compiled graph once'))
            .replace('const { resolveAtomicReference }', 'const { isAtomicExecutable, resolveAtomicReference }'));
    assert.equal((current.match(/await executeCompiledAtomicProducerDag\(/gu) ?? []).length, 1);
});

test(allowedControls[2], () =>
{
    const executionPath = 'tools/test-matrix/atomic-producers/execution.mjs';
    const executionSource = fs.readFileSync(new URL(executionPath, repositoryRoot), 'utf8');
    const frameworkCommit = supportedFrameworkCommits.find((commit) =>
        executionSource === publishedSource(commit, executionPath));
    assert.ok(frameworkCommit, 'execution source must match an exact supported framework commit');
    for (const file of [
        'tools/test-matrix/atomic-producers/compiler.mjs',
        'tools/test-matrix/atomic-producers/contract.mjs',
        'tools/test-matrix/atomic-producers/contract.schema.json',
        'tools/test-matrix/atomic-producers/execution.mjs',
        'tools/test/bundles/bundle-steps.mjs'
    ])
    {
        assert.equal(fs.readFileSync(new URL(file, repositoryRoot), 'utf8'),
            publishedSource(frameworkCommit, file), file);
    }
});

test(allowedControls[3], { skip: 'UNRUN: prepareBackendAtomicBridge(binding, input, options); genuine existing input/private options unavailable; synthetic authority fixtures are excluded' }, () =>
{});
