import { validatePublicPreviewEvidenceBinding } from './test-evidence-receipts.mjs';

export function requirePublicPreviewReleaseEvidence({
    commitSha,
    browserContractReceipt,
    evidence,
    sha256Hex
})
{
    const publicPreview = evidence;
    if (publicPreview?.receipt?.schema !== 'fsusblog.public-preview-screenshot-verification.v1')
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
