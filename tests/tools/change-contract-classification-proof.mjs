import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readFileAtRevision } from '../../tools/governance/change-contract.mjs';

// This experiment never participates in change-contract classification. It
// compiles trusted synthetic fixtures, and optionally compares exact source
// trees under one explicitly manual compiler model. Candidate MSBuild,
// generators, tests, assemblies and application entry points are never run.
export function runClassificationProof({ repository = null, base = null, head = null, output = null } = {})
{
    if (repository && ![base, head].every((revision) => /^[0-9a-f]{40}$/u.test(revision ?? '')))
    {
        throw new Error('source comparison requires exact full base and head commit SHAs');
    }
    if (!repository && (base || head))
    {
        throw new Error('source comparison requires an explicit repository');
    }
    const temporary = mkdtempSync(join(tmpdir(), 'fsusblog-classification-proof-'));
    const helper = resolve(fileURLToPath(new URL('../fixtures/governance/change-contract/classification-proof/Program.cs', import.meta.url)));
    const project = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>
  <ItemGroup>
    <Compile Include="Program.cs" />
    <Reference Include="Microsoft.CodeAnalysis"><HintPath>$(MSBuildSDKsPath)/../Roslyn/bincore/Microsoft.CodeAnalysis.dll</HintPath></Reference>
    <Reference Include="Microsoft.CodeAnalysis.CSharp"><HintPath>$(MSBuildSDKsPath)/../Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll</HintPath></Reference>
  </ItemGroup>
</Project>\n`;
    try
    {
        writeFileSync(join(temporary, 'Proof.csproj'), project);
        writeFileSync(join(temporary, 'Program.cs'), readFileSync(helper));
        writeFileSync(join(temporary, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>\n');
        const gitOptions = { cwd: repository, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' } };
        const inputs = [];
        if (repository)
        {
            for (const [label, revision] of [['baseline', base], ['candidate', head]])
            {
                const directory = join(temporary, label);
                mkdirSync(directory);
                const entries = execFileSync('git', ['ls-tree', '-r', '-z', revision, '--', 'src/shared'], gitOptions)
                    .toString('utf8').split('\0').filter(Boolean);
                for (const entry of entries)
                {
                    const match = /^(100644|100755) blob [0-9a-f]{40}\t(src\/shared\/[A-Za-z0-9._/-]+\.cs)$/u.exec(entry);
                    if (!match)
                    {
                        if (entry.endsWith('.cs'))
                        {
                            throw new Error(`unsupported source tree entry: ${entry}`);
                        }
                        continue;
                    }
                    const path = match[2];
                    const bytes = readFileAtRevision(repository, revision, path);
                    const target = join(directory, path.slice('src/shared/'.length));
                    mkdirSync(dirname(target), { recursive: true });
                    writeFileSync(target, bytes);
                }
                inputs.push(directory);
            }
        }
        execFileSync('dotnet', ['build', 'Proof.csproj', '--configfile', 'NuGet.Config', '--nologo', '-v', 'quiet'],
            { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
        const bytes = execFileSync('dotnet', [join(temporary, 'bin/Debug/net10.0/Proof.dll'), ...inputs],
            { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
        const report = JSON.parse(bytes);
        report.source = repository ? { base, head } : null;
        if (output)
        {
            writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
        }
        return report;
    }
    finally
    {
        rmSync(temporary, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
{
    const option = (name) =>
    {
        const index = process.argv.indexOf(name);
        return index < 0 ? null : process.argv[index + 1];
    };
    console.log(JSON.stringify(runClassificationProof({
        repository: option('--repository'), base: option('--base'), head: option('--head'), output: option('--out')
    }), null, 2));
}
