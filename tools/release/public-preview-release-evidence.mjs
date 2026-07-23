import process from 'node:process';

import { validatePublicPreviewEvidenceBinding } from './test-evidence-receipts.mjs';

export function requirePublicPreviewReleaseEvidence({
    commitSha,
    browserContractReceipt,
    findReceiptFile,
    sha256Hex,
    environment = process.env
})
{
    const publicPreview = findReceiptFile(
        'fsusblog.public-preview-screenshot-verification.v1',
        [environment.FSUSBLOG_PUBLIC_PREVIEW_SCREENSHOT_EVIDENCE, '.tmp/release-evidence/public-preview-screenshots.json'],
        commitSha,
        { requireExactOne: true }
    );
    if (!publicPreview)
    {
        throw new Error('public-preview screenshot evidence is required; release-final fails closed without local evidence');
    }
    const errors = validatePublicPreviewEvidenceBinding(browserContractReceipt?.publicPreview, publicPreview.receipt, {
        expectedCommit: commitSha,
        evidenceFileDigest: `sha256:${sha256Hex(publicPreview.file)}`
    });
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    return publicPreview.receipt;
}
