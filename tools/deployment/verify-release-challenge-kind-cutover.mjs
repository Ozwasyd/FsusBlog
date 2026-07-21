#!/usr/bin/env node

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function fail(message)
{
    throw new Error(message);
}
function parse(argv)
{
    const values = {};
    for (let i = 0; i < argv.length; i += 2)
    {
        if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined)
        {
            fail(`invalid argument near ${argv[i] ?? '<end>'}`);
        }
        values[argv[i].slice(2)] = argv[i + 1];
    }
    return values;
}
async function json(options, name)
{
    if (!options[name])
    {
        fail(`--${name} is required`);
    }
    return JSON.parse(await readFile(options[name], 'utf8'));
}
async function main()
{
    const options = parse(process.argv.slice(2));
    const [state, fence, cutover, protocol, assets, publicAot] = await Promise.all([
        json(options, 'rollout-state'), json(options, 'active-fence'), json(options, 'cutover-acceptance'),
        json(options, 'protocol-activation'),
        json(options, 'asset-materialization'), json(options, 'public-aot-warm')
    ]);
    const target = state.target ?? {};
    const generation = Number(target.runtimeGeneration ?? target.generation);
    const errors = [];
    if (state.schema !== 'fsusblog.release-rollout-state.v1')
    {
        errors.push('rollout state schema mismatch');
    }
    if (state.destructiveCutoverStarted !== true || state.activationCommitted !== false
      || state.currentStage !== 'source-drain')
    {
        errors.push('cutover binding was not captured inside the pre-activation destructive boundary');
    }
    if (fence.result?.accepted !== true || !['acquire', 'status'].includes(fence.operation))
    {
        errors.push('target active fence was not verified');
    }
    const endpoint = new URL(fence.request?.endpoint ?? 'http://invalid.invalid/');
    const fenceRequest = fence.request?.body ?? {
        releaseId: endpoint.searchParams.get('releaseId'),
        slot: endpoint.searchParams.get('slot'),
        generation: Number(endpoint.searchParams.get('generation'))
    };
    for (const [label, value] of [['releaseId', target.releaseId], ['slot', target.slot], ['generation', generation]])
    {
        if (fenceRequest[label] !== value)
        {
            errors.push(`active fence ${label} is not bound to rollout target`);
        }
        if (cutover[label] !== value)
        {
            errors.push(`cutover ${label} is not bound to rollout target`);
        }
    }
    if (cutover.schemaVersion !== 'fsus.security-challenge-kind-cutover-acceptance.v1' || cutover.accepted !== true)
    {
        errors.push('cutover acceptance is invalid');
    }
    if (protocol.schemaVersion !== 'fsus.security-challenge-protocol-activation.v1'
      || protocol.accepted !== true || protocol.status !== 'open'
      || protocol.releaseId !== target.releaseId || protocol.slot !== target.slot
      || protocol.generation !== generation || protocol.operationId !== cutover.operationId
      || protocol.targetFingerprint !== cutover.targetFingerprint)
    {
        errors.push('challenge protocol activation is not bound to verified cutover');
    }
    if (assets.status !== 'ok' || assets.releaseId !== target.releaseId || assets.slot !== target.slot)
    {
        errors.push('static asset materialization is not bound to rollout target');
    }
    if (!Array.isArray(publicAot.routes) || publicAot.routes.length === 0)
    {
        errors.push('frontend public AOT evidence is empty');
    }
    if (publicAot.routes?.some(route => route.settled?.releaseId !== target.releaseId || route.settled?.releaseSlot !== target.slot))
    {
        errors.push('frontend evidence is not bound to rollout target');
    }
    const report = {
        schema: 'fsusblog.release-challenge-kind-cutover-gate.v1',
        status: errors.length === 0 ? 'pass' : 'fail',
        rolloutId: state.rolloutId,
        releaseId: target.releaseId,
        slot: target.slot,
        generation,
        operationId: cutover.operationId ?? null,
        targetFingerprint: cutover.targetFingerprint ?? null,
        lifecycle: { destructiveCutoverStarted: state.destructiveCutoverStarted, activationCommitted: state.activationCommitted, stage: state.currentStage },
        bindings: { backendFence: true, frontend: errors.every(error => !error.startsWith('frontend')), staticAssets: errors.every(error => !error.startsWith('static asset')), cutover: errors.every(error => !error.startsWith('cutover')), protocolActivation: errors.every(error => !error.startsWith('challenge protocol')) },
        errors
    };
    const output = path.resolve(options.out ?? fail('--out is required'));
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, output);
    if (errors.length > 0)
    {
        fail(errors.join('; '));
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
}
main().catch(error =>
{
    process.stderr.write(`[release-challenge-kind-cutover] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
