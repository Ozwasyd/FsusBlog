/* The browser consumes a signed public projection of the sole release manifest.
 * It never admits a database, switches a release or discovers another manifest. */
(() =>
{
    const encoder = new TextEncoder();
    const verifiedProjections = new WeakSet();
    const verifiedInventories = new WeakMap();
    const digestPattern = /^sha256:[a-f0-9]{64}$/u;
    const exactPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
    const fail = reason =>
    {
        throw new Error(`current_release_assets:${reason}`);
    };
    const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
    const canonicalize = value => JSON.stringify(stable(value));
    function freeze(value)
    {
        if (value && typeof value === 'object')
        {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
        }
        return value;
    }
    function stable(value)
    {
        if (Array.isArray(value))
        {
            return value.map(stable);
        }
        if (value && typeof value === 'object')
        {
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
        }
        return value;
    }
    const exact = value => typeof value === 'string' && exactPattern.test(value)
        && !['latest', 'previous', 'stable'].includes(value);
    async function hash(bytes)
    {
        return `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    function base64(value)
    {
        if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value))
        {
            fail('invalid_base64');
        }
        const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
        if (btoa(String.fromCharCode(...bytes)) !== value)
        {
            fail('noncanonical_base64');
        }
        return bytes;
    }
    function validateProjection(value, isReleaseId)
    {
        if (!closed(value, ['schema', 'candidateId', 'manifestContentDigest', 'releaseId', 'buildId',
            'source', 'backendImageDigest', 'schemaDigest', 'contracts', 'serviceWorker', 'inventory',
            'signing', 'contentDigest', 'signature']) || value.schema !== 'fsusblog.release-browser-projection.v1'
            || typeof isReleaseId !== 'function' || !isReleaseId(value.releaseId) || value.buildId !== value.releaseId)
        {
            fail('closed_current_projection_required');
        }
        for (const key of ['candidateId', 'manifestContentDigest', 'backendImageDigest', 'schemaDigest', 'contentDigest'])
        {
            if (!digestPattern.test(value[key]))
            {
                fail(`invalid_${key}`);
            }
        }
        if (!closed(value.source, ['commitSha', 'worktreeFingerprint', 'buildId'])
            || !/^[a-f0-9]{40}$/u.test(value.source.commitSha) || !digestPattern.test(value.source.worktreeFingerprint)
            || !exact(value.source.buildId))
        {
            fail('invalid_source');
        }
        if (!closed(value.contracts, ['aeds', 'protocol', 'wasmAbi', 'notification']))
        {
            fail('invalid_contracts');
        }
        for (const contract of Object.values(value.contracts))
        {
            if (!closed(contract, ['version', 'sha256']) || !exact(contract.version) || !digestPattern.test(contract.sha256))
            {
                fail('exact_contract_required');
            }
        }
        if (!closed(value.serviceWorker, ['namespace', 'version', 'sha256']) || !exact(value.serviceWorker.namespace)
            || !exact(value.serviceWorker.version) || !digestPattern.test(value.serviceWorker.sha256))
        {
            fail('invalid_worker');
        }
        if (!closed(value.inventory, ['url', 'sha256']) || !digestPattern.test(value.inventory.sha256)
            || value.inventory.url !== `/release-assets/${value.releaseId}/asset-manifest.json`)
        {
            fail('invalid_inventory');
        }
        if (!closed(value.signing, ['algorithm', 'keyId', 'publicKeySha256']) || value.signing.algorithm !== 'ed25519'
            || !exact(value.signing.keyId) || !digestPattern.test(value.signing.publicKeySha256))
        {
            fail('invalid_signing');
        }
        if (base64(value.signature).length !== 64)
        {
            fail('invalid_signature');
        }
        return value;
    }
    async function verifyProjection(bytes, trust)
    {
        if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 1024 * 1024
            || !closed(trust, ['keyId', 'publicKeySha256', 'publicKeySpkiBase64', 'isReleaseId']))
        {
            fail('independent_trust_required');
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const projection = validateProjection(JSON.parse(text), trust.isReleaseId);
        if (canonicalize(projection) !== text)
        {
            fail('noncanonical_projection');
        }
        if (projection.signing.keyId !== trust.keyId || projection.signing.publicKeySha256 !== trust.publicKeySha256)
        {
            fail('independent_trust_mismatch');
        }
        const unsigned = { ...projection };
        delete unsigned.signature;
        delete unsigned.contentDigest;
        if (await hash(encoder.encode(canonicalize(unsigned))) !== projection.contentDigest)
        {
            fail('projection_digest_mismatch');
        }
        const key = await crypto.subtle.importKey('spki', base64(trust.publicKeySpkiBase64), 'Ed25519', false, ['verify']);
        // The operational owner pins PEM bytes; SPKI here is the same public key.
        const pem = `-----BEGIN PUBLIC KEY-----\n${trust.publicKeySpkiBase64.match(/.{1,64}/gu).join('\n')}\n-----END PUBLIC KEY-----\n`;
        if (await hash(encoder.encode(pem)) !== trust.publicKeySha256)
        {
            fail('public_key_digest_mismatch');
        }
        if (!await crypto.subtle.verify('Ed25519', key, base64(projection.signature), encoder.encode(projection.contentDigest)))
        {
            fail('signature_mismatch');
        }
        verifiedProjections.add(projection);
        return freeze(projection);
    }
    function inventoryFiles(inventory, releaseId)
    {
        if (!closed(inventory, ['schema', 'releaseId', 'slot', 'frontendBuildId', 'files', 'compatibilityFile'])
            || inventory.schema !== 'fsusblog.release-assets.v1' || inventory.releaseId !== releaseId
            || inventory.frontendBuildId !== releaseId || !['blue', 'green'].includes(inventory.slot)
            || inventory.compatibilityFile !== null || !Array.isArray(inventory.files)
            || inventory.files.length < 1 || inventory.files.length > 10000)
        {
            fail('invalid_current_inventory');
        }
        const seen = new Set();
        const mutable = new Set(['index.html', 'sw.js', 'manifest.webmanifest', '.vite/manifest.json']);
        const media = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
            wasm: 'application/wasm', json: 'application/json', webmanifest: 'application/manifest+json',
            svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
            avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
            ttf: 'font/ttf', otf: 'font/otf', xml: 'application/xml', txt: 'text/plain', bin: 'application/octet-stream' };
        return inventory.files.map(file =>
        {
            if (!closed(file, ['path', 'sha256', 'bytes', 'class', 'releaseUrl', 'cacheControl'])
                || typeof file.path !== 'string' || !/^[A-Za-z0-9._/-]+$/u.test(file.path)
                || file.path.split('/').some(part => !part || ['.', '..', 'latest', 'previous', 'stable'].includes(part))
                || /^(?:api|user|admin|account|private)(?:\/|$)/iu.test(file.path)
                || ['asset-manifest.json', 'release-compatibility.json'].includes(file.path) || seen.has(file.path)
                || !digestPattern.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
                || file.bytes > 64 * 1024 * 1024 || file.releaseUrl !== `/release-assets/${releaseId}/${file.path}`
                || file.class !== (mutable.has(file.path) ? 'mutable-entry' : 'immutable-static')
                || file.cacheControl !== (mutable.has(file.path) ? 'no-store,max-age=0,must-revalidate' : 'public,max-age=31536000,immutable'))
            {
                fail('invalid_inventory_asset');
            }
            seen.add(file.path);
            return Object.freeze({ ...file, mediaType: media[file.path.split('.').at(-1).toLowerCase()] ?? 'application/octet-stream' });
        });
    }
    async function readBoundedResponse(response, maximumBytes)
    {
        if (!response.ok || response.type === 'opaque' || response.redirected)
        {
            fail('invalid_response');
        }
        const declared = response.headers.get('Content-Length');
        if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes))
        {
            fail('response_size_limit');
        }
        const reader = response.body?.getReader();
        if (!reader)
        {
            fail('response_body_missing');
        }
        const chunks = [];
        let length = 0;
        try
        {
            for (;;)
            {
                const item = await reader.read();
                if (item.done)
                {
                    break;
                }
                length += item.value.byteLength;
                if (length > maximumBytes)
                {
                    fail('response_size_limit');
                }
                chunks.push(item.value);
            }
        }
        finally
        {
            await reader.cancel();
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks)
        {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return bytes;
    }
    function publicResponse(response, immutable)
    {
        const directives = new Set((response.headers.get('Cache-Control') ?? '').toLowerCase().split(',')
            .map(part => part.trim().split('=')[0]));
        const vary = response.headers.get('Vary') ?? '';
        if (response.headers.has('Set-Cookie') || vary.trim() === '*' || /(?:^|,)\s*(?:cookie|authorization)\s*(?:,|$)/iu.test(vary))
        {
            fail('private_response');
        }
        if (immutable && (!directives.has('public') || !directives.has('immutable')
            || directives.has('private') || directives.has('no-store')))
        {
            fail('nonpublic_asset_response');
        }
    }
    function createConsumer({ projection, files, origin, cacheStorage, fetchBytes, operationId })
    {
        if (!verifiedProjections.has(projection) || verifiedInventories.get(files) !== projection)
        {
            fail('verified_inventory_required');
        }
        if (!exact(operationId) || typeof fetchBytes !== 'function' || new URL(origin).origin !== origin)
        {
            fail('invalid_operation');
        }
        const byUrl = new Map(files.map(file => [new URL(file.releaseUrl, origin).href, file]));
        const namespace = `${projection.serviceWorker.namespace}:${projection.serviceWorker.version}:${projection.buildId}`
            + `:${projection.candidateId}:${projection.inventory.sha256}`;
        const cacheName = `fsus-static-current:${namespace}`;
        const stagingName = `${cacheName}:operation:${operationId}`;
        let prepared = false;
        let installed = false;
        let ownsStaging = false;
        let attempted = false;
        const observations = [];
        function assetFor(request)
        {
            const url = new URL(typeof request === 'string' ? request : request.url, origin);
            if (url.search || url.hash || !byUrl.has(url.href))
            {
                fail('undeclared_asset_request');
            }
            if (typeof request !== 'string' && (request.method !== 'GET' || request.cache === 'no-store'
                || ['Authorization', 'X-Fsus-Access-Token', 'X-Fsus-Bearer-Token', 'X-Fsus-Session-Id', 'X-Fsus-Mfa-Proof']
                    .some(header => request.headers.has(header))))
            {
                fail('private_asset_request');
            }
            return byUrl.get(url.href);
        }
        async function verifyResponse(response, file, source)
        {
            publicResponse(response, file.class === 'immutable-static');
            if ((response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() !== file.mediaType)
            {
                fail('asset_media_type_mismatch');
            }
            const bytes = await readBoundedResponse(response.clone(), file.bytes);
            if (bytes.length !== file.bytes || await hash(bytes) !== file.sha256)
            {
                fail('asset_hash_or_size_mismatch');
            }
            if (file.path === 'index.html')
            {
                const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                if (/<base\b/iu.test(html))
                {
                    fail('index_base_rejected');
                }
                for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/giu))
                {
                    const url = new URL(match[1] ?? match[2] ?? match[3], `${origin}/`);
                    if (!byUrl.has(url.href) || url.search || url.hash)
                    {
                        fail('index_undeclared_asset');
                    }
                }
            }
            observations.push({ url: new URL(file.releaseUrl, origin).href, path: file.path, sha256: file.sha256,
                bytes: bytes.length, source, candidateId: projection.candidateId, manifestContentDigest: projection.manifestContentDigest,
                inventorySha256: projection.inventory.sha256, buildId: projection.buildId,
                serviceWorkerVersion: projection.serviceWorker.version });
            return response;
        }
        async function prepare()
        {
            if (attempted)
            {
                fail('operation_already_attempted');
            }
            attempted = true;
            if ((await cacheStorage.keys()).includes(stagingName))
            {
                fail('operation_cache_already_exists');
            }
            const cache = await cacheStorage.open(stagingName);
            ownsStaging = true;
            try
            {
                for (const file of files)
                {
                    const response = await verifyResponse(await fetchBytes(new URL(file.releaseUrl, origin).href,
                        { cache: 'no-store', credentials: 'omit', redirect: 'error' }), file, 'network-install');
                    if (file.class === 'immutable-static')
                    {
                        await cache.put(new URL(file.releaseUrl, origin).href, response.clone());
                    }
                }
                prepared = true;
            }
            catch (error)
            {
                await discard();
                throw error;
            }
        }
        async function commit()
        {
            if (!prepared || installed)
            {
                fail('operation_not_prepared');
            }
            const staging = await cacheStorage.open(stagingName);
            const expected = files.filter(file => file.class === 'immutable-static');
            const keys = await staging.keys();
            if (keys.length !== expected.length || keys.some(key => !byUrl.has(key.url)))
            {
                fail('staging_inventory_mismatch');
            }
            // Verify every byte before opening the verified namespace. Failure
            // leaves active caches and every other operation untouched.
            for (const file of expected)
            {
                const response = await staging.match(new URL(file.releaseUrl, origin).href);
                if (!response)
                {
                    fail('staging_asset_missing');
                }
                await verifyResponse(response, file, 'staging-verify');
            }
            const current = await cacheStorage.open(cacheName);
            const existing = await current.keys();
            if (existing.some(key => !byUrl.has(key.url)))
            {
                fail('current_cache_extra_asset');
            }
            for (const file of expected)
            {
                const url = new URL(file.releaseUrl, origin).href;
                const cached = await current.match(url);
                if (cached)
                {
                    await verifyResponse(cached, file, 'current-verify');
                }
                else
                {
                    await current.put(url, (await staging.match(url)).clone());
                }
            }
            installed = true;
            await discard();
        }
        async function fetchAsset(request)
        {
            const file = assetFor(request);
            if (!installed)
            {
                fail('current_cache_not_installed');
            }
            const url = new URL(file.releaseUrl, origin).href;
            if (file.class === 'immutable-static')
            {
                const cache = await cacheStorage.open(cacheName);
                const cached = await cache.match(url);
                if (cached)
                {
                    return verifyResponse(cached, file, 'current-cache');
                }
                const response = await verifyResponse(await fetchBytes(url,
                    { cache: 'no-store', credentials: 'omit', redirect: 'error' }), file, 'network-current');
                await cache.put(url, response.clone());
                return response;
            }
            return verifyResponse(await fetchBytes(url, { cache: 'no-store', credentials: 'omit', redirect: 'error' }), file, 'network-current');
        }
        async function evidence()
        {
            const value = { schema: 'fsusblog.current-asset-observations.v1', candidateId: projection.candidateId,
                manifestContentDigest: projection.manifestContentDigest, inventorySha256: projection.inventory.sha256,
                cacheName, operationId, observations: structuredClone(observations) };
            return { ...value, contentDigest: await hash(encoder.encode(canonicalize(value))) };
        }
        async function discard()
        {
            if (!ownsStaging)
            {
                return false;
            }
            const deleted = await cacheStorage.delete(stagingName);
            ownsStaging = false;
            return deleted;
        }
        return Object.freeze({ cacheName, stagingName, prepare, commit, fetchAsset, evidence,
            discard });
    }
    async function loadInventory(bytes, projection)
    {
        if (!verifiedProjections.has(projection))
        {
            fail('verified_projection_required');
        }
        if (!(bytes instanceof Uint8Array) || bytes.length > 4 * 1024 * 1024
            || await hash(bytes) !== projection.inventory.sha256)
        {
            fail('inventory_digest_mismatch');
        }
        const files = freeze(inventoryFiles(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), projection.releaseId));
        verifiedInventories.set(files, projection);
        return files;
    }
    async function verifyObservations(bytes, projection, files)
    {
        if (!verifiedProjections.has(projection) || verifiedInventories.get(files) !== projection
            || !(bytes instanceof Uint8Array) || bytes.length > 4 * 1024 * 1024)
        {
            fail('verified_observation_inputs_required');
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const value = JSON.parse(text);
        if (canonicalize(value) !== text || !closed(value, ['schema', 'candidateId', 'manifestContentDigest',
            'inventorySha256', 'cacheName', 'operationId', 'observations', 'contentDigest'])
            || value.schema !== 'fsusblog.current-asset-observations.v1' || !exact(value.operationId)
            || value.candidateId !== projection.candidateId || value.manifestContentDigest !== projection.manifestContentDigest
            || value.inventorySha256 !== projection.inventory.sha256 || !Array.isArray(value.observations))
        {
            fail('observation_identity_mismatch');
        }
        const cacheName = `fsus-static-current:${projection.serviceWorker.namespace}:${projection.serviceWorker.version}:${projection.buildId}`
            + `:${projection.candidateId}:${projection.inventory.sha256}`;
        if (value.cacheName !== cacheName)
        {
            fail('observation_namespace_mismatch');
        }
        const { contentDigest, ...payload } = value;
        if (await hash(encoder.encode(canonicalize(payload))) !== contentDigest)
        {
            fail('observation_digest_mismatch');
        }
        for (const item of value.observations)
        {
            const file = files.find(asset => asset.path === item.path);
            const url = new URL(item.url);
            if (!closed(item, ['url', 'path', 'sha256', 'bytes', 'source', 'candidateId', 'manifestContentDigest',
                'inventorySha256', 'buildId', 'serviceWorkerVersion']) || !file
                || url.pathname !== file.releaseUrl || url.search || url.hash || url.protocol !== 'https:'
                || item.sha256 !== file.sha256 || item.bytes !== file.bytes || item.candidateId !== projection.candidateId
                || item.manifestContentDigest !== projection.manifestContentDigest || item.inventorySha256 !== projection.inventory.sha256
                || item.buildId !== projection.buildId || item.serviceWorkerVersion !== projection.serviceWorker.version
                || !['network-install', 'staging-verify', 'current-verify', 'current-cache', 'network-current'].includes(item.source))
            {
                fail('observation_asset_mismatch');
            }
        }
        // A caller-sealed observation is only an inspectable byte-binding record.
        // Original independent browser/native producers still own runtime proof.
        return { candidateId: value.candidateId, observationCount: value.observations.length,
            contentDigest, runtimeQualificationEligible: false };
    }
    Object.defineProperty(globalThis, 'FsusCurrentReleaseAssets', { value: Object.freeze({ canonicalize,
        validateProjection, verifyProjection, loadInventory, createConsumer, verifyObservations, readBoundedResponse, hash }), writable: false });
})();
