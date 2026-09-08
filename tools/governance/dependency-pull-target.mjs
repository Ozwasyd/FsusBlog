import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractCurrentVersion } from './dependency-freshness.mjs';

/** Reuse the canonical extractor over data files from one immutable PR head; execute no candidate code. */
export async function resolveDependencyPullTarget({ mapping, item, config, readFileAtHead })
{
    if (!/^[0-9a-f]{40}$/u.test(mapping?.headSha ?? '') || mapping.state !== 'open'
        || mapping.dependencyId !== item?.id || mapping.packageName !== item.packageName
        || !Array.isArray(item.files) || item.files.length === 0 || item.files.length > 100)
    {
        throw new Error('dependency_pull_target_identity_invalid');
    }
    const files = [...new Set(item.files)];
    if (files.some(file => typeof file !== 'string' || !file || file.includes('\\')
        || file.split('/').some(segment => !segment || segment === '.' || segment === '..')
        || /[\x00-\x1f\x7f:]/u.test(file)))
    {
        throw new Error('dependency_pull_target_path_invalid');
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-pull-target-'));
    try
    {
        let totalBytes = 0;
        for (const file of files)
        {
            const source = await readFileAtHead(file, mapping.headSha);
            if (typeof source !== 'string' || Buffer.byteLength(source) > 16 * 1024 * 1024)
            {
                throw new Error('dependency_pull_target_source_invalid');
            }
            totalBytes += Buffer.byteLength(source);
            if (totalBytes > 32 * 1024 * 1024) throw new Error('dependency_pull_target_source_limit');
            const destination = path.join(root, file);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, source, { flag: 'wx' });
        }
        const targetVersion = extractCurrentVersion(root, item, config);
        if (!targetVersion) throw new Error('dependency_pull_target_version_missing');
        return { ...mapping, declaredTargetVersion: mapping.declaredTargetVersion ?? mapping.targetVersion, targetVersion };
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
