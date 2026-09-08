import fs from 'node:fs';
import path from 'node:path';

import { registryRelease } from './dependency-registry-release.mjs';

export function selectNpmRegistry(packageName, configs)
{
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(packageName)) throw new Error('npm_package_name_invalid');
    const scopeKey = packageName.startsWith('@') ? `${packageName.split('/')[0]}:registry` : null;
    const settings = new Map();
    for (const config of configs)
    {
        for (const line of config.split(/\r?\n/))
        {
            const match = /^\s*(registry|@[^:]+:registry)\s*=\s*(.*?)\s*$/.exec(line);
            if (match) settings.set(match[1], match[2]);
        }
    }
    const value = settings.get(scopeKey) ?? settings.get('registry') ?? 'https://registry.npmjs.org/';
    let url;
    try { url = new URL(value); }
    catch { throw new Error('npm_registry_url_invalid'); }
    if (!['https://registry.npmjs.org', 'https://npm.pkg.github.com'].includes(url.origin)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    {
        throw new Error('npm_registry_url_invalid');
    }
    return url.origin;
}

export async function readLatestNpm(item, root, fetchJson, githubToken)
{
    const readConfig = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const rootConfig = readConfig(path.join(root, '.npmrc'));
    const manifests = (item.files ?? []).filter((file) => path.basename(file) === 'package.json');
    const registries = new Set((manifests.length ? manifests : ['package.json']).map((file) =>
        selectNpmRegistry(item.packageName, [rootConfig, readConfig(path.join(root, path.dirname(file), '.npmrc'))])));
    if (registries.size !== 1) throw new Error(`npm_registry_owner_ambiguous:${item.id}`);
    const origin = [...registries][0];
    const headers = {};
    if (origin === 'https://npm.pkg.github.com')
    {
        if (typeof githubToken !== 'string' || !githubToken || /[\r\n]/.test(githubToken)) throw new Error('npm_github_token_missing_or_invalid');
        headers.Authorization = `Bearer ${githubToken}`;
    }
    const body = await fetchJson(`${origin}/${encodeURIComponent(item.packageName)}`, headers);
    if (body.name !== item.packageName) throw new Error(`npm_registry_package_identity_mismatch:${item.id}`);
    const latest = body['dist-tags']?.latest;
    return registryRelease(latest, body.time?.[latest], `npm:${item.packageName}`);
}
