#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ownershipPath = 'config/testing/security-fixture-ownership.json';
const acceptancePath = '.tmp/test-evidence/security-fixture-acceptance.json';

const auditedRoots = Object.freeze([
    'tests/frontend/checks/runtime',
    'tests/frontend/checks/security',
    'tests/frontend/fixtures',
    'tests/frontend/support',
    'tools/bootstrap-acceptance-env.sh',
    'tools/dev/start.sh',
    'tools/test/lanes',
    'tools/test/run-mixed-performance-window.mjs',
    'tools/test/runtime-scenario-host.mjs',
    'tools/test-fixtures'
]);

const ignoredPaths = new Set([
    'tools/test/check-security-fixture-governance.mjs'
]);

const rules = Object.freeze([
    ['legacy-reset-flag', /(?:FSUSBLOG_)?RESET_(?:SECURITY_TEST_STATE|ANONYMOUS_ISSUANCE_FIXTURE)/u],
    ['legacy-reset-symbol', /\bResetSecurity(?:Runtime|Test)State\b|reset-security-runtime-state/u],
    ['wildcard-redis-cleanup', /redis-cli[\s\S]{0,160}(?:--scan|\bKEYS\b)[\s\S]{0,160}(?:pow-risk|blacklist-user|e2e:)/iu],
    ['global-security-delete', /DELETE\s+FROM\s+(?:security_risk_event|anonymous_credential_issuance_audit)\b(?![\s\S]{0,180}\boperation_id\b)/iu],
    ['auth-ban-side-effect', /(?:clearFixtureUserBanCache|banreason\s*=\s*NULL|blacklist-user)/u],
    ['auth-credential-side-effect', /(?:clearFixtureAnonymousCredentialIssuanceAudit|anonymous_credential_status|anonymous_credential_issuance_audit)/u],
    ['direct-security-redis', /runRedisCli\([^\n]*(?:DEL|SET)[^\n]*(?:sec:|mfa-proof|pow-risk|blacklist)/iu],
    ['threshold-request-loop', /for\s*\([^)]*attempt[^)]*\)[\s\S]{0,900}fetchChallenge/iu],
    ['threshold-override', /\b(?:overrideThreshold|forceRiskThreshold|bypassPowThreshold)\b\s*(?:=|\()/u],
    ['warning-partial-cleanup', /(?:resetLocal(?:Pow|Security)[A-Za-z]*State)[\s\S]{0,500}catch\s*\{\s*(?:\/\/[^\n]*)?\s*\}/u],
    ['raw-production-secret', /(?:productionPrivateKey|productionToken|realIpAddress)\s*[:=]/iu],
    ['second-security-producer', /fixture-catalog:\s*producer\s+security-state/u]
]);

const mutationCases = Object.freeze([
    ['global-reset', 'FSUSBLOG_RESET_SECURITY_TEST_STATE=1'],
    ['renamed-reset-wrapper', 'const ResetSecurityTestState = () => {}'],
    ['wildcard-redis', "redis-cli --scan --pattern '*pow-risk:*' | xargs redis-cli DEL"],
    ['global-database-delete', 'DELETE FROM security_risk_event;'],
    ['auth-ban-cleanup', 'banreason = NULL'],
    ['auth-credential-cleanup', 'clearFixtureAnonymousCredentialIssuanceAudit(userId)'],
    ['direct-security-redis', "runRedisCli(['SET', 'fsus:sec:mfa-proof:x'])"],
    ['request-loop', 'for (let attempt = 0; attempt < 30; attempt += 1) { await fetchChallenge() }'],
    ['threshold-override', 'overrideThreshold = true'],
    ['warning-cleanup', 'async function resetLocalPowRiskState(){ try {} catch {} }'],
    ['production-secret', "productionToken = 'value'"],
    ['second-producer', ['// fixture-catalog:', 'producer security-state'].join(' ')]
]);

function canonical(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function digest(value)
{
    return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')}`;
}

function readJson(relative)
{
    return JSON.parse(readFileSync(path.join(repositoryRoot, relative), 'utf8'));
}

function walk(relative, result = [])
{
    const absolute = path.join(repositoryRoot, relative);
    const stat = statSync(absolute);
    if (stat.isFile())
    {
        result.push(relative.replaceAll(path.sep, '/'));
        return result;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true }))
    {
        if (entry.name === 'node_modules' || entry.name.startsWith('.tmp'))
        {
            continue;
        }
        walk(path.join(relative, entry.name), result);
    }
    return result;
}

function auditedFiles()
{
    return [...new Set(auditedRoots.flatMap((root) => walk(root)))]
        .filter((file) => !ignoredPaths.has(file) && /\.(?:mjs|cjs|js|sh)$/u.test(file))
        .sort();
}

function ruleViolations(source, file, { allowCanonicalProducer = true } = {})
{
    const violations = [];
    for (const [ruleId, pattern] of rules)
    {
        if (!pattern.test(source))
        {
            continue;
        }
        if (ruleId === 'second-security-producer'
          && allowCanonicalProducer
          && file === 'tools/test-fixtures/producers/security-fixture-producer.mjs')
        {
            continue;
        }
        violations.push({ ruleId, file });
    }
    return violations;
}

function ownershipViolations()
{
    const ownership = readJson(ownershipPath);
    const capabilityCatalog = readJson('config/testing/fixture-capability-catalog.json');
    const producerCatalog = readJson('config/testing/fixture-producer-registry.json');
    const profileCatalog = readJson('config/testing/fixture-profile-catalog.json');
    const variants = readJson('config/testing/fixture-variant-catalog.json');
    const violations = [];
    if (ownership.schema !== 'fsusblog.security-fixture-ownership.v1'
      || ownership.producerId !== 'security-state'
      || ownership.strategy !== 'transaction-fixture')
    {
        violations.push({ ruleId: 'ownership-header', file: ownershipPath });
    }
    const catalogCapabilities = capabilityCatalog.capabilities
        .filter((item) => item.ownerProducerId === 'security-state')
        .map((item) => item.id)
        .sort();
    const ownedCapabilities = ownership.capabilities.map((item) => item.id).sort();
    const producer = producerCatalog.producers.find((item) => item.id === 'security-state');
    if (JSON.stringify(catalogCapabilities) !== JSON.stringify(ownedCapabilities)
      || JSON.stringify(producer?.provides ?? []) !== JSON.stringify(ownedCapabilities))
    {
        violations.push({ ruleId: 'capability-inventory-drift', file: ownershipPath });
    }
    if (producerCatalog.producers.filter((item) => item.id === 'security-state').length !== 1
      || JSON.stringify(producer?.implementationPaths) !== JSON.stringify([ownership.producerPath]))
    {
        violations.push({ ruleId: 'producer-owner-drift', file: 'config/testing/fixture-producer-registry.json' });
    }
    const profileById = new Map(profileCatalog.profiles.map((item) => [item.id, item]));
    for (const entry of ownership.capabilities)
    {
        const capability = capabilityCatalog.capabilities.find((item) => item.id === entry.id);
        const variant = variants.variants.filter((item) => item.capabilityId === entry.id);
        if (!capability || capability.postconditionIds.length !== 1
          || capability.postconditionIds[0] !== entry.postconditionId
          || variant.length !== 1 || variant[0].ownerProducerId !== 'security-state')
        {
            violations.push({ ruleId: 'capability-binding-drift', file: entry.id });
        }
        const actualProfiles = profileCatalog.profiles
            .filter((profile) => profile.capabilities.includes(entry.id))
            .map((profile) => profile.id)
            .sort();
        if (JSON.stringify(actualProfiles) !== JSON.stringify(entry.profiles)
          || entry.profiles.some((profileId) => !profileById.has(profileId)))
        {
            violations.push({ ruleId: 'consumer-profile-drift', file: entry.id });
        }
    }
    return violations;
}

export function scanSecurityFixtureGovernance({ sourceOverrides = new Map() } = {})
{
    const violations = ownershipViolations();
    const files = auditedFiles();
    for (const file of files)
    {
        const source = sourceOverrides.get(file) ?? readFileSync(path.join(repositoryRoot, file), 'utf8');
        violations.push(...ruleViolations(source, file));
    }
    const producerDeclarations = files.flatMap((file) =>
    {
        const source = sourceOverrides.get(file) ?? readFileSync(path.join(repositoryRoot, file), 'utf8');
        return [...source.matchAll(/fixture-catalog:\s*producer\s+security-state/gu)].map(() => file);
    });
    if (JSON.stringify(producerDeclarations) !== JSON.stringify(['tools/test-fixtures/producers/security-fixture-producer.mjs']))
    {
        violations.push({ ruleId: 'security-producer-exact-one', file: producerDeclarations.join(',') || '<none>' });
    }
    return Object.freeze({
        violations: Object.freeze(violations.sort((left, right) => `${left.ruleId}:${left.file}`.localeCompare(`${right.ruleId}:${right.file}`))),
        files: Object.freeze(files),
        ownershipDigest: digest(readJson(ownershipPath))
    });
}

export function runSecurityFixtureMutations()
{
    const results = mutationCases.map(([mutationId, source]) =>
    {
        const violations = ruleViolations(source, 'mutation.mjs', { allowCanonicalProducer: false });
        return Object.freeze({ mutationId, killed: violations.length > 0, ruleIds: violations.map((item) => item.ruleId).sort() });
    });
    return Object.freeze(results);
}

export function buildSecurityFixtureAcceptance()
{
    const scan = scanSecurityFixtureGovernance();
    const mutations = runSecurityFixtureMutations();
    const privacyLeaks = scan.violations.filter((item) => item.ruleId === 'raw-production-secret');
    const warnings = [];
    const body = {
        schema: 'fsusblog.security-fixture-acceptance.v1',
        status: scan.violations.length === 0
          && mutations.every((item) => item.killed)
          && privacyLeaks.length === 0
          && warnings.length === 0
            ? 'accepted'
            : 'rejected',
        ownershipDigest: scan.ownershipDigest,
        auditedSourceDigest: digest(scan.files.map((file) => ({
            file,
            digest: digest(readFileSync(path.join(repositoryRoot, file), 'utf8'))
        }))),
        violations: scan.violations,
        mutations,
        privacyLeaks,
        warnings
    };
    return Object.freeze({ ...body, contentDigest: digest(body) });
}

function main()
{
    const receipt = buildSecurityFixtureAcceptance();
    const output = path.join(repositoryRoot, acceptancePath);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(receipt, null, 4)}\n`, { mode: 0o600 });
    if (receipt.status !== 'accepted')
    {
        for (const violation of receipt.violations)
        {
            process.stderr.write(`[security-fixture-governance] ${violation.ruleId}: ${violation.file}\n`);
        }
        for (const mutation of receipt.mutations.filter((item) => !item.killed))
        {
            process.stderr.write(`[security-fixture-governance] mutation survived: ${mutation.mutationId}\n`);
        }
        process.exitCode = 1;
        return;
    }
    process.stdout.write(`${acceptancePath}: accepted (${receipt.mutations.length} mutations killed)\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
