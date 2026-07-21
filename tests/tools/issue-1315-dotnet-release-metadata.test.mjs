import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const project = 'src/backend/FsusBlog.Server.csproj';
const validReleaseId = '20260720010203-abcdef123456';
const validCommitSha = 'abcdef1234567890abcdef1234567890abcdef12';

function runMsbuild(args)
{
    return spawnSync('dotnet', ['msbuild', project, '-nologo', ...args], {
        cwd: new URL('../..', import.meta.url),
        encoding: 'utf8'
    });
}

test('server assembly metadata is stable and local builds are explicitly unversioned', () =>
{
    const result = runMsbuild([
        '-getProperty:AssemblyVersion,FileVersion,InformationalVersion,SourceRevisionId,IncludeSourceRevisionInInformationalVersion'
    ]);

    assert.equal(result.status, 0, result.stderr);
    const properties = JSON.parse(result.stdout).Properties;
    assert.deepEqual(properties, {
        AssemblyVersion: '0.0.0.0',
        FileVersion: '0.0.0.0',
        InformationalVersion: 'local-unversioned',
        SourceRevisionId: '0000000000000000000000000000000000000000',
        IncludeSourceRevisionInInformationalVersion: 'false'
    });
});

test('release publish metadata accepts one coherent canonical identity', () =>
{
    const validation = runMsbuild([
        '-t:ValidateFsusBlogProductionPublishMetadata',
        '-p:Configuration=Release',
        `-p:FsusBlogReleaseId=${validReleaseId}`,
        `-p:FsusBlogCommitSha=${validCommitSha}`
    ]);

    assert.equal(validation.status, 0, validation.stderr);

    const evaluation = runMsbuild([
        '-getProperty:InformationalVersion,SourceRevisionId,IncludeSourceRevisionInInformationalVersion',
        `-p:FsusBlogReleaseId=${validReleaseId}`,
        `-p:FsusBlogCommitSha=${validCommitSha}`
    ]);

    assert.equal(evaluation.status, 0, evaluation.stderr);
    assert.deepEqual(JSON.parse(evaluation.stdout).Properties, {
        InformationalVersion: validReleaseId,
        SourceRevisionId: validCommitSha,
        IncludeSourceRevisionInInformationalVersion: 'false'
    });
});

test('release publish metadata fails closed for missing, malformed, impossible, or inconsistent identity', () =>
{
    const cases = [
        [],
        ['-p:FsusBlogReleaseId=v1.2.3', `-p:FsusBlogCommitSha=${validCommitSha}`],
        ['-p:FsusBlogReleaseId=20260230010203-abcdef123456', `-p:FsusBlogCommitSha=${validCommitSha}`],
        [`-p:FsusBlogReleaseId=${validReleaseId}`, '-p:FsusBlogCommitSha=ABCDEF1234567890ABCDEF1234567890ABCDEF12'],
        [`-p:FsusBlogReleaseId=${validReleaseId}`, '-p:FsusBlogCommitSha=0123456789abcdef0123456789abcdef01234567']
    ];

    for (const metadata of cases)
    {
        const result = runMsbuild([
            '-t:ValidateFsusBlogProductionPublishMetadata',
            '-p:Configuration=Release',
            ...metadata
        ]);
        assert.notEqual(result.status, 0, `unexpectedly accepted ${metadata.join(' ')}`);
    }
});
