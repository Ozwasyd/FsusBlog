/* eslint-disable import-x/no-relative-parent-imports -- The asset inventory shares the existing release identity authority. */
import { createReleaseIdValueContract } from '../release/release-id-value-contract.mjs';

const closed = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
const mediaTypes = Object.freeze({
    html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
    wasm: 'application/wasm', json: 'application/json', webmanifest: 'application/manifest+json',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    xml: 'application/xml', txt: 'text/plain', bin: 'application/octet-stream'
});
const mutable = new Set(['index.html', 'sw.js', 'manifest.webmanifest', '.vite/manifest.json']);

export function releaseAssetMediaType(relativePath)
{
    return mediaTypes[relativePath.split('.').at(-1)?.toLowerCase()] ?? 'application/octet-stream';
}

// Interpret the storage owner's sole inventory. This projection does not sign a
// manifest, invent a second inventory or grant Server/current-schema admission.
export function validateCurrentReleaseAssetInventory(inventory, releaseId, releaseIdContract)
{
    const { isValidReleaseId } = createReleaseIdValueContract(releaseIdContract);
    if (!isValidReleaseId(releaseId)
        || !closed(inventory, ['schema', 'releaseId', 'slot', 'frontendBuildId', 'files', 'compatibilityFile'])
        || inventory.schema !== 'fsusblog.release-assets.v1' || inventory.releaseId !== releaseId
        || inventory.frontendBuildId !== releaseId || !['blue', 'green'].includes(inventory.slot)
        || inventory.compatibilityFile !== null || !Array.isArray(inventory.files)
        || inventory.files.length < 1 || inventory.files.length > 10000)
    {
        throw new Error('current release inventory requires the exact sole inventory and no compatibility metadata');
    }
    const paths = new Set();
    return inventory.files.map(file =>
    {
        if (!closed(file, ['path', 'sha256', 'bytes', 'class', 'releaseUrl', 'cacheControl'])
            || typeof file.path !== 'string' || file.path.includes('\\') || file.path.includes('%')
            || file.path.split('/').some(segment => !segment || ['.', '..', 'latest', 'previous', 'stable'].includes(segment))
            || !/^[A-Za-z0-9._/-]+$/u.test(file.path) || paths.has(file.path)
            || file.path === 'asset-manifest.json' || file.path === 'release-compatibility.json'
            || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.bytes)
            || file.bytes < 0 || file.bytes > 64 * 1024 * 1024
            || file.releaseUrl !== `/release-assets/${releaseId}/${file.path}`
            || file.class !== (mutable.has(file.path) ? 'mutable-entry' : 'immutable-static')
            || file.cacheControl !== (mutable.has(file.path)
                ? 'no-store,max-age=0,must-revalidate' : 'public,max-age=31536000,immutable')
            || /^(?:api|user|admin|account|private)(?:\/|$)/iu.test(file.path))
        {
            throw new Error('current release inventory asset has a drifted path, hash, size, class or URL');
        }
        paths.add(file.path);
        return { ...file, mediaType: releaseAssetMediaType(file.path) };
    });
}
