import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { readArticleBulkWriterSourceReference } = await import(new URL('../../tools/data-scale/distribution-writer-adapter.mjs', import.meta.url));

const ownerCommit = 'c2847aaae1c1230a87435a26c13eae465d6b681c';
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
const observedCommit = execFileSync('git', ['--no-replace-objects', '-C', ownerRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['--no-replace-objects', '-C', ownerRoot, 'status', '--porcelain', '--untracked-files=no'],
    { encoding: 'utf8' });
if (observedCommit !== ownerCommit || dirty !== '')
{
    throw new Error('probe_owner_source_identity_or_worktree_drift');
}
const source = readArticleBulkWriterSourceReference({ repositoryRoot: ownerRoot, sourceCommit: ownerCommit });
if (!source.resolvedSourceReviewed || source.files.some((file) => file.status !== 'present'))
{
    throw new Error('probe_reviewed_typed_owner_source_required');
}
const parent = path.join(repositoryRoot, '.tmp/distribution-writer-typed-probe');
fs.mkdirSync(parent, { recursive: true });
// Directory uniqueness preserves first failures; it never enters plan/graph identity.
const output = fs.mkdtempSync(path.join(parent, 'attempt-'));
function xml(value)
{
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
const project = path.join(output, 'DistributionResolvedInputProbe.csproj');
fs.writeFileSync(project, `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
        <TargetFramework>net10.0</TargetFramework>
        <OutputType>Exe</OutputType>
        <ImplicitUsings>enable</ImplicitUsings>
        <Nullable>enable</Nullable>
        <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    </PropertyGroup>
    <ItemGroup>
        <Compile Include="${xml(path.join(repositoryRoot, 'tools/data-scale/DistributionArticleResolvedInputAdapter.cs'))}" />
        <Compile Include="${xml(path.join(repositoryRoot, 'tests/fixtures/data-scale/DistributionResolvedInputProbe.cs'))}" />
        <ProjectReference Include="${xml(path.join(ownerRoot, 'src/backend/FsusBlog.Server.csproj'))}" />
    </ItemGroup>
</Project>
`);
const args = ['run', '--project', project];
const result = spawnSync(dotnet, args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
fs.writeFileSync(path.join(output, 'stdout.log'), result.stdout ?? '');
fs.writeFileSync(path.join(output, 'stderr.log'), result.stderr ?? '');
const lines = (result.stdout ?? '').trimEnd().split('\n');
let control = null;
if (result.status === 0 && !result.error)
{
    control = JSON.parse(lines.at(-1));
    if (control.Kind !== 'actual-owner-typed-api-unit-probe-not-db-or-release-receipt'
        || control.ChecksPassed < 24 || control.LargeRosterCount !== 100_000
        || control.NativeAllocationInvoked !== false || control.DatabaseWriterInvoked !== false
        || control.ReleaseEvidenceEligible !== false)
    {
        throw new Error('probe_control_result_invalid');
    }
    fs.writeFileSync(path.join(output, 'controls.json'), `${JSON.stringify(control, null, 4)}\n`);
}
const record = {
    purpose: 'actual-owner-typed-source-controls-only',
    ownerCommit,
    sourceReference: source,
    command: [dotnet, ...args],
    status: result.status,
    error: result.error?.message ?? null,
    signal: result.signal,
    checksPassed: control?.ChecksPassed ?? null,
    releaseEvidenceEligible: false
};
fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(record, null, 4)}\n`);
console.log(JSON.stringify({ output, status: record.status, error: record.error, checksPassed: record.checksPassed }));
process.exitCode = result.status === 0 && !result.error ? 0 : 1;
