import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectMsbuildSource, msbuildSourceFiles, validateMsbuildSourceReceipt } from './msbuild-source-inspector.mjs';
import { parseMatrix } from './parse-matrix.mjs';
import { readGitChangedPaths, selectAffectedPrTiers, validatePrImpactPlanBinding, prImpactCallerContext, sourceGovernanceChildEntries, effectivePrExecutionStage, sourceRegressionArguments, unsupportedSourceStageFiles, sourceShellSyntaxArguments, assertSourceShellSyntaxInspection, sourceFrontendCheckGroups, sourceGovernanceDataInputs, isScriptDeclarationSource, isCanonicalTestDeclarationSource, sourceStageInspectionFiles } from './pr-impact-plan.mjs';
import { inspectReleaseFinalCommandTarget, validateReleaseFinalStaticBoundary, validateSourceGovernanceChildExecution } from './release-final-static-boundary.mjs';
import { snapshotGitWorktree } from './scheduler.mjs';
const { parseWorkflowJobNeeds } = await import(new URL('../yaml/workflow-structure.mjs', import.meta.url));
const { inspectCanonicalDeclarationSource, validateCanonicalDeclarationSourceReceipt } = await import(
    new URL('../configuration/check-canonical-declaration-source.mjs', import.meta.url)
);
const { validateSolutionSourceReceipt, validatePythonSourceReceipt, validateBlameIgnoreSourceReceipt } = await import(new URL('../configuration/check-solution-source.mjs', import.meta.url));

const root = fileURLToPath(new URL('../../', import.meta.url));
const plan = JSON.parse(fs.readFileSync(path.join(root, '.tmp/pr-plan.json'), 'utf8'));
const callerContext = prImpactCallerContext();
const evidence = readGitChangedPaths(root, callerContext.baseRef);
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const executionAuthority = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/test-matrix/release-final-execution-target-authority.json'), 'utf8'));
const selection = selectAffectedPrTiers(matrix, evidence.changedFiles, {
    full: callerContext.full || callerContext.eventName === 'push' || callerContext.eventName === 'workflow_dispatch',
    stage: effectivePrExecutionStage(callerContext),
    jobDependencies: parseWorkflowJobNeeds(fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8')),
    executionAuthority
});
const byId = new Map(matrix.tiers.map(tier => [tier.id, tier]));
const selectedJobs = [...new Set([...selection.selectedTierIds.map(id => byId.get(id).ciJob),
    ...Object.values(matrix.aggregateAuthorities ?? {}).filter(value => value.summaryTierIds.some(id => selection.selectedTierIds.includes(id))).map(value => value.ciJob)])].sort();
validatePrImpactPlanBinding(plan, { evidence, actualFingerprint: (await snapshotGitWorktree(root)).fingerprint,
    selectedTierIds: selection.selectedTierIds, selectedJobs,
    deferredQualificationTierIds: selection.deferredQualificationTierIds,
    fullQualificationTierIds: selection.fullQualificationTierIds, callerContext });
const authorityErrors = validateReleaseFinalStaticBoundary({ matrix, repositoryRoot: root,
    scriptSource: fs.readFileSync(path.join(root, 'tools/test/lanes/release-final.sh'), 'utf8'),
    selectedTierIds: plan.fullMode ? null : new Set(selection.selectedTierIds) });
if (authorityErrors.length || !selection.selectedTierIds.includes('source-governance'))
{
    throw new Error(`applicable source execution authority refused: ${authorityErrors.join('\n')}`);
}
// The matrix owns this leaf. These are existing scoped source checkers, not a
// second product DAG; compiled/runtime qualification is never issued here.
execFileSync('git', ['-C', root, 'diff', '--check', `${evidence.mergeBase}..HEAD`], { stdio: 'inherit' });
const files = evidence.changedFiles.filter(file => fs.existsSync(path.join(root, file)));
for (const file of files)
{
    const absolute = path.join(root, file);
    if (!fs.lstatSync(absolute).isFile() || !fs.realpathSync(absolute).startsWith(`${fs.realpathSync(root)}${path.sep}`))
    {
        throw new Error(`source check refuses a nonregular or escaped changed file: ${file}`);
    }
}
const groups = [
    ...sourceFrontendCheckGroups(files, effectivePrExecutionStage(callerContext), evidence.baseCommit, root)
        .map(value => [sourceGovernanceChildEntries.frontend, value.options, value.files]),
    [sourceGovernanceChildEntries.csharp, ['--mode', 'full'], files.filter(file => file.endsWith('.cs'))],
    [sourceGovernanceChildEntries.docs, ['--mode', 'full', '--domain', 'docs', '--operation', 'lint', '--require-tools'], files.filter(file => file.endsWith('.md'))],
    ...(effectivePrExecutionStage(callerContext) === 'source-integration'
        ? [[sourceGovernanceChildEntries.docs, ['--mode', 'full', '--domain', 'scripts', '--operation', 'lint'], files.filter(file => file.endsWith('.sh'))]] : [])
];
const results = [];
const checkedSolutions = [];
const checkedPython = [];
const checkedBlame = [];
const checkedDeclarations = [];
const checkedMsbuild = [];
if (effectivePrExecutionStage(callerContext) === 'source-integration')
{
    // The original SOURCE owner calls a read-only declaration parser directly;
    // no new executable child port or SDK/restore authority is introduced.
    const msbuildFiles = evidence.changedFiles.filter(file => msbuildSourceFiles.includes(file));
    if (msbuildFiles.length)
    {
        let receipt = null;
        let bindingError = null;
        try
        {
            receipt = inspectMsbuildSource({ repositoryRoot: root, files: msbuildFiles });
            validateMsbuildSourceReceipt({ repositoryRoot: root, files: msbuildFiles,
                expectedHead: evidence.headCommit, receipt });
            checkedMsbuild.push(...msbuildFiles);
        }
        catch (error)
        {
            bindingError = error.message;
            process.exitCode = 1;
        }
        results.push({ checker: 'tools/test-matrix/msbuild-source-inspector.mjs', files: msbuildFiles,
            status: bindingError ? 'failure' : 'success', qualificationEligible: false, receipt, bindingError });
    }
    const solutions = files.filter(file => file.endsWith('.slnx'));
    if (solutions.length)
    {
        const checker = sourceGovernanceChildEntries.solution;
        verifyChildBeforeSpawn(checker);
        const result = spawnSync(process.execPath, [checker, '--root', root,
            ...solutions.flatMap(file => ['--file', file])], { cwd: root, encoding: 'utf8' });
        let receipt;
        try
        {
            receipt = JSON.parse(result.stdout ?? '');
        }
        catch
        {
            receipt = null;
        }
        const actualFiles = receipt?.solutions?.map(value => value.file);
        let accepted = !result.error && result.status === 0
            && receipt?.schema === 'fsusblog.solution-source-check.v1' && receipt.status === 'success'
            && receipt.qualificationEligible === false && Array.isArray(actualFiles)
            && actualFiles.length === solutions.length
            && actualFiles.every((file, index) => file === solutions[index]);
        let bindingError = null;
        if (accepted)
        {
            try
            {
                validateSolutionSourceReceipt({ repositoryRoot: root, files: solutions,
                    expectedHead: evidence.headCommit, receipt });
            }
            catch (error)
            {
                bindingError = error.message;
                accepted = false;
            }
        }
        results.push({ checker, files: solutions, exitCode: result.status,
            status: accepted ? 'success' : 'failure', qualificationEligible: false, receipt,
            stderr: result.stderr ?? '', spawnError: result.error?.message ?? null, bindingError });
        if (accepted)
        {
            checkedSolutions.push(...solutions);
        }
        else
        {
            process.exitCode = 1;
        }
    }
    const pythonFiles = files.filter(file => file.endsWith('.py'));
    if (pythonFiles.length)
    {
        const checker = sourceGovernanceChildEntries.solution;
        verifyChildBeforeSpawn(checker);
        const result = spawnSync(process.execPath, [checker, '--language', 'python-ast', '--root', root,
            ...pythonFiles.flatMap(file => ['--file', file])], { cwd: root, encoding: 'utf8' });
        let receipt;
        let bindingError = null;
        let accepted = false;
        try
        {
            receipt = JSON.parse(result.stdout ?? '');
            if (result.error || result.status !== 0)
            {
                throw new Error('Python AST source checker failed');
            }
            validatePythonSourceReceipt({ repositoryRoot: root, files: pythonFiles,
                expectedHead: evidence.headCommit, receipt });
            accepted = true;
        }
        catch (error)
        {
            bindingError = error.message;
        }
        results.push({ checker, mode: 'python-ast', files: pythonFiles, exitCode: result.status,
            status: accepted ? 'success' : 'failure', qualificationEligible: false, receipt,
            stderr: result.stderr ?? '', spawnError: result.error?.message ?? null, bindingError });
        if (accepted)
        {
            checkedPython.push(...pythonFiles);
        }
        else
        {
            process.exitCode = 1;
        }
    }
    for (const file of files.filter(value => value.endsWith('.sh')))
    {
        // This binds source input through the original recursive regular-path/index reader.
        // It is a syntax-only input; no script execution or runtime grant follows.
        const input = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: file });
        assertSourceShellSyntaxInspection(input);
        const result = spawnSync('bash', sourceShellSyntaxArguments(file), { cwd: root, stdio: 'inherit' });
        const after = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: file });
        assertSourceShellSyntaxInspection(after);
        if (input.contentDigest !== after.contentDigest || input.indexDigest !== after.indexDigest)
        {
            throw new Error(`shell syntax input drifted: ${file}`);
        }
        const tools = ['shellcheck', 'shfmt'].map(tool => ({ tool,
            available: (process.env.PATH ?? '').split(path.delimiter).some(directory =>
            {
                try
                {
                    fs.accessSync(path.join(directory, tool), fs.constants.X_OK);
                    return true;
                }
                catch
                {
                    return false;
                }
            }) }));
        results.push({ checker: 'bash -n', files: [file], exitCode: result.status,
            contentDigest: input.contentDigest, indexDigest: input.indexDigest, qualificationEligible: false,
            externalTools: tools.map(value => ({ ...value, status: value.available
                ? 'checker-managed; qualification deferred' : 'UNRUN; unavailable; qualification deferred' })) });
        if (result.error || result.status !== 0)
        {
            process.exitCode = 1;
        }
    }
    const blameFiles = evidence.changedFiles.filter(file => file === '.git-blame-ignore-revs');
    if (blameFiles.length)
    {
        const checker = sourceGovernanceChildEntries.solution;
        verifyChildBeforeSpawn(checker);
        const result = spawnSync(process.execPath, [checker, '--language', 'git-blame-ignore', '--root', root,
            ...blameFiles.flatMap(file => ['--file', file])], { cwd: root, encoding: 'utf8' });
        let receipt;
        let bindingError = null;
        let accepted = false;
        try
        {
            receipt = JSON.parse(result.stdout ?? '');
            if (result.error || result.status !== 0)
            {
                throw new Error('blame-ignore source checker failed');
            }
            validateBlameIgnoreSourceReceipt({ repositoryRoot: root, files: blameFiles,
                expectedHead: evidence.headCommit, receipt });
            accepted = true;
        }
        catch (error)
        {
            bindingError = error.message;
        }
        results.push({ checker, mode: 'git-blame-ignore', files: blameFiles, exitCode: result.status,
            status: accepted ? 'success' : 'failure', qualificationEligible: false, receipt,
            stderr: result.stderr ?? '', spawnError: result.error?.message ?? null, bindingError });
        if (accepted)
        {
            checkedBlame.push(...blameFiles);
        }
        else
        {
            process.exitCode = 1;
        }
    }
}
if (effectivePrExecutionStage(callerContext) === 'source-integration')
{
    const declarations = evidence.changedFiles.filter(isCanonicalTestDeclarationSource);
    if (declarations.length)
    {
        let receipt = null;
        let bindingError = null;
        let accepted = false;
        try
        {
            receipt = inspectCanonicalDeclarationSource({ repositoryRoot: root, files: declarations });
            validateCanonicalDeclarationSourceReceipt({ repositoryRoot: root, files: declarations,
                expectedHead: evidence.headCommit, receipt });
            accepted = true;
            checkedDeclarations.push(...declarations);
        }
        catch (error)
        {
            bindingError = error.message;
            process.exitCode = 1;
        }
        results.push({ checker: 'tools/configuration/check-canonical-declaration-source.mjs',
            mode: 'canonical-generated-declarations', files: declarations, status: accepted ? 'success' : 'failure',
            qualificationEligible: false, receipt, bindingError });
    }
}
for (const [checker, options, applicable] of groups)
{
    if (!applicable.length)
    {
        continue;
    }
    verifyChildBeforeSpawn(checker);
    const argv = [checker, '--root', root, ...options, ...applicable.flatMap(file => ['--file', file])];
    const result = spawnSync(process.execPath, argv, { cwd: root, stdio: 'inherit' });
    results.push({ checker, files: applicable, exitCode: result.status });
    if (result.error || result.status !== 0)
    {
        process.exitCode = 1;
    }
    else if (checker === sourceGovernanceChildEntries.frontend && options[1] === 'strict-full')
    {
        checkedDeclarations.push(...applicable.filter(isScriptDeclarationSource));
    }
}
if (effectivePrExecutionStage(callerContext) === 'source-integration')
{
    const inspectedFiles = sourceStageInspectionFiles(files, evidence.changedFiles);
    const unsupported = unsupportedSourceStageFiles(inspectedFiles, checkedSolutions, checkedPython, checkedBlame, checkedDeclarations, checkedMsbuild);
    if (unsupported.length)
    {
        results.push({ checker: 'unsupported-source-stage-language', files: unsupported,
            exitCode: null, status: 'unsupported', qualificationEligible: false });
        process.exitCode = 1;
    }
}
if (evidence.changedFiles.some(file => file.startsWith('docs/')))
{
    verifyChildBeforeSpawn(sourceGovernanceChildEntries.lifecycle);
    const result = spawnSync(process.execPath, [sourceGovernanceChildEntries.lifecycle, '--check'],
        { cwd: root, stdio: 'inherit' });
    results.push({ checker: 'tools/docs/generate-document-lifecycle.mjs --check', exitCode: result.status });
    if (result.error || result.status !== 0)
    {
        process.exitCode = 1;
    }
}
if (effectivePrExecutionStage(callerContext) === 'source-integration')
{
    for (const entry of selection.sourceRegressionTargets)
    {
        verifyChildBeforeSpawn(entry);
        const result = spawnSync(process.execPath, sourceRegressionArguments(entry), { cwd: root, stdio: 'inherit' });
        results.push({ checker: entry, exitCode: result.status, qualificationEligible: false });
        if (result.error || result.status !== 0)
        {
            process.exitCode = 1;
        }
    }
}
const receipt = { schema: 'fsusblog.source-governance-result.v1', sourceState: plan.sourceState,
    executionStage: effectivePrExecutionStage(callerContext),
    deferredQualificationTierIds: plan.deferredQualificationTierIds,
    fullQualificationTierIds: plan.fullQualificationTierIds,
    changedPathEvidence: evidence, planContentDigest: plan.contentDigest,
    qualificationEligible: false, results, status: process.exitCode ? 'failure' : 'success',
    deferredQualification: 'Unselected compiled/native/runtime/release qualification remains unrun.' };
fs.mkdirSync(path.join(root, '.tmp/source-governance'), { recursive: true });
fs.writeFileSync(path.join(root, '.tmp/source-governance/result.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`[source-governance] ${receipt.status}; no runtime or release qualification`);

function verifyChildBeforeSpawn(entry)
{
    const current = inspectReleaseFinalCommandTarget({ repositoryRoot: root, target: entry,
        additionalTargets: sourceGovernanceDataInputs });
    const errors = validateSourceGovernanceChildExecution(current, executionAuthority, entry);
    if (errors.length)
    {
        throw new Error(errors.join('\n'));
    }
}
