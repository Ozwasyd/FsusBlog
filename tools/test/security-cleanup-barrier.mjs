import fs from 'node:fs';
import path from 'node:path';

export function readVerifiedSecurityCleanupReceipt(file, digest)
{
    if (!file)
    {
        throw new Error('runtime scenario reset barrier requires the security producer exact cleanup receipt');
    }
    const cleanupReceipt = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const body = { ...cleanupReceipt };
    delete body.contentDigest;
    const expectedDigest = `sha256:${digest(body)}`;
    if (cleanupReceipt.schema !== 'fsusblog.security-fixture-cleanup-observation.v1'
      || cleanupReceipt.contentDigest !== expectedDigest
      || cleanupReceipt.nonOwnedMutationCount !== 0
      || !Array.isArray(cleanupReceipt.residualOwnedOperationIds)
      || cleanupReceipt.residualOwnedOperationIds.length !== 0
      || !Array.isArray(cleanupReceipt.preservedNamespaceDigests)
      || cleanupReceipt.preservedNamespaceDigests.length === 0)
    {
        throw new Error('runtime scenario reset barrier rejected the security cleanup receipt');
    }
    return cleanupReceipt;
}
