import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const script = path.join(root, 'tools/security/check-privacy-zk-prod-release.mjs');

test('privacy ZK production release gate accepts disabled safe baseline', () =>
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

        const result = runGate('--config', config, '--summary', summary);

        assert.equal(result.status, 0, result.stderr);
        const parsed = JSON.parse(readFileSync(summary, 'utf8'));
        assert.equal(parsed.status, 'ok');
        assert.equal(parsed.enabled, false);
    });
});

test('privacy ZK production release gate rejects bypass flags even when disabled', () =>
{
    withTempDir((dir) =>
    {
        const config = writeJson(dir, 'unsafe.json', {
            AnonymousIdentity: {
                ZkCommentPolicy: {
                    Enabled: false,
                    AllowDevVerifier: true
                }
            }
        });

        const result = runGate('--config', config, '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /AllowDevVerifier/);
    });
});

test('privacy ZK production release gate fails closed when enabled smoke evidence is missing', () =>
{
    withTempDir((dir) =>
    {
        const verifyingKeyHash = hex('a');
        const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native');
        const issuerPrivateKey = writeText(dir, 'issuer-private.key', 'issuer-secret');
        const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer');
        const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash));
        const config = writeJson(dir, 'enabled.json', enabledConfig({
            nativeLibrary,
            issuerPrivateKey,
            issuerPublicKey,
            verifyingKeyHash
        }));

        const result = runGate(
            '--config', config,
            '--trusted-setup-manifest', setup,
            '--smoke-evidence', path.join(dir, 'missing-smoke.json'),
            '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /zk-prod-smoke-evidence/);
    });
});

test('privacy ZK production release gate fails when credential root is not active', () =>
{
    withTempDir((dir) =>
    {
        const fixture = writeEnabledReleaseFixture(dir, {
            smokeOverrides: { credentialRootActive: false }
        });

        const result = runGate(
            '--config', fixture.config,
            '--trusted-setup-manifest', fixture.setup,
            '--smoke-evidence', fixture.smoke,
            '--root-bootstrap-evidence', fixture.rootBootstrap,
            '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /credentialRootActive/);
    });
});

test('privacy ZK production release gate fails when root bootstrap evidence is missing', () =>
{
    withTempDir((dir) =>
    {
        const fixture = writeEnabledReleaseFixture(dir, {
            omitRootBootstrap: true
        });

        const result = runGate(
            '--config', fixture.config,
            '--trusted-setup-manifest', fixture.setup,
            '--smoke-evidence', fixture.smoke,
            '--root-bootstrap-evidence', path.join(dir, 'missing-root-bootstrap.json'),
            '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /root-bootstrap-evidence/);
    });
});

test('privacy ZK production release gate rejects sensitive smoke evidence fields', () =>
{
    withTempDir((dir) =>
    {
        const fixture = writeEnabledReleaseFixture(dir, {
            smokeOverrides: {
                debug: {
                    credentialSecret: 'must-not-ship'
                }
            }
        });
        const config = fixture.config;
        const setup = fixture.setup;
        const smoke = fixture.smoke;
        const rootBootstrap = fixture.rootBootstrap;

        const result = runGate(
            '--config', config,
            '--trusted-setup-manifest', setup,
            '--smoke-evidence', smoke,
            '--root-bootstrap-evidence', rootBootstrap,
            '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /credentialSecret/);
    });
});

test('privacy ZK production release gate rejects hashing-only smoke evidence', () =>
{
    withTempDir((dir) =>
    {
        const verifyingKeyHash = hex('a');
        const nativeLibrary = writeText(dir, 'libfsus_zk_mock.so', 'native');
        const issuerPrivateKey = writeText(dir, 'issuer-private.key', 'issuer-secret');
        const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer');
        const setup = writeJson(dir, 'trusted-setup.json', setupManifest(verifyingKeyHash));
        const smoke = writeJson(dir, 'smoke.json', {
            status: 'ok',
            nativeVerifier: true,
            wasmProver: true,
            credential: true,
            credentialRootActive: true,
            ticketIssued: true,
            anonymousSubmitPending: true,
            identityHeadersOmitted: true,
            sensitivePayloadRedacted: true,
            evidenceKind: 'hashing-fixture',
            hashingFixtureUsed: true
        });
        const config = writeJson(dir, 'enabled.json', enabledConfig({
            nativeLibrary,
            issuerPrivateKey,
            issuerPublicKey,
            verifyingKeyHash,
            smoke
        }));
        const rootBootstrap = writeJson(dir, 'root-bootstrap.json', rootBootstrapEvidence(verifyingKeyHash));

        const result = runGate(
            '--config', config,
            '--trusted-setup-manifest', setup,
            '--smoke-evidence', smoke,
            '--root-bootstrap-evidence', rootBootstrap,
            '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /real-groth16-cross-stack/);
        assert.match(result.stderr, /hashingFixtureUsed/);
    });
});

test('privacy ZK production release gate rejects smoke evidence without local artifact files', () =>
{
    withTempDir((dir) =>
    {
        const fixture = writeEnabledReleaseFixture(dir, {
            smokeOverrides: { artifacts: {} }
        });

        const result = runGate(
            '--config', fixture.config,
            '--trusted-setup-manifest', fixture.setup,
            '--smoke-evidence', fixture.smoke,
            '--root-bootstrap-evidence', fixture.rootBootstrap,
            '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /artifacts\.r1cs\.path/);
    });
});

test('privacy ZK production release gate rejects smoke evidence without prover performance budget', () =>
{
    withTempDir((dir) =>
    {
        const fixture = writeEnabledReleaseFixture(dir, {
            smokeOverrides: {
                performance: {
                    wasmProverP95Ms: 3500,
                    nativeVerifierP99Ms: 75
                }
            }
        });

        const result = runGate(
            '--config', fixture.config,
            '--trusted-setup-manifest', fixture.setup,
            '--smoke-evidence', fixture.smoke,
            '--root-bootstrap-evidence', fixture.rootBootstrap,
            '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /wasmProverP95Ms/);
        assert.match(result.stderr, /nativeVerifierP99Ms/);
    });
});

test('privacy ZK production release gate rejects offline-only root bootstrap evidence when enabled', () =>
{
    withTempDir((dir) =>
    {
        const fixture = writeEnabledReleaseFixture(dir, {
            rootBootstrapOverrides: {
                status: 'validated_offline',
                mode: 'offline-validated-evidence',
                stagingDbRotateSatisfied: false
            }
        });

        const result = runGate(
            '--config', fixture.config,
            '--trusted-setup-manifest', fixture.setup,
            '--smoke-evidence', fixture.smoke,
            '--root-bootstrap-evidence', fixture.rootBootstrap,
            '--summary', path.join(dir, 'summary.json'));

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /root-bootstrap-evidence status must be rotated/);
        assert.match(result.stderr, /stagingDbRotateSatisfied=true/);
    });
});

test('privacy ZK production release gate accepts complete enabled fixture', () =>
{
    withTempDir((dir) =>
    {
        const fixture = writeEnabledReleaseFixture(dir);
        const summary = path.join(dir, 'summary.json');

        const result = runGate(
            '--config', fixture.config,
            '--trusted-setup-manifest', fixture.setup,
            '--smoke-evidence', fixture.smoke,
            '--root-bootstrap-evidence', fixture.rootBootstrap,
            '--summary', summary);

        assert.equal(result.status, 0, result.stderr);
        const parsed = JSON.parse(readFileSync(summary, 'utf8'));
        assert.equal(parsed.status, 'ok');
        assert.equal(parsed.enabled, true);
    });
});

test('privacy ZK production release gate accepts managed MCL verifier backend marker', () =>
{
    withTempDir((dir) =>
    {
        const fixture = writeEnabledReleaseFixture(dir, {
            nativeLibrary: 'managed:mcl'
        });
        const summary = path.join(dir, 'summary.json');

        const result = runGate(
            '--config', fixture.config,
            '--trusted-setup-manifest', fixture.setup,
            '--smoke-evidence', fixture.smoke,
            '--root-bootstrap-evidence', fixture.rootBootstrap,
            '--summary', summary);

        assert.equal(result.status, 0, result.stderr);
        const parsed = JSON.parse(readFileSync(summary, 'utf8'));
        assert.equal(parsed.status, 'ok');
        assert.equal(parsed.enabled, true);
    });
});

function writeEnabledReleaseFixture(dir, options = {})
{
    const smokeEvidence = completeSmokeEvidence(dir, options.smokeOverrides ?? {});
    const verifyingKeyHash = smokeEvidence.verifyingKeyHash;
    const nativeLibrary = options.nativeLibrary ?? writeText(dir, 'libfsus_zk_mock.so', 'native');
    const issuerPrivateKey = writeText(dir, 'issuer-private.key', 'issuer-secret');
    const issuerPublicKey = writeText(dir, 'issuer-public.key', 'issuer');
    const setupDocument = setupManifest(verifyingKeyHash, smokeEvidence);
    const setup = writeJson(dir, 'trusted-setup.json', setupDocument);
    const smoke = writeJson(dir, 'smoke.json', smokeEvidence);
    const rootBootstrap = options.omitRootBootstrap === true
        ? path.join(dir, 'missing-root-bootstrap.json')
        : writeJson(dir, 'root-bootstrap.json', rootBootstrapEvidence(
      verifyingKeyHash,
      options.rootBootstrapOverrides ?? {}));
    const config = writeJson(dir, 'enabled.json', enabledConfig({
        nativeLibrary,
        issuerPrivateKey,
        issuerPublicKey,
        verifyingKeyHash,
        smoke
    }));

    return {
        verifyingKeyHash,
        nativeLibrary,
        issuerPrivateKey,
        issuerPublicKey,
        setup,
        smoke,
        rootBootstrap,
        config,
        smokeEvidence
    };
}

function completeSmokeEvidence(dir, overrides = {})
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

    const evidence = {
        evidenceKind: 'real-groth16-cross-stack',
        circuitId: 'fsus.anonymous.comment.v5',
        publicInputLayoutVersion: 6,
        proofSystem: 'Groth16',
        verifyingKeyHash: artifactHashes.verifyingKeySha256,
        status: 'ok',
        nativeVerifier: true,
        wasmProver: true,
        credential: true,
        credentialRootActive: true,
        ticketIssued: true,
        anonymousSubmitPending: true,
        identityHeadersOmitted: true,
        sensitivePayloadRedacted: true,
        ...overrides,
        performance: {
            wasmProverP95Ms: 2400,
            nativeVerifierP99Ms: 35,
            ...(overrides.performance ?? {})
        },
        artifactHashes,
        artifacts: overrides.artifacts ?? artifacts,
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
            hashingFixtureUsed: false,
            ...(overrides.crossStack ?? {})
        }
    };
    Object.defineProperty(evidence, '__fixtureArtifacts', { value: artifacts });
    return evidence;
}

function enabledConfig({ nativeLibrary, issuerPrivateKey, verifyingKeyHash })
{
    return {
        AnonymousIdentity: {
            ZkCommentPolicy: {
                Enabled: true,
                RequireCredential: true,
                RequireTrustedSetupVerified: true
            },
            ZkVerifier: {
                Backend: 'native_groth16',
                VerifyingKeyHash: verifyingKeyHash,
                NativeGroth16: { LibraryPath: nativeLibrary },
                VerifyingKeyManifestPath: writeJson(path.dirname(issuerPrivateKey), 'verifying-key-manifest.json', { production_usable: true, verifying_key_hash: verifyingKeyHash })
            }
        },
        AnonymousCredentialIssuer: {
            BlindRsa: {
                PrivateKeyPath: issuerPrivateKey,
                PublicKeyHash: hex('3')
            }
        }
    };
}

function setupManifest(verifyingKeyHash, smokeEvidence = null)
{
    return {
        schema: 'fsusblog.zk.trusted-setup-manifest.v2',
        circuit_id: 'fsus.anonymous.comment.v5',
        public_input_layout_version: 6,
        production_usable: true,
        ceremony_status: 'verified',
        verifying_key_hash: verifyingKeyHash,
        artifacts: {
            r1cs: { sha256: smokeEvidence?.artifactHashes?.r1csSha256 ?? hex('3') },
            proving_key: { sha256: smokeEvidence?.artifactHashes?.provingKeySha256 ?? hex('5') },
            verifying_key: { sha256: verifyingKeyHash }
        }
    };
}

function rootBootstrapEvidence(verifyingKeyHash, overrides = {})
{
    return {
        schema: 'fsusblog.anonymous-credential-root-bootstrap-evidence.v1',
        status: 'rotated',
        mode: 'dotnet-root-lifecycle-rotate',
        stagingDbRotateSatisfied: true,
        rootSnapshot: {
            epoch: 2026062001,
            credentialRootHash: hex('1'),
            revocationRootHash: hex('2'),
            issuerPublicKeyHash: hex('3'),
            circuitId: 'fsus.anonymous.comment.v5',
            circuitNumericId: 7,
            publicInputLayoutVersion: 6,
            verifyingKeyHash,
            expiresAtUtc: '2099-07-20T00:00:00Z',
            graceExpiresAtUtc: '2099-07-27T00:00:00Z'
        },
        checks: [
            'hash-format-valid',
            'verifying-key-hash-bound-to-trusted-setup'
        ],
        highValueAudit: {
            action: 'security.anonymous_credential.root_rotated',
            isHighValue: true
        },
        ...overrides
    };
}

function runGate(...args)
{
    return spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        encoding: 'utf8'
    });
}

function withTempDir(action)
{
    const dir = mkdtempSync(path.join(tmpdir(), 'fsus-zk-prod-'));
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

function hex(ch)
{
    return ch.repeat(64);
}
