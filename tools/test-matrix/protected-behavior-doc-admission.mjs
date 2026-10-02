import { spawn as spawnChild } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readBehaviorDocStaticAdmissionReceipt } from '../docs/behavior-doc-static-admission.mjs';
import { hostDeclarations } from '../docs/behavior-doc-minimal-contract-build-v3-contract.mjs';
import { sealSourceIdentity } from '../fact-extractors/identity.mjs';
import { readPreparedBehaviorDocNuget } from '../test/behavior-doc-nuget-preparation.mjs';

export const behaviorDocProtectedOutputRoots = Object.freeze([
    '.tmp/behavior-doc-static-admission',
    '.tmp/behavior-doc-contract-builds',
    '.tmp/runtime-role-reproducible-builds',
    '.tmp/runtime-role-verifier-builds',
    ...Object.values(hostDeclarations).map((declaration) => path.posix.dirname(declaration.output))
].sort());

export function readProtectedBehaviorDocAdmissionReceipt({ receiptFile, runId, source, repositoryRoot })
{
    return readBehaviorDocStaticAdmissionReceipt(receiptFile, {
        expectedRunId: runId, expectedSourceIdentity: source, expectedWorktree: repositoryRoot
    });
}

/** Forward cancellation to the original runner and wait for its terminal close, not just exit. */
export async function waitProtectedBehaviorDocRunner(command, args, options, { signal, spawn = spawnChild } = {})
{
    if (signal?.aborted) throw signal.reason;
    const child = spawn(command, args, options);
    let firstFailure = null;
    const cancel = (value, reason = null) =>
    {
        firstFailure ??= Object.assign(new Error(`Protected admission cancelled: ${value}`, { cause: reason }), {
            name: 'AbortError', signal: value
        });
        child.kill(value);
    };
    const onSigint = () => cancel('SIGINT');
    const onSigterm = () => cancel('SIGTERM');
    const onAbort = () => cancel('SIGTERM', signal.reason);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    signal?.addEventListener('abort', onAbort, { once: true });
    try
    {
        await new Promise((resolve, reject) =>
        {
            child.once('error', (error) => { firstFailure ??= error; });
            child.once('close', (code, terminationSignal) =>
            {
                if (firstFailure) reject(firstFailure);
                else if (code !== 0 || terminationSignal)
                {
                    reject(Object.assign(new Error('Protected BehaviorDoc admission failed'), {
                        exitCode: code, signal: terminationSignal
                    }));
                }
                else resolve();
            });
            if (signal?.aborted) onAbort();
        });
    }
    finally
    {
        process.removeListener('SIGINT', onSigint);
        process.removeListener('SIGTERM', onSigterm);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** The matrix stays on the host; only the complete original admission CLI is protected. */
export async function runProtectedBehaviorDocAdmission({
    repositoryRoot, runId, outputFile, candidateSpawnCountBeforeReceipt = 0,
    preparationFile = process.env.FSUSBLOG_BEHAVIOR_DOC_NUGET_PREPARATION,
    sourceState = null, signal, spawn = spawnChild
})
{
    const root = fs.realpathSync(repositoryRoot);
    const source = sealSourceIdentity(root);
    if (candidateSpawnCountBeforeReceipt !== 0) throw new Error('Admission must precede candidate spawning');
    const receiptFile = path.resolve(outputFile);
    const admissionRoot = path.join(root, '.tmp/behavior-doc-static-admission');
    if (!receiptFile.startsWith(admissionRoot + path.sep))
    {
        throw new Error('Protected admission receipt escapes its precise original output owner');
    }
    for (const declared of [...behaviorDocProtectedOutputRoots, path.relative(root, path.dirname(receiptFile))])
    {
        let ancestor = path.join(root, declared);
        while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
        if (fs.realpathSync(ancestor) !== ancestor || !fs.statSync(ancestor).isDirectory())
        {
            throw new Error('Protected admission output owner has a physical alias or type drift');
        }
    }
    const preparation = await readPreparedBehaviorDocNuget({ repositoryRoot: root, runId, file: preparationFile });
    const key = 'behavior-doc-static-admission';
    const args = ['tools/test/run-deterministic-command.mjs', '--execution-class', 'correctness',
        '--producer-id', key, '--key', key, '--cwd', root, '--env', 'DOTNET_ROOT', '--env', 'PATH',
        '--prepared-nuget', preparation.file,
        '--path', 'tools/docs/behavior-doc-static-admission.mjs',
        '--path', 'tools/test-matrix/protected-behavior-doc-admission.mjs',
        ...preparation.inputPaths.flatMap((file) => ['--path', file]),
        ...behaviorDocProtectedOutputRoots.flatMap((directory) => ['--output', directory]),
        '--', 'node', 'tools/docs/behavior-doc-static-admission.mjs',
        '--run-id', runId, '--out', receiptFile];
    await waitProtectedBehaviorDocRunner(process.execPath, args, {
        cwd: root, stdio: 'inherit', env: { ...process.env,
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_SOURCE_COMMIT: sourceState?.commit ?? source.sourceCommit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState?.worktreeFingerprint ?? source.worktreeFingerprint }
    }, { signal, spawn });
    // No receipt is read after a physical, preseed or postflight failure.
    const receipt = readProtectedBehaviorDocAdmissionReceipt({
        repositoryRoot: root, receiptFile, runId, source
    });
    if (JSON.stringify(sealSourceIdentity(root)) !== JSON.stringify(source))
    {
        throw new Error('Source drifted across protected BehaviorDoc admission');
    }
    return { receipt, receiptFile };
}
