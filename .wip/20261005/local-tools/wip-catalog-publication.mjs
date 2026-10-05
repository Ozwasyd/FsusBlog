import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = '/home/lyuaoss/projects/FsusBlog';
const OUT = `${ROOT}/.tmp/governance/wip-publication-20261005`;
const CATALOG = 'wip-local/handoff-catalog-20261005';
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
const git = (args, input, encoding = 'utf8', extraEnv = {}) => execFileSync('git', ['-C', ROOT, ...args], { env: { ...env, ...extraEnv }, input, encoding, maxBuffer: 48 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = name => JSON.parse(fs.readFileSync(`${OUT}/${name}`, 'utf8'));
const apply = (file, content) => {
  if (fs.existsSync(file)) throw new Error('refuse overwriting prior catalog artifacts');
  execFileSync('apply_patch', [], { cwd: ROOT, encoding: 'utf8', input: `*** Begin Patch\n*** Add File: ${file}\n${content.split('\n').map(l => '+' + l).join('\n')}\n*** End Patch\n`, maxBuffer: 1024 * 1024 });
};
const save = (name, data) => apply(`${OUT}/${name}`, JSON.stringify(data, null, 2) + '\n');
const remote = () => new Map(git(['ls-remote', '--heads', 'origin']).trim().split('\n').filter(Boolean).map(l => { const [sha, ref] = l.split(/\s+/); return [ref, sha]; }));
function checkOriginal(inv) {
  if (git(['rev-parse', 'HEAD']).trim() !== inv.original.head || git(['symbolic-ref', 'HEAD']).trim() !== inv.original.branch || hash(fs.readFileSync(`${ROOT}/.git/index`)) !== inv.original.indexSha256 || git(['status', '--porcelain=v1', '--untracked-files=no']) !== inv.original.status) throw new Error('original root changed');
  for (const b of inv.branches) if (git(['rev-parse', `refs/heads/${b.branch}`]).trim() !== b.sha) throw new Error('original source branch changed');
  if (git(['stash', 'list', '--format=%H']).trim() !== inv.stashes.map(x => x.sha).join('\n')) throw new Error('original stashes changed');
}
const secret = /-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{70,}|AKIA[A-Z0-9]{16}/;

function catalog() {
  const inv = json('inventory.json');
  const prepared = json('prepared.json').prepared.concat(json('dirty-snapshot.json').prepared);
  checkOriginal(inv);
  if (remote().has(`refs/heads/${CATALOG}`)) throw new Error('catalog remote already exists');
  const originals = inv.branches.map(b => ({ branch: b.branch, source: b.sha, tree: b.tree, linkedIssues: b.linkedIssues, backup: prepared.find(p => p.original === b.sha && p.ref.endsWith('/' + b.branch)) }));
  if (originals.some(x => !x.backup)) throw new Error('catalog source mapping incomplete');
  const operations = [
    ['wip-publication.mjs', `${ROOT}/.tmp/governance/publish-wip-preservation-20261005.mjs`],
    ['wip-catalog-publication.mjs', `${ROOT}/.tmp/governance/publish-wip-catalog-20261005.mjs`],
    ['resource-control.md', `${ROOT}/.tmp/governance/resource-control-20261001.md`],
    ['operational-file-leases.py', `${ROOT}/.tmp/governance/probe-operational-file-leases-20261005.py`],
    ['operational-lease-boundaries.py', '/dev/shm/probe-operational-leases-boundaries-owned-20261005.py'],
    ['export-failed-run-evidence.mjs', `${ROOT}/.tmp/governance/export-failed-v11-readonly-evidence-20261005.mjs`],
    ['archive-compiled-artifacts-source.mjs', '/dev/shm/archive-3564-compiled-artifacts-source-20261005.mjs'],
    ['retire-idle-materializations-source.mjs', '/dev/shm/fsusblog-idle-ram-sparse-source-20261005.yIQ1C2/retire-idle-materializations-primary-error.mjs'],
    ['guest-preparation-caller-source.sh', '/dev/shm/fsusblog-debian-preparation-caller-source-20261004.sbMmZy/guest-original-cli-held-mount-selection-v4.sh'],
    ['failed-run-log-recovery-source.mjs', '/dev/shm/c86-task-overlay-launcher-source-20261004.4BLoCR/launch-task-owned-overlay-failed-v11-log-recovery-v12.mjs'],
  ];
  const operationCopies = operations.map(([name, source]) => {
    const s = fs.lstatSync(source, { bigint: true });
    if (!s.isFile() || s.size > 1024n * 1024n || s.uid !== 1000n) throw new Error('operational source outside regular bounded scope');
    const bytes = fs.readFileSync(source);
    if (secret.test(bytes.toString('utf8'))) throw new Error(`operational source requires credential review: ${name}`);
    const after = fs.lstatSync(source, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs']) if (s[key] !== after[key]) throw new Error('operational source changed during read');
    return { name, target: `.wip/20261005/local-tools/${name}`, sha256: hash(bytes), bytes };
  });
  const manifest = {
    schema: 'fsusblog.wip-handoff-catalog.v1', createdAt: new Date().toISOString(),
    status: 'historical-backup-not-acceptance', originalMaster: inv.remote.find(x => x.ref === 'refs/heads/master').sha,
    sourceBranches: originals, preservedSourceCommits: inv.unpublishedCommits,
    stashes: inv.stashes.map(x => ({ sha: x.sha, subject: x.subject, parents: x.parents, backup: prepared.find(p => p.original === x.sha) })),
    uncommitted: json('dirty-snapshot.json'),
    localOperationalSources: operationCopies.map(({ bytes, ...x }) => x),
    audits: { objects: json('safety-audit.json').objects, paths: json('complete-path-audit.json').checkedPaths, rootsPresent: 422, rootsMissing: 74, trackedDirtyRoots: 1, trackedDirtyFiles: 7, untrackedSourceFiles: 1, dependencySymlinksNotStaged: 5 },
    excluded: ['.qoder', 'credentials and SSH private keys', 'VM disks and COW images', 'full raw logs, traces and acceptance/recovery archives', 'shared caches and dependency symlinks', 'unlisted ignored operational prototypes'],
    acceptance: { testsRunThisBackup: false, ciRun: false, merge: false, issuesClosed: false, trustedBaselinePromoted: false },
    productionGoalStatus: 'blocked; current batch must reach master before completion',
  };
  const listing = originals.map(x => `- \`${x.branch}\` — ${x.linkedIssues.map(i => '#' + i).join(', ') || 'issue待核'} — 原 \`${x.source}\` — [WIP](https://github.com/Ozwasyd/FsusBlog/blob/${x.backup.sha}/.wip/20261005/WIP.md)`).join('\n');
  const readme = `# FsusBlog WIP 备份与接续目录\n\n历史保存，不是当前规范或生产验收结论。不要直接将这些备份分支合入 master。\n\n## 本次保存范围\n\n- 375 个原本地分支（373 个不同 tip），覆盖 868 个当前远端分支不可达的源码提交及其完整父历史。\n- 2 个 stash 的完整父链；原stash未 drop。\n- #2214 唯一脏工作树的 7 个修改与 1 个新增测试，逐文件字节核对；原index/分支/工作树仍保持原状。\n- 10 份选定的本机操作源码，见 [local-tools](local-tools/) 与 [manifest](manifest.json)。这些是历史任务工具，不是生产代码/可信门禁或执行许可。其余 ignored 原型未被全部上传。\n- 422 个现存工作树完成只读核对；74 个缺失物理路径的注册记录仅记录，不 prune；5 个依赖 symlink未 stage。\n\n## 当前批次停靠状态\n\n用户要求完成正在做的批次、确认进入master后停止；不使用CI。\nPR #3664（原head8b4bf659）与 #3666（原head2b4343fb）已在GitHub，但仍draft/unmerged。\n前置 #3652、#3655、#3656 当前源码在本目录的备份分支内。\n原依赖准备曾执行真实SDK restore但未取得完整终态PASS；BehaviorDoc admission、候选测试/native/backend/matrix仍不能视为通过。\n独立SOURCE审不替代原执行绑定与独立实际验收。缺资源和未确认占用仍阻碍当前生产目标，备份动作没有解除或豁免这些门槛。\n不改候选检查器自我放行，不提升可信基线，不合并或关闭issue。\n\n## 恢复与继续\n\n1. 根据下面WIP链接或manifest找到原commit、原tree与备份ref。普通fetch获取对应ref，恢复时从原source commit新建工作分支；不要使用多加了WIP文档的backup head充当旧候选身份。\n2. 每份WIP记录最近原提交、issue线索、merge-base和差异概况；逐项核对issue原验收条件与当前master，不从分支数量推断独立功能数量。\n3. stash可fetch其backup后按原SHA执行stash apply；#2214数据快照保留在manifest的snapshot项，恢复前先检查目标工作区，禁止自动覆盖现有WIP。\n4. generated/fixture/lockfile输出仍由原source+producer治理；当前快照只保存现有字节，没有生成或授予资格。\n5. 补足实际环境、原检查和独立验收后才通过另行PR进入master。所有新备份提交包含[skip ci]；本次没有打开PR或启动/等待CI。\n\n## 不在远端备份范围\n\n.qoder、凭据/SSH私钥、VM/COW恢复盘、完整raw日志/trace/验收档案、共享依赖缓存均仍在本机。\n本次Git备份不意味着可以清空本机；例如失败SDK尝试的恢复盘与原始证据不能由源码重建。\n原本机工作树、分支、stash和忽略材料未删除/重置。\n\n## 原分支 WIP 索引\n\n${listing}\n`;
  const manifestText = JSON.stringify(manifest, null, 2) + '\n';
  if (secret.test(manifestText) || secret.test(readme)) throw new Error('catalog metadata credential marker');
  const documentAttempt = fs.mkdtempSync(`${OUT}/catalog-attempt-`);
  apply(`${documentAttempt}/WIP.md`, readme);
  apply(`${documentAttempt}/manifest.json`, manifestText);
  const files = [{ target: '.wip/20261005/WIP.md', bytes: Buffer.from(readme) }, { target: '.wip/20261005/manifest.json', bytes: Buffer.from(manifestText) }, ...operationCopies];
  const scratch = fs.mkdtempSync(`${OUT}/catalog-index-`);
  const indexEnv = { GIT_INDEX_FILE: `${scratch}/index` };
  const base = manifest.originalMaster;
  git(['-c', 'core.sparseCheckout=false', '-c', 'core.sparseCheckoutCone=false', 'read-tree', '--reset', '-i', base], undefined, 'utf8', indexEnv);
  for (const f of files) {
    if (git(['ls-tree', base, '--', f.target]).trim()) throw new Error('catalog path already exists in base');
    const blob = git(['hash-object', '-w', '--stdin'], f.bytes).trim();
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${f.target}`], undefined, 'utf8', indexEnv);
  }
  const tree = git(['write-tree'], undefined, 'utf8', indexEnv).trim();
  const changed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', `${base}^{tree}`, tree]).trim().split('\n').sort();
  if (JSON.stringify(changed) !== JSON.stringify(files.map(x => x.target).sort())) throw new Error('catalog changed unrelated base paths');
  for (const f of files) if (hash(git(['show', `${tree}:${f.target}`], undefined, null)) !== hash(f.bytes)) throw new Error('catalog copy byte mismatch');
  const sha = git(['commit-tree', tree, '-p', base], 'chore(governance): preserve local wip catalog and sources [skip ci]\n\nHistorical backup only, not merge or acceptance.\n\nRefs: #3663, #3665\n').trim();
  git(['update-ref', `refs/heads/${CATALOG}`, sha, '0000000000000000000000000000000000000000']);
  checkOriginal(inv);
  save('publication-plan.json', { createdAt: new Date().toISOString(), original: inv.original, refs: prepared.concat({ ref: `refs/heads/${CATALOG}`, sha, original: base, handoffPath: '.wip/20261005/WIP.md', catalog: true }), originalSourceCommits: inv.unpublishedCommits, operationalSources: operationCopies.map(({ bytes, ...x }) => x), manifestSha256: hash(Buffer.from(manifestText)), pushed: false });
  console.log(JSON.stringify({ catalog: sha, refs: prepared.length + 1, operationalSources: operationCopies.length, originalPreserved: true }));
}

function push() {
  const plan = json('publication-plan.json');
  const inv = json('inventory.json');
  checkOriginal(inv);
  const mem = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)/m)[1]) * 1024;
  const disk = fs.statfsSync(ROOT, { bigint: true });
  if (mem < 2147483648 || disk.bavail * disk.bsize < 1593835520n) throw new Error('bounded backup resource floor');
  const live = remote();
  for (const p of plan.refs) {
    if (live.has(p.ref) || git(['rev-parse', p.ref]).trim() !== p.sha) throw new Error('backup destination exists or prepared local ref drifted');
    if (!git(['show', '-s', '--format=%B', p.sha]).includes('[skip ci]')) throw new Error('missing push CI skip marker');
  }
  const args = ['-C', ROOT, '-c', 'pack.threads=1', '-c', 'pack.windowMemory=32m', '-c', 'pack.deltaCacheSize=16m', '-c', 'pack.window=5', '-c', 'remote.origin.mirror=false', 'push', '--atomic', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', ...plan.refs.map(p => `--force-with-lease=${p.ref}:`), 'origin', ...plan.refs.map(p => `${p.ref}:${p.ref}`)];
  // Empty expected destination is create-only CAS, never an overwrite permission.
  const result = spawnSync('git', args, { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
  save('push-actual.json', { capturedAt: new Date().toISOString(), status: result.status, signal: result.signal, error: result.error?.message ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '', atomic: true, destinationsRequiredAbsent: true, forcedOverwrite: false });
  if (result.status !== 0 || result.signal || result.error) throw new Error('atomic backup push did not complete; inspect exact actual state before any retry');
  const after = remote();
  const unmatched = plan.refs.filter(p => after.get(p.ref) !== p.sha);
  const changedOriginalRemote = inv.remote.filter(p => p.ref.startsWith('refs/heads/') && after.get(p.ref) !== p.sha);
  if (unmatched.length || changedOriginalRemote.length) throw new Error('remote ref verification mismatch');
  const missingCommits = git(['rev-list', ...plan.originalSourceCommits, '--not', ...plan.refs.map(p => p.sha)]).trim();
  if (missingCommits) throw new Error('original source commit not reachable from published backups');
  checkOriginal(inv);
  const dirty = json('dirty-snapshot.json');
  const sourceWt = '/mnt/dev-cache/lyuaoss/fsusblog-2214-current';
  const sourceGit = a => execFileSync('git', ['-C', sourceWt, ...a], { env, encoding: 'utf8' });
  if (sourceGit(['rev-parse', 'HEAD']).trim() !== dirty.original || hash(fs.readFileSync(sourceGit(['rev-parse', '--git-path', 'index']).trim())) !== dirty.originalIndex) throw new Error('original dirty source changed after push');
  for (const f of dirty.sourceFiles) if (hash(fs.readFileSync(path.join(sourceWt, f.path))) !== f.sha256) throw new Error('original dirty bytes changed after push');
  save('remote-verification.json', { capturedAt: new Date().toISOString(), refsMatched: plan.refs.length, originalRemoteHeadsUnchanged: inv.remote.filter(x => x.ref.startsWith('refs/heads/')).length, sourceCommitsReachable: plan.originalSourceCommits.length, originalRootPreserved: true, originalStashesPreserved: true, dirtySnapshotBytesPreserved: true, master: after.get('refs/heads/master'), ciStartedByThisTask: false, ciSkipDirectiveApplied: true, merge: false, excludedLocalEvidenceStillLocal: true });
  console.log(JSON.stringify({ published: plan.refs.length, sourceCommitsPreserved: plan.originalSourceCommits.length, verified: true, catalog: plan.refs.find(x => x.catalog).sha, masterUnchanged: true }));
}
if (process.argv[2] === '--catalog') catalog();
else if (process.argv[2] === '--push') push();
else throw new Error('expected --catalog or --push');
