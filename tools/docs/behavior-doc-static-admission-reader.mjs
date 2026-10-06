import fs from 'node:fs';
import path from 'node:path';

import { readRuntimeRoleExecutionClosure as readPhysicalExecutionClosure } from '../fact-extractors/lib/runtime-role-execution-closure.mjs';
import { readPinnedRepositoryFile } from '../test-matrix/post-runtime-producer-registry.mjs';

const { digestPath } = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));
const { loadRegistry } = await import(new URL('../fact-extractors/registry.mjs', import.meta.url));
import { validateBehaviorDocStaticAdmissionReceipt as validateBehaviorDocStaticAdmissionReceiptValue } from './behavior-doc-static-admission-contract.mjs';

function readRuntimeRoleExecutionClosure(repositoryRoot, assemblyPath)
{
    return readPhysicalExecutionClosure(repositoryRoot, assemblyPath, readPinnedRepositoryFile);
}

export { behaviorDocAdmissionReceiptSchema } from './behavior-doc-static-admission-contract.mjs';

export function validateBehaviorDocStaticAdmissionReceipt(receipt, options = {})
{
    const expectedExtractorIds = options.expectedWorktree == null
        ? null
        : loadRegistry(path.join(
            options.expectedWorktree,
            'config/contracts/behavior-fact-extractors.json'
        )).extractors.map((extractor) => extractor.id).sort();
    return validateBehaviorDocStaticAdmissionReceiptValue(receipt, {
        ...options,
        expectedExtractorIds,
        readArtifactDigest: digestPath,
        readExecutionClosure: readRuntimeRoleExecutionClosure
    });
}

export function readBehaviorDocStaticAdmissionReceipt(file, expected = {})
{
    const stat = file ? fs.lstatSync(file, { throwIfNoEntry: false }) : null;
    if (!stat)
    {
        throw new Error('BehaviorDoc admission receipt is missing');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file))
    {
        throw new Error('BehaviorDoc admission receipt must be a physical regular file');
    }
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validateBehaviorDocStaticAdmissionReceipt(receipt, expected);
}
