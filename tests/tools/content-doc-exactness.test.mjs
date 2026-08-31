import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { runBehaviorDocStaticAdmission } from '../../tools/docs/behavior-doc-static-admission.mjs';
import {
    negativeClassIds,
    produceMutationEvidence,
    produceTerminalReceipt,
    runContentNegativeClasses,
    scanContentResidues,
    verifyTerminalReceipt
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
} from '../../tools/docs/content-doc-exactness.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- This test or tool imports the existing repository owner that it directly exercises.
import { digestValue } from '../../tools/docs/doc-claim.mjs';

const evidenceRoot = path.join(process.cwd(), '.tmp', 'content-doc-exactness-tests', String(process.pid));
const componentsDirectory = path.join(evidenceRoot, 'components');
const admissionFile = path.join(evidenceRoot, 'admission.json');
const observationFile = path.join(componentsDirectory, 'fact-observations', 'content-lifecycle-fact-extractor.json');
const proseFile = path.join(componentsDirectory, 'doc-claim-verification.json');
const generatedFile = path.join(componentsDirectory, 'generated-section-check.json');
const mutationFile = path.join(evidenceRoot, 'mutation.json');
let admissionPromise;

function currentAdmission()
{
    admissionPromise ??= runBehaviorDocStaticAdmission({
        repositoryRoot: process.cwd(),
        runId: `content-doc-exactness-test-${process.pid}`,
        outputFile: admissionFile,
        componentsDirectory
    });
    return admissionPromise;
}

async function currentContentObservation()
{
    await currentAdmission();
    return JSON.parse(readFileSync(observationFile, 'utf8'));
}

test('content authorities have zero manual exact table, compat, waiver, or self-certification residue', () =>
{
    assert.deepEqual(scanContentResidues(), []);
});

test('thirteen content exactness degradation classes are independently killed', async () =>
{
    const cases = runContentNegativeClasses({ observationReceipt: await currentContentObservation() });
    assert.deepEqual(cases.map((entry) => entry.id).sort(), [...negativeClassIds].sort());
    assert.equal(cases.every((entry) => entry.status === 'killed'), true);
    for (const id of [
        'required-outbox-edge-drift',
        'article-transition-reversal',
        'comment-public-admin-visibility-drift',
        'reply-notification-condition-drift',
        'privacy-forbidden-field-drift'
    ])
    {
        assert.match(cases.find((entry) => entry.id === id).reason, /generated section drift detected/u);
    }
    assert.match(
        cases.find((entry) => entry.id === 'rollback-restore-delete-coordinate-omission').reason,
        /PROSE_(?:RELATION_MISMATCH|CLAIM_REQUIRED_TOKEN_MISSING)/u
    );
});

test('generated and prose exactness stay distinct at repository scale', async () =>
{
    const cases = runContentNegativeClasses({ observationReceipt: await currentContentObservation() });
    const ids = new Set(cases.map((entry) => entry.id));
    assert.equal(ids.has('generated-as-prose'), true);
    assert.equal(ids.has('overbroad-prose-claim'), true);
    assert.equal(ids.has('missing-required-behavior'), true);
    assert.equal(ids.has('wrong-generated-anchor'), true);
});

test('terminal receipt is independently recomputed and rejects re-sealed tampering', async () =>
{
    await currentAdmission();
    mkdirSync(evidenceRoot, { recursive: true });
    const mutation = produceMutationEvidence({ observationFile });
    writeFileSync(mutationFile, `${JSON.stringify(mutation, null, 2)}\n`);
    const componentFiles = { admissionFile, proseFile, generatedFile, observationFile, mutationFile };
    const receipt = produceTerminalReceipt(componentFiles);
    assert.equal(verifyTerminalReceipt(receipt, componentFiles), receipt);

    for (const mutate of [
        (candidate) =>
        {
            candidate.counts.required += 1;
        },
        (candidate) =>
        {
            candidate.rows[0].currentAuthority = 'docs/api/forged.md';
        }
    ])
    {
        const candidate = structuredClone(receipt);
        mutate(candidate);
        candidate.contentDigest = null;
        candidate.contentDigest = digestValue(candidate);
        assert.throws(
            () => verifyTerminalReceipt(candidate, componentFiles),
            /does not match independently recomputed evidence/u
        );
    }
});
