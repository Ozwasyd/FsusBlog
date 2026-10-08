import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parsePlanCli, readFrozenPlan, readRegular, requireCanonicalOwnedPath, requireHeldTaskLock, requireInside, runBounded, taskEnvironment, writeNewJson } from './local-task-plan.mjs';
import { runObserved } from './recover-failed-run-carrier.mjs';

function requireUnchangedSource(before, after)
{
    if (!isDeepStrictEqual(before, after))
    {
        throw new Error('source index/config/refs changed during original call');
    }
}

function closed(value, keys)
{
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))
    {
        throw new Error('closed original caller record required');
    }
}

/** Read-only evidence must cover the selected SDK and feed, not an unrelated mount. */
export function validateInputMounts(plan)
{
    if (!Array.isArray(plan.mounts) || plan.mounts.length !== 2 || plan.tool.sdk === plan.tool.feed || new Set(plan.mounts.map(item => item?.directory)).size !== 2)
    {
        throw new Error('exact SDK/feed readonly mount coverage required');
    }
    for (const mount of plan.mounts)
    {
        closed(mount, ['directory', 'source', 'type']);
        if (![plan.tool.sdk, plan.tool.feed].includes(mount.directory) || typeof mount.source !== 'string' || !mount.source || typeof mount.type !== 'string' || !mount.type)
        {
            throw new Error('selected SDK/feed readonly mount identity required');
        }
    }
}

export function buildOriginalCall(plan)
{
    closed(plan.source, ['repository', 'head', 'tree', 'filesystem']);
    closed(plan.tool, ['node', 'nodeSha256', 'moduleSha256', 'sdk', 'feed', 'feedDigest',
        ...(Object.hasOwn(plan.tool, 'purpose') ? ['purpose'] : [])]);
    const purpose = plan.tool.purpose ?? 'behavior-doc';
    if (!['behavior-doc', 'matrix-native'].includes(purpose))
    {
        throw new Error('Unknown original NuGet preparation purpose');
    }
    closed(plan.guest, ['uid', 'gid', 'user', 'home', 'runtimeDirectory', 'userBus']);
    closed(plan.limits, ['logBytes', 'deadlineMs', 'killGraceMs', 'pollIntervalMs']);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(plan.runId) || !/^[a-f0-9]{40,64}$/.test(plan.source.head) || !/^[a-f0-9]{40,64}$/.test(plan.source.tree) || !/^[a-f0-9]{64}$/.test(plan.tool.feedDigest) || !/^[a-z_][a-z0-9_-]*$/.test(plan.guest.user) || !Number.isSafeInteger(plan.guest.uid) || !Number.isSafeInteger(plan.guest.gid) || plan.guest.uid < 0 || plan.guest.gid < 0)
    {
        throw new Error('explicit current guest/source/run identity required');
    }
    for (const value of Object.values(plan.limits))
    {
        if (!Number.isSafeInteger(value) || value <= 0)
        {
            throw new Error('original caller limit refused');
        }
    }
    const module = path.join(plan.source.repository, 'tools/docs/prepare-behavior-doc-nuget.mjs');
    const descriptor = path.join(plan.source.repository, '.tmp/behavior-doc-nuget-preparation', `${plan.runId}.json`);
    return {
        file: plan.tool.node,
        args: [module, '--run-id', plan.runId, '--out', descriptor, '--feed-root', plan.tool.feed, '--feed-digest', plan.tool.feedDigest,
            ...(purpose === 'matrix-native' ? ['--purpose', purpose] : [])],
        module,
        descriptor,
        env: { HOME: plan.guest.home, USER: plan.guest.user, LOGNAME: plan.guest.user, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', XDG_RUNTIME_DIR: plan.guest.runtimeDirectory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${plan.guest.userBus}`, DOTNET_ROOT: plan.tool.sdk, PATH: `${plan.tool.sdk}:${path.dirname(plan.tool.node)}:/usr/bin:/bin`, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
            ...(purpose === 'matrix-native' ? { FSUSBLOG_CONTENT_FIELD_DOTNET: `${plan.tool.sdk}/dotnet` } : {}) }
    };
}

export async function main(argv)
{
    const cli = parsePlanCli(argv, ['execute-original-cli']);
    const { plan, planSha256 } = readFrozenPlan(cli.planPath, cli.planSha256, ['taskLock', 'sourceSha256', 'sourceInputs', 'callerSha256', 'source', 'tool', 'guest', 'mounts', 'runId', 'limits']);
    if (readRegular(fileURLToPath(import.meta.url)).sha256 !== plan.callerSha256 || readRegular(fileURLToPath(new URL('./guest-preparation-caller.sh', import.meta.url))).sha256 !== plan.sourceSha256)
    {
        throw new Error('current caller source drift');
    }
    const call = buildOriginalCall(plan);
    const expectedSourceInputs = ['./local-task-plan.mjs', './recover-failed-run-carrier.mjs'].map(name => fileURLToPath(new URL(name, import.meta.url)));
    if (!Array.isArray(plan.sourceInputs) || plan.sourceInputs.length !== expectedSourceInputs.length)
    {
        throw new Error('complete current source helper closure required');
    }
    for (const file of expectedSourceInputs)
    {
        const item = plan.sourceInputs.find(member => member?.file === file);
        closed(item, ['file', 'sha256']);
        if (readRegular(file).sha256 !== item.sha256)
        {
            throw new Error('current source helper SHA drift');
        }
    }
    requireCanonicalOwnedPath(plan.taskLock, { insideRoot: plan.taskRoot });
    for (const file of [plan.source.repository, `${plan.source.repository}/.git`, plan.tool.sdk, plan.tool.feed, `${plan.source.repository}/.tmp`, `${plan.source.repository}/.git/production-fresh-exclusive-leases`])
    {
        requireCanonicalOwnedPath(file, { directory: true, insideRoot: plan.taskRoot });
    }
    requireInside(plan.taskRoot, call.module);
    if (readRegular(call.module).sha256 !== plan.tool.moduleSha256 || readRegular(plan.tool.node).sha256 !== plan.tool.nodeSha256)
    {
        throw new Error('original Node/module bytes drift');
    }
    requireCanonicalOwnedPath(plan.tool.node, { insideRoot: plan.taskRoot });
    requireCanonicalOwnedPath(`${plan.tool.sdk}/dotnet`, { insideRoot: plan.taskRoot });
    validateInputMounts(plan);
    for (const mount of plan.mounts)
    {
        closed(mount, ['directory', 'source', 'type']);
        requireCanonicalOwnedPath(mount.directory, { directory: true, insideRoot: plan.taskRoot });
        if (typeof mount.source !== 'string' || !mount.source || typeof mount.type !== 'string' || !mount.type)
        {
            throw new Error('mount identity required');
        }
    }
    if (cli.mode === 'inspect')
    {
        console.log(JSON.stringify({ mode: cli.mode, planSha256, call, effects: false, originalCliQualified: false }));
        return 0;
    }
    requireHeldTaskLock(plan.taskLock);
    if (process.getuid() !== plan.guest.uid || process.getgid() !== plan.guest.gid || runBounded('/usr/bin/id', ['-un']).stdout.trim() !== plan.guest.user)
    {
        throw new Error('actual guest principal drift');
    }
    for (const file of [plan.guest.home, plan.guest.runtimeDirectory])
    {
        requireCanonicalOwnedPath(file, { directory: true });
    }
    if (fs.realpathSync(plan.guest.userBus) !== plan.guest.userBus || !fs.lstatSync(plan.guest.userBus).isSocket() || fs.lstatSync(plan.guest.userBus).uid !== plan.guest.uid)
    {
        throw new Error('actual user bus missing/aliased');
    }
    if (fs.existsSync(`${plan.source.repository}/.git/objects/info/alternates`))
    {
        throw new Error('external Git dependency refused');
    }
    if (runBounded('/usr/bin/findmnt', ['-n', '-o', 'FSTYPE', '--target', plan.source.repository]).stdout.trim() !== plan.source.filesystem)
    {
        throw new Error('source filesystem drift');
    }
    for (const mount of plan.mounts)
    {
        const actual = runBounded('/usr/bin/findmnt', ['-n', '-o', 'SOURCE,FSTYPE,OPTIONS', '--mountpoint', mount.directory]);
        const [source, type, options, ...unknown] = actual.stdout.trim().split(/\s+/);
        if (actual.status !== 0 || actual.signal || unknown.length || source !== mount.source || type !== mount.type || !options?.split(',').includes('ro') || options.split(',').includes('rw'))
        {
            throw new Error('original input readonly mount drift');
        }
    }
    const observeSource = () =>
    {
        const head = runBounded('/usr/bin/git', ['-C', plan.source.repository, '-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD', 'HEAD^{tree}'], { env: { ...taskEnvironment, GIT_NO_REPLACE_OBJECTS: '1' } });
        const status = runBounded('/usr/bin/git', ['-C', plan.source.repository, '-c', 'core.fsmonitor=false', 'status', '--porcelain'], { env: { ...taskEnvironment, GIT_NO_REPLACE_OBJECTS: '1' } });
        if (head.status !== 0 || head.signal || status.status !== 0 || status.signal)
        {
            throw new Error('source observation failed');
        }
        const index = readRegular(`${plan.source.repository}/.git/index`);
        const config = readRegular(`${plan.source.repository}/.git/config`);
        const gitHead = readRegular(`${plan.source.repository}/.git/HEAD`);
        const refs = runBounded('/usr/bin/git', ['-C', plan.source.repository, '-c', 'core.fsmonitor=false', 'for-each-ref', '--format=%(refname) %(objectname)'], { env: { ...taskEnvironment, GIT_NO_REPLACE_OBJECTS: '1' } });
        if (refs.status !== 0 || refs.signal)
        {
            throw new Error('logical ref observation failed');
        }
        const refFiles = [];
        function readRefs(directory)
        {
            requireCanonicalOwnedPath(directory, { directory: true, insideRoot: plan.taskRoot });
            for (const name of fs.readdirSync(directory).sort())
            {
                const file = path.join(directory, name);
                if (fs.lstatSync(file).isDirectory())
                {
                    readRefs(file);
                }
                else
                {
                    const actual = readRegular(file, 1024 * 1024);
                    refFiles.push({ file, identity: actual.identity, sha256: actual.sha256 });
                }
                if (refFiles.length > 10000)
                {
                    throw new Error('physical ref roster bound');
                }
            }
        }
        readRefs(`${plan.source.repository}/.git/refs`);
        const packed = `${plan.source.repository}/.git/packed-refs`;
        if (fs.existsSync(packed))
        {
            const actual = readRegular(packed, 1024 * 1024);
            refFiles.push({ file: packed, identity: actual.identity, sha256: actual.sha256 });
        }
        return { head: head.stdout, status: status.stdout, sourceIndex: { identity: index.identity, sha256: index.sha256 }, sourceConfig: { identity: config.identity, sha256: config.sha256 }, physicalHead: { identity: gitHead.identity, sha256: gitHead.sha256 }, logicalRefs: refs.stdout, physicalRefs: refFiles };
    };
    const before = observeSource();
    if (before.head !== `${plan.source.head}\n${plan.source.tree}\n` || before.status)
    {
        throw new Error('current clean source binding mismatch');
    }
    if (fs.existsSync(call.descriptor) || fs.existsSync(path.dirname(call.descriptor)) && fs.readdirSync(path.dirname(call.descriptor)).includes(path.basename(call.descriptor)))
    {
        throw new Error('descriptor exists; no resume or retry');
    }
    const raw = path.join(plan.taskRoot, `original-cli-${plan.runId}`);
    fs.mkdirSync(raw, { mode: 0o700 });
    const executions = [];
    const signals = [];
    let failure;
    let after;
    fs.writeFileSync(path.join(raw, 'source-before.txt'), before.head, { flag: 'wx', mode: 0o600 });
    writeNewJson(path.join(raw, 'navigation.json'), { runId: plan.runId, planSha256, source: plan.source.repository, feed: plan.tool.feed, feedDigest: plan.tool.feedDigest, descriptor: call.descriptor, originalArgv: [call.file, ...call.args] });
    const previousUmask = process.umask(0o022);
    try
    {
        await runObserved(call.file, call.args, { runRoot: raw, cwd: plan.source.repository, env: call.env, limits: plan.limits, executions, signals, onSpawn: child =>
        {
            const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
            const tail = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
            if (tail.length < 20)
            {
                throw new Error('original child startticks unavailable');
            }
            writeNewJson(path.join(raw, 'node-identity.json'), { pid: child.pid, startticks: tail[19], executable: call.file, module: call.module, argv: call.args });
        } });
    }
    catch (error)
    {
        failure = error;
    }
    finally
    {
        process.umask(previousUmask);
        try
        {
            after = observeSource();
            fs.writeFileSync(path.join(raw, 'source-after.txt'), after.head, { flag: 'wx', mode: 0o600 });
            fs.writeFileSync(path.join(raw, 'source-after-status.txt'), after.status, { flag: 'wx', mode: 0o600 });
            requireUnchangedSource(before, after);
        }
        catch (error)
        {
            if (failure)
            {
                failure.sourceObservationFailure = error.message;
            }
            else
            {
                failure = error;
            }
        }
        const terminal = executions[0];
        fs.writeFileSync(path.join(raw, 'exit-code.txt'), `${terminal?.status ?? 'UNKNOWN'}\n`, { flag: 'wx', mode: 0o600 });
        writeNewJson(path.join(raw, 'caller.actual.json'), { planSha256, sourceBefore: before, sourceAfter: after ?? null, executions, signals, originalCallCount: executions.length, firstFailure: failure?.message ?? null, sourceObservationFailure: failure?.sourceObservationFailure ?? null, originalCliQualified: false, descriptorIsAdmission: false, failedCheckpointResume: false, wholeProcessTreeZero: 'UNKNOWN' });
        console.log(JSON.stringify({ raw, originalExit: terminal?.status ?? null, signal: terminal?.signal ?? null, descriptorIsAdmission: false }));
    }
    const terminal = executions[0];
    if (terminal?.status && terminal.status > 0)
    {
        return terminal.status;
    }
    return failure ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main(process.argv.slice(2)).then(status => { process.exitCode = status; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
