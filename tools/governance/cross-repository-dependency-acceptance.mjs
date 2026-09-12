#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const receiptSchema = 'fsusblog.cross-repository-dependency-acceptance-receipt.v2';
export const fixtureSchema = 'fsusblog.cross-repository-dependency-acceptance-fixtures.v1';
export const evidenceClass = 'local-controlled-simulation';

const blogClosure = [
    'tools/governance/cross-repository-dependency-acceptance.mjs',
    'tools/governance/dependency-automerge.mjs',
    'tools/governance/dependency-required-checks.mjs',
    'tools/governance/validate-dependency-required-checks.mjs',
    'tools/governance/dependency-freshness.mjs',
    'tools/governance/dependency-blocker-state.mjs',
    'tools/governance/dependency-blocker-checks.mjs',
    'tools/governance/dependency-freshness-blockers.mjs',
    'tools/dependencies/update-fsusui-release.mjs',
    'tools/dependencies/verify-fsusui-release-event.mjs',
    'tools/dependencies/fsusui-manager-ownership.mjs',
    'config/dependencies/update-surface.json',
    'config/dependencies/update-surface.schema.json',
    'config/dependencies/required-checks.json',
    'config/dependencies/required-checks.schema.json',
    'config/dependencies/fsusui-release-event.schema.json',
    'config/dependencies/exceptions.json',
    'config/dependencies/exceptions.schema.json',
    'tests/fixtures/governance/cross-repository-dependency-acceptance.json',
    'renovate.json5',
    '.github/workflows/dependency-freshness.yml',
    '.github/workflows/change-contract.yml',
    '.github/workflows/quality-gate.yml',
    '.github/workflows/dependency-review.yml',
    '.github/workflows/codeql.yml',
    '.github/workflows/scorecard.yml'
];
const uiClosure = [
    'scripts/check-dependency-pr-policy.mjs',
    'scripts/update-surface-lib.mjs',
    'scripts/npm-authority-lib.mjs',
    'scripts/deps-freshness.mjs',
    'scripts/dependency-freshness-adapters.mjs',
    'scripts/dependency-freshness-evaluator.mjs',
    'scripts/deps-freshness-report.mjs',
    'scripts/dependency-freshness-blocker-lib.mjs',
    'config/dependencies/update-surface.json',
    'config/dependencies/update-surface.schema.json',
    'config/dependencies/npm-authority.json',
    'config/dependencies/npm-authority.schema.json',
    'config/dependencies/required-checks.json',
    'config/dependencies/exceptions.json',
    'config/dependencies/exceptions.schema.json',
    'tests/fixtures/dependencies/branch-protection-main.json',
    'spec/ci/readiness-gates.json',
    'renovate.json5',
    '.github/workflows/quality.yml',
    '.github/workflows/dependency-freshness.yml'
];
const digestPaths = {
    fsusblog: blogClosure.filter((entry) => entry.startsWith('config/') || entry === 'renovate.json5' || entry.endsWith('/dependency-freshness.yml')),
    fsusui: uiClosure.filter((entry) => entry.startsWith('config/') || entry === 'renovate.json5' || entry.endsWith('/dependency-freshness.yml'))
};

function canonical(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function jsonValue(value)
{
    return JSON.parse(JSON.stringify(value));
}

function assertSha(value, label)
{
    if (!/^[0-9a-f]{40}$/u.test(value ?? ''))
    {
        throw new Error(`${label}_invalid_sha`);
    }
    return value;
}

function git(repository, args, options = {})
{
    const result = spawnSync('git', ['-C', repository, ...args], {
        encoding: options.encoding ?? 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.status !== 0)
    {
        throw new Error(`git_object_read_failed:${args.join(':')}:${String(result.stderr).trim()}`);
    }
    return result.stdout;
}

export function readGitBlob(repository, revision, relative)
{
    if (relative.startsWith('/') || relative.includes('..'))
    {
        throw new Error(`unsafe_git_path:${relative}`);
    }
    const listing = git(repository, ['ls-tree', '-z', revision, '--', relative], { encoding: 'buffer' });
    const entries = listing.toString('utf8').split('\0').filter(Boolean);
    if (entries.length !== 1)
    {
        throw new Error(`git_tree_entry_count:${relative}:${entries.length}`);
    }
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(entries[0]);
    if (!match || match[3] !== relative)
    {
        throw new Error(`git_tree_entry_not_regular_blob:${relative}`);
    }
    const content = git(repository, ['cat-file', 'blob', match[2]], { encoding: 'buffer' });
    return { mode: match[1], objectId: match[2], content };
}

function bindRepository(repository, revision, entries)
{
    const resolved = fs.realpathSync(repository);
    assertSha(revision, 'source');
    git(resolved, ['cat-file', '-e', `${revision}^{commit}`]);
    return {
        repository: resolved,
        revision,
        files: Object.fromEntries(entries.map((relative) =>
        {
            const entry = readGitBlob(resolved, revision, relative);
            return [relative, { mode: entry.mode, objectId: entry.objectId, digest: sha256(entry.content) }];
        }))
    };
}

function materialize(binding, entries, target)
{
    for (const relative of entries)
    {
        const destination = path.join(target, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const entry = readGitBlob(binding.repository, binding.revision, relative);
        const expected = binding.files?.[relative];
        if (expected && canonical(expected) !== canonical({ mode: entry.mode, objectId: entry.objectId, digest: sha256(entry.content) }))
        {
            throw new Error(`git_blob_changed_after_binding:${relative}`);
        }
        fs.writeFileSync(destination, entry.content, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
    }
}

function exactKeys(value, expected, label)
{
    const actual = Object.keys(value ?? {}).sort();
    const wanted = [...expected].sort();
    if (canonical(actual) !== canonical(wanted))
    {
        throw new Error(`${label}_fields`);
    }
}

export function auditUiFreshnessCli(sourceText, reportText)
{
    const errors = [];
    const forbidden = [
        /\bfetch\s*\(/u, /https?\.request\s*\(/u, /\bnet\.(?:connect|createConnection)\s*\(/u,
        /\b(?:spawn|execFile|fork)Sync?\s*\(/u, /\bWebSocket\s*\(/u,
        /\b(?:writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|copyFileSync|mkdirSync)\s*\(/u
    ];
    for (const pattern of forbidden)
    {
        if (pattern.test(sourceText))
        {
            errors.push(`forbidden-network-or-process:${pattern.source}`);
        }
    }
    const commands = [...sourceText.matchAll(/execSync\(\s*`([^`]+)`/gu)].map((match) => match[1].replace(/\s+/gu, ' ').trim());
    const allowed = [
        'npm view "${name}" version 2>/dev/null',
        'gh api --paginate --slurp "repos/${repo}/tags?per_page=100" 2>/dev/null',
        'gh pr list --state open --json title,headRefName,number,url,body,createdAt,statusCheckRollup,labels --limit 100 2>/dev/null',
        'curl -sSL "${url}" 2>/dev/null'
    ];
    if (canonical(commands.sort()) !== canonical(allowed.sort()))
    {
        errors.push('exec-command-allowlist-drift');
    }
    for (const command of commands)
    {
        if (/^(?:\/|[A-Za-z]:\\)/u.test(command) || /(?:^|\s)(?:\/|[A-Za-z]:\\)[^\s]+/u.test(command))
        {
            errors.push(`absolute-executable-or-argument:${command}`);
        }
    }
    if (!/writeFreshnessReport\(outputPath, report, repoRoot\)/u.test(sourceText))
    {
        errors.push('output-write-not-bound-to-repo-root');
    }
    if (!/path\.resolve\(root, outputPath\)/u.test(reportText)
        || !/writeFileSync\(resolved,/u.test(reportText)
        || (reportText.match(/\bwriteFileSync\s*\(/gu) ?? []).length !== 1
        || (reportText.match(/\bmkdirSync\s*\(/gu) ?? []).length !== 1
        || /\b(?:appendFileSync|rmSync|unlinkSync|renameSync|copyFileSync|fetch|exec|spawn|request)\s*\(/u.test(reportText))
    {
        errors.push('report-writer-boundary-drift');
    }
    return errors;
}

function writeAdapter(file, tool)
{
    const program = `#!${process.execPath}\nimport fs from 'node:fs';\nconst facts=JSON.parse(fs.readFileSync(process.env.FSUS_ACCEPTANCE_FACTS,'utf8'));\nfs.appendFileSync(process.env.FSUS_ACCEPTANCE_CALLS,JSON.stringify({tool:${JSON.stringify(tool)},argv:process.argv.slice(2)})+'\\n');\nconst a=process.argv.slice(2);\nfunction fail(){process.stderr.write('unlisted mock command\\n');process.exit(97)}\nlet out;\nif(${JSON.stringify(tool)}==='npm'&&a[0]==='view'&&a[2]==='version'&&a.length===3)out=facts.npm?.[a[1]];\nelse if(${JSON.stringify(tool)}==='gh'&&a[0]==='api'&&a[1]==='--paginate'&&a[2]==='--slurp'&&a.length===4)out=[facts.tags?.[a[3].replace(/^repos\\//,'').replace(/\\/tags\\?per_page=100$/,'')]??[]];\nelse if(${JSON.stringify(tool)}==='gh'&&a[0]==='pr'&&a[1]==='list'&&a[2]==='--state'&&a[3]==='open'&&a[4]==='--json'&&a[6]==='--limit'&&a[7]==='100'&&a.length===8)out=facts.pullRequests;\nelse if(${JSON.stringify(tool)}==='curl'&&a[0]==='-sSL'&&a.length===2)out=facts.urls?.[a[1]];\nelse fail();\nif(out===undefined||out===null)fail();\nprocess.stdout.write(typeof out==='string'?out:JSON.stringify(out));\n`;
    fs.writeFileSync(file, program, { mode: 0o755 });
}

function installAdapters(root, facts)
{
    const bin = path.join(root, 'adapter-bin');
    const state = path.join(root, 'adapter-state');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    const factsFile = path.join(state, 'facts.json');
    const callsFile = path.join(state, 'calls.jsonl');
    fs.writeFileSync(factsFile, JSON.stringify(facts));
    fs.writeFileSync(callsFile, '');
    for (const tool of ['npm', 'gh', 'curl'])
    {
        writeAdapter(path.join(bin, tool), tool);
    }
    return { bin, factsFile, callsFile };
}

function linkJson5(root, json5Package)
{
    const resolved = fs.realpathSync(json5Package);
    const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'));
    if (manifest.name !== 'json5')
    {
        throw new Error('ui_json5_package_invalid');
    }
    const modules = path.join(root, 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(resolved, path.join(modules, 'json5'), 'dir');
    const files = {};
    const visit = (directory, prefix = '') =>
    {
        for (const name of fs.readdirSync(directory).sort())
        {
            const absolute = path.join(directory, name);
            const relative = path.posix.join(prefix, name);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink())
            {
                throw new Error(`ui_json5_symlink_forbidden:${relative}`);
            }
            if (stat.isDirectory())
            {
                visit(absolute, relative);
            }
            else if (stat.isFile())
            {
                files[relative] = sha256(fs.readFileSync(absolute));
            }
            else
            {
                throw new Error(`ui_json5_non_regular_entry:${relative}`);
            }
        }
    };
    visit(resolved);
    return { packageTreeDigest: sha256(canonical(files)), files };
}

async function loadModules(blogRoot, uiRoot)
{
    return {
        blogAutomerge: await import(pathToFileURL(path.join(blogRoot, 'tools/governance/dependency-automerge.mjs'))),
        blogChecks: await import(pathToFileURL(path.join(blogRoot, 'tools/governance/dependency-required-checks.mjs'))),
        blogRequired: await import(pathToFileURL(path.join(blogRoot, 'tools/governance/validate-dependency-required-checks.mjs'))),
        blogFreshness: await import(pathToFileURL(path.join(blogRoot, 'tools/governance/dependency-freshness.mjs'))),
        blogBlocker: await import(pathToFileURL(path.join(blogRoot, 'tools/governance/dependency-blocker-state.mjs'))),
        uiPolicy: await import(pathToFileURL(path.join(uiRoot, 'scripts/check-dependency-pr-policy.mjs'))),
        uiBlocker: await import(pathToFileURL(path.join(uiRoot, 'scripts/dependency-freshness-blocker-lib.mjs')))
    };
}

function json(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function firstBlogGroup(catalog)
{
    return catalog.groups.find((group) => group.id !== 'lockfile-maintenance' && group.checksByUpdateType?.major);
}

function successfulBlogRuns(catalog, group, updateType, conclusion = 'success', omit = false)
{
    const set = catalog.checkSets[group.checksByUpdateType[updateType]];
    return set.filter((_, index) => !(omit && index === 0)).map((name, index) => ({
        name, status: 'completed', conclusion: index === 0 ? conclusion : 'success'
    }));
}

function successfulUiEvidence(contract, group, updateType, conclusion = 'success', omit = false)
{
    const policy = group === 'lockfile-maintenance' ? contract.lockfileMaintenance : contract.groups[group];
    const checks = Object.fromEntries(policy.requiredChecks.filter((_, index) => !(omit && index === 0))
        .map((name, index) => [name, index === 0 ? conclusion : 'success']));
    const gates = Object.fromEntries(policy.requiredGateEvidence.map((name) => [name, 'success']));
    return { checks, gates };
}

function surfaceForGroup(surface, group)
{
    return [...(surface.items ?? []), ...(surface.surfaces ?? [])].find((entry) => entry.group === group) ?? null;
}

function managerEnabled(renovate, surface)
{
    return Boolean(surface?.manager && renovate.enabledManagers?.includes(surface.manager));
}

function effectiveBlogAutomerge(renovate, updateType)
{
    const rule = updateType === 'lockFileMaintenance'
        ? renovate.lockFileMaintenance
        : renovate.packageRules?.find((entry) => entry.matchUpdateTypes?.includes(updateType) && entry.automerge === true);
    return {
        enabled: rule?.automerge === true,
        automergeType: rule?.automergeType ?? renovate.automergeType,
        platformAutomerge: rule?.platformAutomerge ?? renovate.platformAutomerge
    };
}

function simulatePullRequest(repository, fixtureCase, group, surface, renovate)
{
    const enabled = managerEnabled(renovate, surface);
    if (!enabled)
    {
        return null;
    }
    return {
        number: `simulated:${repository}:pr:${fixtureCase.id}`,
        group,
        updateType: fixtureCase.facts.updateType,
        manager: surface.manager,
        surfaceId: surface.id,
        approvalRequirement: renovate.dependencyDashboardApproval === false ? 0 : 1
    };
}

function runAutomergeCases(fixtures, models, modules)
{
    const blogGroup = firstBlogGroup(models.blogCatalog);
    const uiGroup = Object.keys(models.ui.contract.groups)[0];
    const blogSurface = surfaceForGroup(models.blogSurface, blogGroup.id);
    const uiSurface = surfaceForGroup(models.ui.surface, uiGroup);
    const blogConfigErrors = modules.blogAutomerge.validateRenovateAutomerge(models.blogRenovate);
    const uiConfigErrors = modules.uiPolicy.auditRequiredChecks(models.ui);
    return fixtures.automerge.map((fixtureCase) =>
    {
        const facts = fixtureCase.facts;
        const blogCreated = simulatePullRequest('fsusblog', fixtureCase, blogGroup.id, blogSurface, models.blogRenovate);
        const uiCreated = simulatePullRequest('fsusui', fixtureCase, uiGroup, uiSurface, models.ui.renovate);
        const blogAutomerge = effectiveBlogAutomerge(models.blogRenovate, facts.updateType);
        const blogRuns = successfulBlogRuns(models.blogCatalog, blogGroup, facts.updateType,
            facts.checkConclusion ?? 'success', facts.omitCheck === true);
        const blog = modules.blogAutomerge.evaluatePlatformAutomerge({
            catalog: models.blogCatalog,
            defaultHeadSha: 'a'.repeat(40), latestStable: facts.latestStable ?? '2.0.0',
            pullRequest: {
                number: blogCreated?.number, group: blogGroup.id, updateType: facts.updateType,
                draft: facts.draft === true, mergeable: facts.mergeable !== false,
                mergeableState: facts.mergeable === false ? 'dirty' : 'clean', labels: facts.labels ?? [],
                baseSha: 'a'.repeat(40), targetVersion: facts.targetVersion ?? '2.0.0',
                platformAutomerge: blogAutomerge.platformAutomerge,
                automergeType: blogAutomerge.automergeType, checkRuns: blogRuns,
                failedHours: facts.failureAgeHours ?? 0
            }
        });
        const uiEvidence = successfulUiEvidence(models.ui.contract, uiGroup, facts.updateType,
            facts.checkConclusion ?? 'success', facts.omitCheck === true);
        const ui = modules.uiPolicy.evaluateAutomerge(models.ui.contract, {
            group: uiGroup, updateType: facts.updateType, draft: facts.draft === true,
            mergeable: facts.mergeable !== false, directPush: false, approvalsRequired: 0,
            platformAutomerge: models.ui.renovate.platformAutomerge === true, projectionsFresh: true,
            branchBaseSha: 'b'.repeat(40),
            defaultBranchSha: 'b'.repeat(40), currentTarget: facts.targetVersion ?? '2.0.0',
            latestStableTarget: facts.latestStable ?? '2.0.0', labels: facts.labels ?? [],
            checks: uiEvidence.checks, gateEvidence: uiEvidence.gates,
            failureAgeHours: facts.failureAgeHours ?? 0, securityUpdate: false
        });
        const created = { fsusblog: blogCreated !== null, fsusui: uiCreated !== null };
        const actual = {
            fsusblog: created.fsusblog && blogCreated.approvalRequirement === 0 && blogAutomerge.enabled
                && blogConfigErrors.length === 0 && blog.decision === 'merge',
            fsusui: created.fsusui && uiCreated.approvalRequirement === 0
                && uiConfigErrors.length === 0 && ui.eligible
        };
        const repositoryPass = {
            fsusblog: actual.fsusblog === fixtureCase.expectMerge,
            fsusui: actual.fsusui === fixtureCase.expectMerge
        };
        return {
            id: fixtureCase.id,
            prIds: [blogCreated?.number, uiCreated?.number].filter(Boolean),
            runIds: created.fsusblog && created.fsusui
                ? [`simulated:fsusblog:run:${fixtureCase.id}`, `simulated:fsusui:run:${fixtureCase.id}`] : [],
            expectation: fixtureCase.expectMerge, actual,
            repositoryPass, pass: repositoryPass.fsusblog && repositoryPass.fsusui,
            outputs: {
                fsusblog: { created: blogCreated, configurationErrors: blogConfigErrors,
                    decision: blog.decision, errors: blog.errors, checkRuns: blogRuns },
                fsusui: { created: uiCreated, configurationErrors: uiConfigErrors,
                    eligible: ui.eligible, reasons: ui.reasons, labelsToAdd: ui.labelsToAdd,
                    checks: uiEvidence.checks, gateEvidence: uiEvidence.gates }
            }
        };
    });
}

function blogException(fixtureCase)
{
    const value = fixtureCase.facts.exception;
    if (!value)
    {
        return [];
    }
    const record = {
        id: `simulated:exception:${fixtureCase.id}`, dependencyId: 'simulated-dependency', datasource: 'npm',
        packageName: 'semver', currentVersion: fixtureCase.facts.currentVersion,
        targetVersion: fixtureCase.facts.latestStable, reason: 'Controlled acceptance evidence',
        owner: 'dependency-governance', createdAt: value.createdAt, expiresAt: value.expiresAt,
        kind: value.kind, evidenceUrl: 'https://example.invalid/simulated-evidence'
    };
    if (value.omitOwner)
    {
        delete record.owner;
    }
    return [record];
}

function uiException(fixtureCase)
{
    return blogException(fixtureCase).map((entry) => ({
        id: entry.id,
        dependencyId: 'npm-workspace-root', datasource: entry.datasource, packageName: entry.packageName,
        currentVersion: entry.currentVersion, targetVersion: entry.targetVersion, reason: entry.reason,
        evidence: entry.evidenceUrl, owner: entry.owner, createdAt: entry.createdAt, expiresAt: entry.expiresAt,
        ...(entry.kind === 'vulnerability' ? { vulnerability: true } : {})
    }));
}

function writeUiFreshnessFixture(root, fixtureCase)
{
    const config = path.join(root, 'config/dependencies');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'update-surface.json'), JSON.stringify({
        surfaces: [{ id: 'npm-workspace-root', datasource: 'npm', packageName: 'semver' }]
    }));
    fs.writeFileSync(path.join(config, 'npm-authority.json'), JSON.stringify({
        install: { semver: fixtureCase.facts.currentVersion }
    }));
    fs.writeFileSync(path.join(config, 'exceptions.json'), JSON.stringify({ schemaVersion: 1, exceptions: uiException(fixtureCase) }));
    fs.writeFileSync(path.join(config, 'required-checks.json'), JSON.stringify({
        branchProtection: { requiredChecks: ['pr-fast', 'pr-real-render-performance'] }
    }));
}

function uiRawFacts(fixtureCase)
{
    const pull = fixtureCase.facts.pullRequest;
    const rawPull = pull?.state === 'open' ? [{
        number: `simulated:fsusui:pr:${fixtureCase.id}`, title: `chore(deps): update npm-workspace-root to ${pull.targetVersion}`,
        headRefName: 'renovate/npm-workspace-root', url: 'https://example.invalid/simulated-pr', body: '',
        createdAt: '2026-09-06T12:00:00Z', statusCheckRollup: [], labels: []
    }] : [];
    return {
        npm: fixtureCase.facts.latestStable == null ? {} : { semver: fixtureCase.facts.latestStable },
        tags: {}, urls: {}, pullRequests: rawPull
    };
}

function runUiFreshnessCase(uiRoot, fixtureCase, containment)
{
    const caseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cross-repo-ui-case-'));
    try
    {
        materialize(containment.binding, [
            'scripts/deps-freshness.mjs',
            'scripts/dependency-freshness-adapters.mjs',
            'scripts/dependency-freshness-evaluator.mjs',
            'scripts/deps-freshness-report.mjs'
        ], caseRoot);
        writeUiFreshnessFixture(caseRoot, fixtureCase);
        const adapters = installAdapters(caseRoot, uiRawFacts(fixtureCase));
        const output = path.join(caseRoot, 'result.json');
        const clock = path.join(caseRoot, 'controlled-clock.mjs');
        fs.writeFileSync(clock, [
            `const instant = ${JSON.stringify(containment.now)};`,
            'const NativeDate = globalThis.Date;',
            'globalThis.Date = class ControlledDate extends NativeDate {',
            '  constructor(...args) { super(...(args.length === 0 ? [instant] : args)); }',
            '  static now() { return NativeDate.parse(instant); }',
            '};'
        ].join('\n'));
        const home = path.join(caseRoot, 'home');
        const temporary = path.join(caseRoot, 'tmp');
        fs.mkdirSync(home);
        fs.mkdirSync(temporary);
        const result = spawnSync(process.execPath, ['--import', clock, path.join(caseRoot, 'scripts/deps-freshness.mjs'), '--output', output], {
            cwd: caseRoot, encoding: 'utf8', timeout: 30_000,
            env: {
                PATH: adapters.bin, HOME: home, TMPDIR: temporary, LANG: 'C', LC_ALL: 'C',
                FSUS_ACCEPTANCE_FACTS: adapters.factsFile, FSUS_ACCEPTANCE_CALLS: adapters.callsFile
            }
        });
        const report = fs.existsSync(output) ? json(output) : null;
        const calls = fs.readFileSync(adapters.callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const normalizeOutput = (value) => value.trim().replaceAll(caseRoot, '<fixture-root>');
        return { fresh: result.status === 0, exitCode: result.status, signal: result.signal, report, calls,
            stdout: normalizeOutput(result.stdout), stderr: normalizeOutput(result.stderr) };
    }
    finally
    {
        fs.rmSync(caseRoot, { recursive: true, force: true });
    }
}

function runFreshnessCases(fixtures, models, modules, containment)
{
    const catalog = { items: [{
        id: 'simulated-dependency', datasource: 'npm', packageName: 'semver', manager: 'npm',
        files: ['package.json'], fieldPaths: ['/dependencies/semver'], group: 'simulated'
    }] };
    const config = { automerge: false, enabledManagers: ['npm'], packageRules: [{ matchUpdateTypes: ['major', 'minor', 'patch', 'digest'] }] };
    return fixtures.freshness.map((fixtureCase) =>
    {
        const facts = fixtureCase.facts;
        const pullRequests = facts.pullRequest ? [{
            number: `simulated:fsusblog:pr:${fixtureCase.id}`, dependencyId: 'simulated-dependency',
            packageName: 'semver', group: 'simulated', state: facts.pullRequest.state,
            targetVersion: facts.pullRequest.targetVersion
        }] : [];
        const registries = facts.latestStable == null ? null : { byId: { 'simulated-dependency': {
            latestStable: facts.latestStable, releasedAt: '2026-09-07T11:00:00Z'
        } } };
        const blog = modules.blogFreshness.evaluateFreshness({
            catalog, config, exceptions: { schema: modules.blogFreshness.exceptionsSchema, exceptions: blogException(fixtureCase) },
            currentVersions: { 'simulated-dependency': { currentVersion: facts.currentVersion, datasource: 'npm', packageName: 'semver' } },
            registries, pullRequests, now: fixtures.now
        });
        const ui = runUiFreshnessCase(models.uiRoot, fixtureCase, { ...containment, now: fixtures.now });
        const actual = { fsusblog: blog.status === 'pass', fsusui: ui.fresh };
        const repositoryPass = {
            fsusblog: actual.fsusblog === fixtureCase.expectFresh,
            fsusui: actual.fsusui === fixtureCase.expectFresh
        };
        return {
            id: fixtureCase.id, expectation: fixtureCase.expectFresh, actual,
            repositoryPass, pass: repositoryPass.fsusblog && repositoryPass.fsusui,
            outputs: { fsusblog: blog, fsusui: ui }
        };
    });
}

function runBranchCases(fixtures, models, modules)
{
    return fixtures.branchProtection.map((fixtureCase) =>
    {
        const blogProtection = structuredClone(models.blogCatalog.branchProtection);
        const uiProtection = structuredClone(models.ui.branchProtection);
        if (fixtureCase.facts.mutation === 'extra-context')
        {
            blogProtection.contexts = [...(blogProtection.contexts ?? []), 'simulated:extra-check'];
            uiProtection.required_status_checks.contexts = [...(uiProtection.required_status_checks.contexts ?? []), 'simulated:extra-check'];
        }
        const blogErrors = modules.blogRequired.validateRequiredChecksCatalog(models.blogCatalog, {
            root: models.blogRoot, workflowChecks: models.blogWorkflowChecks, branchProtection: blogProtection
        });
        const uiErrors = modules.uiPolicy.auditRequiredChecks({ ...models.ui, branchProtection: uiProtection });
        const contextCounts = {
            fsusblog: blogProtection.contexts?.length ?? 0,
            fsusui: uiProtection.required_status_checks?.contexts?.length ?? 0
        };
        const actual = {
            fsusblog: blogErrors.length === 0 && contextCounts.fsusblog === 13,
            fsusui: uiErrors.length === 0 && contextCounts.fsusui === 2
        };
        const repositoryPass = {
            fsusblog: actual.fsusblog === fixtureCase.expectValid,
            fsusui: actual.fsusui === fixtureCase.expectValid
        };
        return { id: fixtureCase.id, expectation: fixtureCase.expectValid, actual,
            repositoryPass, pass: repositoryPass.fsusblog && repositoryPass.fsusui,
            outputs: { contextCounts, fsusblog: blogErrors, fsusui: uiErrors } };
    });
}

export function aggregateRepositoryOutcomes(outcomes)
{
    return outcomes?.fsusblog === true && outcomes?.fsusui === true;
}

function runCrossRepositoryCases(fixtures)
{
    return fixtures.crossRepository.map((fixtureCase) =>
    {
        const overall = aggregateRepositoryOutcomes(fixtureCase.facts);
        const pass = overall === fixtureCase.expectOverall
            && fixtureCase.facts.fsusblog !== fixtureCase.facts.fsusui;
        return {
            id: fixtureCase.id,
            expectation: fixtureCase.expectOverall,
            actual: { ...fixtureCase.facts, overall },
            repositoryPass: { fsusblog: pass, fsusui: pass },
            pass,
            outputs: { aggregation: 'both-repositories-must-pass' }
        };
    });
}

export function evaluateDelegatedOwnerInvariant(owners)
{
    const reasons = [];
    if (!Array.isArray(owners) || owners.length === 0)
    {
        reasons.push('delegated-manager-owner-missing');
    }
    const unique = new Set(owners ?? []);
    if (unique.size !== (owners ?? []).length)
    {
        reasons.push('delegated-manager-owner-duplicated');
    }
    if (unique.size > 1)
    {
        reasons.push('delegated-manager-dual-owner');
    }
    for (const owner of unique)
    {
        if (!['renovate', 'fsusui-release-train'].includes(owner))
        {
            reasons.push(`delegated-manager-owner-unknown:${owner}`);
        }
    }
    return { valid: reasons.length === 0, reasons };
}

function runDelegatedCases(fixtures, modules)
{
    return fixtures.delegatedManager.map((fixtureCase) =>
    {
        const entries = fixtureCase.facts.owners.map((owner, index) => ({
            id: index === 0 ? 'npm-ozwasyd-element-plus-frontend' : `simulated-element-plus-${index}`,
            datasource: 'npm', packageName: '@ozwasyd/element-plus',
            manager: owner === 'renovate' ? 'npm' : 'delegated',
            customManager: owner === 'renovate' ? undefined : 'fsusui-release-train',
            files: ['src/frontend/package.json', 'src/frontend/package-lock.json'],
            ...(owner === 'renovate' ? { fieldPaths: ['/dependencies/@ozwasyd~1element-plus'] } : {}),
            group: 'frontend-runtime'
        }));
        const currentVersions = Object.fromEntries(entries.map((entry) => [entry.id, {
            currentVersion: '1.0.0', datasource: entry.datasource, packageName: entry.packageName
        }]));
        const byId = Object.fromEntries(entries.map((entry) => [entry.id, {
            latestStable: '1.0.0', releasedAt: '2026-09-07T11:00:00Z'
        }]));
        const result = modules.blogFreshness.evaluateFreshness({
            catalog: { items: entries },
            config: { automerge: false, enabledManagers: ['npm'], packageRules: [{ matchUpdateTypes: ['major', 'minor', 'patch', 'digest'] }] },
            exceptions: { schema: modules.blogFreshness.exceptionsSchema, exceptions: [] }, currentVersions,
            registries: { byId }, pullRequests: [], now: '2026-09-07T12:00:00Z'
        });
        const enumerated = entries.length === fixtureCase.facts.owners.length;
        const invariant = evaluateDelegatedOwnerInvariant(fixtureCase.facts.owners);
        const actual = enumerated && result.status === 'pass' && invariant.valid;
        const repositoryPass = { fsusblog: actual === fixtureCase.expectValid, fsusui: true };
        return { id: fixtureCase.id, expectation: fixtureCase.expectValid, actual,
            repositoryPass, pass: repositoryPass.fsusblog,
            outputs: {
                fsusblog: { formalFreshness: result, delegatedOwnerInvariant: invariant },
                fsusui: { releaseTrainOwners: fixtureCase.facts.owners }
            } };
    });
}

async function runBlockerCases(fixtures, models, modules)
{
    const fixtureCase = fixtures.blocker[0];
    const now = '2026-09-07T12:00:00Z';
    const blogItem = { id: 'simulated-dependency', datasource: 'npm', packageName: 'semver' };
    const blogFail = { schema: modules.blogFreshness.resultSchema, status: 'fail', now,
        results: [{ dependencyId: blogItem.id, currentVersion: '1.0.0', latestStable: '2.0.0', state: 'uncovered' }],
        errors: [{ code: 'behind-over-24h', detail: blogItem.id }] };
    const blogSnapshot = { report: blogFail, catalog: { items: [blogItem] }, exceptions: { exceptions: [] },
        requiredChecks: models.blogCatalog, pullRequests: [], issues: [] };
    const created = modules.blogBlocker.planScheduledBlockers(blogSnapshot);
    const issue = { number: 1, title: created.issue.title, body: created.issue.body, state: 'open' };
    const idempotent = modules.blogBlocker.planScheduledBlockers({ ...blogSnapshot, issues: [issue] });
    const recovered = modules.blogBlocker.planScheduledBlockers({ ...blogSnapshot, issues: [issue], report: {
        ...blogFail, status: 'pass', errors: [], results: [{ ...blogFail.results[0], state: 'current', currentVersion: '2.0.0' }]
    } });
    let blogConcurrent = false;
    try
    {
        modules.blogBlocker.planScheduledBlockers({ ...blogSnapshot, issues: [issue, { ...issue, number: 2 }] });
    }
    catch
    {
        blogConcurrent = true;
    }

    const uiReport = { schemaVersion: 1, generatedAt: now, requiredChecks: ['pr-fast'], errors: [],
        results: [{ dependencyId: 'simulated-dependency', datasource: 'npm', packageName: 'semver',
            currentVersion: '1.0.0', targetVersion: '2.0.0', state: 'stale', pullRequests: [], blockerReasons: ['stale'] }] };
    const uiIssues = [];
    const client = {
        assertWritable: async () =>
        {}, listIssuesByTitle: async () => structuredClone(uiIssues),
        setPullRequestLabel: async () =>
        {},
        createIssue: async (fields) =>
        {
            uiIssues.push({ number: 1, state: 'open', updatedAt: now, ...fields });
        },
        updateIssue: async (number, fields) => Object.assign(uiIssues.find((entry) => entry.number === number), fields)
    };
    const uiCreated = await modules.uiBlocker.reconcileFreshnessReport({ report: uiReport, client });
    const uiIdempotent = await modules.uiBlocker.reconcileFreshnessReport({ report: uiReport, client });
    const uiRecovered = await modules.uiBlocker.reconcileFreshnessReport({ report: {
        ...uiReport, generatedAt: '2026-09-07T13:00:00Z', results: [{ ...uiReport.results[0], state: 'current',
            currentVersion: '2.0.0', targetVersion: '2.0.0', blockerReasons: [] }]
    }, client });
    let uiConcurrent = false;
    let calls = 0;
    const racingClient = {
        ...client, listIssuesByTitle: async () =>
        {
            calls += 1;
            return calls === 1 ? [] : [{ number: 9, state: 'open', title: modules.uiBlocker.BLOCKER_ISSUE_TITLE, body: '', updatedAt: now }];
        }
    };
    try
    {
        await modules.uiBlocker.reconcileFreshnessReport({ report: uiReport, client: racingClient });
    }
    catch
    {
        uiConcurrent = true;
    }
    const outputs = {
        fsusblog: { create: created.issue.action, idempotent: idempotent.issue.action, recovery: recovered.issue.action, concurrentRejected: blogConcurrent },
        fsusui: {
            create: uiCreated.action === 'created' ? 'create' : uiCreated.action,
            idempotent: uiIdempotent.action === 'noop' ? 'none' : uiIdempotent.action,
            recovery: uiRecovered.action === 'closed' ? 'close' : uiRecovered.action,
            concurrentRejected: uiConcurrent
        }
    };
    const repositoryPass = Object.fromEntries(Object.entries(outputs).map(([repository, actual]) => [
        repository, canonical(actual) === canonical(fixtureCase.expect)
    ]));
    return [{ id: fixtureCase.id, expectation: fixtureCase.expect, actual: outputs,
        repositoryPass, pass: repositoryPass.fsusblog && repositoryPass.fsusui, outputs }];
}

function validatePlatformDisclosure(disclosure, label)
{
    exactKeys(disclosure, ['observedAt', 'hostedExecutionEvidence', 'hostedEvidenceClaimed',
        'productionRulesetMutation', 'repositories'], label);
    if (!Number.isFinite(Date.parse(disclosure.observedAt)) || disclosure.hostedExecutionEvidence !== 'unavailable'
        || disclosure.hostedEvidenceClaimed !== false || disclosure.productionRulesetMutation !== false)
    {
        throw new Error(label);
    }
    exactKeys(disclosure.repositories, ['fsusblog', 'fsusui'], `${label}_repositories`);
    for (const repository of ['fsusblog', 'fsusui'])
    {
        const state = disclosure.repositories[repository];
        exactKeys(state, ['actionsPermission', 'rulesetId', 'requiredStatusChecks', 'classicBranchProtection'],
            `${label}_${repository}`);
        if (state.actionsPermission !== 'enabled' || !Number.isInteger(state.rulesetId)
            || state.requiredStatusChecks?.length !== 0 || state.classicBranchProtection !== 'not-configured')
        {
            throw new Error(`${label}_${repository}`);
        }
    }
    return disclosure;
}

function validateFixtures(fixtures)
{
    exactKeys(fixtures, ['schema', 'now', 'platformDisclosure', 'automerge', 'freshness', 'branchProtection',
        'delegatedManager', 'blocker', 'crossRepository'], 'fixture');
    if (fixtures.schema !== fixtureSchema || !Number.isFinite(Date.parse(fixtures.now)))
    {
        throw new Error('fixture_header');
    }
    validatePlatformDisclosure(fixtures.platformDisclosure, 'fixture_platform_disclosure');
    for (const section of ['automerge', 'freshness', 'branchProtection', 'delegatedManager', 'crossRepository'])
    {
        if (!Array.isArray(fixtures[section]) || fixtures[section].length === 0)
        {
            throw new Error(`fixture_section:${section}`);
        }
        for (const item of fixtures[section])
        {
            if (!item.id || !item.facts || !Object.keys(item).some((key) => key.startsWith('expect')))
            {
                throw new Error(`fixture_case:${section}`);
            }
        }
    }
    if (!Array.isArray(fixtures.blocker) || fixtures.blocker.length !== 1 || !fixtures.blocker[0]?.expect)
    {
        throw new Error('fixture_section:blocker');
    }
    return fixtures;
}

export function assertFixtureBinding(fixtures, source)
{
    const bound = validateFixtures(JSON.parse(Buffer.from(source).toString('utf8')));
    if (canonical(fixtures) !== canonical(bound))
    {
        throw new Error('acceptance_fixtures_not_source_bound');
    }
    return true;
}

function receiptPayload(receipt)
{
    const payload = { ...receipt };
    delete payload.receiptDigest;
    return payload;
}

export function validateReceipt(receipt)
{
    exactKeys(receipt, ['schema', 'evidenceClass', 'terminalQualification', 'qualification', 'fixtureDigest', 'sources',
        'runtimeDependencies', 'containment', 'cases', 'repositories', 'warnings', 'status', 'receiptDigest'], 'receipt');
    if (receipt.schema !== receiptSchema || receipt.evidenceClass !== evidenceClass)
    {
        throw new Error('receipt_header');
    }
    exactKeys(receipt.qualification, ['mode', 'hostedEvidenceClaimed', 'platformDisclosure'], 'receipt_qualification');
    if (receipt.qualification.mode !== 'explicit-user-authorized-local-equivalent'
        || receipt.qualification.hostedEvidenceClaimed !== false)
    {
        throw new Error('receipt_qualification');
    }
    validatePlatformDisclosure(receipt.qualification.platformDisclosure, 'receipt_platform_disclosure');
    if (!Array.isArray(receipt.warnings) || receipt.status !== (receipt.cases.every((item) => item.pass) && receipt.warnings.length === 0 ? 'pass' : 'fail'))
    {
        throw new Error('receipt_status');
    }
    if (receipt.terminalQualification !== (receipt.status === 'pass'))
    {
        throw new Error('receipt_terminal_qualification');
    }
    exactKeys(receipt.sources, ['fsusblog', 'fsusui'], 'receipt_sources');
    const digestPattern = /^sha256:[0-9a-f]{64}$/u;
    for (const repository of ['fsusblog', 'fsusui'])
    {
        const binding = receipt.sources[repository];
        exactKeys(binding, ['sha', 'authorityDigests', 'materializedClosureDigests', 'implementationClosureDigests'], `receipt_source_${repository}`);
        assertSha(binding.sha, `receipt_source_${repository}`);
        const materialized = binding.materializedClosureDigests;
        if (!materialized || Object.keys(materialized).length === 0)
        {
            throw new Error(`receipt_source_${repository}_empty`);
        }
        for (const [relative, file] of Object.entries(materialized))
        {
            if (relative.startsWith('/') || relative.includes('..'))
            {
                throw new Error(`receipt_source_${repository}_path`);
            }
            exactKeys(file, ['mode', 'objectId', 'digest'], `receipt_source_${repository}_file`);
            if (!['100644', '100755'].includes(file.mode) || !/^[0-9a-f]{40}$/u.test(file.objectId)
                || !digestPattern.test(file.digest))
            {
                throw new Error(`receipt_source_${repository}_file_identity`);
            }
        }
        for (const subset of ['authorityDigests', 'implementationClosureDigests'])
        {
            if (Object.keys(binding[subset] ?? {}).length === 0)
            {
                throw new Error(`receipt_source_${repository}_${subset}_empty`);
            }
            for (const [relative, file] of Object.entries(binding[subset]))
            {
                if (canonical(file) !== canonical(materialized[relative]))
                {
                    throw new Error(`receipt_source_${repository}_${subset}_unbound`);
                }
            }
        }
    }
    exactKeys(receipt.runtimeDependencies, ['uiJson5'], 'receipt_runtime_dependencies');
    exactKeys(receipt.runtimeDependencies.uiJson5, ['packageTreeDigest', 'files'], 'receipt_ui_json5');
    if (!digestPattern.test(receipt.runtimeDependencies.uiJson5.packageTreeDigest)
        || Object.values(receipt.runtimeDependencies.uiJson5.files).some((digest) => !digestPattern.test(digest)))
    {
        throw new Error('receipt_ui_json5_digest');
    }
    if (!Array.isArray(receipt.cases) || receipt.cases.length === 0
        || new Set(receipt.cases.map((item) => item.id)).size !== receipt.cases.length
        || receipt.cases.some((item) => !item.id || typeof item.pass !== 'boolean'
            || typeof item.repositoryPass?.fsusblog !== 'boolean' || typeof item.repositoryPass?.fsusui !== 'boolean'))
    {
        throw new Error('receipt_cases');
    }
    if (canonical(receipt.repositories) !== canonical(['fsusblog', 'fsusui'].map((name) => ({
        name, status: receipt.cases.every((item) => item.repositoryPass[name]) ? 'pass' : 'fail'
    }))))
    {
        throw new Error('receipt_repository_status');
    }
    if (receipt.receiptDigest !== sha256(canonical(receiptPayload(receipt))))
    {
        throw new Error('receipt_digest');
    }
    const ids = receipt.cases.flatMap((entry) => entry.prIds ?? [])
        .concat(receipt.cases.flatMap((entry) => entry.runIds ?? []));
    if (ids.some((id) => typeof id !== 'string' || !id.startsWith('simulated:')))
    {
        throw new Error('receipt_non_simulated_id');
    }
    return receipt;
}

export function assertReceiptReplay(receipt, replayed)
{
    if (canonical(replayed) !== canonical(receipt))
    {
        throw new Error('receipt_replay_mismatch');
    }
    return true;
}

export async function runAcceptance({ blogRepository, blogSha, uiRepository, uiSha, uiJson5Package, fixtures })
{
    validateFixtures(fixtures);
    const blogBinding = bindRepository(blogRepository, blogSha, blogClosure);
    const uiBinding = bindRepository(uiRepository, uiSha, uiClosure);
    const producerPath = 'tools/governance/cross-repository-dependency-acceptance.mjs';
    const fixturePath = 'tests/fixtures/governance/cross-repository-dependency-acceptance.json';
    if (sha256(fs.readFileSync(fileURLToPath(import.meta.url))) !== blogBinding.files[producerPath].digest)
    {
        throw new Error('acceptance_producer_not_source_bound');
    }
    assertFixtureBinding(fixtures, readGitBlob(blogBinding.repository, blogBinding.revision, fixturePath).content);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-cross-repo-acceptance-'));
    try
    {
        const blogRoot = path.join(root, 'fsusblog');
        const uiRoot = path.join(root, 'fsusui');
        materialize(blogBinding, blogClosure, blogRoot);
        materialize(uiBinding, uiClosure, uiRoot);
        const json5Binding = linkJson5(uiRoot, uiJson5Package);
        const cliSource = fs.readFileSync(path.join(uiRoot, 'scripts/deps-freshness.mjs'), 'utf8');
        const adapterSource = fs.readFileSync(path.join(uiRoot, 'scripts/dependency-freshness-adapters.mjs'), 'utf8');
        const reportSource = fs.readFileSync(path.join(uiRoot, 'scripts/deps-freshness-report.mjs'), 'utf8');
        const containmentErrors = auditUiFreshnessCli(`${cliSource}\n${adapterSource}`, reportSource);
        if (containmentErrors.length > 0)
        {
            throw new Error(`ui_freshness_containment:${containmentErrors.join(',')}`);
        }
        const modules = await loadModules(blogRoot, uiRoot);
        const models = {
            blogCatalog: json(path.join(blogRoot, 'config/dependencies/required-checks.json')),
            blogSurface: json(path.join(blogRoot, 'config/dependencies/update-surface.json')),
            blogRenovate: json(path.join(blogRoot, 'renovate.json5')),
            blogWorkflowChecks: modules.blogChecks.discoverWorkflowChecks(blogRoot), blogRoot,
            ui: modules.uiPolicy.loadPolicyModels(uiRoot), uiRoot
        };
        const cases = [
            ...runAutomergeCases(fixtures, models, modules),
            ...runFreshnessCases(fixtures, models, modules, { binding: uiBinding }),
            ...runBranchCases(fixtures, models, modules),
            ...runDelegatedCases(fixtures, modules),
            ...await runBlockerCases(fixtures, models, modules),
            ...runCrossRepositoryCases(fixtures)
        ];
        const repositories = ['fsusblog', 'fsusui'].map((name) => ({
            name,
            status: cases.every((item) => item.repositoryPass?.[name] !== false) ? 'pass' : 'fail'
        }));
        const payload = {
            schema: receiptSchema, evidenceClass,
            terminalQualification: cases.every((item) => item.pass),
            qualification: {
                mode: 'explicit-user-authorized-local-equivalent',
                hostedEvidenceClaimed: false,
                platformDisclosure: jsonValue(fixtures.platformDisclosure)
            },
            fixtureDigest: sha256(canonical(fixtures)),
            sources: {
                fsusblog: {
                    sha: blogSha,
                    authorityDigests: Object.fromEntries(digestPaths.fsusblog.map((entry) => [entry, blogBinding.files[entry]])),
                    materializedClosureDigests: blogBinding.files,
                    implementationClosureDigests: Object.fromEntries(blogClosure
                        .filter((entry) => entry.endsWith('.mjs')).map((entry) => [entry, blogBinding.files[entry]]))
                },
                fsusui: {
                    sha: uiSha,
                    authorityDigests: Object.fromEntries(digestPaths.fsusui.map((entry) => [entry, uiBinding.files[entry]])),
                    materializedClosureDigests: uiBinding.files,
                    implementationClosureDigests: Object.fromEntries(uiClosure
                        .filter((entry) => entry.endsWith('.mjs')).map((entry) => [entry, uiBinding.files[entry]]))
                }
            },
            runtimeDependencies: { uiJson5: json5Binding },
            containment: {
                network: 'explicit-npm-gh-curl-adapter-allowlist', platformWrites: 'forbidden',
                producer: 'exact-fsusblog-git-blob',
                unlistedCommand: 'exit-97', cliAudit: 'pass', childCwd: 'exact-temporary-fixture-root',
                clock: 'explicit-controlled-node-preload', adapterRuntime: process.execPath,
                sandboxWrites: ['<fixture-root>/result.json', '<fixture-root>/adapter-state/calls.jsonl'],
                childEnvironment: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'FSUS_ACCEPTANCE_FACTS', 'FSUS_ACCEPTANCE_CALLS']
            },
            cases, repositories, warnings: [],
            status: cases.every((item) => item.pass) ? 'pass' : 'fail'
        };
        const serializable = jsonValue(payload);
        return validateReceipt({ ...serializable, receiptDigest: sha256(canonical(serializable)) });
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

export async function verifyReceipt({ receipt, ...options })
{
    validateReceipt(receipt);
    const replayed = await runAcceptance(options);
    assertReceiptReplay(receipt, replayed);
    return { status: 'pass', receiptDigest: receipt.receiptDigest };
}

function parseArguments(argv)
{
    const values = { command: argv[0] };
    for (let index = 1; index < argv.length; index += 2)
    {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined)
        {
            throw new Error('invalid_arguments');
        }
        values[key.slice(2)] = value;
    }
    return values;
}

async function main(argv)
{
    const args = parseArguments(argv);
    if (!['run', 'verify'].includes(args.command))
    {
        throw new Error('usage: run|verify --blog-repository <path> --blog-sha <sha> --ui-repository <path> --ui-sha <sha> --ui-json5-package <path> --fixtures <path> [--output|--receipt <path>]');
    }
    const options = {
        blogRepository: args['blog-repository'], blogSha: args['blog-sha'],
        uiRepository: args['ui-repository'], uiSha: args['ui-sha'], uiJson5Package: args['ui-json5-package'],
        fixtures: validateFixtures(json(args.fixtures))
    };
    if (args.command === 'run')
    {
        if (!args.output)
        {
            throw new Error('run_requires_output');
        }
        const receipt = await runAcceptance(options);
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(receipt, null, 2)}\n`);
        console.log(JSON.stringify({ status: receipt.status, receiptDigest: receipt.receiptDigest }));
        process.exitCode = receipt.status === 'pass' ? 0 : 1;
        return;
    }
    if (!args.receipt)
    {
        throw new Error('verify_requires_receipt');
    }
    console.log(JSON.stringify(await verifyReceipt({ ...options, receipt: json(args.receipt) })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main(process.argv.slice(2)).catch((error) =>
    {
        console.error(`[cross-repository-dependency-acceptance] FAIL ${error.message}`);
        process.exitCode = 2;
    });
}
