import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

// Root-reviewed task-only SOURCE. The sole mutation is ordinary WT-local Git sparse.
const repository = '/home/lyuaoss/projects/FsusBlog';
const common = `${repository}/.git`;
const soleLock = `${repository}/.tmp/governance/resource-control-20261001.heavy.lock`;
const planPath = new URL('./targets.json', import.meta.url);
const planSha256 = '4a35045a39731115a7349cc72cf735f6de96d8b0c9c94fe68ed85d589884be6a';
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
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
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, n));
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
  return { head: git(repository, ['rev-parse', 'HEAD']).trim(), status: git(repository, ['status', '--porcelain=v1', '--untracked-files=normal']), commonConfig: regular(`${common}/config`), primaryIndex: regular(`${common}/index`), primaryConfig: optional(`${common}/config.worktree`, true), primarySparse: optional(`${common}/info/sparse-checkout`, true) };
}
function state(target) {
  return { head: git(target.root, ['rev-parse', 'HEAD']).trim(), tree: git(target.root, ['rev-parse', 'HEAD^{tree}']).trim(), status: git(target.root, ['status', '--porcelain=v1', '--untracked-files=all']), admin: git(target.root, ['rev-parse', '--absolute-git-dir']).trim(), common: fs.realpathSync(path.resolve(target.root, git(target.root, ['rev-parse', '--git-common-dir']).trim())), stage: hash(git(target.root, ['ls-files', '--stage', '-z'])) };
}
function adminState(target) {
  return { dotGit: regular(`${target.root}/.git`), HEAD: regular(`${target.admin}/HEAD`), gitdir: regular(`${target.admin}/gitdir`), index: regular(`${target.admin}/index`), config: optional(`${target.admin}/config.worktree`, true), patterns: optional(`${target.admin}/info/sparse-checkout`, true) };
}
function requireSoleLock() {
  const parent = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0');
  if (path.basename(parent[0]) !== 'flock' || !parent.includes(soleLock)) throw new Error('direct root sole-flock parent required');
  const s = fs.lstatSync(soleLock, { bigint: true }), d = s.dev;
  if (!s.isFile()) throw new Error('sole lock regular file');
  const major = ((d >> 8n) & 0xfffn) | ((d >> 32n) & 0xfffff000n), minor = (d & 0xffn) | ((d >> 12n) & 0xffffff00n);
  const identity = `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${s.ino}`;
  if (!fs.readFileSync('/proc/locks', 'utf8').split('\n').some(row => {
    const f = row.trim().split(/\s+/);
    return f[1] === 'FLOCK' && f[2] === 'ADVISORY' && f[3] === 'WRITE' && f[4] === String(process.ppid) && f[5] === identity;
  })) throw new Error('root sole flock not held');
}
function activities(targets) {
  // Scope is readable UID1000 /proc FD/cwd/argv only, never global absence proof.
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
    if (uid[1] !== '1000' && uid[2] !== '1000') continue;
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
      for (const root of hits) matches.push({ pid, root, activity: 'readable UID1000 FD/cwd/argv reference' });
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unknown.push({ pid, source: 'UID1000 FD/cwd/argv', error: error.code }); }
  }
  return { scope: 'readable UID1000 FD/cwd/argv at this instant; not globally no activity', matches, unknown };
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

if (process.argv.length !== 3 || process.argv[2] !== '--execute-reviewed-sparse') throw new Error('SOURCE only until root reviewed execution');
if (process.getuid() !== 1000) throw new Error('root-task UID1000');
requireSoleLock();
const planBytes = fs.readFileSync(planPath), plan = JSON.parse(planBytes);
if (hash(planBytes) !== planSha256) throw new Error('fixed reviewed target plan digest');
if (plan.targets.length !== 25 || new Set(plan.targets.map(t => t.root)).size !== 25) throw new Error('fixed25 roots');
for (const source of plan.sources) if (hash(fs.readFileSync(source.path)) !== source.sha256) throw new Error('fixed original report digest');
for (const target of plan.targets) {
  if (!/^\/dev\/shm\/fsusblog-[A-Za-z0-9._-]+\/source$/.test(target.root) || fs.realpathSync(target.root) !== target.root || !target.admin.startsWith(`${common}/worktrees/`) || plan.protected.some(p => target.root === p || target.root.startsWith(p + '/') || p.startsWith(target.root + '/'))) throw new Error('target/protected/admin identity');
}
const runRoot = fs.mkdtempSync('/dev/shm/fsusblog-idle-ram-sparse-actual-');
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
      if (current.head !== target.head || current.admin !== target.admin || current.common !== common || current.status !== '' || git(target.root, ['config', '--local', '--get', 'extensions.worktreeConfig']).trim() !== 'true') throw new Error('HEAD/clean/common/WT-only config binding');
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
      before = { state: current, admin: adminState(target), inventory: beforeInventory, keepPaths: [...keep], patterns, activity, shared: originalShared, originalPlanSha256: hash(planBytes) };
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
  write(`${runRoot}/summary.json`, { results, qualificationEligible: false, SDK: false, test: false, CI: false, globalNoActivityClaim: false, sourcePlan: String(planPath), sharedAfter: sharedState() });
  console.log(JSON.stringify({ runRoot, projected: results.filter(r => r.status === 'PROJECTED_STORAGE_ONLY').length, refused: results.filter(r => r.status.startsWith('REFUSED')).length, qualificationEligible: false }));
} catch (error) {
  write(`${runRoot}/failure.json`, { results, firstFailure: error.message, mutationStarted, qualificationEligible: false, automaticRollback: false });
  console.error(JSON.stringify({ runRoot, firstFailure: error.message }));
  process.exitCode = 1;
}
