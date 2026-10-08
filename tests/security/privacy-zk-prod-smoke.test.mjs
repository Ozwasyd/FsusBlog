import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(root, 'tools/security/run-privacy-zk-prod-smoke.mjs');
const sensitiveSamples = [
    'proof-raw-value',
    'ticket-secret-value',
    'credential-secret-value',
    'nullifier-secret-value'
];

test('privacy ZK production smoke records feature flag off as expected unavailable', () =>
{
    withTempDir((dir) =>
    {
        const config = writeJson(dir, 'off.json', {
            AnonymousIdentity: {
                ZkCommentPolicy: {
                    Enabled: false
                }
            }
        });
        const summary = path.join(dir, 'summary.json');

        const result = runSmoke('--config', config, '--summary', summary);

        assert.equal(result.status, 0, result.stderr);
        const parsed = JSON.parse(readFileSync(summary, 'utf8'));
        assert.equal(parsed.status, 'expected_unavailable');
        assert.equal(parsed.featureFlagOffExpectedUnavailable, true);
        assert.equal(parsed.identityHeadersOmitted, true);
        assert.equal(parsed.sensitivePayloadRedacted, true);
        assertNoSensitivePayload(result.stdout + result.stderr + JSON.stringify(parsed));
    });
});

test('privacy ZK production smoke fails require-real when real prover evidence is unavailable', () =>
{
    withTempDir((dir) =>
    {
        const config = writeJson(dir, 'enabled.json', {
            AnonymousIdentity: {
                ZkCommentPolicy: {
                    Enabled: true
                },
                ZkVerifier: {
                    NativeGroth16: { LibraryPath: path.join(dir, 'missing-native.so') }
                }
            }
        });

        const result = runSmoke(
            '--config', config,
            '--summary', path.join(dir, 'summary.json'),
            '--require-real');

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /real ZK-Prod smoke evidence is required/);
        assertNoSensitivePayload(result.stdout + result.stderr);
    });
});

test('privacy ZK production smoke accepts sanitized real full-chain evidence', () =>
{
    withTempDir((dir) =>
    {
        const config = writeJson(dir, 'enabled.json', {
            AnonymousIdentity: {
                ZkCommentPolicy: {
                    Enabled: true
                }
            }
        });
        const evidence = {
            ...completeRealEvidence(dir),
            status: 'ok',
            proofRaw: sensitiveSamples[0],
            ticket: sensitiveSamples[1],
            credentialSecret: sensitiveSamples[2],
            nullifierSecret: sensitiveSamples[3]
        };
        const realEvidence = writeJson(dir, 'real-evidence.json', evidence);
        const summary = path.join(dir, 'summary.json');

        const result = runSmoke(
            '--config', config,
            '--real-evidence', realEvidence,
            '--summary', summary,
            '--require-real');

        assert.equal(result.status, 0, result.stderr);
        const parsed = JSON.parse(readFileSync(summary, 'utf8'));
        assert.equal(parsed.status, 'ok');
        assert.equal(parsed.nativeVerifier, true);
        assert.equal(parsed.wasmProver, true);
        assert.equal(parsed.credential, true);
        assert.equal(parsed.ticketIssued, true);
        assert.equal(parsed.anonymousSubmitPending, true);
        assert.equal(parsed.identityHeadersOmitted, true);
        assert.equal(parsed.sensitivePayloadRedacted, true);
        assert.equal(parsed.realEvidenceKind, 'real-groth16-cross-stack');
        assert.equal(parsed.circuitId, 'fsus.anonymous.comment.v5');
        assert.equal(parsed.publicInputLayoutVersion, 6);
        assert.equal(parsed.proofSystem, 'Groth16');
        assert.equal(parsed.artifactHashes.wasmProverSha256, evidence.artifactHashes.wasmProverSha256);
        assert.equal(parsed.evidenceArtifacts.wasmProver.sha256, evidence.artifacts.wasmProver.sha256);
        assertNoSensitivePayload(result.stdout + result.stderr + JSON.stringify(parsed));
    });
});

test('privacy ZK production smoke rejects real evidence without local artifact files', () =>
{
    withTempDir((dir) =>
    {
        const config = writeJson(dir, 'enabled.json', {
            AnonymousIdentity: {
                ZkCommentPolicy: {
                    Enabled: true
                }
            }
        });
        const realEvidence = writeJson(dir, 'paper-only-evidence.json', completeRealEvidence(dir, {
            artifacts: {}
        }));

        const result = runSmoke(
            '--config', config,
            '--real-evidence', realEvidence,
            '--summary', path.join(dir, 'summary.json'),
            '--require-real');

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /artifacts\.r1cs\.path/);
    });
});

test('privacy ZK production smoke rejects boolean-only or hashing-only real evidence', () =>
{
    withTempDir((dir) =>
    {
        const config = writeJson(dir, 'enabled.json', {
            AnonymousIdentity: {
                ZkCommentPolicy: {
                    Enabled: true
                }
            }
        });
        const realEvidence = writeJson(dir, 'hashing-only.json', {
            status: 'ok',
            nativeVerifier: true,
            wasmProver: true,
            credential: true,
            ticketIssued: true,
            anonymousSubmitPending: true,
            identityHeadersOmitted: true,
            sensitivePayloadRedacted: true,
            evidenceKind: 'hashing-fixture',
            hashingFixtureUsed: true
        });

        const result = runSmoke(
            '--config', config,
            '--real-evidence', realEvidence,
            '--summary', path.join(dir, 'summary.json'),
            '--require-real');

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /real-groth16-cross-stack/);
        assert.match(result.stderr, /hashingFixtureUsed/);
        assertNoSensitivePayload(result.stdout + result.stderr);
    });
});

test('privacy ZK production smoke rejects real evidence without prover performance budget', () =>
{
    withTempDir((dir) =>
    {
        const config = writeJson(dir, 'enabled.json', {
            AnonymousIdentity: {
                ZkCommentPolicy: {
                    Enabled: true
                }
            }
        });
        const realEvidence = writeJson(dir, 'slow-prover.json', {
            ...completeRealEvidence(dir, {
                performance: {
                    wasmProverP95Ms: 3500,
                    nativeVerifierP99Ms: 75
                }
            })
        });

        const result = runSmoke(
            '--config', config,
            '--real-evidence', realEvidence,
            '--summary', path.join(dir, 'summary.json'),
            '--require-real');

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /wasmProverP95Ms/);
        assert.match(result.stderr, /nativeVerifierP99Ms/);
    });
});

function runSmoke(...args)
{
    return spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        encoding: 'utf8'
    });
}

function assertNoSensitivePayload(text)
{
    for (const sample of sensitiveSamples)
    {
        assert.equal(text.includes(sample), false, `sensitive payload leaked: ${sample}`);
    }
}

function withTempDir(action)
{
    const dir = mkdtempSync(path.join(tmpdir(), 'fsus-zk-prod-smoke-'));
    try
    {
        action(dir);
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
}

function writeJson(dir, name, value)
{
    const file = path.join(dir, name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return file;
}

function writeText(dir, name, value)
{
    const file = path.join(dir, name);
    writeFileSync(file, value);
    return file;
}

function completeRealEvidence(dir, overrides = {})
{
    const artifacts = writeEvidenceArtifacts(dir);
    const artifactHashes = {
        r1csSha256: artifacts.r1cs.sha256,
        provingKeySha256: artifacts.provingKey.sha256,
        verifyingKeySha256: artifacts.verifyingKey.sha256,
        nativeVerifierSha256: artifacts.nativeVerifier.sha256,
        wasmProverSha256: artifacts.wasmProver.sha256,
        ...(overrides.artifactHashes ?? {})
    };

    return {
        status: 'ok',
        evidenceKind: 'real-groth16-cross-stack',
        circuitId: 'fsus.anonymous.comment.v5',
        publicInputLayoutVersion: 6,
        proofSystem: 'Groth16',
        verifyingKeyHash: artifactHashes.verifyingKeySha256,
        nativeVerifier: true,
        wasmProver: true,
        credential: true,
        credentialRootActive: true,
        ticketIssued: true,
        anonymousSubmitPending: true,
        identityHeadersOmitted: true,
        sensitivePayloadRedacted: true,
        artifactHashes,
        artifacts,
        crossStack: {
            frontendProofGenerated: true,
            backendProofVerified: true,
            publicInputsMatch: true,
            tamperCasesRejected: true,
            completeTranscriptUnlinkableAcrossScopes: true,
            sameScopeNullifierStable: true,
            differentScopeNullifiersUnique: true,
            legacyLayoutRejected: true,
            sampledScopes: 100,
            hashingFixtureUsed: false
        },
        performance: {
            wasmProverP95Ms: 2400,
            nativeVerifierP99Ms: 35,
            ...(overrides.performance ?? {})
        },
        ...overrides
    };
}

function writeEvidenceArtifacts(dir)
{
    return {
        r1cs: writeArtifact(dir, 'comment-v5.r1cs', 'r1cs artifact'),
        provingKey: writeArtifact(dir, 'comment-v5.pk', 'proving key artifact'),
        verifyingKey: writeArtifact(dir, 'comment-v5.vk', 'verifying key artifact'),
        nativeVerifier: writeArtifact(dir, 'libfsus_zk_native.so', 'native verifier artifact'),
        wasmProver: writeArtifact(dir, 'comment-privacy-prover.wasm', 'wasm prover artifact'),
        proofFixture: writeArtifact(dir, 'comment-v5-proof-fixture.json', '{"proof":"redacted"}'),
        publicInputs: writeArtifact(dir, 'comment-v5-public-inputs.json', '{"inputs":["redacted"]}'),
        tamperCases: writeArtifact(dir, 'comment-v5-tamper-cases.json', '{"tamperCases":["redacted"]}'),
        unlinkabilityTranscripts: writeArtifact(dir, 'comment-v5-unlinkability.json', '{"sampledScopes":100,"stableCredentialFields":[]}')
    };
}

function writeArtifact(dir, name, value)
{
    const file = writeText(dir, name, value);
    return {
        path: file,
        sha256: sha256File(file)
    };
}

function sha256File(file)
{
    return createHash('sha256').update(readFileSync(file)).digest('hex');
}
