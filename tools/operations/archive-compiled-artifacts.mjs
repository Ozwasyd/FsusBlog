import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parsePlanCli, readFrozenPlan, requireCanonicalOwnedPath, requireInside, readRegular, requireHeldTaskLock, requireSourceClosure } from './local-task-plan.mjs';

// Source preservation: archive receipts grant neither retirement nor runtime qualification.
export async function preserveCompiledArtifacts(plan, planSha256, mode = 'inspect') {
    validateArchivePlan(plan);
    const repository = plan.taskRoot;
    const original = plan.original;
    const lock = plan.taskLock;
    const terminal = plan.terminal;
    const terminalSha = plan.terminalSha256;
    const diskFloor = BigInt(plan.budgets.diskFloorBytes), memoryFloor = plan.budgets.memoryFloorBytes;
    const archiveBound = plan.budgets.archiveBytes, restoreBound = plan.budgets.restoreBytes;
    const metadataReserve = plan.budgets.metadataBytes;
    const totalOutputReserve = archiveBound + restoreBound + metadataReserve;
    if (!Number.isSafeInteger(totalOutputReserve)) throw Error('archive total reserve overflow');
    const ownerUid = BigInt(process.getuid()), ownerGid = BigInt(process.getgid());
    const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const commands = [], signals = [];
    let runRoot, archive, restoreRoot, currentChild, firstFailure;
    function fail(e) { firstFailure ??= e; }
    function epoch(s) {
        return { dev: String(s.dev), ino: String(s.ino), mode: Number(s.mode & 0o7777n),
            uid: Number(s.uid), gid: Number(s.gid), nlink: Number(s.nlink), size: String(s.size),
            mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
    }
    function equal(a, b, reason) { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(reason); }
    function errorData(e) { return { name: e?.name, message: e?.message, code: e?.code ?? null, stack: e?.stack }; }
    function closeBoth(fds, primary) {
        const secondary = [];
        for (const fd of fds) { try { fs.closeSync(fd); } catch (e) { secondary.push(errorData(e)); } }
        if (primary) { if (secondary.length) primary.archiveCloseFailures = secondary; throw primary; }
        if (secondary.length) { const e = Error('archive descriptor cleanup failed'); e.archiveCloseFailures = secondary; throw e; }
    }
    function hashFile(file, bound) {
        const initial = fs.lstatSync(file, { bigint: true });
        if (!initial.isFile() || initial.uid !== ownerUid || initial.gid !== ownerGid || initial.nlink !== 1n || initial.size > BigInt(bound)) throw Error('hash owner/type/size refusal');
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        let primary, digest;
        try {
            equal(epoch(initial), epoch(fs.fstatSync(fd, { bigint: true })), 'hash initial descriptor mismatch');
            const h = crypto.createHash('sha256'), b = Buffer.alloc(65536);
            let n, readBytes = 0;
            while ((n = fs.readSync(fd, b, 0, b.length, null))) {
                if ((readBytes += n) > bound) throw Error('archive live hash bound refused');
                h.update(b.subarray(0, n));
            }
            equal(epoch(initial), epoch(fs.fstatSync(fd, { bigint: true })), 'hash descriptor drift');
            equal(epoch(initial), epoch(fs.lstatSync(file, { bigint: true })), 'hash path drift');
            digest = h.digest('hex');
        } catch (e) { primary = e; }
        closeBoth([fd], primary);
        return digest;
    }
    function requireHeavyLock() { if (mode === 'archive') requireHeldTaskLock(lock); }
    function outputAllocated() {
        let allocated = 0;
        function visit(p) {
            const s = fs.lstatSync(p);
            if (!s.isFile() && !s.isDirectory()) throw Error('unexpected archive output type');
            allocated += s.blocks * 512;
            if (s.isDirectory()) for (const n of fs.readdirSync(p)) visit(path.join(p, n));
        }
        if (runRoot) visit(runRoot);
        return allocated;
    }
    function guard(initial = false) {
        requireHeavyLock();
        const stat = fs.statfsSync(repository, { bigint: true });
        const diskAvailable = stat.bavail * stat.bsize;
        const m = /^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
        const memoryAvailable = m ? Number(m[1]) * 1024 : 0;
        const allocated = outputAllocated();
        const required = diskFloor + BigInt(initial ? totalOutputReserve : Math.max(0, totalOutputReserve - allocated));
        if (memoryAvailable < memoryFloor || diskAvailable < required || allocated > totalOutputReserve ||
                (archive && fs.existsSync(archive) && fs.lstatSync(archive).size > archiveBound)) {
            const e = Error('archive resource floor/reserve refusal');
            e.resourceObservation = { memoryAvailable, memoryRequired: memoryFloor, diskAvailable: String(diskAvailable), diskRequired: String(required), allocated, totalOutputReserve };
            throw e;
        }
        return { memoryAvailable, diskAvailable: String(diskAvailable), diskRequired: String(required), allocated };
    }
    function inventory(root) {
        if (fs.realpathSync(root) !== root) throw Error('root canonical refusal');
        const rootStat = fs.lstatSync(root, { bigint: true }), entries = [];
        let bytes = 0, allocated = 0;
        function visit(relative) {
            const file = path.join(root, relative), s = fs.lstatSync(file, { bigint: true });
            if (entries.length >= plan.budgets.maxEntries || s.dev !== rootStat.dev || s.uid !== ownerUid || s.gid !== ownerGid ||
                    (!s.isFile() && !s.isDirectory())) throw Error('archive roster owner/type/device refusal');
            allocated += Number(s.blocks) * 512;
            const row = { relative, type: s.isDirectory() ? 'directory' : 'file', ...epoch(s) };
            if (s.isFile()) {
                if (s.nlink !== 1n || (bytes += Number(s.size)) > restoreBound) throw Error('archive file/link/bytes refusal');
                row.sha256 = hashFile(file, restoreBound);
            }
            entries.push(row);
            if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
            equal(epoch(s), epoch(fs.lstatSync(file, { bigint: true })), 'archive inventory path drift');
        }
        visit('.');
        if (allocated > restoreBound) throw Error('archive allocation bound refusal');
        // Read all native extended attributes by nofollow FD, including raw POSIX ACL attributes.
        const python = `import os,sys,json,base64\nrequest=json.load(sys.stdin)\nout=[];total=0\nfor row in request:\n p=row['path'];s=os.lstat(p)\n fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_DIRECTORY if row['type']=='directory' else 0))\n primary=None\n try:\n  def identity(t):return [t.st_dev,t.st_ino,t.st_mode,t.st_uid,t.st_gid,t.st_nlink,t.st_size,t.st_mtime_ns,t.st_ctime_ns]\n  if identity(s)!=identity(os.fstat(fd)):raise RuntimeError('extended metadata FD mismatch')\n  attrs={}\n  for name in sorted(os.listxattr(fd)):\n   value=os.getxattr(fd,name);total+=len(value)+len(name)\n   if len(value)>65536 or total>1048576:raise RuntimeError('extended metadata bound')\n   attrs[name]=base64.b64encode(value).decode('ascii')\n  if identity(s)!=identity(os.fstat(fd)) or identity(s)!=identity(os.lstat(p)):raise RuntimeError('extended metadata drift')\n  out.append({'relative':row['relative'],'xattrs':attrs})\n except BaseException as e:primary=e\n try:os.close(fd)\n except BaseException as e:\n  if primary is None:primary=e\n if primary is not None:raise primary\njson.dump(out,sys.stdout,separators=(',',':'))\n`;
        guard();
        const r = spawnSync('/usr/bin/python3', ['-I', '-c', python], { input: JSON.stringify(entries.map(x => ({ path: path.join(root, x.relative), relative: x.relative, type: x.type }))),
            encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1' } });
        if (r.error || r.status !== 0 || r.signal) throw Error(`extended metadata observation failed: ${r.error?.message ?? r.stderr}`);
        const attrs = JSON.parse(r.stdout);
        if (attrs.length !== entries.length) throw Error('extended metadata roster mismatch');
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].relative !== attrs[i].relative) throw Error('extended metadata order mismatch');
            entries[i].xattrs = attrs[i].xattrs;
            equal(epoch(fs.lstatSync(path.join(root, entries[i].relative), { bigint: true })),
                Object.fromEntries(Object.keys(epoch(rootStat)).map(k => [k, entries[i][k]])), 'inventory changed during metadata observation');
        }
        return { bytes, allocated, entries };
    }
    function semantic(roster) {
        return roster.entries.map(({ relative, type, mode, uid, gid, nlink, mtimeNs, size, sha256, xattrs }) =>
            ({ relative, type, mode, uid, gid, nlink, mtimeNs, xattrs, ...(type === 'file' ? { size, sha256 } : {}) }));
    }
    function write(file, data) { fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
    function stopChild(signal = 'SIGTERM') {
        if (!currentChild?.pid) return;
        try { process.kill(-currentChild.pid, signal); } catch (e) { if (e.code !== 'ESRCH') fail(e); }
    }
    const signalHandlers = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => { signals.push(signal); fail(Error(`archive operator ${signal}`)); stopChild(signal); }]));
    async function command(argv, name) {
        guard();
        const child = spawn(argv[0], argv.slice(1), { detached: true, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        currentChild = child;
        const record = { argv, pid: child.pid ?? null, started: Number.isSafeInteger(child.pid), terminal: false, wholeTreeZero: 'UNKNOWN' };
        commands.push(record);
        const streams = ['stdout', 'stderr'].map(n => fs.createWriteStream(`${runRoot}/${name}.${n}`, { flags: 'wx', mode: 0o600 }));
        child.stdout.pipe(streams[0]); child.stderr.pipe(streams[1]);
        let primary, killTimer;
        function stop(e) { primary ??= e; stopChild(); killTimer ??= setTimeout(() => stopChild('SIGKILL'), 1000); }
        for (const s of streams) s.on('error', stop);
        const interval = setInterval(() => { try {
            guard(); if (firstFailure) throw firstFailure;
            for (const n of ['stdout', 'stderr']) if (fs.statSync(`${runRoot}/${name}.${n}`).size > 4 * 1024 * 1024) throw Error('archive log bound');
        } catch (e) { stop(e); } }, 250);
        const deadline = setTimeout(() => stop(Error('archive operational command deadline')), 120000);
        const closed = await new Promise(resolve => {
            child.once('error', e => { primary ??= e; });
            child.once('close', (code, signal) => resolve({ code, signal }));
        });
        clearInterval(interval); clearTimeout(deadline); clearTimeout(killTimer);
        currentChild = null;
        await Promise.all(streams.map(s => new Promise(resolve => {
            if (s.closed || s.writableFinished) { resolve(); return; }
            s.once('close', resolve); s.once('finish', resolve); if (!s.destroyed) s.end();
        })));
        Object.assign(record, closed, { terminal: true, failure: primary ? errorData(primary) : null,
            cleanupObligation: 'Direct child/pipe terminal only; descendant cleanup not physically proven. No retirement authority.' });
        write(`${runRoot}/${name}.actual.json`, record);
        if (primary) throw primary;
        if (closed.code !== 0 || closed.signal) throw Error(`archive ${name} exited ${closed.code}/${closed.signal}`);
    }
    let before;
    try {
        requireCanonicalOwnedPath(original, { directory: true });
        const s = fs.lstatSync(original, { bigint: true });
        equal(epoch(s), plan.expectedRoot, 'artifact current root identity refusal');
        if (hashFile(terminal, 1024 * 1024) !== terminalSha) throw Error('bound terminal changed');
        before = inventory(original);
        if (plan.originalInventorySha256 !== null && hash(Buffer.from(JSON.stringify(before))) !== plan.originalInventorySha256) throw Error('bound artifact inventory changed');
        if (mode === 'inspect') return { original, planSha256, inventorySha256: hash(Buffer.from(JSON.stringify(before))), inventory: before, originalsRetained: true, retirementAuthorized: false, qualificationEligible: false };
        if (mode !== 'archive' || plan.originalInventorySha256 === null) throw Error('explicit archive mode with frozen inventory required');
        for (const [signal, handler] of signalHandlers) process.on(signal, handler);
        guard(true);
        runRoot = fs.mkdtempSync(`${repository}/compiled-preservation-`); fs.chmodSync(runRoot, 0o700);
        before = inventory(original); write(`${runRoot}/before.json`, before);
        archive = `${runRoot}/compiled-artifacts.tar`;
        await command(['/usr/bin/tar', '--format=posix', '--acls', '--xattrs', '--xattrs-include=*', '--numeric-owner', '--sort=name',
            '-cf', archive, '-C', original, '.'], 'archive');
        fs.chmodSync(archive, 0o600);
        equal(before, inventory(original), 'original changed during archive; originals retained');
        restoreRoot = `${runRoot}/restore-verification`; fs.mkdirSync(restoreRoot, { mode: 0o700 });
        await command(['/usr/bin/tar', '--acls', '--xattrs', '--xattrs-include=*', '--numeric-owner', '--same-owner', '--same-permissions',
            '-xf', archive, '-C', restoreRoot], 'restore');
        const restored = inventory(restoreRoot); write(`${runRoot}/restored.json`, restored);
        equal(semantic(before), semantic(restored), 'full archive roundtrip file SHA/root modes/uidgid/mtime/nlink/ACL/xattr mismatch');
        const after = inventory(original); write(`${runRoot}/after.json`, after);
        equal(before, after, 'original drift after roundtrip; originals retained');
        if (firstFailure) throw firstFailure;
        write(`${runRoot}/preservation.actual.json`, { original, planSha256, terminalSha, archive, archiveSha256: hashFile(archive, archiveBound), archiveBytes: fs.statSync(archive).size,
            beforeSha256: hash(fs.readFileSync(`${runRoot}/before.json`)), restoredSha256: hash(fs.readFileSync(`${runRoot}/restored.json`)), afterSha256: hash(fs.readFileSync(`${runRoot}/after.json`)),
            fullRoundtripBytesRootModeOwnerMtimeAclXattrVerified: true, restoreRoot, restoreCopyRetained: true, originalsRetained: true,
            resources: guard(), archiveBound, restoreBound, totalOutputReserve, commands, signals,
            futureRetirementBlockedByUnreadableActivityUnknown: true, retirementAuthorized: false, qualificationEligible: false, sdkCalls: 0, ciCalls: 0 });
        return JSON.parse(fs.readFileSync(`${runRoot}/preservation.actual.json`, 'utf8'));
    } catch (e) {
        fail(e);
        const failure = { original, runRoot: runRoot ?? null, firstFailure: errorData(firstFailure), closeFailures: firstFailure.archiveCloseFailures ?? [],
            resourceObservation: firstFailure.resourceObservation ?? null, commands, signals, originalsRetained: true,
            archiveAndRestoreRetainedIfCreated: true, wholeProcessTreeZero: 'UNKNOWN', retirementAuthorized: false, qualificationEligible: false };
        if (runRoot) { try { write(`${runRoot}/preservation.FAILED.json`, failure); } catch (secondary) { failure.failureWriteSecondary = errorData(secondary); } }
        firstFailure.preservationFailure = failure;
        throw firstFailure;
    } finally {
        for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    }
}


export function validateArchivePlan(plan) {
    requireSourceClosure(plan.sourceInputs, [fileURLToPath(import.meta.url), fileURLToPath(new URL('./local-task-plan.mjs', import.meta.url))]);
    const keys = ['diskFloorBytes', 'memoryFloorBytes', 'archiveBytes', 'restoreBytes', 'metadataBytes', 'maxEntries'];
    if (!plan.budgets || Object.keys(plan.budgets).length !== keys.length || keys.some(key => !Number.isSafeInteger(plan.budgets[key]) || plan.budgets[key] < 1)) throw Error('closed archive budgets required');
    if (!/^[a-f0-9]{64}$/.test(plan.terminalSha256) || !(plan.originalInventorySha256 === null || /^[a-f0-9]{64}$/.test(plan.originalInventorySha256))) throw Error('bound archive source digests required');
    requireCanonicalOwnedPath(plan.taskRoot, { directory: true });
    requireCanonicalOwnedPath(plan.original, { directory: true });
    requireCanonicalOwnedPath(plan.terminal);
    requireCanonicalOwnedPath(plan.taskLock, { insideRoot: plan.taskRoot });
    requireInside(plan.taskRoot, plan.original);
    requireInside(plan.taskRoot, plan.terminal);
    if (plan.original === plan.taskRoot || !plan.expectedRoot || Object.keys(plan.expectedRoot).sort().join(',') !== 'ctimeNs,dev,gid,ino,mode,mtimeNs,nlink,size,uid') throw Error('closed artifact epoch required');
    for (const value of Object.values(plan.expectedRoot)) if (!(typeof value === 'string' && /^[0-9]+$/.test(value) || Number.isSafeInteger(value) && value >= 0)) throw Error('artifact epoch numeric string required');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parsePlanCli(process.argv.slice(2), ['archive']);
        const { plan, planSha256 } = readFrozenPlan(options.planPath, options.planSha256, ['sourceInputs', 'original', 'terminal', 'terminalSha256', 'taskLock', 'budgets', 'expectedRoot', 'originalInventorySha256']);
        validateArchivePlan(plan);
        console.log(JSON.stringify(await preserveCompiledArtifacts(plan, planSha256, options.mode)));
    } catch (error) {
        console.error(JSON.stringify(error.preservationFailure ?? { firstFailure: error.message }));
        process.exitCode = 1;
    }
}
