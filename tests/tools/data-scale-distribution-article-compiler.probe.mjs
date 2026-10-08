import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { canonicalDigest } = await import(new URL('../../tools/data-scale/distribution-contract.mjs', import.meta.url));
const { readArticleBulkWriterSourceReference } = await import(new URL('../../tools/data-scale/distribution-writer-adapter.mjs', import.meta.url));
const {
    createDistributionArticleCompiler,
    createDistributionArticleAssignmentShards,
    verifyDistributionArticleAssignmentShards
} = await import(new URL('../../tools/data-scale/distribution-assignment.mjs', import.meta.url));

const ownerCommit = '21a20129b3127fdcfb6f34bff7f80b1ef8b5f239';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2)
{
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!['--owner-root', '--dotnet'].includes(name) || options.has(name) || !value || !path.isAbsolute(value))
    {
        throw new Error('usage: --owner-root <exact-owner-checkout> --dotnet <absolute-dotnet>');
    }
    options.set(name, fs.realpathSync(value));
}
if (options.size !== 2)
{
    throw new Error('probe_owner_root_and_dotnet_required');
}
const ownerRoot = options.get('--owner-root');
const dotnet = options.get('--dotnet');
const git = (args) => execFileSync('git', ['--no-replace-objects', '-C', ownerRoot, ...args], { encoding: 'utf8' }).trim();
if (git(['rev-parse', 'HEAD']) !== ownerCommit || git(['status', '--porcelain', '--untracked-files=no']) !== '')
{
    throw new Error('probe_owner_source_identity_or_worktree_drift');
}
const source = readArticleBulkWriterSourceReference({ repositoryRoot: ownerRoot, sourceCommit: ownerCommit });
if (!source.resolvedSourceReviewed || !source.taxonomySourceReviewed)
{
    throw new Error('probe_reviewed_owner_source_required');
}
const parent = path.join(repositoryRoot, '.tmp/distribution-article-compiler-probe');
fs.mkdirSync(parent, { recursive: true });
// Unique local attempts retain failures; directory names are never plan inputs.
const output = fs.mkdtempSync(path.join(parent, 'attempt-'));
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const project = path.join(output, 'DistributionArticleCompilerInputProbe.csproj');
fs.writeFileSync(project, `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
        <TargetFramework>net10.0</TargetFramework>
        <OutputType>Exe</OutputType>
        <ImplicitUsings>enable</ImplicitUsings>
        <Nullable>enable</Nullable>
        <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    </PropertyGroup>
    <ItemGroup>
        <Compile Include="${xml(path.join(repositoryRoot, 'tools/data-scale/DistributionArticlePlanCompilerInput.cs'))}" />
        <Compile Include="${xml(path.join(repositoryRoot, 'tests/fixtures/data-scale/DistributionArticleCompilerInputProbe.cs'))}" />
        <ProjectReference Include="${xml(path.join(ownerRoot, 'src/backend/FsusBlog.Server.csproj'))}" />
    </ItemGroup>
</Project>
`);
const args = ['run', '--project', project, '--', '--content-catalog',
    path.join(repositoryRoot, 'config/testing/content-shape-catalog.json')];
const result = spawnSync(dotnet, args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
fs.writeFileSync(path.join(output, 'stdout.log'), result.stdout ?? '');
fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr ?? '');
let controls = null;
let replay = null;
let validationError = null;
try
{
    if (result.status !== 0 || result.error)
    {
        throw new Error('probe_actual_owner_execution_failed');
    }
    controls = JSON.parse(result.stdout.trimEnd().split('\n').at(-1));
    if (controls.kind !== 'actual-owner-plan-projection-unit-probe-not-production-receipt'
        || controls.checksPassed < 24 || controls.input.articleCount !== 100_000
        || controls.nativeAllocationInvoked !== false || controls.databaseWriterInvoked !== false
        || controls.releaseEvidenceEligible !== false)
    {
        throw new Error('probe_control_result_invalid');
    }
    fs.writeFileSync(path.join(output, 'controls.json'), `${JSON.stringify(controls, null, 4)}\n`);
    const compiler = createDistributionArticleCompiler(controls.input, {
        scenarioId: 'multilingual-content', sourceReference: source,
        expectedInputDigest: canonicalDigest(controls.input), expectedOwnerPlanDigest: controls.input.ownerPlanDigest
    });
    const request = { shardSize: 1000 };
    replay = verifyDistributionArticleAssignmentShards(compiler, request,
        createDistributionArticleAssignmentShards(compiler, request));
    fs.writeFileSync(path.join(output, 'partial-compiler-replay.json'), `${JSON.stringify(replay, null, 4)}\n`);
}
catch (error)
{
    validationError = error.message;
}
const record = {
    purpose: 'actual-owner-plan-projection-and-partial-compiler-unit-controls-only', ownerCommit,
    sourceReference: source, command: [dotnet, ...args], status: result.status,
    error: result.error?.message ?? validationError, checksPassed: controls?.checksPassed ?? null,
    partialArticleReferencesReplayed: replay?.articleCount ?? null,
    completeAssignmentPlan: false, nativeAllocationInvoked: false,
    databaseWriterInvoked: false, releaseEvidenceEligible: false
};
fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(record, null, 4)}\n`);
console.log(JSON.stringify({ output, status: record.status, error: record.error,
    checksPassed: record.checksPassed, partialArticleReferencesReplayed: record.partialArticleReferencesReplayed }));
process.exitCode = result.status === 0 && !result.error && !validationError ? 0 : 1;
