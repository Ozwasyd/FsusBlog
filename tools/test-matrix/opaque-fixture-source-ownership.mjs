import { isDeepStrictEqual } from 'node:util';

export const opaqueFixtureSourcePath = 'tests/tools/fixtures/canonical-digest-edge/v3-contract.mjs';
export const opaqueFixtureSourceChecker = 'tools/configuration/check-opaque-fixture-source.mjs';
export const opaqueFixtureSourceConsumer = 'tests/tools/canonical-digest-edge.test.mjs';
export const opaqueFixtureSourceRegressions = Object.freeze([
    'tools/configuration/opaque-fixture-source.test.mjs',
    'tools/test-matrix/opaque-fixture-source-ownership.test.mjs'
]);

export function isOpaqueFrontendFixture(file)
{
    return /^tests\/(?:[^/]+\/)*(?:Fixtures|fixtures)\//u.test(file)
        && /\.(?:mjs|js|cjs|ts|tsx|vue|css|scss)$/u.test(file);
}

export function assertOpaqueFixtureSourceOwner(matrix, files)
{
    if (!isDeepStrictEqual(files, [opaqueFixtureSourcePath]))
    {
        throw new Error('opaque frontend fixture has no registered complete source consumer');
    }
    const groups = Object.entries(matrix.commandGroups ?? {});
    const owners = groups.flatMap(([groupName, group]) => (group.commands ?? [])
        .filter(command => command.id === 'frontend-style-fixtures')
        .map(command => ({ groupName, group, command })));
    if (owners.length !== 1 || owners[0].groupName !== 'frontend-static-governance'
        || owners[0].group.schema !== 'fsusblog.frontend-static-command-manifest.v2'
        || owners[0].group.lane !== 'frontend-static-governance'
        || !isDeepStrictEqual(owners[0].command.command,
            ['node', '--test', '../../tests/tools/frontend-style.test.mjs', '../../tests/tools/canonical-digest-edge.test.mjs'])
        || owners[0].command.access !== 'write'
        || !Array.isArray(owners[0].command.consumedInputs)
        || !owners[0].command.consumedInputs.includes(opaqueFixtureSourcePath)
        || !owners[0].command.consumedInputs.includes('tests/tools/canonical-digest-edge.test.mjs'))
    {
        throw new Error('opaque fixture is not owned by its complete original matrix consumer');
    }
}

export function selectOpaqueFixtureSourceRegressions(changedFiles)
{
    return changedFiles.some(file => file === opaqueFixtureSourcePath || file === opaqueFixtureSourceConsumer
        || file === opaqueFixtureSourceChecker || opaqueFixtureSourceRegressions.includes(file)
        || file === 'tools/test-matrix/opaque-fixture-source-ownership.mjs'
        || file === 'tools/test-matrix/source-governance.mjs' || file === 'tools/test-matrix/pr-impact-plan.mjs'
        || file === 'tools/configuration/opaque-fixture-native-reporter.mjs'
        || file === 'tools/frontend/style-toolchain/closed-canonical-edge.mjs'
        || file === 'config/development/canonical-digest-edge.json'
        || file === 'config/development/opaque-source-fixture-policy.json')
        ? [...opaqueFixtureSourceRegressions] : [];
}
