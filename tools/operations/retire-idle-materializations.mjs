import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parsePlanCli, readFrozenPlan, requireCanonicalOwnedPath, requireInside, requireHeldTaskLock, requireSourceClosure, readRegular } from './local-task-plan.mjs';

// The only mutation is ordinary worktree-local Git sparse projection.
export function retireIdleMaterializations(plan, planSha256, mode = 'inspect') {
    const repository = plan.repository;
    const soleLock = plan.taskLock;
    const ownerUid = String(process.getuid());
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const common = fs.realpathSync(path.resolve(repository, git(repository, ['rev-parse', '--git-common-dir']).trim()));
    const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    function equal(a, b, reason) { if (!isDeepStrictEqual(a, b)) throw new Error(reason); }
    function epoch(s) { return { dev: String(s.dev), ino: String(s.ino), mode: Number(s.mode & 0o7777n), uid: Number(s.uid), gid: Number(s.gid), nlink: Number(s.nlink), bytes: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) }; }
    function regular(file, limit = 64 * 1024 * 1024) {
        const before = fs.lstatSync(file, { bigint: true });
        if (!before.isFile() || before.size > BigInt(limit)) throw new Error(`regular bound: ${file}`);
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let primaryError;
        let primaryFailed = false;
        try {
            equal(epoch(before), epoch(fs.fstatSync(fd, { bigint: true })), `FD identity: ${file}`);
            const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
            let n, readBytes = 0;
            while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
                if ((readBytes += n) > limit) throw new Error('retirement live read bound refused');
                digest.update(buffer.subarray(0, n));
            }
            equal(epoch(before), epoch(fs.fstatSync(fd, { bigint: true })), `FD changed: ${file}`);
            equal(epoch(before), epoch(fs.lstatSync(file, { bigint: true })), `path changed: ${file}`);
            return { ...epoch(before), sha256: digest.digest('hex') };
        } catch (error) {
            primaryFailed = true;
            primaryError = error;
            throw error;
        } finally {
            try { fs.closeSync(fd); }
            catch (closeError) {
                if (!primaryFailed) throw closeError;
                // Preserve the exact primary thrown value; never replace it with close failure.
                try { console.error(JSON.stringify({ phase: 'regular.close-secondary', file, primary: primaryError?.message ?? String(primaryError), secondary: { code: closeError.code ?? null, message: closeError.message } })); } catch { /* diagnostic failure cannot replace the primary */ }
            }
        }
    }
    function optional(file, body = false) {
        try { return { record: regular(file), ...(body ? { body: fs.readFileSync(file, 'utf8') } : {}) }; }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    function command(executable, args, input) {
        const r = spawnSync(executable, args, { env, input, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
        if (r.error || r.status !== 0 || r.signal) throw new Error(`${executable}: ${r.stderr || r.error?.message || r.signal}`);
        return r.stdout;
    }
    function git(root, args, input) { return command('/usr/bin/git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], input); }
    function sharedState() {
        return { refs: git(repository, ['for-each-ref', '--format=%(refname) %(objectname)']), head: git(repository, ['rev-parse', 'HEAD']).trim(), status: git(repository, ['status', '--porcelain=v1', '--untracked-files=normal']), commonConfig: regular(`${common}/config`), primaryIndex: regular(`${common}/index`), primaryConfig: optional(`${common}/config.worktree`, true), primarySparse: optional(`${common}/info/sparse-checkout`, true) };
    }
    function state(target) {
        return { head: git(target.root, ['rev-parse', 'HEAD']).trim(), tree: git(target.root, ['rev-parse', 'HEAD^{tree}']).trim(), branch: git(target.root, ['symbolic-ref', '-q', 'HEAD']).trim(), status: git(target.root, ['status', '--porcelain=v1', '--untracked-files=all']), admin: git(target.root, ['rev-parse', '--absolute-git-dir']).trim(), common: fs.realpathSync(path.resolve(target.root, git(target.root, ['rev-parse', '--git-common-dir']).trim())), stage: hash(git(target.root, ['ls-files', '--stage', '-z'])) };
    }
    function adminState(target) {
        return { dotGit: regular(`${target.root}/.git`), HEAD: regular(`${target.admin}/HEAD`), gitdir: regular(`${target.admin}/gitdir`), index: regular(`${target.admin}/index`), config: optional(`${target.admin}/config.worktree`, true), patterns: optional(`${target.admin}/info/sparse-checkout`, true) };
    }
    function requireSoleLock() { if (mode === 'sparse') requireHeldTaskLock(soleLock); }
    function activities(targets) {
        // Scope is readable current-owner UID /proc FD/cwd/argv only, never global absence proof.
        const matches = [], unknown = [];
        const contains = (value, root) => value.includes(root) || value.includes(path.dirname(root) + '/source');
        for (const name of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
            const pid = Number(name);
            if (pid === process.pid) continue;
            let status;
            try { status = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); }
            catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unknown.push({ pid, source: 'UID status', error: error.code }); continue; }
            const uid = /^Uid:\s+(\d+)\s+(\d+)/m.exec(status);
            if (!uid) { unknown.push({ pid, source: 'UID missing' }); continue; }
            if (uid[1] !== ownerUid && uid[2] !== ownerUid) continue;
            try {
                const cwd = fs.readlinkSync(`/proc/${pid}/cwd`), argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
                const descriptors = fs.readdirSync(`/proc/${pid}/fd`);
                const hits = new Set(targets.filter(t => contains(cwd, t.root) || contains(argv, t.root)).map(t => t.root));
                for (const descriptor of descriptors) {
                    let link;
                    try { link = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`); }
                    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
                    for (const target of targets) if (contains(link, target.root)) hits.add(target.root);
                }
                for (const root of hits) matches.push({ pid, root, activity: 'readable current-owner UID FD/cwd/argv reference' });
            } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unknown.push({ pid, source: 'current-owner FD/cwd/argv', error: error.code }); }
        }
        return { scope: 'readable current-owner UID FD/cwd/argv at this instant; not globally no activity', matches, unknown };
    }
    function inventory(target, keep, tracked) {
        const files = [], missing = [], present = [];
        for (const relative of tracked) {
            const file = `${target.root}/${relative}`;
            if (!fs.existsSync(file)) { missing.push(relative); continue; }
            present.push(relative);
            if (keep.has(relative)) files.push({ relative, record: regular(file) });
        }
        const ignored = [], roots = git(target.root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).split('\0').filter(Boolean);
        const device = fs.lstatSync(target.root, { bigint: true }).dev;
        function visit(relative) {
            if (ignored.length >= 20000 || path.posix.normalize(relative) !== relative || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('ignored path/roster bound');
            const file = `${target.root}/${relative}`, s = fs.lstatSync(file, { bigint: true });
            if (s.dev !== device) throw new Error(`ignored mount requires separate ownership: ${relative}`);
            if (s.isFile()) ignored.push({ relative, kind: 'file', record: regular(file) });
            else if (s.isSymbolicLink()) ignored.push({ relative, kind: 'symlink', record: { ...epoch(s), sha256: hash(fs.readlinkSync(file)) } });
            else if (s.isDirectory()) {
                const before = epoch(s);
                ignored.push({ relative, kind: 'directory', record: before });
                for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`);
                equal(epoch(fs.lstatSync(file, { bigint: true })), before, 'ignored directory changed');
            } else throw new Error(`ignored special file: ${relative}`);
        }
        for (const relative of roots) visit(relative.replace(/\/$/, ''));
        return { files, ignored, missing, present };
    }
    function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }

    validateRetirementPlan(plan);
    requireSoleLock();
    if (fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== plan.expectedBootId) throw new Error('current boot CAS changed');
    for (const source of plan.sources) if (readRegular(source.path, 1024 * 1024).sha256 !== source.sha256) throw new Error('current ownership report digest changed');
    if (mode === 'inspect') return { planSha256, currentShared: sharedState(), targets: plan.targets.map(target => ({ target, current: state(target) })), activity: activities(plan.targets), mutationAuthorized: false, qualificationEligible: false };
    if (mode !== 'sparse') throw new Error('explicit sparse mode required');
    const runRoot = fs.mkdtempSync(`${plan.taskRoot}/idle-materialization-projection-`);
    fs.chmodSync(runRoot, 0o700);
    const originalShared = sharedState(), results = [];
    let mutationStarted = false;
    try {
        for (let index = 0; index < plan.targets.length; index++) {
            const target = plan.targets[index], prefix = `${runRoot}/${String(index + 1).padStart(2, '0')}`;
            let before, keep, patterns, phase = 'preflight';
            try {
                requireSoleLock();
                equal(sharedState(), originalShared, 'common/primary Git epoch changed');
                const activity = activities(plan.targets);
                if (activity.unknown.length || activity.matches.some(m => m.root === target.root)) {
                    results.push({ root: target.root, status: 'REFUSED_ACTIVITY_OR_UNKNOWN', activity });
                    continue;
                }
                const current = state(target);
                if (current.head !== target.head || current.branch !== target.ref || current.admin !== target.admin || current.common !== common || current.status !== '' || git(target.root, ['config', '--local', '--get', 'extensions.worktreeConfig']).trim() !== 'true') throw new Error('HEAD/clean/common/WT-only config binding');
                const tracked = git(target.root, ['ls-files', '-z']).split('\0').filter(Boolean);
                const diff = git(target.root, ['diff', '--name-only', '-z', `${plan.base}..${target.head}`]).split('\0').filter(Boolean);
                equal(diff, target.diffPaths, 'original owner diff roster changed');
                keep = new Set([...diff, ...tracked.filter(p => !p.includes('/') || /(^|\/)(packages\.lock|package-lock)\.json$/.test(p)), 'tests/matrix.yml', 'tests/backend/Fixtures/backend-evidence-path-authority.generated.json', ...target.preservedPaths]);
                const beforeInventory = inventory(target, keep, tracked), existing = new Set(beforeInventory.present);
                for (const relative of target.preservedPaths) if (!existing.has(relative)) throw new Error(`original physical keeper now missing: ${relative}`);
                // A missing keeper remains absent, never introduced by a broad new include.
                patterns = beforeInventory.files.map(x => {
                    if (!/^[A-Za-z0-9._/-]+$/.test(x.relative)) throw new Error('literal noncone keeper grammar');
                    return `/${x.relative}`;
                });
                if (!patterns.length) throw new Error('no existing source keepers');
                const skipRows = git(target.root, ['ls-files', '-v', '-z']).split('\0').filter(Boolean);
                for (const row of skipRows) if ((row[0].toUpperCase() === 'S' || row[0] !== row[0].toUpperCase()) && existing.has(row.slice(2)) && !keep.has(row.slice(2))) throw new Error('existing skipped/assume-unchanged payload needs independent dirty check');
                before = { state: current, admin: adminState(target), inventory: beforeInventory, keepPaths: [...keep], patterns, activity, shared: originalShared, originalPlanSha256: planSha256 };
                write(`${prefix}.before.json`, before);
                const fresh = activities(plan.targets);
                if (fresh.unknown.length || fresh.matches.some(m => m.root === target.root)) throw new Error('new activity or permission UNKNOWN before sparse');
                equal(state(target), current, 'source changed during preparation');
                equal(sharedState(), originalShared, 'shared Git changed during preparation');
                phase = 'normal WT-local Git sparse';
                const argv = ['-C', target.root, '-c', 'core.fsmonitor=false', 'sparse-checkout', 'set', '--no-cone', '--no-sparse-index', '--stdin'];
                mutationStarted = true;
                const actual = spawnSync('/usr/bin/git', argv, { env, input: `${patterns.join('\n')}\n`, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60000 });
                write(`${prefix}.git.json`, { executable: '/usr/bin/git', argv, stdin: patterns.join('\n') + '\n', status: actual.status, signal: actual.signal, error: actual.error?.message ?? null, stdout: actual.stdout, stderr: actual.stderr });
                if (actual.error || actual.status !== 0 || actual.signal) throw new Error(`Git sparse failed: ${actual.error?.message || actual.stderr || actual.signal}`);
                phase = 'postconditions';
                const afterState = state(target), afterInventory = inventory(target, keep, tracked), afterAdmin = adminState(target);
                equal(afterState, current, 'HEAD/tree/stage/status/common/admin changed');
                equal(sharedState(), originalShared, 'primary/common config/index changed');
                equal(afterInventory.files, beforeInventory.files, 'retained tracked SHA/mode/inode/mtime/ctime changed');
                equal(afterInventory.ignored, beforeInventory.ignored, 'ignored physical/raw/dependency epoch changed');
                const absent = new Set(afterInventory.missing);
                for (const relative of beforeInventory.missing) if (!absent.has(relative)) throw new Error(`previously missing path silently materialized: ${relative}`);
                for (const key of ['dotGit', 'HEAD', 'gitdir']) equal(afterAdmin[key], before.admin[key], `administrative identity changed: ${key}`);
                equal(afterAdmin.patterns.body, patterns.join('\n') + '\n', 'actual noncone patterns');
                if (git(target.root, ['config', '--worktree', '--get', 'core.sparseCheckout']).trim() !== 'true' || git(target.root, ['config', '--worktree', '--get', 'core.sparseCheckoutCone']).trim() !== 'false') throw new Error('sparse not WT-local noncone');
                write(`${prefix}.after.json`, { state: afterState, admin: afterAdmin, inventory: afterInventory, shared: originalShared, fullInactivePhysicalEpochRetired: true, qualificationEligible: false, restore: 'At same exact HEAD restore saved original WT config/pattern with normal Git sparse-checkout set or disable; verify bytes and new physical inputclosure before admission/tests.' });
                results.push({ root: target.root, head: current.head, status: 'PROJECTED_STORAGE_ONLY', before: `${prefix}.before.json`, after: `${prefix}.after.json`, qualificationEligible: false });
                mutationStarted = false;
            } catch (error) {
                write(`${prefix}.failure.json`, { root: target.root, phase, firstFailure: error.message, mutationStarted, automaticRollback: false });
                results.push({ root: target.root, status: mutationStarted ? 'STOPPED_POST_MUTATION_FAILURE' : 'REFUSED_PREFLIGHT', phase, firstFailure: error.message });
                if (mutationStarted) throw error;
            }
        }
        write(`${runRoot}/summary.json`, { results, qualificationEligible: false, SDK: false, test: false, CI: false, globalNoActivityClaim: false, planSha256, sharedAfter: sharedState() });
        return { runRoot, projected: results.filter(r => r.status === 'PROJECTED_STORAGE_ONLY').length, refused: results.filter(r => r.status.startsWith('REFUSED')).length, qualificationEligible: false };
    } catch (error) {
        write(`${runRoot}/failure.json`, { results, firstFailure: error.message, mutationStarted, qualificationEligible: false, automaticRollback: false });
        error.projectionFailure = { runRoot, firstFailure: error.message, mutationStarted };
        throw error;
    }
}


export function validateRetirementPlan(plan) {
    requireSourceClosure(plan.sourceInputs, [fileURLToPath(import.meta.url), fileURLToPath(new URL('./local-task-plan.mjs', import.meta.url))]);
    requireCanonicalOwnedPath(plan.taskRoot, { directory: true });
    requireCanonicalOwnedPath(plan.repository, { directory: true, insideRoot: plan.taskRoot });
    requireCanonicalOwnedPath(plan.taskLock, { insideRoot: plan.taskRoot });
    if (!/^[a-f0-9]{40}$/.test(plan.base) || !/^[a-f0-9-]{36}$/.test(plan.expectedBootId) || !Array.isArray(plan.targets) || !plan.targets.length || plan.targets.length > 128 || new Set(plan.targets.map(target => target.root)).size !== plan.targets.length || !Array.isArray(plan.protected) || !plan.protected.includes(plan.repository) || !Array.isArray(plan.sources) || !plan.sources.length) throw new Error('closed reviewed retirement scope required');
    for (const source of plan.sources) {
        if (Object.keys(source).sort().join(',') !== 'path,sha256' || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('closed ownership source binding required');
        requireCanonicalOwnedPath(source.path, { insideRoot: plan.taskRoot });
    }
    for (const target of plan.targets) {
        if (Object.keys(target).sort().join(',') !== 'admin,diffPaths,head,preservedPaths,ref,root' || !/^[a-f0-9]{40}$/.test(target.head) || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(target.ref)) throw new Error('closed current target CAS required');
        requireCanonicalOwnedPath(target.root, { directory: true, insideRoot: plan.taskRoot });
        requireCanonicalOwnedPath(target.admin, { directory: true, insideRoot: plan.taskRoot });
        if (plan.protected.some(value => target.root === value || target.root.startsWith(value + '/') || value.startsWith(target.root + '/'))) throw new Error('protected resource overlap refused');
        for (const values of [target.diffPaths, target.preservedPaths]) {
            if (!Array.isArray(values) || new Set(values).size !== values.length || values.some(value => typeof value !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(value) || value.split('/').some(part => part === '..' || part === '.' || !part))) throw new Error('literal target path roster required');
        }
    }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const options = parsePlanCli(process.argv.slice(2), ['sparse']);
        const { plan, planSha256 } = readFrozenPlan(options.planPath, options.planSha256, ['sourceInputs', 'repository', 'taskLock', 'base', 'expectedBootId', 'targets', 'protected', 'sources']);
        console.log(JSON.stringify(retireIdleMaterializations(plan, planSha256, options.mode)));
    } catch (error) {
        console.error(JSON.stringify(error.projectionFailure ?? { firstFailure: error.message }));
        process.exitCode = 1;
    }
}
