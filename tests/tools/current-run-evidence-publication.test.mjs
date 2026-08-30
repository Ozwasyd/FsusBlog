import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { governanceContentDigest } from '../../tools/test/evidence-location-contract.mjs';
import {
    createEvidenceParentReceipt,
    publishCurrentRunEvidenceReference,
    resolveEvidenceReferencePayload
} from '../../tools/test/current-run-evidence-publication.mjs';

const d = (value) => `sha256:${value.repeat(64)}`;
function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-publish-ref-'));
    fs.mkdirSync(path.join(root, 'artifacts/current-run'), { recursive: true });
    const body = { schema: 'fsusblog.current-run-evidence-context.v1', schedulerRunId: 'run-1', attemptId: 'attempt-1',
        sourceCommit: 'a'.repeat(40), worktreeFingerprint: d('b'), candidateIdentity: { id: 'candidate', digest: d('c') },
        buildIdentity: { id: 'build', digest: d('d') }, ownedRoots: ['artifacts/current-run'] };
    const context = { ...body, contentDigest: governanceContentDigest(body) };
    fs.writeFileSync(path.join(root, 'artifacts/current-run/payload.json'), JSON.stringify({ schema: 'payload.v1', ok: true }));
    const options = { authorityId: 'release-manifest.current-run', context, outputPath: 'artifacts/current-run/reference.json',
        payloadPath: 'artifacts/current-run/payload.json', payloadSchema: 'payload.v1', producerId: 'release-producer',
        repositoryRoot: root, terminalStatus: 'success' };
    return { root, context, options };
}

test('terminal producer publication is atomic exact-one and content addressed', () =>
{
    const f = fixture();
    try {
        const receipt = publishCurrentRunEvidenceReference(f.options);
        assert.equal(JSON.parse(fs.readFileSync(`${path.join(f.root, f.options.outputPath)}.publication.json`)).state, 'finalized');
        assert.equal(resolveEvidenceReferencePayload(receipt, { repositoryRoot: f.root,
            ownedRoots: f.context.ownedRoots }).payload.ok, true);
        assert.throws(() => publishCurrentRunEvidenceReference(f.options), /already has a final reference/u);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('failure cancel missing output and cross-attempt parent refs fail closed', () =>
{
    for (const status of ['failure', 'cancelled'])
    {
        const f = fixture();
        try {
            assert.throws(() => publishCurrentRunEvidenceReference({ ...f.options, terminalStatus: status }), /terminal success/u);
            assert.equal(fs.existsSync(path.join(f.root, f.options.outputPath)), false);
        } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }
    const f = fixture();
    try {
        fs.rmSync(path.join(f.root, f.options.payloadPath));
        assert.throws(() => publishCurrentRunEvidenceReference(f.options), /payload is missing/u);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    const g = fixture();
    try {
        const receipt = publishCurrentRunEvidenceReference(g.options);
        assert.throws(() => createEvidenceParentReceipt({ context: g.context, parentAuthorityId: 'parent', producerId: 'parent-producer',
            childReferences: [{ ...receipt, path: g.options.outputPath, inputDigest: d('e'), attemptId: 'old-attempt' }] }), /crosses run attempt/u);
        const parent = createEvidenceParentReceipt({ context: g.context, parentAuthorityId: 'parent', producerId: 'parent-producer',
            childReferences: [{ ...receipt, path: g.options.outputPath, inputDigest: d('e') }] });
        assert.deepEqual(Object.keys(parent.children[0]).sort(),
            ['authorityId', 'inputDigest', 'path', 'producerId', 'producerReceiptDigest']);
    } finally { fs.rmSync(g.root, { recursive: true, force: true }); }
});

test('pointer target digest tamper and path escape fail independently', () =>
{
    const f = fixture();
    try {
        const receipt = publishCurrentRunEvidenceReference(f.options);
        fs.writeFileSync(path.join(f.root, f.options.payloadPath), JSON.stringify({ schema: 'payload.v1', ok: false }));
        assert.throws(() => resolveEvidenceReferencePayload(receipt, { repositoryRoot: f.root,
            ownedRoots: f.context.ownedRoots }), /digest mismatch/u);
        const outside = path.join(f.root, 'outside.json'); fs.writeFileSync(outside, JSON.stringify({ schema: 'payload.v1' }));
        const escaped = structuredClone(receipt); escaped.payload.path = 'outside.json';
        assert.throws(() => resolveEvidenceReferencePayload(escaped, { repositoryRoot: f.root,
            ownedRoots: f.context.ownedRoots }), /escapes/u);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('publication rejects payload and output-parent symlink escapes before writing', () =>
{
    const f = fixture();
    try
    {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-publish-outside-'));
        try
        {
            const outsidePayload = path.join(outside, 'payload.json');
            fs.writeFileSync(outsidePayload, JSON.stringify({ schema: 'payload.v1' }));
            const payloadLink = path.join(f.root, 'artifacts/current-run/payload-link.json');
            fs.symlinkSync(outsidePayload, payloadLink);
            assert.throws(() => publishCurrentRunEvidenceReference({ ...f.options,
                payloadPath: 'artifacts/current-run/payload-link.json' }), /share a current-run owned root/u);

            const outputLink = path.join(f.root, 'artifacts/current-run/output-link');
            fs.symlinkSync(outside, outputLink);
            assert.throws(() => publishCurrentRunEvidenceReference({ ...f.options,
                outputPath: 'artifacts/current-run/output-link/reference.json' }), /share a current-run owned root/u);
            assert.equal(fs.existsSync(path.join(outside, 'reference.json')), false);
        }
        finally
        {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    }
    finally
    {
        fs.rmSync(f.root, { recursive: true, force: true });
    }
});
