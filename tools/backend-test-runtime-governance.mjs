import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { maskCSharpTrivia } from './test/csharp-source-mask.mjs';

const platformRuntimeGovernanceFixtureDirectory = 'tests/backend/Fixtures/platform-runtime-governance';
const publicAotCrashWorkerGovernanceFixtureDirectory = 'tests/backend/Fixtures/public-aot-crash-worker-governance';

function requireFile(root, path, fail)
{
    if (!path || !statSafe(resolve(root, path)))
    {
        fail(`missing file ${path}`);
    }
}

function statSafe(path)
{
    try
    {
        return statSync(path).isFile();
    }
    catch
    {
        return false;
    }
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

function toRepoPath(root, path)
{
    return relative(root, path).replace(/\\/gu, '/');
}

function lineNumberForIndex(source, index)
{
    return source.slice(0, Math.max(0, index)).split('\n').length;
}

function findClosingBrace(source, openingIndex)
{
    let depth = 0;
    for (let index = openingIndex; index < source.length; index += 1)
    {
        if (source[index] === '{')
        {
            depth += 1;
        }
        else if (source[index] === '}' && --depth === 0)
        {
            return index;
        }
    }
    return source.length;
}

function scanPlatformSpecificRuntimeReturns(relativePath, source)
{
    const masked = maskCSharpTrivia(source);
    const violations = [];
    const methodPattern =
        /((?:\[[^\]\r\n]+\][ \t\r\n]*)+)(?:public\s+)?(?:async\s+)?(?:Task(?:<[^>]+>)?|ValueTask(?:<[^>]+>)?|void)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/gu;
    for (const match of masked.matchAll(methodPattern))
    {
        const attributes = source.slice(match.index, match.index + match[1].length);
        const hasPlatformTrait = /\bTrait\s*\(\s*"Platform"\s*,/u.test(attributes);
        const hasAnyPlatformEvidenceTrait =
            /\bTrait\s*\(\s*"PlatformEvidence"\s*,/u.test(attributes);
        const hasSupportedPlatformEvidenceTrait =
            /\bTrait\s*\(\s*"PlatformEvidence"\s*,\s*"(?:UnixMode|UnixRequestPath|UnixSymlinkBoundary)"\s*\)/u
                .test(attributes);
        const isDeclaredWindowsUnsupported =
            /\bUnsupportedOSPlatform\s*\(\s*"windows"\s*\)/iu.test(attributes);
        if (isDeclaredWindowsUnsupported && !hasPlatformTrait)
        {
            violations.push({
                path: relativePath,
                line: lineNumberForIndex(source, match.index),
                rule: 'platform-membership-missing',
                message: `${match[2]} declares Windows unsupported but has no Platform trait`
            });
        }
        if (hasAnyPlatformEvidenceTrait && !hasSupportedPlatformEvidenceTrait)
        {
            violations.push({
                path: relativePath,
                line: lineNumberForIndex(source, match.index),
                rule: 'platform-evidence-contract-unsupported',
                message: `${match[2]} declares an unsupported PlatformEvidence contract`
            });
        }
        if (hasAnyPlatformEvidenceTrait && !hasPlatformTrait)
        {
            violations.push({
                path: relativePath,
                line: lineNumberForIndex(source, match.index),
                rule: 'platform-evidence-membership-missing',
                message: `${match[2]} declares PlatformEvidence without Platform membership`
            });
        }
        if (!hasPlatformTrait)
        {
            continue;
        }
        const openingIndex = match.index + match[0].lastIndexOf('{');
        const closingIndex = findClosingBrace(masked, openingIndex);
        const body = masked.slice(openingIndex + 1, closingIndex);
        const bodySource = source.slice(openingIndex + 1, closingIndex);
        if (
            bodySource.includes('backend-platform-runtime-evidence') &&
            !hasSupportedPlatformEvidenceTrait
        )
        {
            violations.push({
                path: relativePath,
                line: lineNumberForIndex(source, match.index),
                rule: 'platform-evidence-membership-missing',
                message: `${match[2]} emits backend platform runtime evidence without a PlatformEvidence trait`
            });
        }
        const runtimeReturn = /\breturn\b/u.exec(body);
        if (runtimeReturn)
        {
            const index = openingIndex + 1 + runtimeReturn.index;
            violations.push({
                path: relativePath,
                line: lineNumberForIndex(source, index),
                rule: 'platform-specific-runtime-return',
                message: `${match[2]} must express platform membership through runner selection, not runtime return`
            });
        }
    }
    return violations;
}

export function verifyPlatformRuntimeGovernance(root, fail)
{
    const positiveFixture =
        `${platformRuntimeGovernanceFixtureDirectory}/planned-unix-test.fixture.cs.txt`;
    const negativeFixture =
        `${platformRuntimeGovernanceFixtureDirectory}/runtime-return.fixture.cs.txt`;
    const missingMembershipFixture =
        `${platformRuntimeGovernanceFixtureDirectory}/missing-platform-trait.fixture.cs.txt`;
    const missingEvidenceMembershipFixture =
        `${platformRuntimeGovernanceFixtureDirectory}/missing-platform-evidence-trait.fixture.cs.txt`;
    const evidenceWithoutPlatformFixture =
        `${platformRuntimeGovernanceFixtureDirectory}/platform-evidence-without-platform.fixture.cs.txt`;
    requireFile(root, positiveFixture);
    requireFile(root, negativeFixture);
    requireFile(root, missingMembershipFixture);
    requireFile(root, missingEvidenceMembershipFixture);
    requireFile(root, evidenceWithoutPlatformFixture);
    if (scanPlatformSpecificRuntimeReturns(
        positiveFixture,
        readFileSync(resolve(root, positiveFixture), 'utf8')
    ).length !== 0)
    {
        fail('backend platform runtime governance rejected the planned Unix fixture');
    }
    const negative = scanPlatformSpecificRuntimeReturns(
        negativeFixture,
        readFileSync(resolve(root, negativeFixture), 'utf8')
    );
    if (negative.length !== 1 || negative[0].rule !== 'platform-specific-runtime-return')
    {
        fail('backend platform runtime governance must reject exactly one runtime-return fixture');
    }
    const missingMembership = scanPlatformSpecificRuntimeReturns(
        missingMembershipFixture,
        readFileSync(resolve(root, missingMembershipFixture), 'utf8')
    );
    if (missingMembership.length !== 1 || missingMembership[0].rule !== 'platform-membership-missing')
    {
        fail('backend platform runtime governance must reject exactly one missing-membership fixture');
    }
    const missingEvidenceMembership = scanPlatformSpecificRuntimeReturns(
        missingEvidenceMembershipFixture,
        readFileSync(resolve(root, missingEvidenceMembershipFixture), 'utf8')
    );
    if (
        missingEvidenceMembership.length !== 1 ||
        missingEvidenceMembership[0].rule !== 'platform-evidence-membership-missing'
    )
    {
        fail('backend platform runtime governance must reject exactly one missing-evidence-membership fixture');
    }
    const evidenceWithoutPlatform = scanPlatformSpecificRuntimeReturns(
        evidenceWithoutPlatformFixture,
        readFileSync(resolve(root, evidenceWithoutPlatformFixture), 'utf8')
    );
    if (
        evidenceWithoutPlatform.length !== 2 ||
        !evidenceWithoutPlatform.some((violation) => violation.rule === 'platform-membership-missing') ||
        !evidenceWithoutPlatform.some(
            (violation) => violation.rule === 'platform-evidence-membership-missing'
        )
    )
    {
        fail('backend platform runtime governance must reject evidence declared without platform membership');
    }

    const backendTestFiles = walk(
        resolve(root, 'tests/backend'),
        path => path.endsWith('.cs')
    )
        .map(path => ({ fullPath: path, relativePath: toRepoPath(root, path) }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    for (const { fullPath, relativePath } of backendTestFiles)
    {
        const source = readFileSync(fullPath, 'utf8');
        for (const violation of scanPlatformSpecificRuntimeReturns(relativePath, source))
        {
            fail(
                `backend-platform-runtime-governance ${violation.path}:${violation.line} ` +
                `${violation.rule}: ${violation.message}`
            );
        }
    }
}

function scanPublicAotCrashWorkerGovernance(relativePath, source)
{
    const masked = maskCSharpTrivia(source);
    const violations = [];
    if (
        /\b(?:class|record)\s+PublicAotCrashWorker[A-Za-z0-9_]*\b/u.test(masked) &&
        /\[\s*(?:Fact|Theory)(?:\s*\([^)]*\))?\s*\]/u.test(masked)
    )
    {
        violations.push({
            path: relativePath,
            line: lineNumberForIndex(source, source.search(/\[\s*(?:Fact|Theory)/u)),
            rule: 'discoverable-worker-helper',
            message: 'the Public AOT crash worker helper must not carry xUnit test attributes'
        });
    }
    const oldWorkerIndex = source.indexOf('Recovery_RealProcessCrashWorker');
    if (oldWorkerIndex >= 0)
    {
        violations.push({
            path: relativePath,
            line: lineNumberForIndex(source, oldWorkerIndex),
            rule: 'legacy-worker-test-id',
            message: 'the retired Public AOT crash worker test ID must not reappear'
        });
    }
    const legacyEnvironmentIndex = source.search(
        /FSUSBLOG_PUBLIC_AOT_CRASH_TEST_(?:ROOT|STATE)/u
    );
    if (legacyEnvironmentIndex >= 0)
    {
        violations.push({
            path: relativePath,
            line: lineNumberForIndex(source, legacyEnvironmentIndex),
            rule: 'legacy-worker-environment',
            message: 'the retired Public AOT crash worker environment contract must not reappear'
        });
    }
    const methodPattern =
        /((?:\[[^\]\r\n]+\][ \t\r\n]*)+)(?:public\s+)?(?:async\s+)?(?:Task(?:<[^>]+>)?|ValueTask(?:<[^>]+>)?|void)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/gu;
    for (const match of masked.matchAll(methodPattern))
    {
        const attributes = source.slice(match.index, match.index + match[1].length);
        if (!/\b(?:Fact|Theory)\b/u.test(attributes))
        {
            continue;
        }
        const openingIndex = match.index + match[0].lastIndexOf('{');
        const closingIndex = findClosingBrace(masked, openingIndex);
        const body = masked.slice(openingIndex + 1, closingIndex);
        const bodySource = source.slice(openingIndex + 1, closingIndex);
        if (
            /FSUSBLOG_PUBLIC_AOT_CRASH_TEST_(?:ROOT|STATE)/u.test(bodySource) &&
            /\breturn\s*;/u.test(body)
        )
        {
            violations.push({
                path: relativePath,
                line: lineNumberForIndex(source, match.index),
                rule: 'worker-environment-return',
                message: `${match[2]} must not report Passed after a missing worker environment input`
            });
        }
    }
    return violations;
}

export function verifyPublicAotCrashWorkerGovernance(root, fail)
{
    const positiveFixture =
        `${publicAotCrashWorkerGovernanceFixtureDirectory}/owned-command.fixture.cs.txt`;
    const discoverableFixture =
        `${publicAotCrashWorkerGovernanceFixtureDirectory}/discoverable-helper.fixture.cs.txt`;
    const environmentReturnFixture =
        `${publicAotCrashWorkerGovernanceFixtureDirectory}/environment-return.fixture.cs.txt`;
    requireFile(root, positiveFixture);
    requireFile(root, discoverableFixture);
    requireFile(root, environmentReturnFixture);
    if (scanPublicAotCrashWorkerGovernance(
        positiveFixture,
        readFileSync(resolve(root, positiveFixture), 'utf8')
    ).length !== 0)
    {
        fail('backend Public AOT crash-worker governance rejected the owned command fixture');
    }
    const discoverable = scanPublicAotCrashWorkerGovernance(
        discoverableFixture,
        readFileSync(resolve(root, discoverableFixture), 'utf8')
    );
    if (
        discoverable.length !== 1 ||
        discoverable[0].rule !== 'discoverable-worker-helper'
    )
    {
        fail('backend Public AOT crash-worker governance must reject a discoverable helper');
    }
    const environmentReturn = scanPublicAotCrashWorkerGovernance(
        environmentReturnFixture,
        readFileSync(resolve(root, environmentReturnFixture), 'utf8')
    );
    if (
        environmentReturn.length !== 2 ||
        !environmentReturn.some(violation => violation.rule === 'legacy-worker-environment') ||
        !environmentReturn.some(violation => violation.rule === 'worker-environment-return')
    )
    {
        fail('backend Public AOT crash-worker governance must reject an environment-driven empty Passed');
    }

    const backendTestFiles = walk(
        resolve(root, 'tests/backend'),
        path => path.endsWith('.cs')
    )
        .map(path => ({ fullPath: path, relativePath: toRepoPath(root, path) }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    for (const { fullPath, relativePath } of backendTestFiles)
    {
        const source = readFileSync(fullPath, 'utf8');
        for (const violation of scanPublicAotCrashWorkerGovernance(relativePath, source))
        {
            fail(
                `backend-public-aot-crash-worker-governance ${violation.path}:${violation.line} ` +
                `${violation.rule}: ${violation.message}`
            );
        }
    }
}
