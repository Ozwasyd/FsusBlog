import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { msbuildSourceFiles } from './msbuild-source-inspector.mjs';
import { opaqueFixtureSourceChecker, opaqueFixtureSourceConsumer, opaqueFixtureSourceRegressions, selectOpaqueFixtureSourceRegressions } from './opaque-fixture-source-ownership.mjs';

const { canonicalTestDeclarationOutputs } = await import(
    new URL('../frontend/canonical-test-declaration-inputs.mjs', import.meta.url)
);

const eligiblePrTier = tier => tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true
    && !['nightly', 'release-manual'].includes(tier.cadence);

const coordinationIds = ['validate-declarations', 'pr-smart-gate-plan', 'source-governance'];
const partialJobs = new Set(['backend-qps-collectors', 'release-evidence', 'production-summary', 'browser-diagnostics']);
const sharedPaths = [
    '.github/workflows', 'config/testing', 'config/schemas', 'tests/matrix.yml',
    'tests/matrix.schema.json', 'tests/coverage-registry.json', 'tools/test-matrix',
    'tools/run-test-matrix.mjs', 'tools/check-workflow-matrix-sync.mjs',
    'tools/test.sh', 'tools/test/lanes', 'tools/test/bundles', 'tools/governance',
    'tools/docs/behavior-doc-static-admission.mjs', 'tools/fact-extractors',
    'docs/testing.md', 'docs/development/change-contract.md', 'docs/testing',
    'tests/fixtures/test-matrix/release-final-execution-target-authority.json',
    'global.json', 'NuGet.config', 'Directory.Build.props', 'Directory.Build.targets'
];

export function matchesImpactPath(file, pattern)
{
    if (typeof pattern !== 'string' || !pattern)
    {
        return false;
    }
    if (!pattern.includes('*'))
    {
        return file === pattern || file.startsWith(`${pattern.replace(/\/$/u, '')}/`);
    }
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
        .replaceAll('**', '\u0000').replaceAll('*', '[^/]*').replaceAll('\u0000', '.*');
    return new RegExp(`^${escaped}$`, 'u').test(file);
}

export function validateImpactDeclarations(matrix)
{
    const errors = [];
    const byId = new Map();
    for (const tier of matrix.tiers ?? [])
    {
        if (!tier.id || byId.has(tier.id))
        {
            errors.push(`missing or duplicate tier: ${tier.id}`);
        }
        byId.set(tier.id, tier);
        if (!Array.isArray(tier.executionDependsOn))
        {
            errors.push(`${tier.id} must declare executionDependsOn`);
        }
    }
    const visited = new Set();
    const visiting = new Set();
    function visit(id)
    {
        if (visiting.has(id))
        {
            errors.push(`execution dependency cycle: ${id}`);
            return;
        }
        if (visited.has(id))
        {
            return;
        }
        const tier = byId.get(id);
        if (!tier)
        {
            errors.push(`unknown execution dependency: ${id}`);
            return;
        }
        visiting.add(id);
        for (const dep of tier.executionDependsOn ?? [])
        {
            if (byId.get(dep)?.phase > tier.phase)
            {
                errors.push(`${id} has a later-phase dependency: ${dep}`);
            }
            visit(dep);
        }
        for (const dep of tier.requiresEvidenceFrom ?? [])
        {
            if (!byId.has(dep))
            {
                errors.push(`${id} has an unknown evidence dependency: ${dep}`);
            }
        }
        visiting.delete(id);
        visited.add(id);
    }
    for (const id of byId.keys())
    {
        visit(id);
    }
    return errors;
}

export function readGitChangedPaths(repositoryRoot, baseRef)
{
    if (typeof baseRef !== 'string' || !/^(?:[a-f0-9]{40}|(?:refs\/)?[A-Za-z0-9][A-Za-z0-9._/-]*)$/u.test(baseRef))
    {
        throw new Error('PR impact requires an explicit valid base ref');
    }
    const git = args => execFileSync('git', ['-C', repositoryRoot, ...args], { encoding: 'utf8' }).trim();
    if (git(['status', '--porcelain', '--untracked-files=all']))
    {
        throw new Error('PR impact requires a clean committed source candidate');
    }
    const baseCommit = git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
    const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const mergeBase = git(['merge-base', baseCommit, headCommit]);
    const raw = execFileSync('git', ['-C', repositoryRoot, 'diff', '--name-only', '-z', '--no-renames', `${mergeBase}..${headCommit}`]);
    const changedFiles = raw.toString('utf8').split('\0').filter(Boolean).sort();
    if (changedFiles.some(file => file.startsWith('/') || file.split('/').includes('..') || /[\r\n]/u.test(file)))
    {
        throw new Error('PR impact contains an unsupported Git path');
    }
    return { baseCommit, headCommit, mergeBase, changedFiles,
        changedPathsDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}` };
}

export function selectAffectedPrTiers(matrix, changedFiles, { full = false, jobDependencies = new Map(), executionAuthority = null, stage = 'qualification' } = {})
{
    const errors = validateImpactDeclarations(matrix);
    if (errors.length)
    {
        throw new Error(errors.join('\n'));
    }
    if (!['qualification', 'source-integration'].includes(stage))
    {
        throw new Error(`unknown PR execution stage: ${stage}`);
    }
    const tiers = matrix.tiers;
    if (stage === 'source-integration' && !full)
    {
        const qualification = selectAffectedPrTiers(matrix, changedFiles, { jobDependencies, executionAuthority });
        const selectedTierIds = coordinationIds.filter(id => tiers.some(tier => tier.id === id)).sort();
        if (selectedTierIds.length !== coordinationIds.length)
        {
            throw new Error('source integration requires every declared source coordination gate');
        }
        return { selectedTierIds, fullMode: false, selectionScope: 'source-integration',
            reason: 'explicit source integration; product qualification is deferred, never passed',
            reasons: Object.fromEntries(selectedTierIds.map(id => [id, 'mandatory source integration gate'])),
            sourceRegressionTargets: selectSourceRegressionTargets(changedFiles),
            deferredQualificationTierIds: qualification.selectedTierIds.filter(id => !selectedTierIds.includes(id)),
            fullQualificationTierIds: tiers.map(tier => tier.id).sort() };
    }
    const byId = new Map(tiers.map(tier => [tier.id, tier]));
    const selected = new Set(coordinationIds.filter(id => byId.has(id)));
    const reasons = new Map([...selected].map(id => [id, 'source declaration, impact plan and applicable source checks']));
    let fullReason = full ? 'explicit full/push/release execution' : null;
    for (const file of changedFiles)
    {
        if (sharedPaths.some(pattern => matchesImpactPath(file, pattern)))
        {
            fullReason = `shared governance or selection authority changed: ${file}`;
            break;
        }
        let matched = false;
        for (const target of executionAuthority?.targets ?? [])
        {
            if (target.target === file || (target.dependencyClosure ?? []).includes(file))
            {
                for (const owner of target.owners ?? [])
                {
                    if (!byId.has(owner))
                    {
                        throw new Error(`indexed dependency has an unknown tier owner: ${owner}`);
                    }
                    if (!full && !eligiblePrTier(byId.get(owner)))
                    {
                        continue;
                    }
                    selected.add(owner);
                    reasons.set(owner, `indexed execution consumer of changed source: ${file}`);
                    matched = true;
                }
            }
        }
        // These changes still receive the declared source-governance leaf and
        // the independent Change Contract workflow; they confer no qualification.
        if ((!matched && file.startsWith('docs/') && file.endsWith('.md')) || /^artifacts\/change-contract\/[A-Za-z0-9-]+-(?:external-naming|generated-binding)\.json$/u.test(file))
        {
            continue;
        }
        for (const tier of tiers)
        {
            if (!eligiblePrTier(tier) || coordinationIds.includes(tier.id) || tier.id === 'validate-matrix')
            {
                continue;
            }
            const inputs = [...(tier.triggerFiles ?? []), ...(tier.triggerPaths ?? []), ...(tier.cacheInputs ?? [])];
            const target = String(tier.command ?? '').split(/\s+/u).find(value => /^(?:tools|tests)\//u.test(value));
            if (target)
            {
                inputs.push(target);
            }
            if (inputs.some(pattern => matchesImpactPath(file, pattern)))
            {
                selected.add(tier.id);
                reasons.set(tier.id, `changed source input: ${file}`);
                matched = true;
            }
        }
        if (!matched)
        {
            fullReason = `unknown or undeclared source impact: ${file}`;
            break;
        }
    }
    if (full)
    {
        return { selectedTierIds: tiers.map(tier => tier.id).sort(), fullMode: true,
            reason: fullReason, selectionScope: 'full', reasons: Object.fromEntries(tiers.map(tier => [tier.id, fullReason])) };
    }
    if (fullReason)
    {
        for (const tier of tiers.filter(eligiblePrTier))
        {
            selected.add(tier.id);
            reasons.set(tier.id, fullReason);
        }
    }
    let previousSize;
    do
    {
        previousSize = selected.size;
        const fixedJobs = new Set([...selected].map(id => byId.get(id).ciJob).filter(id => !partialJobs.has(id)));
        for (const tier of tiers)
        {
            if (fixedJobs.has(tier.ciJob) && eligiblePrTier(tier))
            {
                selected.add(tier.id);
                reasons.set(tier.id, reasons.get(tier.id) ?? `complete fixed workflow job: ${tier.ciJob}`);
            }
        }
        for (const id of [...selected])
        {
            const tier = byId.get(id);
            for (const dep of [...tier.executionDependsOn, ...(tier.requiresEvidenceFrom ?? [])])
            {
                selected.add(dep);
                reasons.set(dep, reasons.get(dep) ?? `required execution/evidence dependency of ${id}`);
            }
        }
        const selectedJobs = new Set([...selected].map(id => byId.get(id).ciJob));
        for (const authority of Object.values(matrix.aggregateAuthorities ?? {}))
        {
            if ((authority.summaryTierIds ?? []).some(id => selected.has(id)))
            {
                selectedJobs.add(authority.ciJob);
            }
        }
        for (const job of selectedJobs)
        {
            for (const dependencyJob of jobDependencies.get(job) ?? [])
            {
                const summaryIds = Object.values(matrix.aggregateAuthorities ?? {})
                    .filter(authority => authority.ciJob === dependencyJob).flatMap(authority => authority.summaryTierIds ?? []);
                const prerequisites = tiers.filter(tier => (tier.ciJob === dependencyJob || summaryIds.includes(tier.id))
                    && eligiblePrTier(tier));
                if (!prerequisites.length)
                {
                    throw new Error(`selected workflow job ${job} has an undeclared prerequisite: ${dependencyJob}`);
                }
                for (const tier of prerequisites)
                {
                    selected.add(tier.id);
                    reasons.set(tier.id, reasons.get(tier.id) ?? `required workflow prerequisite of ${job}`);
                }
            }
        }
    }
    while (selected.size !== previousSize);
    return { selectedTierIds: [...selected].sort(), fullMode: false,
        reason: fullReason ?? 'affected source and complete applicable execution/evidence closure',
        selectionScope: fullReason ? 'complete-pr' : 'affected-pr', reasons: Object.fromEntries(reasons) };
}

export function validatePrImpactPlanBinding(plan, { evidence, actualFingerprint, selectedTierIds, selectedJobs, deferredQualificationTierIds, fullQualificationTierIds, callerContext })
{
    function canonical(value)
    {
        if (Array.isArray(value))
        {
            return value.map(canonical);
        }
        return value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    }
    if (!callerContext || plan.baseRef !== callerContext.baseRef
        || plan.eventName !== callerContext.eventName || plan.runId !== callerContext.runId
        || plan.runAttempt !== callerContext.runAttempt
        || (plan.executionStage ?? 'qualification') !== effectivePrExecutionStage(callerContext)
        || plan.fullMode !== (callerContext.full || ['push', 'workflow_dispatch'].includes(callerContext.eventName))
        || (callerContext.expectedDigest && plan.contentDigest !== callerContext.expectedDigest))
    {
        throw new Error('PR plan differs from the independent caller base/event/run/attempt/digest authority');
    }
    if (effectivePrExecutionStage(callerContext) === 'source-integration'
        && (JSON.stringify(plan.sourceRegressionTargets) !== JSON.stringify(selectSourceRegressionTargets(evidence.changedFiles))
            || JSON.stringify(plan.deferredQualificationTierIds) !== JSON.stringify(deferredQualificationTierIds)
            || JSON.stringify(plan.fullQualificationTierIds) !== JSON.stringify(fullQualificationTierIds)))
    {
        throw new Error('source stage differs from independently rebuilt regression and deferred qualification rosters');
    }
    const unsigned = { ...plan };
    delete unsigned.contentDigest;
    const digest = `sha256:${createHash('sha256').update(JSON.stringify(canonical(unsigned))).digest('hex')}`;
    if (digest !== plan.contentDigest || plan.sourceState?.commit !== evidence.headCommit
        || String(plan.sourceState?.worktreeFingerprint).replace(/^sha256:/u, '') !== actualFingerprint.replace(/^sha256:/u, '')
        || JSON.stringify(plan.changedPathEvidence) !== JSON.stringify(evidence)
        || JSON.stringify(plan.selectedTierIds) !== JSON.stringify(selectedTierIds)
        || JSON.stringify(plan.selectedJobs) !== JSON.stringify(selectedJobs))
    {
        throw new Error('PR selection requires actual Git/source identity and the independently rebuilt complete applicable plan');
    }
}

export function prImpactCallerContext(environment = process.env, overrides = {})
{
    const context = { baseRef: environment.FSUSBLOG_BASE_REF ?? environment.GITHUB_BASE_REF ?? 'origin/master',
        eventName: environment.GITHUB_EVENT_NAME ?? environment.FSUSBLOG_PR_EVENT_NAME ?? 'local',
        runId: String(environment.GITHUB_RUN_ID ?? 'local'), runAttempt: String(environment.GITHUB_RUN_ATTEMPT ?? '0'),
        full: environment.FSUSBLOG_SMART_GATE_FULL === '1' || environment.FSUSBLOG_RELEASE_FINAL === '1',
        stage: environment.FSUSBLOG_CI_STAGE ?? 'qualification',
        expectedDigest: environment.FSUSBLOG_PR_PLAN_DIGEST ?? null, ...overrides };
    if (environment.FSUSBLOG_CI_STAGE && overrides.stage && environment.FSUSBLOG_CI_STAGE !== overrides.stage)
    {
        throw new Error('PR stage disagrees with the independent caller environment');
    }
    effectivePrExecutionStage(context);
    if (environment.GITHUB_ACTIONS === 'true' && !context.expectedDigest)
    {
        throw new Error('CI plan consumption requires the original planner output digest');
    }
    return context;
}

export function prImpactConsumerEnvironment(context)
{
    return {
        FSUSBLOG_BASE_REF: context.baseRef,
        FSUSBLOG_PR_EVENT_NAME: context.eventName,
        FSUSBLOG_PR_PLAN_DIGEST: context.expectedDigest ?? '',
        FSUSBLOG_SMART_GATE_FULL: context.full ? '1' : '0',
        FSUSBLOG_CI_STAGE: effectivePrExecutionStage(context)
    };
}

export const sourceGovernanceExecutionTarget = 'tools/test-matrix/source-governance.mjs';
export const sourceGovernanceChildEntries = Object.freeze({
    frontend: 'tools/frontend/check-frontend-style.mjs',
    csharp: 'tools/dotnet/check-csharp-style.mjs',
    solution: 'tools/configuration/check-solution-source.mjs',
    docs: 'tools/style/check-native-tooling-style.mjs',
    lifecycle: 'tools/docs/generate-document-lifecycle.mjs',
    opaqueFixture: opaqueFixtureSourceChecker
});


export function effectivePrExecutionStage(context)
{
    const stage = context.stage ?? 'qualification';
    if (!['qualification', 'source-integration'].includes(stage))
    {
        throw new Error(`unknown PR execution stage: ${stage}`);
    }
    if (context.full || ['push', 'workflow_dispatch'].includes(context.eventName))
    {
        return 'qualification';
    }
    return stage;
}

// Explicit source-only regression ports. Their complete current AST/index closure
// belongs to source-governance; no other test or runtime command is admitted here.
export const sourceRegressionEntries = Object.freeze([
    'tests/tools/pr-impact-plan.test.mjs',
    'tests/tools/pr-applicable-execution-authority.test.mjs',
    'tools/frontend/source-unit-style-diff.test.mjs',
    'tests/tools/native-tooling-style.test.mjs',
    'tools/configuration/solution-source.test.mjs',
    'tests/tools/canonical-declaration-source.test.mjs'
]);

export function selectSourceRegressionTargets(changedFiles)
{
    const original = changedFiles.some(file => sharedPaths.some(pattern => matchesImpactPath(file, pattern))
        || sourceRegressionEntries.includes(file)
        || matchesImpactPath(file, 'tools/frontend/check-frontend-style.mjs')
        || matchesImpactPath(file, 'tools/frontend/source-unit-style-diff.mjs')
        || matchesImpactPath(file, 'tools/style/check-native-tooling-style.mjs')
        || matchesImpactPath(file, 'tools/configuration/check-canonical-declaration-source.mjs')
        || matchesImpactPath(file, 'tools/configuration/canonical-workspace-source.mjs')
        || matchesImpactPath(file, 'tools/frontend/generate-canonical-test-declarations.mjs')
        || matchesImpactPath(file, 'tools/frontend/canonical-test-declaration-inputs.mjs')
        || matchesImpactPath(file, 'src/frontend/scripts/prepare-local-fsusui-install.mjs')
        || matchesImpactPath(file, 'src/frontend/scripts/run-local-fsusui-typecheck.mjs')
        || isCanonicalTestDeclarationSource(file)
        || matchesImpactPath(file, 'tools/configuration/check-solution-source.mjs')) ? [...sourceRegressionEntries]
        : changedFiles.some(file => file.endsWith('.slnx') || file.endsWith('.py')
            || file === '.git-blame-ignore-revs') ? ['tools/configuration/solution-source.test.mjs'] : [];
    return [...new Set([...original, ...selectOpaqueFixtureSourceRegressions(changedFiles)])];
}

export function sourceGovernanceExecutableEntries()
{
    return [...Object.values(sourceGovernanceChildEntries), ...sourceRegressionEntries,
        ...opaqueFixtureSourceRegressions, opaqueFixtureSourceConsumer];
}


export function sourceRegressionArguments(entry)
{
    if (![...sourceRegressionEntries, ...opaqueFixtureSourceRegressions].includes(entry))
    {
        throw new Error(`unknown source regression entry: ${entry}`);
    }
    return entry === 'tests/tools/native-tooling-style.test.mjs'
        ? ['--test', '--test-name-pattern=^(?:native fragment mock span transport|original Markdown adapter package boundary)', entry]
        : ['--test', entry];
}


// Known structured data receives the declaration/closed-input source checks;
// it never grants executable authority. Every other unchecked surface is explicit.
export function isScriptDeclarationSource(file)
{
    return typeof file === 'string' && file.startsWith('src/frontend/scripts/')
        && /\.d\.(?:mts|cts)$/u.test(file) && !/[\\\0\r\n]/u.test(file)
        && file.split('/').every(part => part && part !== '.' && part !== '..');
}

export function isCanonicalTestDeclarationSource(file)
{
    return typeof file === 'string' && canonicalTestDeclarationOutputs.includes(file);
}

export function sourceStageInspectionFiles(presentFiles, changedFiles)
{
    return [...new Set([...presentFiles, ...changedFiles.filter(file => isScriptDeclarationSource(file)
        || isCanonicalTestDeclarationSource(file) || msbuildSourceFiles.includes(file))])];
}

export function unsupportedSourceStageFiles(files, checkedSolutions = [], checkedPython = [], checkedBlame = [], checkedDeclarations = [], checkedMsbuild = [])
{
    return files.filter(file => !/\.(?:mjs|js|cjs|ts|tsx|vue|css|scss|cs|md|sh|json|yaml|yml)$/u.test(file)
        && !(file.endsWith('.slnx') && checkedSolutions.includes(file))
        && !(file.endsWith('.py') && checkedPython.includes(file))
        && !(file === '.git-blame-ignore-revs' && checkedBlame.includes(file))
        && !((isScriptDeclarationSource(file) || isCanonicalTestDeclarationSource(file)) && checkedDeclarations.includes(file))
        && !(msbuildSourceFiles.includes(file) && checkedMsbuild.includes(file))
        && !['.gitignore', '.gitattributes', '.editorconfig'].includes(file));
}


export function sourceShellSyntaxArguments(file)
{
    if (typeof file !== 'string' || !file.endsWith('.sh') || file.startsWith('/')
        || file.startsWith('-') || file.split('/').includes('..') || ['\\', '\0', '\r', '\n'].some(character => file.includes(character)))
    {
        throw new Error('source shell syntax requires an actual repository-relative .sh input');
    }
    return ['-n', '--', file];
}


// Fixed repository inputs of the reviewed frontend SOURCE checker/parser contract.
// These are data/configuration witnesses, never executable child ports.
export const sourceFrontendDataInputs = Object.freeze([
    'config/development/frontend-style-policy.json',
    'config/development/frontend-style-rule-registry.json',
    'tools/frontend/style-toolchain/package.json',
    'tools/frontend/style-toolchain/package-lock.json',
    '.editorconfig', 'eslint.config.mjs', 'stylelint.config.mjs',
    'src/frontend/eslint.config.mjs', 'src/frontend/stylelint.config.mjs',
    'tools/frontend/style-toolchain/eslint.config.mjs',
    'tools/frontend/style-toolchain/stylelint.config.mjs',
    'src/frontend/tsconfig.node.json',
    'src/frontend/tsconfig.playwright.json'
]);

export const sourceGovernanceDataInputs = Object.freeze([
    ...sourceFrontendDataInputs,
    'config/development/canonical-digest-edge.json',
    'config/development/opaque-source-fixture-policy.json'
]);

export function assertSourceShellSyntaxInspection(input)
{
    if (!Array.isArray(input?.errors) || input.errors.length
        || !/^sha256:[a-f0-9]{64}$/u.test(input.contentDigest ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(input.indexDigest ?? ''))
    {
        throw new Error(`shell syntax source/index inspection refused: ${(input?.errors ?? []).join('; ')}`);
    }
}

export function inspectSourceFrontendConfiguration(repositoryRoot, baseCommit)
{
    if (typeof repositoryRoot !== 'string' || !/^[a-f0-9]{40}$/u.test(baseCommit ?? ''))
    {
        throw new Error('SOURCE frontend configuration requires the actual repository and exact base commit');
    }
    const git = args => execFileSync('git', ['-C', repositoryRoot, ...args]);
    git(['merge-base', '--is-ancestor', baseCommit, 'HEAD']);
    function read(file, revision, required)
    {
        if (typeof file !== 'string' || !file || file.startsWith('/') || file.startsWith('-')
            || file.split('/').includes('..') || /[\\\0\r\n]/u.test(file))
        {
            throw new Error('SOURCE frontend configuration contains an invalid input path');
        }
        const record = git(['ls-tree', '-z', revision, '--', file]).toString('utf8');
        if (!record && !required)
        {
            return null;
        }
        if (!/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(record)
            || record.slice(record.indexOf('\t') + 1) !== `${file}\0`)
        {
            throw new Error(`SOURCE frontend configuration requires a tracked regular input: ${file}`);
        }
        if (revision !== 'HEAD')
        {
            return git(['show', `${revision}:${file}`]);
        }
        const absolute = path.resolve(repositoryRoot, file);
        if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()
            || !fs.realpathSync(absolute).startsWith(`${fs.realpathSync(repositoryRoot)}${path.sep}`))
        {
            throw new Error(`SOURCE frontend configuration refuses a nonregular or escaped input: ${file}`);
        }
        return fs.readFileSync(absolute);
    }
    const policyPath = 'config/development/frontend-style-policy.json';
    const priorPolicy = JSON.parse(read(policyPath, baseCommit, true));
    const currentPolicy = JSON.parse(read(policyPath, 'HEAD', true));
    function inputs(policy)
    {
        if (!Array.isArray(policy.configurationSources) || !policy.configurationSources.length)
        {
            throw new Error('SOURCE frontend configuration requires the complete policy input set');
        }
        return new Set([...sourceFrontendDataInputs, ...policy.configurationSources,
            policy.ruleRegistry, policy.toolchain?.package, policy.toolchain?.lock,
            policy.eslintConfig, policy.stylelintConfig]);
    }
    const priorInputs = inputs(priorPolicy);
    const currentInputs = inputs(currentPolicy);
    const identities = [...new Set([...priorInputs, ...currentInputs])].sort().map(file =>
    {
        const prior = read(file, baseCommit, priorInputs.has(file));
        const current = read(file, 'HEAD', currentInputs.has(file));
        const digest = bytes => bytes === null ? null : `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        return { file, baseDigest: digest(prior), currentDigest: digest(current) };
    });
    return { baseCommit, changed: identities.some(value => value.baseDigest !== value.currentDigest), identities };
}

export function sourceFrontendCheckGroups(files, stage, baseCommit, repositoryRoot)
{
    const applicable = files.filter(file => /\.(?:mjs|js|cjs|ts|tsx|vue|css|scss)$/u.test(file)
        || isScriptDeclarationSource(file));
    if (stage !== 'source-integration')
    {
        return [{ options: ['--mode', 'strict-full'], files: applicable }];
    }
    const configuration = inspectSourceFrontendConfiguration(repositoryRoot, baseCommit);
    const actual = readGitChangedPaths(repositoryRoot, baseCommit).changedFiles
        .filter(file => fs.existsSync(path.join(repositoryRoot, file))).sort();
    if (JSON.stringify([...files].sort()) !== JSON.stringify(actual))
    {
        throw new Error('SOURCE frontend routing requires the complete actual changed-source scope');
    }
    if (configuration.changed)
    {
        return [{ options: ['--mode', 'strict-full'], files: applicable }];
    }
    return [
        { options: ['--mode', 'source-diff', '--base', baseCommit],
            files: applicable.filter(file => /\.(?:mjs|js|cjs)$/u.test(file)) },
        { options: ['--mode', 'strict-full'],
            files: applicable.filter(file => /\.(?:ts|tsx|vue|css|scss)$/u.test(file) || isScriptDeclarationSource(file)) }
    ];
}
