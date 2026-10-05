import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = '/home/lyuaoss/projects/FsusBlog';
const OUT = `${ROOT}/.tmp/governance/wip-publication-20261005`;
const PREFIX = 'wip-local/20261005';
const META = '.wip/20261005/WIP.md';
const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' };
const run = (args, input, encoding = 'utf8') => execFileSync('git', ['-C', ROOT, ...args], { env, input, encoding, maxBuffer: 48 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const credentialPattern = /-----BEGIN (?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{70,}|AKIA[A-Z0-9]{16}/;
const sensitivePath = p => /(?:^|\/)\.qoder(?:\/|$)/i.test(p) || /(?:^|\/)(?:qa_ed25519|id_rsa|id_ed25519|\.env(?:\..*)?|credentials\.json|secrets\.json)$/i.test(p);
const physicalRecord = s => JSON.stringify(Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(k => [k, String(s[k])])));
const apply = (file, content) => {
  if (fs.existsSync(file)) throw new Error(`refuse existing generated handoff file: ${file}`);
  execFileSync('apply_patch', [], { cwd: ROOT, input: `*** Begin Patch\n*** Add File: ${file}\n${content.split('\n').map(l => '+' + l).join('\n')}\n*** End Patch\n`, encoding: 'utf8', maxBuffer: 1024 * 1024 });
};
const save = (name, value) => apply(`${OUT}/${name}`, JSON.stringify(value, null, 2) + '\n');
const liveRefs = () => run(['ls-remote', '--heads', '--tags', 'origin']).trim().split('\n').filter(Boolean).map(l => { const [sha, ref] = l.split(/\s+/); return { sha, ref }; });
const refs = () => run(['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads']).trim().split('\n').filter(Boolean).map(l => ({ sha: l.slice(0, 40), branch: l.slice(41) }));
const identity = () => ({ head: run(['rev-parse', 'HEAD']).trim(), branch: run(['symbolic-ref', 'HEAD']).trim(), indexSha256: hash(fs.readFileSync(`${ROOT}/.git/index`)), status: run(['status', '--porcelain=v1', '--untracked-files=no']) });
const assertIdentity = original => {
  if (JSON.stringify(identity()) !== JSON.stringify(original)) throw new Error('original root head/index/working changes drifted');
};
const checkName = ref => run(['check-ref-format', `refs/heads/${ref}`]);
const issuesFor = (branch, bodies) => [...new Set([...branch.matchAll(/(?:issue-|task\/|\/)(\d{3,5})(?:-|\/|$)/g), ...bodies.matchAll(/(?:Refs:|Closes|Fixes|#)\s*#?(\d{3,5})\b/g)].map(m => Number(m[1])))].slice(0, 24);
const wtList = () => run(['worktree', 'list', '--porcelain']).split('\n\n').filter(Boolean).map(block => Object.fromEntries(block.split('\n').filter(Boolean).map(line => { const at = line.indexOf(' '); return at < 0 ? [line, true] : [line.slice(0, at), line.slice(at + 1)]; })));

function inventory() {
  const original = identity();
  const remote = liveRefs();
  const remoteCommits = [...new Set(remote.map(x => run(['rev-parse', `${x.sha}^{commit}`]).trim()))];
  const unpublished = run(['rev-list', '--branches', '--not', ...remoteCommits]).trim().split('\n').filter(Boolean);
  const only = new Set(unpublished);
  const local = refs();
  const worktrees = wtList();
  const branches = local.filter(x => only.has(x.sha)).map(x => {
    const log = run(['log', '-8', '--format=%h %s%n%b', x.sha]);
    const base = run(['merge-base', 'origin/master', x.sha]).trim();
    const diffStat = run(['diff', '--stat', base, x.sha]);
    return { ...x, tree: run(['rev-parse', `${x.sha}^{tree}`]).trim(), base, linkedIssues: issuesFor(x.branch, log), recentHistory: log, diffStat, worktrees: worktrees.filter(w => w.branch === `refs/heads/${x.branch}`).map(w => ({ root: w.worktree, present: fs.existsSync(w.worktree), head: w.HEAD })) };
  });
  const stashes = run(['stash', 'list', '--format=%H%x09%gs']).trim().split('\n').filter(Boolean).map((l, i) => ({ ordinal: i, sha: l.slice(0, 40), subject: l.slice(41), parents: run(['show', '-s', '--format=%P', l.slice(0, 40)]).trim().split(' '), stat: run(['show', '--stat', '--format=', l.slice(0, 40)]) }));
  const pendingObjects = run(['rev-list', '--objects', ...branches.map(b => b.sha), ...stashes.map(s => s.sha), '--not', ...remoteCommits]).trim().split('\n').filter(Boolean);
  const suspiciousPaths = pendingObjects.filter(l => sensitivePath(l.slice(41)));
  if (suspiciousPaths.length) throw new Error(`sensitive path review required: ${JSON.stringify(suspiciousPaths.map(x => x.slice(41)))}`);
  const objectIds = pendingObjects.map(l => l.split(' ')[0]);
  const sizes = run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], objectIds.join('\n') + '\n').trim().split('\n').filter(Boolean).map(l => { const [sha, type, size] = l.split(' '); return { sha, type, size: Number(size) }; });
  const large = sizes.filter(x => x.type === 'blob' && x.size >= 10 * 1024 * 1024);
  if (large.length) throw new Error(`large blob review required: ${JSON.stringify(large)}`);
  const secretFindings = [];
  for (const obj of sizes.filter(x => x.type === 'blob')) {
    const bytes = run(['cat-file', 'blob', obj.sha], undefined, null);
    if (credentialPattern.test(bytes.toString('utf8'))) {
      secretFindings.push({ sha: obj.sha, path: pendingObjects.find(l => l.startsWith(obj.sha + ' '))?.slice(41), size: obj.size });
    }
  }
  if (secretFindings.length) throw new Error(`credential-pattern review required: ${JSON.stringify(secretFindings)}`);
  assertIdentity(original);
  const result = { schema: 'fsusblog.wip-preservation-inventory.v1', capturedAt: new Date().toISOString(), remote, original, localBranches: local.length, unpublishedCommitCount: unpublished.length, unpublishedCommits: unpublished, branches, stashes, worktreeCount: worktrees.length, objectCount: sizes.length, unpublishedBlobBytes: sizes.filter(x => x.type === 'blob').reduce((a, x) => a + x.size, 0), secretPatternFindings: [], largeBlobs: [], noAcceptanceClaim: true };
  save('inventory.json', result);
  console.log(JSON.stringify({ inventory: `${OUT}/inventory.json`, branches: branches.length, uniqueTips: new Set(branches.map(x => x.sha)).size, unpublishedCommits: unpublished.length, stashes: stashes.length, objectCount: sizes.length, blobBytes: result.unpublishedBlobBytes }));
}

function insert(tree, parts, blob) {
  const entries = run(['ls-tree', '-z', tree]).split('\0').filter(Boolean).map(l => { const at = l.indexOf('\t'); const [mode, type, oid] = l.slice(0, at).split(' '); return { mode, type, oid, name: l.slice(at + 1) }; });
  const name = parts[0];
  const old = entries.find(x => x.name === name);
  let entry;
  if (parts.length === 1) {
    if (old) throw new Error(`WIP path already exists: ${META}`);
    entry = { mode: '100644', type: 'blob', oid: blob, name };
  } else {
    if (old && old.type !== 'tree') throw new Error(`metadata directory collides: ${name}`);
    const empty = old?.oid ?? run(['mktree'], '').trim();
    entry = { mode: '040000', type: 'tree', oid: insert(empty, parts.slice(1), blob), name };
  }
  const next = entries.filter(x => x.name !== name).concat(entry);
  return run(['mktree', '-z'], next.map(x => `${x.mode} ${x.type} ${x.oid}\t${x.name}\0`).join('')).trim();
}

function preserve(parent, ref, content, issueIds) {
  checkName(ref);
  try { run(['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]); throw new Error(`backup local ref exists: ${ref}`); } catch (e) { if (e.status !== 1) throw e; }
  const file = `${OUT}/documents/${ref.replaceAll('/', '__')}.md`;
  apply(file, content);
  const blob = run(['hash-object', '-w', '--stdin'], fs.readFileSync(file)).trim();
  const parentTree = run(['rev-parse', `${parent}^{tree}`]).trim();
  const tree = insert(parentTree, META.split('/'), blob);
  const issueFooter = issueIds.length ? `\nRefs: ${issueIds.map(i => '#' + i).join(', ')}\n` : '';
  const message = `docs(governance): record recoverable wip handoff [skip ci]\n\nBackup only. Preserve the exact original parent and source tree.\nNo merge, test pass, issue closure or trusted-baseline promotion.\n${issueFooter}`;
  const commit = run(['commit-tree', tree, '-p', parent], message).trim();
  if (run(['rev-parse', `${commit}^`]).trim() !== parent || run(['diff-tree', '--no-commit-id', '--name-only', '-r', parent, commit]).trim() !== META) throw new Error('backup commit changed more than handoff metadata');
  run(['update-ref', `refs/heads/${ref}`, commit, '0000000000000000000000000000000000000000']);
  return { ref: `refs/heads/${ref}`, sha: commit, original: parent, originalTree: parentTree, handoffBlob: blob, handoffPath: META };
}

function prepare() {
  const inv = JSON.parse(fs.readFileSync(`${OUT}/inventory.json`, 'utf8'));
  const safety = JSON.parse(fs.readFileSync(`${OUT}/complete-path-audit.json`, 'utf8'));
  if (!safety.auditCompleted || safety.inventorySha256 !== hash(fs.readFileSync(`${OUT}/inventory.json`))) throw new Error('complete publication safety audit missing/stale');
  assertIdentity(inv.original);
  const nowRemote = new Map(liveRefs().map(x => [x.ref, x.sha]));
  for (const b of inv.branches) {
    if (run(['rev-parse', `refs/heads/${b.branch}`]).trim() !== b.sha) throw new Error('original source branch changed');
    if (nowRemote.has(`refs/heads/${PREFIX}/${b.branch}`)) throw new Error('remote backup name already exists');
  }
  const prepared = [];
  for (const b of inv.branches) {
    const issues = b.linkedIssues.length ? b.linkedIssues.map(i => `#${i}`).join(', ') : '未从原分支和最近提交中可靠提取；不虚构 issue 绑定';
    const notes = `# WIP: ${b.branch}\n\n历史备份与接续信息，非当前规范、合并资格或验收证据。\n\n- 原始分支：\`${b.branch}\`\n- 原始 commit：\`${b.sha}\`\n- 原始 tree：\`${b.tree}\`\n- 与当前 master 的 merge base：\`${b.base}\`\n- 相关 issue 线索：${issues}\n- 本次状态：源码已保存，未实施或运行任何新的产品/测试修改。\n- 本次未运行构建、测试、数据库、浏览器或 CI；历史结果不得自动算当前候选通过。\n- 本分支只加此 WIP 文档，父提交保留原始源码和完整历史，不替代原候选 head。\n- 接续要求：核对 issue 原验收条件和最新 master；复用原 source owners/producer，不手改生成产物；补齐测试与独审后再走独立 PR。不得直接合并此备份分支。\n- 保留边界：原始本地分支/worktree/stash/ignored证据未删除、未重置。WIP 推送不代表 VM、凭据或所有本地 raw 材料已远端备份。\n\n## 最近提交（原始历史，不代表已验收）\n\n\`\`\`text\n${b.recentHistory.trim()}\n\`\`\`\n\n## 相对原 merge base 的源码差异概况\n\n\`\`\`text\n${b.diffStat.trim() || '(no tracked tree difference)'}\n\`\`\`\n`;
    prepared.push(preserve(b.sha, `${PREFIX}/${b.branch}`, notes, b.linkedIssues));
  }
  for (const s of inv.stashes) {
    const ref = `${PREFIX}/stash/${s.sha.slice(0, 12)}`;
    if (nowRemote.has(`refs/heads/${ref}`)) throw new Error('remote stash backup exists');
    const content = `# WIP stash snapshot\n\n历史保存，不授合并或验收资格。\n\n- 原 stash commit：\`${s.sha}\`\n- 原描述：${s.subject}\n- 原 parents：${s.parents.map(x => '`' + x + '`').join(', ')}\n- 原 stash 仍保留；备份直接以原 stash 为父，保留 staged/worktree/可能的untracked父快照。\n- 此备份只增加 WIP；不能直接将其合入 master。\n- 恢复前核对原基线与当前工作区，按需 fetch 后使用 \`git stash apply ${s.sha}\`；不自动 drop/reset。\n- 本次没有运行测试或 CI，也没有重生成这些产物；generated/source配套验收仍须原 producer核验。\n\n\`\`\`text\n${s.stat.trim()}\n\`\`\`\n`;
    prepared.push(preserve(s.sha, ref, content, issuesFor('', s.subject)));
  }
  assertIdentity(inv.original);
  save('prepared.json', { capturedAt: new Date().toISOString(), original: inv.original, prepared, ciDirective: '[skip ci]', noPushYet: true });
  console.log(JSON.stringify({ prepared: prepared.length, file: `${OUT}/prepared.json`, unchangedOriginal: true }));
}

function snapshotDirty() {
  const inv = JSON.parse(fs.readFileSync(`${OUT}/inventory.json`, 'utf8'));
  const safety = JSON.parse(fs.readFileSync(`${OUT}/complete-path-audit.json`, 'utf8'));
  if (!safety.auditCompleted || safety.inventorySha256 !== hash(fs.readFileSync(`${OUT}/inventory.json`))) throw new Error('complete publication safety audit missing/stale');
  assertIdentity(inv.original);
  const wt = '/mnt/dev-cache/lyuaoss/fsusblog-2214-current';
  const original = 'd653afbde02b75814d8384777886b10419fb38a1';
  const sourcePaths = [
    'artifacts/schema-migration/migration-assembly-binding.json',
    'artifacts/schema-migration/migration-assembly-receipt.json',
    'docs/database-migration.md',
    'tests/migration/FsusBlog.Migration.Tests.csproj',
    'tests/migration/packages.lock.json',
    'tests/tools/migration-terminal-governance.test.mjs',
    'tools/db/check-migration-terminal-governance.mjs',
    'tests/migration/MigrationProviderExecutionTests.cs',
  ];
  const source = args => execFileSync('git', ['-C', wt, ...args], { env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (source(['rev-parse', 'HEAD']).trim() !== original) throw new Error('dirty source head changed');
  const indexPath = source(['rev-parse', '--git-path', 'index']).trim();
  const statusBefore = source(['status', '--porcelain=v1', '--untracked-files=all']);
  const originalIndex = hash(fs.readFileSync(indexPath));
  const actual = sourcePaths.map(p => {
    const file = path.join(wt, p);
    const s = fs.lstatSync(file, { bigint: true });
    if (!s.isFile() || s.nlink !== 1n || s.uid !== 1000n || p.startsWith('.qoder/')) throw new Error('dirty source path not safe regular file');
    const bytes = fs.readFileSync(file);
    if (credentialPattern.test(bytes.toString('utf8'))) throw new Error('dirty credential pattern needs review');
    const physical = physicalRecord(s);
    return { path: p, sha256: hash(bytes), physical, bytes: bytes.length };
  });
  const scratch = fs.mkdtempSync(`${OUT}/private-index-`);
  const privateEnv = { ...env, GIT_INDEX_FILE: `${scratch}/index` };
  const privateGit = args => execFileSync('git', ['-C', wt, '-c', 'core.fsmonitor=false', ...args], { env: privateEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  privateGit(['read-tree', original]);
  privateGit(['add', '--', ...sourcePaths]);
  const tree = privateGit(['write-tree']).trim();
  const changedPaths = run(['diff-tree', '--no-commit-id', '--name-only', '-r', `${original}^{tree}`, tree]).trim().split('\n').filter(Boolean).sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify([...sourcePaths].sort())) throw new Error('snapshot changed unexpected paths');
  for (const row of actual) {
    const bytes = run(['show', `${tree}:${row.path}`], undefined, null);
    if (hash(bytes) !== row.sha256) throw new Error('snapshot Git blob not exact original dirty bytes');
    if (hash(fs.readFileSync(path.join(wt, row.path))) !== row.sha256 || physicalRecord(fs.lstatSync(path.join(wt, row.path), { bigint: true })) !== row.physical) throw new Error('source dirty epoch changed');
  }
  if (source(['status', '--porcelain=v1', '--untracked-files=all']) !== statusBefore || hash(fs.readFileSync(indexPath)) !== originalIndex || source(['rev-parse', 'HEAD']).trim() !== original) throw new Error('original dirty worktree/index changed');
  const snapshot = run(['commit-tree', tree, '-p', original], 'chore(governance): preserve uncommitted migration wip [skip ci]\n\nBackup exact existing worktree bytes without modifying its index or branch.\nProducer outputs are historical WIP copies, not regenerated or accepted.\n\nRefs: #2214\n').trim();
  const content = `# WIP: uncommitted migration terminal work\n\n历史快照，未授合并、producer绑定、native验收或issue关闭资格。\n\n- 原分支：\`codex/issue-2214-terminal-current\`\n- 原 HEAD：\`${original}\`\n- 8文件真实工作树字节快照：\`${snapshot}\`\n- 原staged为空，7 tracked修改与1新测试均unstaged；原index/工作树/分支未改，改动仍在本机。\n- 两个 artifacts/schema-migration JSON是原producer输出的现有WIP，未手改/重生成/自签资格；继续时须原producer与来源/receipt配套验证。\n- 本次只保存源码与WIP；未运行SDK、测试、数据库、浏览器或CI，不可直接merge。\n- 继续时核对 #2214 原条件、最新master、源代码与生成输出绑定、MigrationProviderExecutionTests及完整matrix/indep门禁。\n\n## 已保存文件及原工作树 SHA-256\n\n${actual.map(x => '- `' + x.path + '` — `' + x.sha256 + '`').join('\n')}\n`;
  const ref = `${PREFIX}/uncommitted/issue-2214-terminal-current`;
  if (liveRefs().some(x => x.ref === `refs/heads/${ref}`)) throw new Error('dirty remote backup already exists');
  const prepared = preserve(snapshot, ref, content, [2214]);
  assertIdentity(inv.original);
  save('dirty-snapshot.json', { original, originalIndex, statusPreserved: true, indexPreserved: true, sourceFiles: actual.map(({ physical, ...x }) => x), snapshot, snapshotTree: tree, prepared, testsRun: false, pushYet: false });
  console.log(JSON.stringify({ snapshot, prepared, originalUntouched: true }));
}

function safetyAudit() {
  const inv = JSON.parse(fs.readFileSync(`${OUT}/inventory.json`, 'utf8'));
  assertIdentity(inv.original);
  const parents = [...new Set([...inv.branches.map(x => x.sha), ...inv.stashes.map(x => x.sha)])];
  const old = [...new Set(inv.remote.map(x => x.sha))];
  const objects = run(['rev-list', '--objects', ...parents, '--not', ...old]).trim().split('\n').filter(Boolean);
  const paths = objects.filter(x => sensitivePath(x.slice(41))).map(x => x.slice(41));
  if (paths.length) throw new Error(`sensitive path review required: ${JSON.stringify(paths)}`);
  const changes = run(['log', '--format=', '--name-only', ...parents, '--not', ...old, '--', '.qoder']).trim();
  if (changes) throw new Error('unpublished history introduces .qoder files');
  const types = run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], objects.map(x => x.split(' ')[0]).join('\n') + '\n').trim().split('\n').filter(Boolean);
  const findings = [];
  for (const line of types) {
    const [sha, type, rawSize] = line.split(' ');
    if (type !== 'blob' && type !== 'commit') continue;
    const data = run(['cat-file', type, sha], undefined, null);
    if (Number(rawSize) >= 10 * 1024 * 1024 || credentialPattern.test(data.toString('utf8'))) findings.push({ sha, type, path: objects.find(x => x.startsWith(sha + ' '))?.slice(41), bytes: Number(rawSize) });
  }
  if (findings.length) throw new Error(`credential/large-object review required: ${JSON.stringify(findings)}`);
  assertIdentity(inv.original);
  save('safety-audit.json', { capturedAt: new Date().toISOString(), inventorySha256: hash(fs.readFileSync(`${OUT}/inventory.json`)), objects: types.length, sensitivePaths: [], credentialFindings: [], qoderIntroductions: [], auditCompleted: true, acceptance: false });
  console.log(JSON.stringify({ safetyAudit: 'passed', objects: types.length, originalUntouched: true }));
}

function completePathAudit() {
  const inv = JSON.parse(fs.readFileSync(`${OUT}/inventory.json`, 'utf8'));
  const partial = JSON.parse(fs.readFileSync(`${OUT}/safety-audit.json`, 'utf8'));
  const invDigest = hash(fs.readFileSync(`${OUT}/inventory.json`));
  if (!partial.auditCompleted || partial.inventorySha256 !== invDigest) throw new Error('byte/commit safety audit missing/stale');
  assertIdentity(inv.original);
  const tips = [...new Set([...inv.branches.map(x => x.sha), ...inv.stashes.flatMap(x => [x.sha, ...x.parents])])];
  const commits = [...new Set([...run(['rev-list', ...tips, '--not', ...new Set(inv.remote.map(x => x.sha))]).trim().split('\n').filter(Boolean), ...tips])];
  const trees = [...new Set(commits.map(c => run(['rev-parse', `${c}^{tree}`]).trim()))];
  const findings = [];
  const publicTemplates = new Map([
    ['config/examples/.env.example', 'dc8856c634a61275b663476b2ec835c68287b77a'],
    ['config/examples/.env.production.example', '9081588ba3d12f0202bc397a6b4a50b67742cba5'],
    ['.env.example', 'dc8856c634a61275b663476b2ec835c68287b77a'],
    ['.env.production.example', '9081588ba3d12f0202bc397a6b4a50b67742cba5'],
  ]);
  const publishedMaster = inv.remote.find(x => x.ref === 'refs/heads/master')?.sha;
  if (!publishedMaster) throw new Error('published master missing');
  for (const [p, oid] of publicTemplates) {
    const publishedPath = p.startsWith('config/examples/') ? p : `config/examples/${p}`;
    if (run(['ls-tree', publishedMaster, '--', publishedPath]).trim() !== `100644 blob ${oid}\t${publishedPath}`) throw new Error('reviewed public template baseline mismatch');
  }
  let exactPublishedTemplatePaths = 0;
  let checkedPaths = 0;
  for (const tree of trees) {
    const paths = run(['ls-tree', '-r', '-z', '--name-only', tree]).split('\0').filter(Boolean);
    checkedPaths += paths.length;
    for (const p of paths) if (sensitivePath(p)) {
      const oid = publicTemplates.get(p);
      if (oid && run(['ls-tree', tree, '--', p]).trim() === `100644 blob ${oid}\t${p}`) exactPublishedTemplatePaths++;
      else findings.push({ tree, path: p });
    }
  }
  if (findings.length) throw new Error(`full-tree sensitive-path review required: ${JSON.stringify(findings.slice(0, 32))}`);
  assertIdentity(inv.original);
  save('complete-path-audit.json', { capturedAt: new Date().toISOString(), inventorySha256: invDigest, byteAuditSha256: hash(fs.readFileSync(`${OUT}/safety-audit.json`)), commits: commits.length, trees: trees.length, checkedPaths, exactPublishedTemplatePaths, publicTemplates: [...publicTemplates], publishedMaster, sensitivePaths: [], auditCompleted: true, acceptance: false });
  console.log(JSON.stringify({ completePathAudit: 'passed', commits: commits.length, trees: trees.length, checkedPaths }));
}

const mode = process.argv[2];
if (mode === '--inventory') inventory();
else if (mode === '--prepare') prepare();
else if (mode === '--snapshot-dirty-2214') snapshotDirty();
else if (mode === '--safety-audit') safetyAudit();
else if (mode === '--complete-path-audit') completePathAudit();
else throw new Error('expected --inventory, --prepare, --snapshot-dirty-2214, --safety-audit or --complete-path-audit');
