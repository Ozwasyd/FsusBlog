import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const {loadRegistry, validateOwnershipAgainstBehaviorCatalog, root} = await import(new URL('../../tools/fact-extractors/registry.mjs', import.meta.url));
const {loadCatalog} = await import(new URL('../../tools/contracts/behavior-contract-catalog.mjs', import.meta.url));
const {extract: extractConfigErrorSecurity} = await import(new URL('../../tools/fact-extractors/config-error-security-policy/extract.mjs', import.meta.url));
const {validateObservations} = await import(new URL('../../tools/fact-extractors/receipt.mjs', import.meta.url));
const observationRelative = '.tmp/contracts/config-error-security/config-error-security-policy-observation.json';
const activeChallengeKinds = [
    'adminPasskeyStepUpV1',
    'anonymousCredentialProofV1',
    'argon2idPoSpaceV1',
    'humanReadProofV1',
    'passkeyStepUpV1',
    'perceptionCharacterV3',
    'perceptionLocalizationV2',
    'perceptionMicroInteractionV2',
    'recoveryKeyProofV1',
    'sha256PowV1',
    'zkAnonymousCommentProofV1'
];

function sha256(buffer)
{
    return createHash('sha256').update(buffer).digest('hex');
}

function observationFact(result, factId)
{
    return result.observations.facts[factId];
}

function observationMapEntry(map, identity)
{
    const key = /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(identity)
        ? identity
        : `key_${Buffer.from(identity, 'utf8').toString('hex')}`;
    const entry = map[key];
    return key === identity ? entry : entry?.value;
}

function writeObservation(repositoryRoot, observation)
{
    const absolute = path.join(repositoryRoot, observationRelative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    const text = `${JSON.stringify(observation, null, 2)}\n`;
    writeFileSync(absolute, text);
    return {
        absolute,
        artifactDigest: sha256(Buffer.from(text, 'utf8')),
        text
    };
}

function sampleDomainErrors()
{
    const entries = [
        ['auth.login.failed', 'auth', 'login', 'Unauthorized', 401],
        ['auth.session.revoked', 'session', 'validation', 'Unauthorized', 401],
        ['auth.passkey.invalid', 'passkey', 'authenticate', 'Unauthorized', 401],
        ['auth.mfa.invalid', 'mfa', 'verify', 'Unauthorized', 401],
        ['auth.recovery.invalid', 'recovery', 'verify', 'Unauthorized', 401],
        ['auth.step-up.required', 'step-up', 'authorize', 'Forbidden', 403],
        ['security.pow.invalid', 'pow', 'verify', 'Forbidden', 403],
        ['security.challenge.invalid', 'security-challenge', 'verify', 'Validation', 400]
    ];
    return {
        schema: 'fsusblog.domain-error-catalog.v1',
        version: 1,
        closed: true,
        active: Object.fromEntries(entries.map(([stableCode, domain, operation, aedsErrorCode, httpStatus]) => [
            stableCode,
            {
                stableCode,
                domain,
                operation,
                condition: 'typed production condition',
                transport: { httpStatus, aedsFrame: 'Error', aedsErrorCode },
                retryability: 'retry-after-new-proof',
                failMode: 'fail-closed',
                status: 'active',
                sourceOwner: 'src/backend/Authority.cs',
                sourceRange: 'Authority.Member',
                proofTests: ['AuthorityTests.ProvesCondition']
            }
        ])),
        retired: {},
        migrationOnly: {}
    };
}

function sampleChallengeWindow()
{
    return {
        schema: 'fsusblog.security-challenge-verification-window.v1',
        version: 1,
        closed: true,
        factId: 'security.challenge.verify-attempt-window',
        windowType: 'sliding-expiry-counter',
        duration: { value: 2, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
        durationMilliseconds: 120000,
        startsAt: 'first-counter-increment',
        boundary: 'count-less-than-or-equal-max-attempts',
        challengeKinds: activeChallengeKinds,
        challengeManifestVersion: '2026.07.22.1',
        cacheExpiryFactId: 'security.challenge.verify-attempt-cache-expiry',
        cacheExpiry: { value: 2, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
        cacheExpiryMilliseconds: 120000,
        maxAttemptsFactId: 'security.challenge.verify-max-attempts',
        maxAttempts: { value: 3, unit: 'attempts', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
        failModeFactId: 'security.challenge.verify-fail-mode',
        failMode: 'fail-closed',
        relation: 'window-duration-and-cache-expiry-are-distinct-facts-with-equal-current-duration',
        'window-relation': {
            relationId: 'security.challenge.verify-window-distinct-from-cache-expiry',
            subject: 'security.challenge.verify-attempt-window',
            predicate: 'is-distinct-from',
            object: 'security.challenge.verify-attempt-cache-expiry',
            direction: 'subject-to-object',
            condition: 'current sliding-expiry-counter policy',
            truthValue: 'true'
        },
        sourceOwner: 'src/backend/Services/Security/SecurityChallengeVerifyRateLimiter.cs',
        sourceRange: 'SecurityChallengeVerifyRateLimiter.TryAcquireAsync',
        proofTests: ['SecurityChallengeVerifyRateLimiterTests']
    };
}

function sampleObservation(overrides = {})
{
    const { facts: factOverrides, ...rest } = overrides;
    return {
        schema: 'fsusblog.config-error-security-policy-observation.v2',
        source: 'compiled-production-constants',
        status: 'ok',
        failureReasons: [],
        observationDigest: 'a'.repeat(64),
        facts: {
            'configuration.keys': {
                'Jwt:AccessTokenExpiresMinutes': {
                    valueType: 'integer',
                    secret: false,
                    nullable: false,
                    requiredStatus: 'optional',
                    requiredWhen: 'optional',
                    layer: 'canonical-catalog'
                },
                'ConnectionStrings:DefaultConnection': {
                    valueType: 'secret-string',
                    secret: true,
                    nullable: true,
                    requiredStatus: 'required',
                    requiredWhen: 'Production',
                    layer: 'canonical-catalog'
                }
            },
            'configuration.defaults': {
                'Jwt:AccessTokenExpiresMinutes': {
                    type: 'integer',
                    unit: 'minutes',
                    nullable: false,
                    secret: false,
                    layers: {
                        'code-default': { value: 15, layer: 'code-default' },
                        'canonical-repository-config': { value: 15, layer: 'canonical-repository-config' }
                    }
                },
                'RateLimiting:FixedIpPermitLimit': {
                    type: 'integer',
                    unit: 'requests-per-window',
                    nullable: false,
                    secret: false,
                    layers: {
                        'code-default': { value: 100, layer: 'code-default' }
                    }
                },
                'ConnectionStrings:DefaultConnection': {
                    type: 'secret',
                    secret: true,
                    nullable: true,
                    layers: {
                        'canonical-repository-config': {
                            present: true,
                            valueMaterialized: false
                        }
                    }
                }
            },
            'configuration.allowed-values': {
                'AntiCrawler:Mode': ['disabled', 'enforce', 'lockdown', 'observe', 'strict']
            },
            'configuration.required-production-values': {
                'ConnectionStrings:DefaultConnection': {
                    required: true,
                    requiredWhen: 'Production',
                    valueType: 'secret-string',
                    secret: true,
                    layer: 'production-required-override',
                    valueMaterialized: false
                }
            },
            'error-codes.public': [
                'Conflict',
                'Forbidden',
                'InfraFailure',
                'NotFound',
                'Unauthorized',
                'Unknown',
                'Validation'
            ],
            'error-codes.transport-mapping': {
                '400': { httpStatus: 400, errorCode: 'Validation', direction: 'status-to-error-code' },
                '401': { httpStatus: 401, errorCode: 'Unauthorized', direction: 'status-to-error-code' },
                'code:Conflict': { errorCode: 'Conflict', httpStatus: 409, direction: 'error-code-to-status' },
                'code:Forbidden': { errorCode: 'Forbidden', httpStatus: 403, direction: 'error-code-to-status' },
                'code:InfraFailure': { errorCode: 'InfraFailure', httpStatus: 500, direction: 'error-code-to-status' },
                'code:Unauthorized': { errorCode: 'Unauthorized', httpStatus: 401, direction: 'error-code-to-status' },
                'code:Validation': { errorCode: 'Validation', httpStatus: 400, direction: 'error-code-to-status' }
            },
            'error-codes.domain': sampleDomainErrors(),
            'security.challenge-kinds': {
                active: activeChallengeKinds,
                manifestVersion: '2026.07.22.1'
            },
            'security.challenge-retired-kinds': [],
            'security.challenge-verification-window': sampleChallengeWindow(),
            'security.rate-limit-policies': {
                fixed_ip: {
                    policyId: 'fixed_ip',
                    window: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    codeDefaultPermitLimit: { value: 100, unit: 'requests-per-window', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    failMode: 'fail-closed'
                },
                public_read: {
                    policyId: 'public_read',
                    window: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    codeDefaultPermitLimit: { value: 120, unit: 'requests-per-window', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    failMode: 'fail-closed'
                },
                read_proof: {
                    policyId: 'read_proof',
                    window: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    codeDefaultPermitLimit: { value: 30, unit: 'requests-per-window', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    failMode: 'fail-closed'
                },
                notification_stream: {
                    policyId: 'notification_stream',
                    window: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    codeDefaultPermitLimit: { value: 120, unit: 'requests-per-window', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    failMode: 'fail-closed'
                },
                security_challenge_verify: {
                    policyId: 'security_challenge_verify',
                    maxAttempts: { value: 3, unit: 'attempts', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    cacheExpiry: { value: 2, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    failMode: 'fail-closed'
                }
            },
            'security.cache-policy-classes': {
                ArticleDetail: {
                    id: 'ArticleDetail',
                    domain: 'blog',
                    resource: 'article-detail',
                    securityCritical: false,
                    class: 'blog',
                    l1Ttl: { value: 5, unit: 'minutes' },
                    l2Ttl: { value: 1, unit: 'hours' }
                },
                SecurityMfaChallenge: {
                    id: 'SecurityMfaChallenge',
                    domain: 'sec',
                    resource: 'mfa-challenge',
                    securityCritical: true,
                    class: 'security-critical',
                    l1Ttl: { value: 0, unit: 'seconds' },
                    l2Ttl: { value: 10, unit: 'minutes' }
                }
            },
            'security.fail-open-closed-modes': {
                'rate-limiter-rejection': 'fail-closed',
                'security-challenge-verify': 'fail-closed',
                'production-startup-validation': 'fail-closed'
            },
            'security.numeric-boundaries': {
                'security.step-up.freshness-minutes': {
                    configurationKey: 'Security:StepUp:FreshnessMinutes',
                    default: { value: 5, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    minimum: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    maximum: { value: 15, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                    bound: 'inclusive-inclusive'
                },
                'security.rate-limit.permit-limit': {
                    min: 1,
                    max: 100000,
                    unit: 'requests-per-window',
                    inclusiveMin: true,
                    inclusiveMax: true,
                    bound: 'inclusive-inclusive'
                },
                'security.challenge-verify.max-attempts': {
                    value: 3,
                    unit: 'attempts',
                    inclusiveMin: true,
                    inclusiveMax: true,
                    bound: 'inclusive-inclusive'
                }
            },
            ...(factOverrides ?? {})
        },
        ...rest
    };
}

function runExtract(repositoryRoot, observation, buildIdentityOverrides = {})
{
    const written = writeObservation(repositoryRoot, observation);
    return extractConfigErrorSecurity({
        repositoryRoot,
        buildIdentity: {
            artifactId: 'config-error-security-policy-observation',
            artifactDigest: written.artifactDigest,
            receiptDigest: 'b'.repeat(64),
            ...buildIdentityOverrides
        }
    });
}

function writeFrontendProjection(repositoryRoot, {
    appErrorCodes = [
        'Validation',
        'Unauthorized',
        'Forbidden',
        'NotFound',
        'Conflict',
        'PreconditionRequired',
        'RateLimited',
        'InfraFailure',
        'ProtocolFailure',
        'Timeout',
        'InvariantViolation',
        'Unknown'
    ],
    wireNames = [
        'sha256PowV1',
        'argon2idPoSpaceV1',
        'humanReadProofV1',
        'passkeyStepUpV1',
        'adminPasskeyStepUpV1',
        'recoveryKeyProofV1',
        'anonymousCredentialProofV1',
        'zkAnonymousCommentProofV1',
        'perceptionLocalizationV2',
        'perceptionMicroInteractionV2',
        'perceptionCharacterV3'
    ]
} = {})
{
    const appErrorPath = path.join(repositoryRoot, 'src/frontend/src/utils/appError.ts');
    mkdirSync(path.dirname(appErrorPath), { recursive: true });
    writeFileSync(
        appErrorPath,
        `export const AppErrorCode = {\n${appErrorCodes.map((code) => `  ${code}: '${code}',`).join('\n')}\n} as const\n`
    );

    const binaryApiPath = path.join(repositoryRoot, 'src/frontend/src/contracts/binaryApi.ts');
    mkdirSync(path.dirname(binaryApiPath), { recursive: true });
    writeFileSync(binaryApiPath, 'export const SecurityChallengeKind = {\n  Unknown: 0\n} as const\n');

    const wirePath = path.join(repositoryRoot, 'src/frontend/src/security/challenge-kind-wire.ts');
    mkdirSync(path.dirname(wirePath), { recursive: true });
    writeFileSync(
        wirePath,
        `${wireNames.map((name) => `    case X:\n      return '${name}'`).join('\n')}\n`
    );

    const registryPath = path.join(repositoryRoot, 'src/frontend/src/security/challenge-capability-registry.ts');
    writeFileSync(registryPath, 'export const MANIFEST_VERSION = \'2026.07.22.1\'\n');
}

test('registry owns configuration-error-security-policy via config-error-security-policy-fact-extractor', () =>
{
    const registry = loadRegistry();
    const result = validateOwnershipAgainstBehaviorCatalog(registry, loadCatalog(), root);
    assert.equal(
        result.behaviorOwners.get('configuration-error-security-policy'),
        'config-error-security-policy-fact-extractor'
    );
    const extractor = registry.extractors.find((entry) => entry.id === 'config-error-security-policy-fact-extractor');
    assert.equal(extractor.kind, 'compiled-assembly');
    assert.equal(extractor.hermeticPolicy, 'exact-build-receipt');
    assert.equal(extractor.requiredBuildArtifact, 'config-error-security-policy-observation');
    assert.ok(!extractor.consumedInputs.some((input) => input.includes('docs/')));
    assert.ok(!extractor.consumedInputs.some((input) => input.includes('appsettings.Development')));
    assert.ok(!extractor.consumedInputs.some((input) => input.includes('example')));
    assert.ok(!extractor.consumedInputs.some((input) => /baseline/iu.test(input)));
});

test('positive sample observation extracts typed config/error/security facts', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const result = runExtract(directory, sampleObservation());
        assert.equal(result.status, 'ok', result.failureReasons?.join('\n'));
        validateObservations(result.observations);
        assert.ok(observationFact(result, 'error-codes.public').includes('Validation'));
        assert.equal(observationFact(result, 'security.rate-limit-policies').fixed_ip.window.unit, 'minutes');
        assert.equal(observationFact(result, 'frontend.projection')['error-codes'].status, 'exact');
        assert.equal(observationFact(result, 'frontend.projection')['challenge-kinds'].status, 'exact');
        assert.equal(observationFact(result, 'security.fail-open-closed-modes')['rate-limiter-rejection'], 'fail-closed');
        assert.equal(observationFact(result, 'error-codes.domain').closed, true);
        assert.notEqual(
            observationFact(result, 'security.challenge-verification-window').factId,
            observationFact(result, 'security.challenge-verification-window').cacheExpiryFactId
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('1) backend new error code forces projection failure when frontend lacks it', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const observation = sampleObservation({
            facts: {
                'error-codes.public': [
                    'Conflict',
                    'Forbidden',
                    'InfraFailure',
                    'NotFound',
                    'Unauthorized',
                    'Unknown',
                    'Validation',
                    'BrandNewPublicCode'
                ]
            }
        });
        const result = runExtract(directory, observation);
        assert.equal(result.status, 'failed');
        assert.ok(result.failureReasons.some((reason) => /BrandNewPublicCode|projection/iu.test(reason)));
        // Observation surface itself still enumerates the new code when host produces it.
        assert.ok(observation.facts['error-codes.public'].includes('BrandNewPublicCode'));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('2) configuration default change from 5 to 10 changes receipt surface', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const five = runExtract(directory, sampleObservation());
        assert.equal(five.status, 'ok', five.failureReasons?.join('\n'));
        const tenObservation = sampleObservation({
            facts: {
                'configuration.defaults': {
                    'Jwt:AccessTokenExpiresMinutes': {
                        type: 'integer',
                        unit: 'minutes',
                        nullable: false,
                        secret: false,
                        layers: {
                            'code-default': { value: 10, layer: 'code-default' },
                            'canonical-repository-config': { value: 10, layer: 'canonical-repository-config' }
                        }
                    },
                    'RateLimiting:FixedIpPermitLimit': {
                        type: 'integer',
                        unit: 'requests-per-window',
                        nullable: false,
                        secret: false,
                        layers: {
                            'code-default': { value: 100, layer: 'code-default' }
                        }
                    },
                    'ConnectionStrings:DefaultConnection': {
                        type: 'secret',
                        secret: true,
                        nullable: true,
                        layers: {
                            'canonical-repository-config': {
                                present: true,
                                valueMaterialized: false
                            }
                        }
                    }
                }
            }
        });
        const ten = runExtract(directory, tenObservation);
        assert.equal(ten.status, 'ok', ten.failureReasons?.join('\n'));
        assert.notEqual(
            JSON.stringify(observationMapEntry(observationFact(five, 'configuration.defaults'), 'Jwt:AccessTokenExpiresMinutes')),
            JSON.stringify(observationMapEntry(observationFact(ten, 'configuration.defaults'), 'Jwt:AccessTokenExpiresMinutes'))
        );
        assert.equal(
            observationMapEntry(
                observationFact(ten, 'configuration.defaults'),
                'Jwt:AccessTokenExpiresMinutes'
            ).layers['code-default'].value,
            10
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('3) runtime-environment layer must not pollute code-default observation', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const observation = sampleObservation({
            facts: {
                'configuration.defaults': {
                    'Jwt:AccessTokenExpiresMinutes': {
                        type: 'integer',
                        unit: 'minutes',
                        nullable: false,
                        secret: false,
                        layers: {
                            'code-default': { value: 15, layer: 'code-default' },
                            'runtime-environment': { value: 20, layer: 'runtime-environment' }
                        }
                    }
                }
            }
        });
        const result = runExtract(directory, observation);
        assert.equal(result.status, 'failed');
        assert.ok(result.failureReasons.some((reason) => /runtime-environment/iu.test(reason)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('4) retired challenge listed as active fails closed', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const observation = sampleObservation({
            facts: {
                'security.challenge-kinds': {
                    active: [
                        'adminPasskeyStepUpV1',
                        'anonymousCredentialProofV1',
                        'argon2idPoSpaceV1',
                        'humanReadProofV1',
                        'legacyRetiredChallengeV0',
                        'passkeyStepUpV1',
                        'perceptionCharacterV3',
                        'perceptionLocalizationV2',
                        'perceptionMicroInteractionV2',
                        'recoveryKeyProofV1',
                        'sha256PowV1',
                        'zkAnonymousCommentProofV1'
                    ],
                    manifestVersion: '2026.07.22.1'
                },
                'security.challenge-retired-kinds': ['legacyRetiredChallengeV0']
            }
        });
        const result = runExtract(directory, observation);
        assert.equal(result.status, 'failed');
        assert.ok(result.failureReasons.some((reason) => /retired|legacyRetiredChallengeV0/iu.test(reason)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('5) rate-limit unit change seconds→minutes with same bare number fails validation shape or changes unit', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const minutes = runExtract(directory, sampleObservation());
        assert.equal(minutes.status, 'ok');
        const secondsObservation = sampleObservation({
            facts: {
                'security.rate-limit-policies': {
                    fixed_ip: {
                        policyId: 'fixed_ip',
                        window: { value: 1, unit: 'seconds', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        codeDefaultPermitLimit: { value: 100, unit: 'requests-per-window', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        failMode: 'fail-closed'
                    },
                    public_read: {
                        policyId: 'public_read',
                        window: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        codeDefaultPermitLimit: { value: 120, unit: 'requests-per-window', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        failMode: 'fail-closed'
                    },
                    read_proof: {
                        policyId: 'read_proof',
                        window: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        codeDefaultPermitLimit: { value: 30, unit: 'requests-per-window', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        failMode: 'fail-closed'
                    },
                    notification_stream: {
                        policyId: 'notification_stream',
                        window: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        codeDefaultPermitLimit: { value: 120, unit: 'requests-per-window', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        failMode: 'fail-closed'
                    },
                    security_challenge_verify: {
                        policyId: 'security_challenge_verify',
                        maxAttempts: { value: 3, unit: 'attempts', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        cacheExpiry: { value: 2, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        failMode: 'fail-closed'
                    }
                }
            }
        });
        const seconds = runExtract(directory, secondsObservation);
        assert.equal(seconds.status, 'ok');
        assert.notEqual(
            observationFact(minutes, 'security.rate-limit-policies').fixed_ip.window.unit,
            observationFact(seconds, 'security.rate-limit-policies').fixed_ip.window.unit
        );
        assert.equal(observationFact(seconds, 'security.rate-limit-policies').fixed_ip.window.value, 1);
        assert.equal(observationFact(seconds, 'security.rate-limit-policies').fixed_ip.window.unit, 'seconds');
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('6) inclusive upper bound becoming exclusive changes observation without bare-number equality', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const inclusive = runExtract(directory, sampleObservation());
        assert.equal(inclusive.status, 'ok');
        const exclusiveObservation = sampleObservation({
            facts: {
                'security.numeric-boundaries': {
                    'security.step-up.freshness-minutes': {
                        configurationKey: 'Security:StepUp:FreshnessMinutes',
                        default: { value: 5, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        minimum: { value: 1, unit: 'minutes', inclusiveMin: true, inclusiveMax: true, bound: 'inclusive-inclusive' },
                        maximum: { value: 15, unit: 'minutes', inclusiveMin: true, inclusiveMax: false, bound: 'inclusive-exclusive' },
                        bound: 'inclusive-exclusive'
                    },
                    'security.rate-limit.permit-limit': {
                        min: 1,
                        max: 100000,
                        unit: 'requests-per-window',
                        inclusiveMin: true,
                        inclusiveMax: true,
                        bound: 'inclusive-inclusive'
                    },
                    'security.challenge-verify.max-attempts': {
                        value: 3,
                        unit: 'attempts',
                        inclusiveMin: true,
                        inclusiveMax: true,
                        bound: 'inclusive-inclusive'
                    }
                }
            }
        });
        const exclusive = runExtract(directory, exclusiveObservation);
        assert.equal(exclusive.status, 'ok');
        assert.equal(
            observationFact(inclusive, 'security.numeric-boundaries')['security.step-up.freshness-minutes'].maximum.value,
            observationFact(exclusive, 'security.numeric-boundaries')['security.step-up.freshness-minutes'].maximum.value
        );
        assert.notEqual(
            observationFact(inclusive, 'security.numeric-boundaries')['security.step-up.freshness-minutes'].maximum.bound,
            observationFact(exclusive, 'security.numeric-boundaries')['security.step-up.freshness-minutes'].maximum.bound
        );
        assert.equal(
            observationFact(exclusive, 'security.numeric-boundaries')['security.step-up.freshness-minutes'].maximum.inclusiveMax,
            false
        );
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('7) extractor rejects connection-string leakage in observation', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const observation = sampleObservation({
            facts: {
                'configuration.defaults': {
                    'ConnectionStrings:DefaultConnection': {
                        type: 'secret-string',
                        secret: true,
                        nullable: false,
                        layers: {
                            'canonical-repository-config': {
                                value: 'Host=db;Username=fsus;Password=super-secret;Database=fsusblog',
                                layer: 'canonical-repository-config'
                            }
                        }
                    }
                }
            }
        });
        const result = runExtract(directory, observation);
        assert.equal(result.status, 'failed');
        assert.ok(result.failureReasons.some((reason) => /secret|connection|Host=/iu.test(reason)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('8) hardcoded alignment map is no longer fact authority in error-code checker', () =>
{
    const checker = readFileSync(
        path.join(root, 'tests/frontend/checks/static/check-error-code-alignment.mjs'),
        'utf8'
    );
    assert.doesNotMatch(checker, /const\s+alignment\s*=\s*\{/u);
    assert.doesNotMatch(checker, /csharp:\s*'Validation'/u);
    // Dynamic catalog comparison remains allowed; fixed answer tables are not.
    assert.match(checker, /ErrorCode\.cs|AppErrorCode/u);
});

test('ambient bin/Debug build identity is refused', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const observation = sampleObservation();
        const written = writeObservation(directory, observation);
        const result = extractConfigErrorSecurity({
            repositoryRoot: directory,
            buildIdentity: {
                artifactId: 'config-error-security-policy-observation',
                artifactDigest: written.artifactDigest,
                path: 'bin/Debug/net10.0/FsusBlog.ConfigErrorSecurityObservation.dll',
                receiptDigest: 'b'.repeat(64)
            }
        });
        assert.equal(result.status, 'failed');
        assert.ok(result.failureReasons.some((reason) => /bin\/Debug|bin\/Release/iu.test(reason)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('docs/example source markers fail closed', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);
        const result = runExtract(directory, sampleObservation({ source: 'example-appsettings' }));
        assert.equal(result.status, 'failed');
        assert.ok(result.failureReasons.some((reason) => /example|docs|fixture/iu.test(reason)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('domain error omissions, conflicts, lifecycle leaks, aliases and missing proof fail closed', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);

        const missing = sampleDomainErrors();
        delete missing.active['auth.mfa.invalid'];
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'error-codes.domain': missing } }))
            .failureReasons.some((reason) => /missing active mfa coverage/iu.test(reason)));

        const conflict = sampleDomainErrors();
        conflict.active['auth.login.failed'].transport.httpStatus = 403;
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'error-codes.domain': conflict } }))
            .failureReasons.some((reason) => /mapping conflicts/iu.test(reason)));

        const retired = sampleDomainErrors();
        retired.active['auth.login.failed'].status = 'retired';
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'error-codes.domain': retired } }))
            .failureReasons.some((reason) => /status=active/iu.test(reason)));

        const messageIdentity = sampleDomainErrors();
        messageIdentity.active['auth.login.failed'].messageText = 'login_failed';
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'error-codes.domain': messageIdentity } }))
            .failureReasons.some((reason) => /message text/iu.test(reason)));

        const alias = sampleDomainErrors();
        alias.active['auth.login.compat-alias'] = {
            ...alias.active['auth.login.failed'],
            stableCode: 'auth.login.compat-alias'
        };
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'error-codes.domain': alias } }))
            .failureReasons.some((reason) => /compatibility domain error identity/iu.test(reason)));

        const unproved = sampleDomainErrors();
        unproved.active['auth.login.failed'].proofTests = [];
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'error-codes.domain': unproved } }))
            .failureReasons.some((reason) => /missing proofTests/iu.test(reason)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('verification window rejects cache aliasing, wrong canonical duration, missing scope and zero fallback', () =>
{
    const directory = mkdtempSync(path.join(os.tmpdir(), 'config-error-sec-obs-'));
    try
    {
        writeFrontendProjection(directory);

        const cacheAlias = sampleChallengeWindow();
        cacheAlias.cacheExpiryFactId = cacheAlias.factId;
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'security.challenge-verification-window': cacheAlias } }))
            .failureReasons.some((reason) => /distinct stable fact IDs/iu.test(reason)));

        const wrongUnit = sampleChallengeWindow();
        wrongUnit.duration = { ...wrongUnit.duration, value: 2, unit: 'seconds' };
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'security.challenge-verification-window': wrongUnit } }))
            .failureReasons.some((reason) => /canonical duration mismatch/iu.test(reason)));

        const zero = sampleChallengeWindow();
        zero.duration = { ...zero.duration, value: 0 };
        zero.durationMilliseconds = 0;
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'security.challenge-verification-window': zero } }))
            .failureReasons.some((reason) => /non-zero typed duration/iu.test(reason)));

        const wrongScope = sampleChallengeWindow();
        wrongScope.challengeKinds = wrongScope.challengeKinds.slice(1);
        assert.ok(runExtract(directory, sampleObservation({ facts: { 'security.challenge-verification-window': wrongScope } }))
            .failureReasons.some((reason) => /scope must exactly match/iu.test(reason)));
    }
    finally
    {
        rmSync(directory, { recursive: true, force: true });
    }
});
