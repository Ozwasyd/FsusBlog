import assert from 'node:assert/strict';
import test from 'node:test';

import { runClassificationProof } from './change-contract-classification-proof.mjs';

test('compiled classification controls distinguish benign examples from implicit and reflective consumers', () =>
{
    const proof = runClassificationProof();
    assert.equal(proof.qualification, false);
    assert.equal(proof.documentationWithoutConsumers.tokensEqual, true);
    assert.equal(proof.documentationWithoutConsumers.peEqual, true);
    assert.equal(proof.documentationWithoutConsumers.beforeResult, 7);
    assert.equal(proof.documentationWithoutConsumers.afterResult, 7);
    assert.equal(proof.privateFieldWithoutConsumers.beforeResult, 1);
    assert.equal(proof.privateFieldWithoutConsumers.afterResult, 1);
    assert.equal(proof.privateFieldWithoutConsumers.peEqual, false);
    assert.equal(proof.xmlCommentCallerLineNumber.tokensEqual, true);
    assert.equal(proof.xmlCommentCallerLineNumber.beforeResult, 4);
    assert.equal(proof.xmlCommentCallerLineNumber.afterResult, 5);
    assert.equal(proof.xmlCommentSourceGenerator.tokensEqual, true);
    assert.equal(proof.xmlCommentSourceGenerator.beforeResult, 1);
    assert.equal(proof.xmlCommentSourceGenerator.afterResult, 2);
    assert.equal(proof.privateStaticFieldCallerArgumentExpression.beforeResult, 'ContractObserver.SnapshotTime');
    assert.equal(proof.privateStaticFieldCallerArgumentExpression.afterResult, 'ContractObserver.s_snapshotTime');
    assert.equal(proof.privateStaticFieldReflection.beforeResult, true);
    assert.equal(proof.privateStaticFieldReflection.afterResult, false);
    assert.equal(proof.rawStringDocumentationLookalike.tokensEqual, false);
    assert.equal(proof.rawStringDocumentationLookalike.beforeResult, '/// Before.');
    assert.equal(proof.rawStringDocumentationLookalike.afterResult, '/// After.');
    assert.equal(proof.privateFieldNameof.beforeResult, 'SnapshotTime');
    assert.equal(proof.privateFieldNameof.afterResult, 's_snapshotTime');
    for (const control of [proof.xmlCommentCallerLineNumber, proof.xmlCommentSourceGenerator,
        proof.privateStaticFieldCallerArgumentExpression, proof.privateStaticFieldReflection,
        proof.rawStringDocumentationLookalike, proof.privateFieldNameof])
    {
        assert.equal(control.peEqual, false);
    }
});

test('source comparison refuses mutable or incomplete revision context before compiler execution', () =>
{
    for (const revision of ['HEAD', 'latest', '39f955b6', '--help', '../tree', '0'.repeat(39)])
    {
        assert.throws(() => runClassificationProof({ repository: '.', base: revision, head: 'a'.repeat(40) }), /exact full/u);
    }
    assert.throws(() => runClassificationProof({ base: 'a'.repeat(40) }), /explicit repository/u);
});
