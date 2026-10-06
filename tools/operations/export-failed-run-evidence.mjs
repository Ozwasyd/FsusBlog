import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePlanCli, readFrozenPlan, readRegular, requireCanonicalOwnedPath, requireHeldTaskLock, requireInside, sha256, writeNewJson } from './local-task-plan.mjs';

function closed(value, keys) {
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error('closed export record required');
}
export function quoteShell(value) {
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\n')) throw new Error('single remote argument required');
    return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Fixed read-only command shapes preserve raw CLI, physical receipts and old-boot journals. */
export function buildCaptures(guest) {
    closed(guest, ['taskRoot', 'runId', 'bootId', 'uid', 'head', 'tree']);
    if (typeof guest.taskRoot !== 'string' || !path.posix.isAbsolute(guest.taskRoot) || path.posix.resolve(guest.taskRoot) !== guest.taskRoot || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(guest.runId) || !/^[a-f0-9]{32}$/.test(guest.bootId) || !Number.isSafeInteger(guest.uid) || guest.uid < 0 || !/^[a-f0-9]{40,64}$/.test(guest.head) || !/^[a-f0-9]{40,64}$/.test(guest.tree)) throw new Error('current explicit guest identity required');
    const root = quoteShell(guest.taskRoot);
    const source = quoteShell(`${guest.taskRoot}/source`);
    const run = quoteShell(guest.runId);
    const physical = quoteShell(guest.runId.toLowerCase());
    const sourceCommand = `env GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 git -C ${source} rev-parse HEAD 'HEAD^{tree}'; env GIT_OPTIONAL_LOCKS=0 GIT_NO_REPLACE_OBJECTS=1 git -C ${source} status --porcelain`;
    return [
        { name: 'source-before', command: sourceCommand },
        { name: 'identity', command: 'id; cat /proc/sys/kernel/random/boot_id; journalctl --list-boots --no-pager' },
        { name: 'original-raw.tar', command: `tar --format=posix --numeric-owner -C ${root} -cf - ${quoteShell(`original-cli-${guest.runId}`)}` },
        { name: 'physical-records.tar', command: `tar --format=posix --numeric-owner -C ${source}/.tmp/physical-executions -cf - ${physical}` },
        { name: 'old-boot-user-journal', command: `journalctl --no-pager -o json -b ${quoteShell(guest.bootId)} ${quoteShell(`_UID=${guest.uid}`)}` },
        { name: 'owned-tool-cache-roster', command: `find ${source}/.tmp/test-execution-envelope/run-owned/${run} -maxdepth 7 -type f -printf '%s %p\\n'` },
        { name: 'original-descriptor-and-raw-status', command: `for p in ${source}/.tmp/behavior-doc-nuget-preparation/${run}.json ${root}/${quoteShell(`original-cli-${guest.runId}`)}/exit-code.txt ${root}/${quoteShell(`original-cli-${guest.runId}`)}/source-after.txt; do if test -f "$p"; then stat -c '%s %n' "$p"; else printf 'MISSING %s\\n' "$p"; fi; done` },
        { name: 'source-after', command: sourceCommand },
    ];
}

export function buildSshArguments(transport) {
    closed(transport, ['executable', 'sha256', 'identityFile', 'identitySha256', 'knownHostsFile', 'knownHostsSha256', 'host', 'port', 'user', 'hostKeyAlias']);
    if (transport.host !== '127.0.0.1' && transport.host !== '::1' || !Number.isSafeInteger(transport.port) || transport.port < 1 || transport.port > 65535 || !/^[a-z_][a-z0-9_-]*$/.test(transport.user) || typeof transport.hostKeyAlias !== 'string' || !transport.hostKeyAlias || /[\0\n]/.test(transport.hostKeyAlias)) throw new Error('explicit local carrier SSH endpoint required');
    return ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', `HostKeyAlias=${transport.hostKeyAlias}`, '-o', `UserKnownHostsFile=${transport.knownHostsFile}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-i', transport.identityFile, '-p', String(transport.port), `${transport.user}@${transport.host}`];
}

export function main(argv) {
    const cli = parsePlanCli(argv, ['export-readonly']);
    const { plan, planSha256 } = readFrozenPlan(cli.planPath, cli.planSha256, ['taskLock', 'sourceSha256', 'sourceInputs', 'transport', 'guest', 'limits']);
    if (readRegular(fileURLToPath(import.meta.url)).sha256 !== plan.sourceSha256) throw new Error('current exporter source drift');
    const expectedSourceInputs = ['./local-task-plan.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));
    if (!Array.isArray(plan.sourceInputs) || plan.sourceInputs.length !== expectedSourceInputs.length) throw new Error('complete current source helper closure required');
    for (const file of expectedSourceInputs) {
        const item = plan.sourceInputs.find(member => member?.file === file);
        closed(item, ['file', 'sha256']);
        if (readRegular(file).sha256 !== item.sha256) throw new Error('current source helper SHA drift');
    }
    requireCanonicalOwnedPath(plan.taskLock, { insideRoot: plan.taskRoot });
    const args = buildSshArguments(plan.transport);
    const captures = buildCaptures(plan.guest);
    closed(plan.limits, ['timeoutMs', 'maxBytes']);
    for (const limit of Object.values(plan.limits)) if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('positive export bound required');
    for (const [fileKey, shaKey] of [['executable', 'sha256'], ['identityFile', 'identitySha256'], ['knownHostsFile', 'knownHostsSha256']]) {
        requireInside(plan.taskRoot, plan.transport[fileKey]);
        if (readRegular(plan.transport[fileKey]).sha256 !== plan.transport[shaKey]) throw new Error('SSH custody digest drift');
    }
    if (cli.mode === 'inspect') {
        console.log(JSON.stringify({ mode: cli.mode, planSha256, captures, effects: false, qualificationEligible: false }));
        return 0;
    }
    requireHeldTaskLock(plan.taskLock);
    const root = fs.mkdtempSync(path.join(plan.taskRoot, 'failed-run-export-'));
    fs.chmodSync(root, 0o700);
    const observations = [];
    let failure;
    let before;
    let after;
    try {
        for (const capture of captures) {
            const argv = [...args, capture.command];
            const result = spawnSync(plan.transport.executable, argv, { timeout: plan.limits.timeoutMs, maxBuffer: plan.limits.maxBytes, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
            for (const stream of ['stdout', 'stderr']) if (result[stream]) fs.writeFileSync(path.join(root, `${capture.name}.${stream}`), result[stream].subarray(0, plan.limits.maxBytes), { flag: 'wx', mode: 0o600 });
            observations.push({ name: capture.name, executable: plan.transport.executable, argv, status: result.status, signal: result.signal, error: result.error?.message ?? null, stdoutBytes: result.stdout?.length ?? 0, stderrBytes: result.stderr?.length ?? 0, stdoutSha256: result.stdout ? sha256(result.stdout) : null, stderrSha256: result.stderr ? sha256(result.stderr) : null });
            if (result.error || result.signal || result.status !== 0) throw new Error(`bounded read-only export failed: ${capture.name}`);
            if (capture.name === 'source-before') {
                before = result.stdout.toString('utf8');
                if (before !== `${plan.guest.head}\n${plan.guest.tree}\n`) throw new Error('guest source/current clean identity mismatch');
            }
            if (capture.name === 'source-after') after = result.stdout.toString('utf8');
        }
        if (before !== after) throw new Error('guest source changed during export');
    } catch (error) { failure = error; }
    finally {
        writeNewJson(path.join(root, 'observations.json'), observations);
        writeNewJson(path.join(root, 'summary.json'), { planSha256, observations, sourceBefore: before ?? null, sourceAfter: after ?? null, firstFailure: failure?.message ?? null, exportsComplete: !failure, oldOriginalCliTerminal: 'UNKNOWN', oldContainedZero: 'UNKNOWN', oldCleanup: 'UNKNOWN', partialPackagesQualified: false, qualificationEligible: false, failedRunResumed: false, SDK: false, CI: false });
        console.log(JSON.stringify({ root, exportsComplete: !failure, qualificationEligible: false }));
    }
    return failure ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.exitCode = main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
