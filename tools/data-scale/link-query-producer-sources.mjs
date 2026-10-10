import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeSha256 } from './runtime-plan.mjs';

const commits = Object.freeze({ writer: 'eca3afcf011caead9647c6854b6382a187a9644c',
    comment: '83299c6891eb06c101bb31badd589c4adf780180', consumer: '5dcd62096f97ccb2297781f2fcebf04fa8dbedd6' });
const directory = 'src/backend/Services/Fixtures/DataScale/';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function git(root, args)
{
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

function verifiedRoot(root, commit)
{
    const real = fs.realpathSync(root);
    if (/['$;]/u.test(real))
    {
        throw new Error('source path cannot contain MSBuild condition or property syntax');
    }
    if (git(real, ['rev-parse', '--show-toplevel']) !== real || git(real, ['rev-parse', 'HEAD']) !== commit
        || git(real, ['status', '--porcelain', '--untracked-files=normal']))
    {
        throw new Error('exact clean original source worktree required');
    }
    return real;
}

function xml(text)
{
    return String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function source(root, commit, relativePath)
{
    const original = execFileSync('git', ['show', `${commit}:${relativePath}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const fullPath = path.join(root, relativePath);
    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || !fs.readFileSync(fullPath).equals(original))
    {
        throw new Error('original source bytes differ from the supplied commit');
    }
    return { path: relativePath, sourcePath: fullPath, sourceCommit: commit,
        gitBlob: git(root, ['rev-parse', `${commit}:${relativePath}`]), contentDigest: computeSha256(original) };
}

/** Link original projects and source files for component controls; never generate a writer or query receipt. */
export function linkQueryProducerSources({ writerRoot, commentRoot, consumerRoot, outputDirectory, queryRoot = repositoryRoot })
{
    const queryCommit = git(queryRoot, ['rev-parse', 'HEAD']);
    const query = verifiedRoot(queryRoot, queryCommit);
    const writer = verifiedRoot(writerRoot, commits.writer);
    const comment = verifiedRoot(commentRoot, commits.comment);
    const consumer = verifiedRoot(consumerRoot, commits.consumer);
    const list = (root, commit) => git(root, ['ls-tree', '-r', '--name-only', commit, '--', directory])
        .split('\n').filter((file) => file.endsWith('.cs'));
    const commentPaths = list(comment, commits.comment);
    const writerPaths = list(writer, commits.writer);
    const common = writerPaths.filter((file) => commentPaths.includes(file)).map((file) =>
    {
        const article = source(writer, commits.writer, file);
        const commentSource = source(comment, commits.comment, file);
        if (article.gitBlob !== commentSource.gitBlob)
        {
            throw new Error(`original producer source conflict: ${file}`);
        }
        return { article, comment: commentSource };
    });
    const additions = writerPaths.filter((file) => !commentPaths.includes(file)).map((file) => source(writer, commits.writer, file));
    const consumers = ['QueryProducerRoleIntake.cs', 'QueryPostgresProducerIntake.cs']
        .map((name) => source(consumer, commits.consumer, `tools/data-scale/query-producer-role-intake/${name}`));
    const querySources = git(query, ['ls-files', '--', 'tools/data-scale/query-plan-collector/*.cs'])
        .split('\n').map((file) => source(query, queryCommit, file));
    const backend = source(comment, commits.comment, 'src/backend/FsusBlog.Server.csproj');
    const friendGrant = source(comment, commits.comment, 'src/backend/Properties/AssemblyInfo.cs');
    if (!fs.readFileSync(friendGrant.sourcePath, 'utf8').includes('InternalsVisibleTo("FsusBlog.Server.Tests")'))
    {
        throw new Error('original test friend grant unavailable');
    }
    const output = path.resolve(outputDirectory);
    if (/['$;]/u.test(output))
    {
        throw new Error('output path cannot contain MSBuild condition or property syntax');
    }
    const relativeOutput = path.relative(path.join(query, '.tmp'), output);
    if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput))
    {
        throw new Error('new task-scoped output directory under the query worktree .tmp is required');
    }
    fs.mkdirSync(output, { mode: 0o700 });
    const targets = path.join(output, 'original-project-source-links.targets');
    const project = path.join(output, 'OriginalQueryPlanCollector.csproj');
    fs.writeFileSync(targets, `<Project>\n<Target Name="LinkOriginalArticleProducerSource" BeforeTargets="BeforeCompile" Condition="'$(MSBuildProjectFullPath)' == '${xml(backend.sourcePath)}'">\n<ItemGroup>\n${additions.map((row) => `<Compile Include="${xml(row.sourcePath)}" Link="${xml(row.path.slice('src/backend/'.length))}" />`).join('\n')}\n</ItemGroup>\n</Target>\n</Project>\n`, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(project, `<Project Sdk="Microsoft.NET.Sdk">\n<PropertyGroup>\n<TargetFramework>net10.0</TargetFramework>\n<OutputType>Exe</OutputType>\n<AssemblyName>FsusBlog.Server.Tests</AssemblyName>\n<ImplicitUsings>enable</ImplicitUsings>\n<Nullable>enable</Nullable>\n<EnableDefaultCompileItems>false</EnableDefaultCompileItems>\n<DefineConstants>QUERY_PRODUCER_INTAKE_LINKED</DefineConstants>\n</PropertyGroup>\n<ItemGroup>\n<ProjectReference Include="${xml(backend.sourcePath)}" AdditionalProperties="FsusBlogCommitSha=${commits.comment};PublishClientAssets=false;CustomAfterMicrosoftCommonTargets=${xml(targets)}" />\n${[...querySources, ...consumers].map((row) => `<Compile Include="${xml(row.sourcePath)}" />`).join('\n')}\n<AssemblyMetadata Include="FsusBlog.QuerySourceCommit" Value="${queryCommit}" />\n</ItemGroup>\n</Project>\n`, { mode: 0o600, flag: 'wx' });
    const manifest = { scope: 'original-project-source-linkage-only', qualification: false, releaseEvidenceEligible: false,
        queryCommit, commits, project, targets, commonSources: common, originalArticleSourceLinks: additions,
        originalConsumers: consumers, querySources, backendProject: backend, originalFriendGrant: friendGrant };
    fs.writeFileSync(path.join(output, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    const args = process.argv.slice(2);
    const names = ['--writer-root', '--comment-root', '--consumer-root', '--output'];
    if (args.length !== 8 || names.some((name, index) => args[index * 2] !== name || !args[index * 2 + 1]))
    {
        throw new Error('usage: link-query-producer-sources.mjs --writer-root <exact Git worktree> --comment-root <exact Git worktree> --consumer-root <exact Git worktree> --output <new directory>');
    }
    const manifest = linkQueryProducerSources({ writerRoot: args[1], commentRoot: args[3], consumerRoot: args[5], outputDirectory: args[7] });
    console.log(JSON.stringify({ project: manifest.project, queryCommit: manifest.queryCommit, qualification: false }));
}
