import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { verifyProductionBuildReceipt } from '../ci/production-build-artifacts.mjs';
import { verifyReplayQualification } from '../test/verify-replay-qualification.mjs';
import { digestCanonical } from '../test-fixtures/receipt/canonical.mjs';

import { loadRuntimeStateAuthority } from './catalog.mjs';
import { normalizeRuntimeIdentity, sealDocument, verifySealedDocument } from './contract.mjs';

const fixtureAuthorityPaths = Object.freeze([
    'config/testing/fixture-capability-catalog.json',
    'config/testing/fixture-profile-catalog.json',
    'config/testing/fixture-profile-matrix.generated.json',
    'config/testing/fixture-producer-registry.json',
    'config/testing/fixture-variant-catalog.json'
]);

function regularFile(root, candidate, label)
{
    const absolute = path.resolve(root, candidate);
    if (!absolute.startsWith(`${root}${path.sep}`))
    {
        throw new Error(`${label} must remain inside the repository`);
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error(`${label} must be a regular non-symlink file`);
    }
    return absolute;
}

function fileBinding(root, candidate, label)
{
    const absolute = regularFile(root, candidate, label);
    return Object.freeze({
        file: path.relative(root, absolute).replaceAll(path.sep, '/'),
        digest: `sha256:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`
    });
}

function json(root, candidate, label)
{
    const binding = fileBinding(root, candidate, label);
    return { binding, document: JSON.parse(fs.readFileSync(path.join(root, binding.file), 'utf8')) };
}

export function produceRuntimeOrderIdentity({
    root,
    outputFile,
    runId,
    attemptId,
    sourceState,
    buildReceiptFile,
    replayQualificationFile,
    fixedClockEpochMs,
    executionEnvelopePolicyFile = 'config/testing/test-execution-envelope-policy.json'
})
{
    const repositoryRoot = path.resolve(root);
    const output = path.resolve(repositoryRoot, outputFile);
    if (!output.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error('runtime-order identity output must remain inside the repository');
    }
    if (!Number.isSafeInteger(Number(fixedClockEpochMs)))
    {
        throw new Error('fixed clock epoch must be a safe integer');
    }

    const buildBinding = fileBinding(repositoryRoot, buildReceiptFile, 'production build receipt');
    const { receipt: buildReceipt } = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(path.join(repositoryRoot, buildBinding.file)),
        expectedSourceState: sourceState,
        expectedProducer: { runId, job: 'production-build-artifacts' },
        repairReadOnlySeal: false
    });
    if (buildReceipt.contentDigest !== JSON.parse(
        fs.readFileSync(path.join(repositoryRoot, buildBinding.file), 'utf8')
    ).contentDigest)
    {
        throw new Error('production build receipt verification returned a different authority');
    }

    const replay = json(repositoryRoot, replayQualificationFile, 'replay qualification receipt');
    const replayVerification = verifyReplayQualification(path.join(repositoryRoot, replay.binding.file));
    if (replay.document.schema !== 'fsusblog.replay-qualification.v1'
      || replay.document.status !== 'qualified'
      || replay.document.sourceState?.commit !== sourceState.commit
      || replay.document.sourceState?.worktreeFingerprint !== sourceState.worktreeFingerprint
      || replayVerification.status !== 'verified'
      || replayVerification.receiptDigest !== replay.document.contentDigest)
    {
        throw new Error('replay qualification is stale, cross-source, or unverified');
    }

    const fixtureAuthorities = fixtureAuthorityPaths.map((file) => fileBinding(
        repositoryRoot, file, `fixture authority ${file}`
    ));
    const envelopePolicy = json(repositoryRoot, executionEnvelopePolicyFile, 'execution envelope policy');
    if (envelopePolicy.document.schema !== 'fsusblog.test-execution-envelope-policy.v1')
    {
        throw new Error('execution envelope policy schema is invalid');
    }
    const fixedClock = Object.freeze({
        epochMs: Number(fixedClockEpochMs),
        digest: digestCanonical({
            schema: 'fsusblog.runtime-order-fixed-clock.v1',
            epochMs: Number(fixedClockEpochMs)
        })
    });
    const authority = composeRuntimeOrderIdentity({
        runId, attemptId, sourceState, fixedClock,
        buildReceipt: { file: buildBinding.file, contentDigest: buildReceipt.contentDigest, fileDigest: buildBinding.digest },
        replayQualification: { file: replay.binding.file, contentDigest: replay.document.contentDigest, fileDigest: replay.binding.digest },
        fixtureAuthorities,
        executionEnvelopePolicy: envelopePolicy.binding,
        catalogDigest: loadRuntimeStateAuthority().catalogDigest
    });
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(output, `${JSON.stringify(authority, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return Object.freeze({ file: output, authority });
}

export function composeRuntimeOrderIdentity({
    runId,
    attemptId,
    sourceState,
    fixedClock,
    buildReceipt,
    replayQualification,
    fixtureAuthorities,
    executionEnvelopePolicy,
    catalogDigest
})
{
    const identity = normalizeRuntimeIdentity({
        runId,
        attemptId,
        sessionId: 'schedule-template',
        sourceCommit: sourceState.commit,
        sourceFingerprint: sourceState.worktreeFingerprint,
        buildReceiptDigest: buildReceipt.contentDigest,
        fixtureDigest: digestCanonical({ schema: 'fsusblog.runtime-order-fixture-authorities.v1', files: fixtureAuthorities }),
        envelopeDigest: digestCanonical({
            schema: 'fsusblog.runtime-order-execution-envelope-authority.v1',
            policy: executionEnvelopePolicy
        }),
        clockDigest: fixedClock.digest,
        replayDigest: replayQualification.contentDigest,
        catalogDigest
    });
    return sealDocument({
        schema: 'fsusblog.production-runtime-order-identity.v1',
        identity,
        fixedClock,
        buildReceipt,
        replayQualification,
        fixtureAuthorities,
        executionEnvelopePolicy
    });
}

export function verifyRuntimeOrderIdentityAuthority({ root, file })
{
    const repositoryRoot = path.resolve(root);
    const identityFile = regularFile(repositoryRoot, file, 'runtime-order identity');
    const document = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    if (document.schema !== 'fsusblog.production-runtime-order-identity.v1')
    {
        throw new Error('runtime-order identity schema is invalid');
    }
    verifySealedDocument(document);
    const identity = normalizeRuntimeIdentity(document.identity);
    const expectedClock = digestCanonical({
        schema: 'fsusblog.runtime-order-fixed-clock.v1', epochMs: Number(document.fixedClock?.epochMs)
    });
    if (!Number.isSafeInteger(Number(document.fixedClock?.epochMs))
      || document.fixedClock?.digest !== expectedClock
      || identity.clockDigest !== expectedClock)
    {
        throw new Error('runtime-order identity fixed clock is invalid');
    }
    const build = fileBinding(repositoryRoot, document.buildReceipt?.file, 'production build receipt');
    if (build.digest !== document.buildReceipt?.fileDigest)
    {
        throw new Error('runtime-order build receipt file drifted');
    }
    const { receipt } = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(path.join(repositoryRoot, build.file)),
        expectedSourceState: { commit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint },
        expectedProducer: { runId: identity.runId, job: 'production-build-artifacts' },
        repairReadOnlySeal: false
    });
    if (receipt.contentDigest !== identity.buildReceiptDigest
      || receipt.contentDigest !== document.buildReceipt?.contentDigest)
    {
        throw new Error('runtime-order build receipt identity drifted');
    }
    const replay = json(repositoryRoot, document.replayQualification?.file, 'replay qualification receipt');
    const replayVerification = verifyReplayQualification(path.join(repositoryRoot, replay.binding.file));
    if (replay.binding.digest !== document.replayQualification?.fileDigest
      || replay.document.contentDigest !== identity.replayDigest
      || replay.document.contentDigest !== document.replayQualification?.contentDigest
      || replay.document.sourceState?.commit !== identity.sourceCommit
      || replay.document.sourceState?.worktreeFingerprint !== identity.sourceFingerprint
      || replayVerification.status !== 'verified'
      || replayVerification.receiptDigest !== identity.replayDigest)
    {
        throw new Error('runtime-order replay qualification drifted');
    }
    const fixtures = fixtureAuthorityPaths.map((fixture) => fileBinding(repositoryRoot, fixture, `fixture authority ${fixture}`));
    if (JSON.stringify(fixtures) !== JSON.stringify(document.fixtureAuthorities)
      || identity.fixtureDigest !== digestCanonical({
          schema: 'fsusblog.runtime-order-fixture-authorities.v1', files: fixtures
      }))
    {
        throw new Error('runtime-order fixture authority drifted');
    }
    const envelope = fileBinding(repositoryRoot, 'config/testing/test-execution-envelope-policy.json', 'execution envelope policy');
    if (JSON.stringify(envelope) !== JSON.stringify(document.executionEnvelopePolicy)
      || identity.envelopeDigest !== digestCanonical({
          schema: 'fsusblog.runtime-order-execution-envelope-authority.v1', policy: envelope
      }))
    {
        throw new Error('runtime-order execution envelope authority drifted');
    }
    if (identity.catalogDigest !== loadRuntimeStateAuthority().catalogDigest)
    {
        throw new Error('runtime-order state catalog authority drifted');
    }
    return Object.freeze({ document, identity });
}
