#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    factWrapperContracts,
    verifyCentralOpenApiPackageContract
} from './backend-test-governance-contracts.mjs';
import {
    verifyPlatformRuntimeGovernance,
    verifyPublicAotCrashWorkerGovernance
} from './backend-test-runtime-governance.mjs';
import { verifyStrykerCallerContract } from './mutation/stryker-caller-governance-contract.mjs';
import {
    backendEvidencePathAuthorityFile,
    buildBackendEvidencePathAuthority
} from './test/backend-evidence-path-authority.mjs';
import { maskCSharpTrivia, verifyFactWrappersAndSearchUtf8ScalarOwner } from './test/csharp-source-mask.mjs';
import { parseMatrix } from './test-matrix/parse-matrix.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requirementCatalogPath = 'tests/backend/Fixtures/backend-test-requirements.json';
const aedsCatalogPath = 'tests/backend/Fixtures/aeds-golden-catalog.json';
const pathGovernanceFixtureDirectory = 'tests/backend/Fixtures/backend-test-path-governance';
const environmentVariableGovernanceFixtureDirectory = 'tests/backend/Fixtures/environment-variable-governance';
const localRedisFixtureGovernanceDirectory =
    'tests/backend/Fixtures/local-redis-fixture-governance';
const environmentVariableCollectionPath = 'tests/backend/Fixtures/EnvironmentVariableCollection.cs';
const approvedEnvironmentVariableMutationFiles = new Set([
    'tests/backend/Fixtures/ScopedEnvironmentVariables.cs'
]);
const backendPathGovernanceAllowedFiles = new Set([
    'tests/backend/Unit/TestInfrastructure/BackendTestPaths.cs',
    'tests/backend/Unit/TestInfrastructure/BackendTestPathsTests.cs'
]);
const requirementCatalog = JSON.parse(readFileSync(resolve(root, requirementCatalogPath), 'utf8'));
const aedsCatalog = JSON.parse(readFileSync(resolve(root, aedsCatalogPath), 'utf8'));
const matrix = readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8');
const parsedMatrix = parseMatrix(matrix);
const matrixTierCommands = new Map(parsedMatrix.tiers.map((tier) => [tier.id, tier.command]));
const testSh = readFileSync(resolve(root, 'tools/test.sh'), 'utf8');
const legacyTest = readFileSync(resolve(root, 'tools/test/lanes/_suite-support.sh'), 'utf8');
const serverProject = readFileSync(resolve(root, 'src/backend/FsusBlog.Server.csproj'), 'utf8');
const centralPackages = readFileSync(resolve(root, 'Directory.Packages.props'), 'utf8');
const dotnetToolManifestPath = '.config/dotnet-tools.json';
const defaultStrykerConfigPath = 'config/testing/mutation/default.json';
const criticalStrykerConfigRepoPath = 'config/testing/mutation/critical.json';
const toolManifest = JSON.parse(readFileSync(resolve(root, dotnetToolManifestPath), 'utf8'));
const strykerConfig = JSON.parse(readFileSync(resolve(root, defaultStrykerConfigPath), 'utf8'));
const criticalStrykerConfigPath = resolve(root, criticalStrykerConfigRepoPath);
const criticalStrykerConfig = existsSync(criticalStrykerConfigPath)
    ? JSON.parse(readFileSync(criticalStrykerConfigPath, 'utf8'))
    : {};
const errors = [];
const testShDelegatesToMatrix = testSh.includes('tools/run-test-matrix.mjs')
  && testSh.includes('run "$tier"');

function expectedProfileCommand(profileId)
{
    return matrixTierCommands.get(profileId);
}

function fail(message)
{
    errors.push(message);
}

function requireFile(path)
{
    if (typeof path !== 'string' || path.trim() === '')
    {
        fail(`invalid file path ${JSON.stringify(path)}`);
        return;
    }
    if (!existsSync(resolve(root, path)))
    {
        fail(`missing file ${path}`);
    }
}

function requireEvidencePath(path)
{
    if (path.startsWith('.tmp/'))
    {
        if (!matrixEvidencePaths.has(path))
        {
            fail(`generated backend evidence is not declared by an exact matrix tier output: ${path}`);
        }
        return;
    }
    requireFile(path);
}

const matrixEvidenceAuthority = buildBackendEvidencePathAuthority(
    matrix,
    parsedMatrix,
    requirementCatalog);
const matrixEvidencePaths = new Set(
    matrixEvidenceAuthority.authority.entries
        .filter((entry) => entry.owners.length > 0)
        .map((entry) => entry.evidencePath));
errors.push(...matrixEvidenceAuthority.errors);
const expectedMatrixEvidenceAuthority = `${JSON.stringify(matrixEvidenceAuthority.authority, null, 4)}\n`;
const matrixEvidenceAuthorityPath = resolve(root, backendEvidencePathAuthorityFile);
if (!existsSync(matrixEvidenceAuthorityPath)
    || readFileSync(matrixEvidenceAuthorityPath, 'utf8') !== expectedMatrixEvidenceAuthority)
{
    fail(`${backendEvidencePathAuthorityFile} is stale`);
}

function walk(dir, predicate, results = [])
{
    for (const entry of readdirSync(dir))
    {
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory())
        {
            if (entry === 'bin' || entry === 'obj' || entry === 'node_modules' || entry === '.git')
            {
                continue;
            }
            walk(fullPath, predicate, results);
        }
        else if (predicate(fullPath))
        {
            results.push(fullPath);
        }
    }
    return results;
}

function toRepoPath(path)
{
    return relative(root, path).replace(/\\/g, '/');
}

function lineNumberForIndex(source, index)
{
    return source.slice(0, Math.max(0, index)).split('\n').length;
}

function addBackendPathViolation(violations, relativePath, rule, source, index, message)
{
    violations.push({
        path: relativePath,
        line: lineNumberForIndex(source, index),
        rule,
        message
    });
}

function findRuleMatches(source, regex)
{
    const matches = [];
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(source)) !== null)
    {
        matches.push(match.index);
    }
    return matches;
}

function scanBackendTestPathSource(relativePath, source)
{
    if (backendPathGovernanceAllowedFiles.has(relativePath))
    {
        return [];
    }

    const violations = [];
    const literalRules = [
        {
            rule: 'private-repo-root-resolver',
            regex: /\bprivate\s+static\s+[A-Za-z0-9_<>,.?[\]\s]+\s+Find(?:Repo|Repository)Root\s*\(/g,
            message: 'use BackendTestPaths instead of a private repo-root resolver'
        },
        {
            rule: 'low-context-repo-root-error',
            regex: /["']Unable to locate repository root\.?["']/g,
            message: 'use BackendTestPaths for consistent repository-root failure context'
        },
        {
            rule: 'direct-slnx-root-marker',
            regex: /["']FsusBlog\.slnx["']/g,
            message: 'use BackendTestPaths instead of walking for FsusBlog.slnx'
        }
    ];

    for (const { rule, regex, message } of literalRules)
    {
        for (const index of findRuleMatches(source, regex))
        {
            addBackendPathViolation(violations, relativePath, rule, source, index, message);
        }
    }

    const appContextIndex = source.search(/\bAppContext\.BaseDirectory\b/);
    if (appContextIndex >= 0 && /\bDirectory\.GetParent\s*\(|\.Parent\b/.test(source))
    {
        addBackendPathViolation(
            violations,
            relativePath,
            'appcontext-parent-traversal',
            source,
            appContextIndex,
            'use BackendTestPaths instead of AppContext.BaseDirectory parent traversal'
        );
    }

    return violations;
}

function verifyBackendTestPathGovernanceFixtures()
{
    const positiveFixture = `${pathGovernanceFixtureDirectory}/shared-helper-usage.fixture.cs.txt`;
    const negativeFixture = `${pathGovernanceFixtureDirectory}/private-find-repo-root.fixture.cs.txt`;

    requireFile(positiveFixture);
    requireFile(negativeFixture);

    const positiveViolations = scanBackendTestPathSource(
        positiveFixture,
        readFileSync(resolve(root, positiveFixture), 'utf8')
    );
    if (positiveViolations.length > 0)
    {
        fail(`backend-test-path-governance positive fixture emitted violations: ${positiveViolations.map(v => v.rule).join(', ')}`);
    }

    const negativeViolations = scanBackendTestPathSource(
        negativeFixture,
        readFileSync(resolve(root, negativeFixture), 'utf8')
    );
    const negativeRules = new Set(negativeViolations.map(violation => violation.rule));
    for (const expectedRule of [
        'private-repo-root-resolver',
        'low-context-repo-root-error',
        'direct-slnx-root-marker',
        'appcontext-parent-traversal'
    ])
    {
        if (!negativeRules.has(expectedRule))
        {
            fail(`backend-test-path-governance negative fixture did not trigger ${expectedRule}`);
        }
    }
}

function verifyBackendTestPathGovernance()
{
    verifyBackendTestPathGovernanceFixtures();

    const backendTestFiles = walk(
        resolve(root, 'tests/backend'),
        path => path.endsWith('.cs')
    )
        .map(path => ({ fullPath: path, relativePath: toRepoPath(path) }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    for (const { fullPath, relativePath } of backendTestFiles)
    {
        const source = readFileSync(fullPath, 'utf8');
        for (const violation of scanBackendTestPathSource(relativePath, source))
        {
            fail(
                `backend-test-path-governance ${violation.path}:${violation.line} ` +
        `${violation.rule}: ${violation.message}`
            );
        }
    }
}

function scanEnvironmentVariableMutations(relativePath, source)
{
    if (approvedEnvironmentVariableMutationFiles.has(relativePath))
    {
        return [];
    }

    const masked = maskCSharpTrivia(source);
    const mutationIndexes = findRuleMatches(
        masked,
        /\bEnvironment\s*\.\s*SetEnvironmentVariable\s*\(/g
    );
    if (mutationIndexes.length === 0)
    {
        return [];
    }

    const collectionPattern =
        /\[\s*Collection\s*\(\s*nameof\s*\(\s*EnvironmentVariableCollection\s*\)\s*\)\s*\]/u;
    const classes = [];
    const classPattern = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/gu;
    for (const match of masked.matchAll(classPattern))
    {
        const declarationRemainder = masked.slice(match.index + match[0].length);
        const openingOffset = declarationRemainder.search(/[{;]/u);
        if (openingOffset < 0)
        {
            continue;
        }

        const openingIndex = match.index + match[0].length + openingOffset;
        if (masked[openingIndex] !== '{')
        {
            continue;
        }

        let depth = 0;
        let bodyEnd = masked.length;
        for (let index = openingIndex; index < masked.length; index += 1)
        {
            if (masked[index] === '{')
            {
                depth += 1;
            }
            else if (masked[index] === '}')
            {
                depth -= 1;
                if (depth === 0)
                {
                    bodyEnd = index + 1;
                    break;
                }
            }
        }

        const previousBrace = masked.lastIndexOf('}', match.index);
        const previousSemicolon = masked.lastIndexOf(';', match.index);
        const declarationStart = Math.max(0, previousBrace + 1, previousSemicolon + 1);
        const declarationPrefix = masked.slice(declarationStart, match.index);
        classes.push({
            bodyStart: openingIndex,
            bodyEnd,
            approved: collectionPattern.test(declarationPrefix)
        });
    }

    return mutationIndexes
        .filter(index => !classes.some(currentClass =>
            currentClass.approved &&
      currentClass.bodyStart < index &&
      index < currentClass.bodyEnd
        ))
        .map(index => ({
            path: relativePath,
            line: lineNumberForIndex(source, index),
            rule: 'unisolated-environment-variable-mutation',
            message:
        'use ScopedEnvironmentVariables and annotate the owning test class with EnvironmentVariableCollection'
        }));
}

function formatEnvironmentVariableViolation(violation)
{
    return `backend-environment-variable-governance ${violation.path}:${violation.line} ` +
    `${violation.rule}: ${violation.message}`;
}

function verifyEnvironmentVariableGovernanceFixtures()
{
    const positiveFixture =
        `${environmentVariableGovernanceFixtureDirectory}/approved-scoped-helper.fixture.cs.txt`;
    const negativeFixture =
        `${environmentVariableGovernanceFixtureDirectory}/unapproved-direct-mutation.fixture.cs.txt`;
    const mixedOwnershipFixture =
        `${environmentVariableGovernanceFixtureDirectory}/mixed-collection-ownership.fixture.cs.txt`;

    requireFile(positiveFixture);
    requireFile(negativeFixture);
    requireFile(mixedOwnershipFixture);

    const positiveViolations = scanEnvironmentVariableMutations(
        positiveFixture,
        readFileSync(resolve(root, positiveFixture), 'utf8')
    );
    if (positiveViolations.length > 0)
    {
        fail(
            'backend-environment-variable-governance positive fixture emitted violations: ' +
      positiveViolations.map(violation => violation.rule).join(', ')
        );
    }

    const negativeViolations = scanEnvironmentVariableMutations(
        negativeFixture,
        readFileSync(resolve(root, negativeFixture), 'utf8')
    );
    if (negativeViolations.length !== 1)
    {
        fail(
            'backend-environment-variable-governance negative fixture must emit exactly one violation'
        );
        return;
    }

    const diagnostic = formatEnvironmentVariableViolation(negativeViolations[0]);
    if (!diagnostic.includes(`${negativeFixture}:5 `))
    {
        fail(
            'backend-environment-variable-governance negative fixture diagnostic must include file and line'
        );
    }

    const mixedOwnershipViolations = scanEnvironmentVariableMutations(
        mixedOwnershipFixture,
        readFileSync(resolve(root, mixedOwnershipFixture), 'utf8')
    );
    if (mixedOwnershipViolations.length !== 1)
    {
        fail(
            'backend-environment-variable-governance mixed-class fixture must reject the unapproved owner'
        );
        return;
    }

    const mixedOwnershipDiagnostic = formatEnvironmentVariableViolation(
        mixedOwnershipViolations[0]
    );
    if (!mixedOwnershipDiagnostic.includes(`${mixedOwnershipFixture}:13 `))
    {
        fail(
            'backend-environment-variable-governance mixed-class diagnostic must include file and line'
        );
    }
}

function verifyEnvironmentVariableGovernance()
{
    requireFile(environmentVariableCollectionPath);
    const collectionSource = readFileSync(resolve(root, environmentVariableCollectionPath), 'utf8');
    if (
        !/\[\s*CollectionDefinition\s*\(\s*nameof\s*\(\s*EnvironmentVariableCollection\s*\)\s*,\s*DisableParallelization\s*=\s*true\s*\)\s*\]/u
            .test(collectionSource)
    )
    {
        fail(
            `${environmentVariableCollectionPath} must keep EnvironmentVariableCollection ` +
      'DisableParallelization = true'
        );
    }

    verifyEnvironmentVariableGovernanceFixtures();

    const backendTestFiles = walk(
        resolve(root, 'tests/backend'),
        path => path.endsWith('.cs')
    )
        .map(path => ({ fullPath: path, relativePath: toRepoPath(path) }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

    for (const { fullPath, relativePath } of backendTestFiles)
    {
        const source = readFileSync(fullPath, 'utf8');
        for (const violation of scanEnvironmentVariableMutations(relativePath, source))
        {
            fail(formatEnvironmentVariableViolation(violation));
        }
    }
}

function scanLocalRedisFixtureGovernance(relativePath, source)
{
    const masked = maskCSharpTrivia(source);
    const violations = [];
    const methodPattern =
        /((?:\[[^\]\r\n]+\][ \t\r\n]*)+)(?:public\s+)?(?:async\s+)?(?:Task(?:<[^>]+>)?|ValueTask(?:<[^>]+>)?|void)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/gu;
    for (const match of masked.matchAll(methodPattern))
    {
        const attributes = source.slice(match.index, match.index + match[1].length);
        if (!/\b(?:Fact|Theory)\b/u.test(attributes))
        {
            continue;
        }
        const hasLocalRedisTrait =
            /\[\s*Trait\s*\(\s*(?:"|@")Fixture(?:"|@")\s*,\s*(?:"|@")LocalRedis(?:"|@")\s*\)\s*\]/u.test(attributes);

        const openingIndex = match.index + match[0].lastIndexOf('{');
        let depth = 0;
        let closingIndex = masked.length;
        for (let index = openingIndex; index < masked.length; index += 1)
        {
            if (masked[index] === '{')
            {
                depth += 1;
            }
            else if (masked[index] === '}')
            {
                depth -= 1;
                if (depth === 0)
                {
                    closingIndex = index;
                    break;
                }
            }
        }
        const body = masked.slice(openingIndex + 1, closingIndex);
        const bodySource = source.slice(openingIndex + 1, closingIndex);

        if (bodySource.includes('FSUSBLOG_TEST_REDIS') && !hasLocalRedisTrait)
        {
            violations.push({
                path: relativePath,
                line: lineNumberForIndex(source, match.index),
                rule: 'local-redis-fixture-trait-missing',
                message: `${match[2]} consumes FSUSBLOG_TEST_REDIS without [Trait("Fixture", "LocalRedis")]`
            });
        }

        if (
            (match[2] === 'ArtifactPoolBurnSurvivesCancellationProcessInterruptionAndAmbiguousReply' ||
             match[2] === 'BudgetedLeaseAtomicallyAccountsExactBytesQuotasAndRetryIdentity' ||
             match[2] === 'RedisStore_RetiresAllV3NamespacesAndEnvelopeIdempotently' ||
             match[2] === 'RedisLua_IsLinearizableBoundedBindingAwareAndFailClosed' ||
             relativePath.includes('local-redis-fixture-governance')) &&
            bodySource.includes('FSUSBLOG_TEST_REDIS') &&
            /\breturn\s*;/u.test(body)
        )
        {
            violations.push({
                path: relativePath,
                line: lineNumberForIndex(source, match.index),
                rule: 'local-redis-runtime-return',
                message: `${match[2]} must fail closed when FSUSBLOG_TEST_REDIS is missing, not return early`
            });
        }
    }
    return violations;
}

function verifyLocalRedisFixtureGovernance()
{
    const affectedSource = readFileSync(resolve(root, 'tools/dotnet-affected-tests.sh'), 'utf8');
    if (!affectedSource.includes('ordinaryFilter="${FSUSBLOG_BACKEND_ORDINARY_TEST_FILTER:-Category!=Integration&Fixture!=LocalRedis}"') ||
        !affectedSource.includes('--filter "$ordinaryFilter"') || !affectedSource.includes('--ordinary-plan'))
    {
        fail('ordinary affected backend must exclude LocalRedis and emit exact not-selected membership');
    }
    const burnSource = readFileSync(resolve(root, 'tests/backend/Unit/PerceptionCharacterV3ArtifactPoolTests.cs'), 'utf8');
    if (!burnSource.includes('FSUSBLOG_TEST_REDIS_BURN_EVIDENCE') || !burnSource.includes('redis.RegisterProfiler') ||
        !burnSource.includes('redisProfile.FinishProfiling'))
    {
        fail('artifact burn must emit its own profiled Redis-call evidence');
    }
    const positiveFixture = `${localRedisFixtureGovernanceDirectory}/planned-local-redis-test.fixture.cs.txt`;
    const runtimeReturnFixture = `${localRedisFixtureGovernanceDirectory}/runtime-return.fixture.cs.txt`;
    const missingTraitFixture = `${localRedisFixtureGovernanceDirectory}/missing-fixture-trait.fixture.cs.txt`;

    requireFile(positiveFixture);
    requireFile(runtimeReturnFixture);
    requireFile(missingTraitFixture);

    if (scanLocalRedisFixtureGovernance(
        positiveFixture,
        readFileSync(resolve(root, positiveFixture), 'utf8')
    ).length !== 0)
    {
        fail('backend LocalRedis fixture governance rejected the positive fixture');
    }

    const runtimeReturn = scanLocalRedisFixtureGovernance(
        runtimeReturnFixture,
        readFileSync(resolve(root, runtimeReturnFixture), 'utf8')
    );
    if (runtimeReturn.length !== 1 || runtimeReturn[0].rule !== 'local-redis-runtime-return')
    {
        fail('backend LocalRedis fixture governance must reject runtime return');
    }

    const missingTrait = scanLocalRedisFixtureGovernance(
        missingTraitFixture,
        readFileSync(resolve(root, missingTraitFixture), 'utf8')
    );
    if (missingTrait.length !== 1 || missingTrait[0].rule !== 'local-redis-fixture-trait-missing')
    {
        fail('backend LocalRedis fixture governance must reject missing Fixture=LocalRedis trait');
    }

    const backendTestFiles = walk(
        resolve(root, 'tests/backend'),
        path => path.endsWith('.cs')
    )
        .map(path => ({ fullPath: path, relativePath: toRepoPath(path) }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    for (const { fullPath, relativePath } of backendTestFiles)
    {
        const source = readFileSync(fullPath, 'utf8');
        for (const violation of scanLocalRedisFixtureGovernance(relativePath, source))
        {
            fail(
                `backend-local-redis-fixture-governance ${violation.path}:${violation.line} ` +
                `${violation.rule}: ${violation.message}`
            );
        }
    }
}

function extractFactMethods(source)
{
    const masked = maskCSharpTrivia(source);
    const methods = [];
    const pattern = /\[\s*Fact(?:\s*\([^)]*\))?\s*\]\s*(?:public\s+)?(?:async\s+)?(?:Task|void)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gu;
    for (const match of masked.matchAll(pattern))
    {
        const remainder = masked.slice(match.index + match[0].length);
        const bodyOpen = remainder.search(/\{/u);
        if (bodyOpen < 0)
        {
            methods.push({ name: match[1], body: '' });
            continue;
        }

        let depth = 0;
        let end = bodyOpen;
        for (; end < remainder.length; end += 1)
        {
            if (remainder[end] === '{')
            {
                depth += 1;
            }
            else if (remainder[end] === '}')
            {
                depth -= 1;
                if (depth === 0)
                {
                    end += 1;
                    break;
                }
            }
        }
        methods.push({ name: match[1], body: remainder.slice(bodyOpen + 1, end - 1) });
    }
    return methods;
}

function inspectFactWrapperContract(source, ownerMethods, wrapperMethod)
{
    const facts = extractFactMethods(source);
    const ownerCalls = ownerMethods.map((method) => `await\\s+${method}\\s*\\(\\s*\\)\\s*;`).join('\\s*');
    return {
        ownerCounts: ownerMethods.map((method) => facts.filter((entry) => entry.name === method).length),
        wrappers: facts.filter((entry) => entry.name === wrapperMethod),
        forwarders: facts.filter((entry) => (
            !ownerMethods.includes(entry.name)
            && new RegExp(`^${ownerCalls}$`, 'u').test(entry.body.replace(/\s+/gu, ' ').trim())
        )),
        identifierPresent: new RegExp(`\\b${wrapperMethod}\\b`, 'u').test(source)
    };
}

function verifyFactWrapperDeleted(testPath, source, ownerMethods, wrapperMethod)
{
    const live = inspectFactWrapperContract(source, ownerMethods, wrapperMethod);
    if (live.ownerCounts.some((count) => count !== 1))
    {
        fail(`${testPath} must keep exactly one [Fact] for each owner: ${ownerMethods.join(', ')}`);
    }
    if (live.wrappers.length > 0 || live.identifierPresent)
    {
        fail(`${testPath} must not keep ${wrapperMethod} as a test, skip, helper, or alias`);
    }
    if (live.forwarders.length > 0)
    {
        fail(`${testPath} must not keep a [Fact] that only awaits ${ownerMethods.join(', ')}`);
    }
}

function verifyFactWrappersDeleted()
{
    const sources = new Map();
    for (const [testPath] of factWrapperContracts)
    {
        if (sources.has(testPath))
        {
            continue;
        }
        requireFile(testPath);
        sources.set(testPath, readFileSync(resolve(root, testPath), 'utf8'));
    }

    for (const [testPath, ownerMethods, wrapperMethod] of factWrapperContracts)
    {
        verifyFactWrapperDeleted(testPath, sources.get(testPath), ownerMethods, wrapperMethod);
        const legalOwners = ownerMethods.map((method) => `[Fact] public async Task ${method}() { Assert.True(true); }`).join('\n');
        const legal = inspectFactWrapperContract(legalOwners, ownerMethods, wrapperMethod);
        if (legal.ownerCounts.some((count) => count !== 1) || legal.wrappers.length !== 0 || legal.forwarders.length !== 0 || legal.identifierPresent)
        {
            fail(`Fact wrapper scanner must accept the independent owners ${ownerMethods.join(', ')}`);
        }

        const illegalFixture = [
            legalOwners,
            `[Fact] public async Task ${wrapperMethod}() { ${ownerMethods.map((method) => `await ${method}();`).join(' ')} }`
        ].join('\n');
        const illegal = inspectFactWrapperContract(illegalFixture, ownerMethods, wrapperMethod);
        if (illegal.wrappers.length !== 1 || illegal.forwarders.length !== 1 || !illegal.identifierPresent)
        {
            fail(`Fact wrapper scanner must reject a [Fact] that only awaits ${ownerMethods.join(', ')}`);
        }
    }
}

function extractAedsEnumValues()
{
    const source = readFileSync(resolve(root, 'src/core/Algorithms/AedsFrameType.cs'), 'utf8');
    const values = [];
    const regex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/gm;
    let match;
    while ((match = regex.exec(source)) !== null)
    {
        values.push({ name: match[1], value: Number(match[2]) });
    }
    return values;
}

if (requirementCatalog.version !== 'fsusblog-backend-test-governance-v1')
{
    fail('backend requirement catalog version drifted');
}

if (aedsCatalog.version !== 'fsusblog-aeds-golden-catalog-v1')
{
    fail('AEDS golden catalog version drifted');
}

if (!testShDelegatesToMatrix)
{
    fail('tools/test.sh does not delegate backend tiers to tools/run-test-matrix.mjs');
}

const requirementIds = new Set();
for (const requirement of requirementCatalog.requirements || [])
{
    if (requirementIds.has(requirement.id))
    {
        fail(`duplicate backend requirement ${requirement.id}`);
    }
    requirementIds.add(requirement.id);

    if (!/^BACKEND-[A-Z0-9-]+$/.test(requirement.id))
    {
        fail(`invalid backend requirement id ${requirement.id}`);
    }
    if (!requirement.risk || !requirement.coverage)
    {
        fail(`backend requirement ${requirement.id} lacks risk/coverage`);
    }
    if (!Array.isArray(requirement.evidencePaths) || requirement.evidencePaths.length === 0)
    {
        fail(`backend requirement ${requirement.id} lacks evidence paths`);
    }
    else
    {
        for (const path of requirement.evidencePaths)
        {
            requireEvidencePath(path);
        }
    }
}

const requiredProfiles = new Set([
    'backend-api-integration',
    'backend-auth-state-machine',
    'backend-concurrency',
    'backend-property',
    'backend-golden',
    'backend-test-governance',
    'backend-perf',
    'backend-benchmark-regression',
    'backend-mutation',
    'backend-nightly'
]);

for (const profile of requirementCatalog.profiles || [])
{
    requiredProfiles.delete(profile.id);

    const expectedCommand = expectedProfileCommand(profile.id);
    if (!expectedCommand)
    {
        fail(`tests/matrix.yml lacks tier command for backend profile ${profile.id}`);
        continue;
    }
    if (profile.command !== expectedCommand)
    {
        fail(`backend profile ${profile.id} has invalid command ${profile.command}; expected ${expectedCommand}`);
    }
    if (!matrix.includes(`id: ${profile.id}`))
    {
        fail(`tests/matrix.yml lacks tier ${profile.id}`);
    }
    if (!matrix.includes(`command: ${profile.command}`))
    {
        fail(`tests/matrix.yml lacks command ${profile.command}`);
    }

    for (const requirement of profile.requirements || [])
    {
        if (!requirementIds.has(requirement))
        {
            fail(`profile ${profile.id} references unknown requirement ${requirement}`);
        }
    }

    for (const path of profile.evidencePaths || [])
    {
        requireEvidencePath(path);
    }
}

for (const missing of requiredProfiles)
{
    fail(`missing backend profile ${missing}`);
}

const endpointFamilyIds = new Set();
for (const endpoint of requirementCatalog.endpointFamilies || [])
{
    if (typeof endpoint.id !== 'string' || endpoint.id.trim() === '')
    {
        fail(`endpoint family lacks a non-empty id: ${JSON.stringify(endpoint)}`);
    }
    else if (endpointFamilyIds.has(endpoint.id))
    {
        fail(`duplicate endpoint family id ${endpoint.id}`);
    }
    else
    {
        endpointFamilyIds.add(endpoint.id);
    }
    const routePrefixes = Array.isArray(endpoint.routePrefixes) ? endpoint.routePrefixes : [];
    const routePatterns = Array.isArray(endpoint.routePatterns) ? endpoint.routePatterns : [];
    if (routePrefixes.length + routePatterns.length === 0)
    {
        fail(`endpoint family ${endpoint.id ?? '<missing>'} must declare routePrefixes or routePatterns`);
    }
    for (const route of [...routePrefixes, ...routePatterns])
    {
        if (typeof route !== 'string' || !route.startsWith('/'))
        {
            fail(`endpoint family ${endpoint.id ?? '<missing>'} has invalid route ${JSON.stringify(route)}`);
        }
    }
    for (const requirement of endpoint.requirements || [])
    {
        if (!requirementIds.has(requirement))
        {
            fail(`endpoint ${endpoint.path} references unknown requirement ${requirement}`);
        }
    }
}

const enumValues = extractAedsEnumValues();
const catalogByName = new Map((aedsCatalog.frames || []).map(frame => [frame.name, frame]));
const catalogValues = new Set();
for (const frame of aedsCatalog.frames || [])
{
    if (catalogValues.has(frame.value))
    {
        fail(`duplicate AEDS golden frame value ${frame.value}`);
    }
    catalogValues.add(frame.value);
    if (!frame.family)
    {
        fail(`AEDS golden frame ${frame.name} lacks family`);
    }
}

for (const frame of enumValues)
{
    const catalogEntry = catalogByName.get(frame.name);
    if (!catalogEntry)
    {
        fail(`AEDS golden catalog misses frame ${frame.name}`);
        continue;
    }
    if (catalogEntry.value !== frame.value)
    {
        fail(`AEDS golden catalog value mismatch for ${frame.name}: ${catalogEntry.value} != ${frame.value}`);
    }
}

if (toolManifest.version !== 1 || toolManifest.isRoot !== true)
{
    fail(`${dotnetToolManifestPath} must remain a root .NET local-tool manifest`);
}
if (!toolManifest.tools?.['dotnet-stryker'])
{
    fail(`${dotnetToolManifestPath} lacks dotnet-stryker`);
}
if (toolManifest.tools['dotnet-stryker'].version !== '4.14.2'
    || toolManifest.tools['dotnet-stryker'].rollForward !== false)
{
    fail(`${dotnetToolManifestPath} must pin the reviewed upstream Stryker release`);
}

const stryker = strykerConfig['stryker-config'] || {};
for (const key of ['solution', 'test-case-filter', 'mutate'])
{
    if (!stryker[key])
    {
        fail(`${defaultStrykerConfigPath} lacks ${key}`);
    }
}
if ('project' in stryker)
{
    fail('solution-scoped mutation must not pin Stryker project to a test-project path');
}
if (stryker.configuration !== 'Debug')
{
    fail('solution-scoped mutation must use the tested Debug solution configuration');
}
const strykerThresholds = stryker.thresholds || {};
if ((strykerThresholds.break ?? 0) < 70 || (strykerThresholds.high ?? 0) < 85)
{
    fail('Stryker thresholds are below issue #40 minimums');
}
for (const legacyKey of ['threshold-high', 'threshold-low', 'threshold-break', 'output'])
{
    if (legacyKey in stryker)
    {
        fail(`Stryker.NET 4.14 config must not contain unsupported key ${legacyKey}`);
    }
}
if (!legacyTest.includes('--output "$outputDir"'))
{
    fail('backend mutation runner must pass the report output directory through the supported CLI option');
}
const strykerToolPolicy = JSON.parse(readFileSync(resolve(root, 'config/testing/mutation/stryker-tool.v1.json'), 'utf8'));
for (const error of verifyStrykerCallerContract({
    laneSource: legacyTest,
    policy: strykerToolPolicy,
    manifest: toolManifest,
    patch: readFileSync(resolve(root, strykerToolPolicy.patchPath)),
    expressionTreePatch: readFileSync(resolve(root, strykerToolPolicy.expressionTreePatchPath))
}))
{
    fail(error);
}
for (const configPath of [defaultStrykerConfigPath, criticalStrykerConfigRepoPath])
{
    if (!legacyTest.includes(`$ROOT_DIR/${configPath}`))
    {
        fail(`backend mutation runner must pass the explicit Stryker config path ${configPath}`);
    }
}
if (!legacyTest.includes('export FSUSBLOG_MUTATION_BUILD'))
{
    fail('backend mutation runner must export the dedicated MSBuild marker');
}
if (!legacyTest.includes('check-stryker-report.mjs'))
{
    fail('backend mutation runner must reject reports that execute no mutants');
}
if (stryker.mutate.some((pattern) => pattern.startsWith('src/')))
{
    fail('solution-scoped Stryker mutate globs must be relative to each project root');
}

const criticalStryker = criticalStrykerConfig['stryker-config'] || {};
const expectedCriticalMutationFiles = [
    'Algorithms/AedsEncoder.cs'
];
if ('solution' in criticalStryker || criticalStryker.configuration !== 'Debug' ||
    JSON.stringify(criticalStryker['test-projects'] || []) !== JSON.stringify(['../../tests/backend/FsusBlog.Server.Tests.csproj']))
{
    fail('critical Stryker config must run from the Core source-project context with the backend test project');
}
if (JSON.stringify(criticalStryker.mutate || []) !== JSON.stringify(expectedCriticalMutationFiles))
{
    fail('critical Stryker config must retain the reviewed AEDS v2 wire-frame scope');
}
if (criticalStryker['test-case-filter'] !== 'FullyQualifiedName~FsusBlog.Server.Tests.Unit.AedsEncoderTests')
{
    fail('critical Stryker config must select the direct AedsEncoder unit-test slice without unrelated release-evidence prerequisites');
}
if ((criticalStryker.thresholds?.break ?? 0) < 70 || criticalStryker['report-file-name'] !== 'backend-mutation-critical')
{
    fail('critical Stryker config must fail below 70 and write the dedicated report name');
}
if (!legacyTest.includes('backend-mutation-critical'))
{
    fail('legacy test runner must expose the dedicated critical mutation tier');
}
if (!legacyTest.includes('"$ROOT_DIR/src/core"'))
{
    fail('critical mutation runner must execute from the Core source-project directory');
}
for (const contract of [
    'Target Name="DisableCompileTimeOpenApiXmlGeneratorForMutation"',
    "Condition=\"'$(FSUSBLOG_MUTATION_BUILD)' == '1'\"",
    'Analyzer Remove="$(PkgMicrosoft_AspNetCore_OpenApi)/analyzers/dotnet/cs/Microsoft.AspNetCore.OpenApi.SourceGenerators.dll"'
])
{
    if (!serverProject.includes(contract))
    {
        fail(`Stryker build must disable only the incompatible OpenAPI XML source generator: missing ${contract}`);
    }
}
for (const error of verifyCentralOpenApiPackageContract(centralPackages, serverProject))
{
    fail(`Stryker OpenAPI build contract is invalid: ${error}`);
}

for (const path of [
    'tests/backend/Unit/BackendApiIntegrationContractTests.cs',
    'tests/backend/Unit/MfaLoginEndpointPostgresTests.cs',
    'tests/backend/Integration/UserSessionRevocationIntegrationTests.cs',
    'tests/backend/Unit/BackendGoldenCatalogTests.cs',
    'tests/backend/Unit/BackendPropertyTests.cs',
    'tests/backend/Unit/BackendTestGovernanceTests.cs',
    'benchmarks/core/FsusBlog.Core.Benchmarks.csproj'
])
{
    requireFile(path);
}

verifyBackendTestPathGovernance();
verifyEnvironmentVariableGovernance();
verifyPlatformRuntimeGovernance(root, fail);
verifyPublicAotCrashWorkerGovernance(root, fail);
verifyFactWrappersAndSearchUtf8ScalarOwner(root, fail, maskCSharpTrivia, verifyFactWrappersDeleted);
verifyLocalRedisFixtureGovernance();

if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[backend-test-governance] ${error}`);
    }
    process.exit(1);
}

console.log(`[backend-test-governance] ok profiles=${requirementCatalog.profiles.length} requirements=${requirementCatalog.requirements.length} frames=${aedsCatalog.frames.length}`);
