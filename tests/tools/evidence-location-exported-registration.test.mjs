import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { parseEmbeddedEvidenceRegistration } = await import(new URL('../../tools/test/generate-evidence-location-governance.mjs', import.meta.url));
const producerSource = 'tools/release/publish-release-final-bindings.mjs';
const exportName = 'releaseFinalBindingOutputRegistration';
const source = fs.readFileSync(new URL('../../tools/release/publish-release-final-bindings.mjs', import.meta.url), 'utf8');
const parse = (value = source) => parseEmbeddedEvidenceRegistration(value, producerSource, exportName);

test('exported registration parses actual publisher without executing its module', () =>
{
    const entry = parse(`${source}\nthrow new Error('producer module must never execute');\n`);
    assert.equal(entry.consumerId, 'evidence-consumer.release.publish-release-final-bindings');
    assert.equal(entry.producerSource, producerSource);
    assert.equal(entry.producerCallsite, producerSource);
    assert.equal(entry.producerCommand, `node ${producerSource}`);
    assert.equal(entry.publicationMode, 'embedded');
    assert.equal(entry.receiptSchema, 'fsusblog.current-run-evidence-reference.v1');
    assert.deepEqual(entry.requiredIdentityFields, ['attemptId', 'buildIdentity', 'candidateIdentity',
        'schedulerRunId', 'sourceCommit', 'worktreeFingerprint']);
    assert.deepEqual(entry.requiredDigestFields, ['contentDigest', 'producerReceiptDigest']);
    assert.deepEqual(entry.allowedRoots, ['artifacts/current-run']);
    assert.equal(entry.expectedCardinality, 'exact-one');
    assert.equal(entry.outputBindingKey, 'FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_PATH');
    assert.equal(entry.handoffBindingKey, 'FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_HANDOFF_PATH');
    assert.equal(entry.checkpointCommand, `node tools/test/attach-current-run-evidence-checkpoint.mjs --consumer ${entry.consumerId}`);
    assert.deepEqual(parse(source.replace('export const releaseFinalBindingOutputRegistration',
        '/* registration */ export const releaseFinalBindingOutputRegistration')), entry);
});

test('exported registration rejects unknown source and export identities', () =>
{
    assert.throws(() => parseEmbeddedEvidenceRegistration(source, 'tools/release/other.mjs', exportName), /unrecognized/);
    assert.throws(() => parseEmbeddedEvidenceRegistration(source, producerSource, 'otherRegistration'), /unrecognized/);
});

test('exported registration requires one direct exported immutable declaration', () =>
{
    assert.throws(() => parse(source.replace(`export const ${exportName}`, `const ${exportName}`)), /one direct exported const/);
    assert.throws(() => parse(source.replace(`export const ${exportName}`, `export let ${exportName}`)), /one direct exported const/);
    assert.throws(() => parse(`${source}\nexport const ${exportName} = {};`));
    assert.throws(() => parse(source.replace(`export const ${exportName}`, `const ${exportName}`)
        + `\nexport { ${exportName} };`), /one direct exported const/);
});

test('exported registration rejects missing unknown and malformed required fields', () =>
{
    for (const changed of [
        source.replace("expectedCardinality: 'exact-one',", ''),
        source.replace("'attemptId', 'buildIdentity',", "'attemptId',"),
        source.replace("'contentDigest', 'producerReceiptDigest'", "'contentDigest'"),
        source.replace("expectedCardinality: 'exact-one'", "expectedCardinality: 'zero-or-more'"),
        source.replace("publicationMode: 'embedded'", "publicationMode: 'hooked'"),
        source.replace("producerBindingClass: 'cli'", "producerBindingClass: 'unknown'"),
        source.replace('    consumerId, authorityId:', "    unknownField: 'unexpected', consumerId, authorityId:")
    ])
    {
        assert.throws(() => parse(changed), /schema rejected|omit current-run identity/);
    }
});

test('exported registration rejects source binding and owned root drift', () =>
{
    for (const changed of [
        source.replace("const producerSource = 'tools/release/publish-release-final-bindings.mjs'",
            "const producerSource = 'tools/release/other.mjs'"),
        source.replace("const consumerId = 'evidence-consumer.release.publish-release-final-bindings'",
            "const consumerId = 'evidence-consumer.release.other'"),
        source.replace("allowedRoots: Object.freeze(['artifacts/current-run'])", "allowedRoots: Object.freeze(['artifacts/other'])"),
        source.replace('FSUSBLOG_RELEASE_PUBLISH_RELEASE_FINAL_BINDINGS_EVIDENCE_PATH', 'FSUSBLOG_OTHER_EVIDENCE_PATH'),
        source.replace("locatorMode: 'explicit-run-path'", "locatorMode: 'content-addressed-reference'")
    ])
    {
        assert.throws(() => parse(changed), /differs from canonical source identity/);
    }
});

test('exported registration rejects executable expressions spreads accessors and duplicate fields', () =>
{
    for (const changed of [
        source.replace("allowedRoots: Object.freeze(['artifacts/current-run'])", 'allowedRoots: getRoots()'),
        source.replace('    consumerId, authorityId:', '    ...otherRegistration, consumerId, authorityId:'),
        source.replace('    consumerId, authorityId:', "    get consumerId() { throw new Error('never execute'); }, authorityId:"),
        source.replace('    consumerId, authorityId:', "    consumerId, consumerId: 'duplicate', authorityId:"),
        source.replace('    consumerId, authorityId:', "    ['consumerId']: consumerId, authorityId:"),
        source.replace('    consumerId, authorityId:', '    consumerId: process.env.CONSUMER, authorityId:')
    ])
    {
        assert.throws(() => parse(changed), /unsupported expression|rejects spread|duplicate or non-string/);
    }
});
