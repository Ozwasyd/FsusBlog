// fixture-catalog: consumer browser-contract-facade acceptance-representative
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
    resolveAuthFixtureDirectory,
    resolveAuthFixtureManifest,
    resolveFixtureNamespace,
    resolveFixtureRoot,
    resolvePublicFixtureFile
// eslint-disable-next-line import-x/no-relative-parent-imports -- The browser-contract facade owns the canonical cross-suite fixture path adapter.
} from '../frontend/support/fixture-paths.mjs';
// eslint-disable-next-line import-x/no-relative-parent-imports -- The browser-contract facade consumes the canonical public fixture reader.
import { readPublicFixtures } from '../frontend/support/public-fixtures.mjs';

import { BrowserContractFailure, contractAssert } from './contract.mjs';
import {
    browserContractFixedFixtureTopology,
    browserContractFixtureManifestSchema,
    createBrowserContractFixtureApi,
    readSealedBrowserContractFixture,
    resolveBrowserContractRunIdentity
} from './fixture-lifecycle.mjs';
import { validatePublicShellLocaleMatrix } from './public-shell-locale-matrix.mjs';

export { browserContractFixedFixtureTopology, resolveBrowserContractRunIdentity };
export {
    BrowserContractFailure,
    browserContractReceiptSchema,
    browserContractScenarios,
    classifyBrowserContractFailure,
    createBrowserContractReceipt,
    selectBrowserContractScenarios
} from './contract.mjs';

export const browserContractFixtureAdapterSchema = 'fsusblog.browser-contract-fixture-adapter.v2';
const publicShellSceneHandles = new WeakMap();
const publicShellContexts = new WeakMap();
const usedPublicShellContexts = new WeakSet();

function publicShellSceneApi(prepared, signal = null)
{
    contractAssert(prepared?.lifecycle?.status === 'prepared', 'PublicShell scene requires live canonical preparation');
    return createBrowserContractFixtureApi({
        identity: prepared.identity, env: prepared.env, repoRoot: prepared.repoRoot,
        sourceState: prepared.sourceState, build: prepared.build, preparation: prepared.preparation, signal
    });
}

function sceneHandle(prepared, handle)
{
    const owned = publicShellSceneHandles.get(handle);
    contractAssert(owned?.prepared === prepared && owned.status === 'prepared',
        'PublicShell scene handle is missing, foreign or already consumed', { lease: handle });
    publicShellSceneApi(prepared);
    return owned;
}

/** Read current common authority through the configured provider; allocate no scene or actor. */
export async function readPublicShellLocaleRootAuthority(prepared, { matrix, signal = null })
{
    if (signal?.aborted)
    {
        throw new BrowserContractFailure('PublicShell Root authority query was cancelled', 'infra');
    }
    const api = publicShellSceneApi(prepared, signal);
    await validatePublicShellLocaleMatrix(matrix, prepared.repoRoot);
    contractAssert(matrix.identity.sourceCommit === prepared.sourceState.commit
        && matrix.identity.worktreeFingerprint === prepared.sourceState.worktreeFingerprint,
    'PublicShell Root matrix does not bind the prepared source');
    contractAssert(matrix.scenes.length > 0, 'PublicShell Root matrix has no canonical scene');
    if (signal?.aborted)
    {
        throw new BrowserContractFailure('PublicShell Root authority query was cancelled', 'infra');
    }
    const authority = await api.readPublicShellLocaleAuthority(matrix.scenes[0].id);
    if (signal?.aborted)
    {
        throw new BrowserContractFailure('PublicShell Root authority query was cancelled', 'infra');
    }
    contractAssert(authority.matrixDigest === matrix.contentDigest
        && typeof authority.runtimeRunId === 'string' && authority.runtimeRunId.trim().length > 0
        && typeof authority.runtime?.frontendUrl === 'string'
        && typeof authority.runtime?.backendUrl === 'string'
        && authority.runtime?.frontendUrl === prepared.lifecycle.runtime?.frontendUrl
        && authority.runtime?.backendUrl === prepared.lifecycle.runtime?.backendUrl
        && typeof authority.fixtureReceiptDigest === 'string'
        && /^(?:sha256:)?[a-f0-9]{64}$/u.test(authority.fixtureReceiptDigest),
    'PublicShell Root authority does not bind the current prepared runtime');
    return Object.freeze(structuredClone(authority));
}

/** Formal facade: returns a lease (or explicit auth blocker), never a product acceptance flag. */
export async function preparePublicShellLocaleScene(prepared, { matrix, sceneId })
{
    const api = publicShellSceneApi(prepared);
    await validatePublicShellLocaleMatrix(matrix, prepared.repoRoot);
    contractAssert(matrix.identity.sourceCommit === prepared.sourceState.commit
        && matrix.identity.worktreeFingerprint === prepared.sourceState.worktreeFingerprint,
    'PublicShell scene matrix does not bind the prepared source');
    const scene = matrix.scenes.find((item) => item.id === sceneId);
    contractAssert(scene, 'PublicShell scene is not in the canonical matrix');
    const lease = await api.preparePublicShellLocaleScene(sceneId);
    prepared.lifecycle.publicShellLocaleSceneBindingFile = path.join(prepared.root, 'public-shell-locale-scene-bindings.json');
    if (lease.status === 'blocked')
    {
        contractAssert(scene.authActionContext !== 'anonymous' && lease.contextCount === 0
            && lease.reason === 'canonical-scene-auth-allocation-unavailable', 'PublicShell auth blocker is invalid');
        return Object.freeze(lease);
    }
    contractAssert(lease.status === 'prepared' && lease.role === 'anonymous' && scene.authActionContext === 'anonymous'
        && lease.sceneId === sceneId && lease.authority?.matrixDigest === matrix.contentDigest,
    'PublicShell scene actor source is missing or mismatched', { lease });
    const handle = Object.freeze(structuredClone(lease));
    publicShellSceneHandles.set(handle, { prepared, lease, api, status: 'prepared' });
    return handle;
}

/** Only the canonical runner supplies its existing Browser; this facade does not launch one. */
export async function consumePublicShellLocaleScene(prepared, handle, browser)
{
    const owned = sceneHandle(prepared, handle);
    contractAssert(typeof browser?.newContext === 'function' && typeof browser.contexts === 'function',
        'PublicShell scene requires the canonical Browser owner');
    const previousContexts = new Set(browser.contexts());
    owned.lease = await owned.api.transitionPublicShellLocaleScene(owned.lease, 'reserved');
    owned.status = 'reserved';
    const inputs = owned.lease.authority.inputs;
    const options = {
        viewport: { ...inputs.viewport }, javaScriptEnabled: inputs.javaScriptEnabled,
        serviceWorkers: 'block',
        storageState: { cookies: [], origins: [] },
        extraHTTPHeaders: inputs.acceptLanguage === null ? {} : { 'Accept-Language': inputs.acceptLanguage }
    };
    if (inputs.cookie !== null)
    {
        options.storageState.cookies.push({
            name: inputs.cookieName, value: inputs.cookie,
            domain: new URL(owned.lease.authority.runtime.frontendUrl).hostname,
            path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax'
        });
    }
    let context;
    try
    {
        context = await browser.newContext(options);
    }
    catch (error)
    {
        try
        {
            owned.lease = await owned.api.transitionPublicShellLocaleScene(owned.lease, 'creation-failed', error);
        }
        catch (bindingError)
        {
            Object.assign(error, { sceneBindingError: bindingError, sceneLease: owned.lease });
        }
        owned.status = 'creation-failed';
        throw error;
    }
    contractAssert(context && typeof context.close === 'function' && typeof context.browser === 'function'
        && context.browser() === browser && browser.contexts().includes(context)
        && !previousContexts.has(context) && !usedPublicShellContexts.has(context),
    'PublicShell context is missing, foreign or reused; reserved lease retained', { lease: owned.lease });
    usedPublicShellContexts.add(context);
    publicShellContexts.set(context, owned);
    owned.context = context;
    owned.lease = await owned.api.transitionPublicShellLocaleScene(owned.lease, 'entered');
    owned.status = 'entered';
    if (inputs.acceptLanguage === null)
    {
        try
        {
            contractAssert(typeof context.route === 'function', 'PublicShell missing-header context requires request routing');
            await context.route('**/*', async (route) =>
            {
                const headers = { ...await route.request().allHeaders() };
                for (const name of Object.keys(headers))
                {
                    if (name.toLowerCase() === 'accept-language')
                    {
                        delete headers[name];
                    }
                }
                await route.continue({ headers });
            });
        }
        catch (error)
        {
            try
            {
                await finishPublicShellLocaleScene(prepared, handle, context, error);
            }
            catch (cleanupError)
            {
                Object.assign(error, { sceneCleanupError: cleanupError, sceneLease: owned.lease });
            }
            throw error;
        }
    }
    return context;
}

/** Read only through the entered scene's original provider capability and live context. */
export async function readPublicShellLocaleScenePublishedArtifact(prepared, handle, context, selectedPath)
{
    const owned = publicShellSceneHandles.get(handle);
    const requireEntered = () =>
    {
        publicShellSceneApi(prepared);
        contractAssert(owned?.prepared === prepared && owned.status === 'entered'
            && owned.context === context && publicShellContexts.get(context) === owned
            && !owned.finishing && !owned.closed,
        'PublicShell published read requires its exact entered scene context');
    };
    requireEntered();
    const result = await owned.api.readPublicShellLocalePublishedArtifact(handle.sceneId, selectedPath);
    requireEntered();
    contractAssert(result.sceneId === handle.sceneId
        && result.matrixDigest === handle.authority.matrixDigest
        && result.runtimeRunId === handle.authority.runtimeRunId,
    'PublicShell published read result belongs to another scene or runtime');
    return Object.freeze(structuredClone(result));
}

export async function finishPublicShellLocaleScene(prepared, handle, context, failure = null)
{
    const owned = publicShellSceneHandles.get(handle);
    contractAssert(owned?.prepared === prepared && owned.status === 'entered'
        && !owned.finishing && owned.context === context && publicShellContexts.get(context) === owned,
    'PublicShell close requires the exact live context owner', { lease: handle });
    publicShellSceneApi(prepared);
    owned.firstFailure ??= failure;
    // A failed close retains the entered lease; no invented end count or early namespace cleanup.
    owned.finishing = true;
    try
    {
        if (!owned.closed)
        {
            try
            {
                await context.close();
                owned.closed = true;
            }
            catch (error)
            {
                owned.firstFailure ??= error;
                try
                {
                    owned.lease = await owned.api.transitionPublicShellLocaleScene(owned.lease, 'close-failed', owned.firstFailure);
                }
                catch (bindingError)
                {
                    Object.assign(error, { sceneBindingError: bindingError, sceneLease: owned.lease });
                }
                throw error;
            }
        }
        owned.lease = await owned.api.transitionPublicShellLocaleScene(owned.lease, 'finished', owned.firstFailure ?? failure);
        owned.status = 'finished';
        publicShellContexts.delete(context);
        return Object.freeze(structuredClone(owned.lease));
    }
    finally
    {
        owned.finishing = false;
    }
}

export async function abandonPublicShellLocaleScene(prepared, handle, failure = null)
{
    const owned = sceneHandle(prepared, handle);
    owned.lease = await owned.api.transitionPublicShellLocaleScene(owned.lease, 'abandoned', failure);
    owned.status = 'abandoned';
    return Object.freeze(structuredClone(owned.lease));
}

function resolveStorageStateFile(authDirectory, descriptor, role, { requirePrivate = false } = {})
{
    const relative = String(descriptor?.storageStateFile ?? '').trim();
    contractAssert(relative && path.basename(relative) === relative, `${role} storage state filename is invalid`);
    const file = path.resolve(authDirectory, relative);
    contractAssert(file.startsWith(`${path.resolve(authDirectory)}${path.sep}`), `${role} storage state escapes fixture root`);
    contractAssert(existsSync(file), `${role} storage state is missing: ${relative}`);
    const stat = lstatSync(file);
    contractAssert(
        stat.isFile() && !stat.isSymbolicLink() && realpathSync(file) === file,
        `${role} storage state must be a regular non-symlink file`
    );
    if (requirePrivate)
    {
        contractAssert((stat.mode & 0o777) === 0o600, `${role} storage state permissions must be 0600`);
    }
    return file;
}

async function loadPortableStorageState(file, baseUrl, role)
{
    let source;
    try
    {
        source = JSON.parse(await readFile(file, 'utf8'));
    }
    catch (error)
    {
        throw new BrowserContractFailure(`${role} storage state is not valid JSON`, 'contract', {
            message: error instanceof Error ? error.message : String(error)
        });
    }

    contractAssert(Array.isArray(source?.cookies), `${role} storage state cookies are invalid`);
    contractAssert(Array.isArray(source?.origins), `${role} storage state origins are invalid`);
    const runtimeOrigin = new URL(baseUrl).origin;
    const allowSecureCookies = runtimeOrigin.startsWith('https://');
    const cookies = source.cookies
        .filter((cookie) => allowSecureCookies || cookie?.secure !== true)
        .map((cookie) =>
        {
            contractAssert(
                typeof cookie?.name === 'string' && typeof cookie?.value === 'string',
                `${role} storage state cookie is invalid`
            );
            const portable = { ...cookie };
            delete portable.domain;
            delete portable.path;
            delete portable.url;
            // Fixture JWTs are bound to the injected business clock. Keeping a
            // host-wall-clock expiry would make Playwright discard an otherwise
            // valid acceptance session before the request reaches the runtime.
            delete portable.expires;
            return { ...portable, url: runtimeOrigin };
        });
    contractAssert(cookies.length > 0, `${role} storage state has no cookies valid for ${runtimeOrigin}`);

    return Object.freeze({
        cookies: Object.freeze(cookies),
        origins: Object.freeze(source.origins.map((origin) => ({
            ...origin,
            origin: runtimeOrigin
        })))
    });
}

function combineAdminStorageState(userStorageState, adminStorageState)
{
    const cookies = new Map();
    for (const cookie of [...userStorageState.cookies, ...adminStorageState.cookies])
    {
        const key = [
            cookie.name,
            cookie.url ?? '',
            cookie.domain ?? '',
            cookie.path ?? ''
        ].join('\0');
        cookies.set(key, cookie);
    }
    const origins = new Map();
    for (const origin of [...userStorageState.origins, ...adminStorageState.origins])
    {
        origins.set(origin.origin, origin);
    }
    return Object.freeze({
        cookies: Object.freeze([...cookies.values()]),
        origins: Object.freeze([...origins.values()])
    });
}

async function loadSealedContractFixture({
    env,
    fixtureRoot,
    lifecycle,
    expectedSourceState,
    expectedBuild
})
{
    const manifestFile = path.join(fixtureRoot, 'contract-fixture.json');
    if (!existsSync(manifestFile))
    {
        throw new BrowserContractFailure(
            `sealed browser contract fixture is missing under ${fixtureRoot}; public fallback is forbidden`,
            'contract'
        );
    }
    const manifest = await readSealedBrowserContractFixture(manifestFile);
    contractAssert(manifest.schema === browserContractFixtureManifestSchema, 'browser contract fixture manifest schema mismatch');
    contractAssert(manifest.topology?.sessions === 1, 'browser contract fixture must contain exactly one session');
    contractAssert(manifest.topology?.concurrency === 1, 'browser contract fixture preparation concurrency must be one');
    const namespace = String(manifest.identity?.namespace ?? '').trim();
    contractAssert(namespace && namespace === String(env.FSUSBLOG_TEST_SESSION ?? namespace), 'browser contract fixture namespace mismatch');
    contractAssert(manifest.identity?.laneId === 'browser-contract', 'browser contract fixture lane identity mismatch');
    if (lifecycle?.preparation)
    {
        contractAssert(
            manifest.preparation?.id === lifecycle.preparation.id
        && manifest.preparation?.startedAt === lifecycle.preparation.startedAt,
            'browser contract fixture preparation freshness mismatch'
        );
    }
    contractAssert(manifest.resources?.databaseSchema === 'public', 'browser contract database schema mismatch');
    contractAssert(
        manifest.resources?.databaseInstance === `fsusblog-test-postgres-${namespace}`,
        'browser contract database instance mismatch'
    );
    contractAssert(manifest.resources?.redisNamespace === `FsusBlog_${namespace}_`, 'browser contract Redis namespace mismatch');
    contractAssert(
        manifest.resources?.redisInstance === `fsusblog-test-redis-${namespace}`,
        'browser contract Redis instance mismatch'
    );
    contractAssert(
        manifest.transport?.testSessionHeader === false,
        'browser contract fixture must explicitly disable the test-session header'
    );
    contractAssert(
        manifest.ownership?.containers?.postgres?.name === manifest.resources.databaseInstance
      && /^[a-f0-9]{64}$/u.test(String(manifest.ownership.containers.postgres.id ?? '')),
        'browser contract database ownership identity is invalid'
    );
    contractAssert(
        manifest.ownership?.containers?.redis?.name === manifest.resources.redisInstance
      && /^[a-f0-9]{64}$/u.test(String(manifest.ownership.containers.redis.id ?? '')),
        'browser contract Redis ownership identity is invalid'
    );
    if (expectedSourceState)
    {
        contractAssert(manifest.sourceState?.commit === expectedSourceState.commit, 'browser contract fixture source commit mismatch');
        contractAssert(
            manifest.sourceState?.worktreeFingerprint === expectedSourceState.worktreeFingerprint,
            'browser contract fixture source fingerprint mismatch'
        );
    }
    if (expectedBuild?.receiptContentDigest)
    {
        contractAssert(
            manifest.buildIdentity?.receiptContentDigest === expectedBuild.receiptContentDigest,
            'browser contract fixture build identity mismatch'
        );
    }

    const entities = manifest.entities ?? {};
    const articleId = String(entities.publicArticle?.id ?? '').trim();
    contractAssert(/^\d+$/u.test(articleId), 'browser contract public article id must be numeric');
    contractAssert(String(entities.publicArticle?.title ?? '').trim(), 'browser contract public article title is missing');
    contractAssert(Number.isInteger(Number(entities.user?.id)) && Number(entities.user.id) > 0, 'browser contract user fixture is invalid');
    contractAssert(Number.isInteger(Number(entities.admin?.id)) && Number(entities.admin.id) > 0, 'browser contract admin fixture is invalid');
    const userStorageStateFile = resolveStorageStateFile(fixtureRoot, entities.user, 'user', { requirePrivate: true });
    const adminStorageStateFile = resolveStorageStateFile(fixtureRoot, entities.admin, 'admin', { requirePrivate: true });
    const [userStorageState, adminStorageState] = await Promise.all([
        loadPortableStorageState(userStorageStateFile, manifest.baseUrl, 'user'),
        loadPortableStorageState(adminStorageStateFile, manifest.baseUrl, 'admin')
    ]);
    const completeAdminStorageState = combineAdminStorageState(
        userStorageState,
        adminStorageState
    );

    return Object.freeze({
        schema: browserContractFixtureAdapterSchema,
        manifestSchema: manifest.schema,
        namespace,
        root: fixtureRoot,
        generatedAt: String(manifest.generatedAt ?? ''),
        baseUrl: String(manifest.baseUrl).replace(/\/+$/u, ''),
        backendUrl: String(manifest.backendUrl).replace(/\/+$/u, ''),
        testSession: null,
        databaseSchema: manifest.resources.databaseSchema,
        databaseInstance: manifest.resources.databaseInstance,
        redisNamespace: manifest.resources.redisNamespace,
        redisInstance: manifest.resources.redisInstance,
        sourceState: manifest.sourceState,
        buildIdentity: manifest.buildIdentity,
        preparation: manifest.preparation,
        ownership: manifest.ownership,
        transport: manifest.transport,
        topology: Object.freeze({ sessions: 1, concurrency: 1 }),
        lifecycle,
        publicArticle: Object.freeze({
            id: articleId,
            title: String(entities.publicArticle.title),
            url: String(entities.publicArticle.url)
        }),
        category: Object.freeze({
            id: String(entities.category?.id ?? '').trim(),
            name: String(entities.category?.name ?? '').trim()
        }),
        pendingComment: Object.freeze({
            id: String(entities.pendingComment?.id ?? '').trim(),
            articleId: String(entities.pendingComment?.articleId ?? '').trim(),
            url: String(entities.pendingComment?.url ?? '')
        }),
        capabilities: Object.freeze({
            webAuthnRegistration: manifest.capabilities?.webAuthnRegistration === true
        }),
        user: Object.freeze({
            id: Number(entities.user.id),
            storageStateFile: userStorageStateFile,
            storageState: userStorageState
        }),
        admin: Object.freeze({
            id: Number(entities.admin.id),
            storageStateFile: adminStorageStateFile,
            storageState: completeAdminStorageState
        })
    });
}

export async function loadBrowserContractFixture({
    env = process.env,
    repoRoot = process.cwd(),
    fixtureRoot = null,
    lifecycle = null,
    expectedSourceState = null,
    expectedBuild = null
} = {})
{
    if (env.FSUSBLOG_PLAYWRIGHT_SESSION_MODE === 'browser-contract')
    {
        const root = path.resolve(fixtureRoot ?? env.FSUSBLOG_FIXTURE_ROOT ?? '');
        contractAssert(root && root !== path.parse(root).root, 'browser contract fixture root is missing');
        return await loadSealedContractFixture({
            env,
            fixtureRoot: root,
            lifecycle,
            expectedSourceState,
            expectedBuild
        });
    }
    const legacyFixtureRoot = resolveFixtureRoot({ env, repoRoot });
    const publicFixtureFile = resolvePublicFixtureFile({ env, repoRoot });
    const authFixtureFile = resolveAuthFixtureManifest({ env, repoRoot });
    const authDirectory = resolveAuthFixtureDirectory({ env, repoRoot });

    if (!existsSync(publicFixtureFile) || !existsSync(authFixtureFile))
    {
        throw new BrowserContractFailure(
            `browser contract fixture is incomplete under ${legacyFixtureRoot}; prepare one immutable namespace before launch`,
            'contract',
            { publicFixtureFile, authFixtureFile }
        );
    }

    const publicFixture = readPublicFixtures({}, {
        requireCurrent: true,
        env,
        repoRoot
    });
    const authFixture = JSON.parse(await readFile(authFixtureFile, 'utf8'));
    const articleId = String(publicFixture.articleId ?? '').trim();
    const articleTitle = String(publicFixture.articleTitle ?? '').trim();
    contractAssert(/^\d+$/u.test(articleId), 'browser contract public article id must be numeric');
    contractAssert(articleTitle.length > 0, 'browser contract public article title is missing');
    contractAssert(Number.isInteger(Number(authFixture.user?.id)) && Number(authFixture.user.id) > 0, 'browser contract user fixture is invalid');
    contractAssert(Number.isInteger(Number(authFixture.admin?.id)) && Number(authFixture.admin.id) > 0, 'browser contract admin fixture is invalid');

    const baseUrl = String(
        env.PLAYWRIGHT_BASE_URL
      || env.FSUSBLOG_PUBLIC_BASE_URL
      || env.FSUSBLOG_DEBUG_FRONTEND_URL
      || 'http://127.0.0.1:3000'
    ).replace(/\/+$/u, '');
    const backendUrl = String(
        env.FSUSBLOG_ACCEPTANCE_BACKEND_URL
      || env.FSUSBLOG_BASE_URL
      || env.FSUSBLOG_DEBUG_BACKEND_URL
      || 'http://127.0.0.1:7568'
    ).replace(/\/+$/u, '');

    try
    {
        new URL(baseUrl);
        new URL(backendUrl);
    }
    catch (error)
    {
        throw new BrowserContractFailure('browser contract fixture contains an invalid runtime URL', 'contract', {
            message: error instanceof Error ? error.message : String(error)
        });
    }

    const userStorageStateFile = resolveStorageStateFile(authDirectory, authFixture.user, 'user');
    const adminStorageStateFile = resolveStorageStateFile(authDirectory, authFixture.admin, 'admin');
    const [userStorageState, adminStorageState] = await Promise.all([
        loadPortableStorageState(userStorageStateFile, baseUrl, 'user'),
        loadPortableStorageState(adminStorageStateFile, baseUrl, 'admin')
    ]);
    const completeAdminStorageState = combineAdminStorageState(
        userStorageState,
        adminStorageState
    );

    return Object.freeze({
        schema: browserContractFixtureAdapterSchema,
        namespace: resolveFixtureNamespace(env),
        root: legacyFixtureRoot,
        generatedAt: String(authFixture.generatedAt ?? publicFixture.generatedAt ?? ''),
        baseUrl,
        backendUrl,
        testSession: String(env.FSUSBLOG_TEST_SESSION ?? '').trim() || null,
        publicArticle: Object.freeze({ id: articleId, title: articleTitle }),
        category: Object.freeze({
            id: String(publicFixture.categoryId ?? '').trim(),
            name: String(env.FSUSBLOG_PLAYWRIGHT_CATEGORY_NAME ?? 'Acceptance Category')
        }),
        capabilities: Object.freeze({
            webAuthnRegistration: authFixture.capabilities?.webAuthnRegistration === true
        }),
        user: Object.freeze({
            id: Number(authFixture.user.id),
            storageStateFile: userStorageStateFile,
            storageState: userStorageState
        }),
        admin: Object.freeze({
            id: Number(authFixture.admin.id),
            storageStateFile: adminStorageStateFile,
            storageState: completeAdminStorageState
        })
    });
}

export function fixtureReceiptView(fixture, repoRoot = process.cwd())
{
    const relative = (value) => path.relative(repoRoot, value).replaceAll(path.sep, '/');
    return {
        schema: fixture.schema,
        namespace: fixture.namespace,
        manifestSchema: fixture.manifestSchema ?? null,
        generatedAt: fixture.generatedAt,
        publicArticleId: fixture.publicArticle.id,
        pendingCommentId: fixture.pendingComment?.id ?? null,
        categoryId: fixture.category.id,
        userId: fixture.user.id,
        adminId: fixture.admin.id,
        capabilities: fixture.capabilities,
        topology: fixture.topology ?? { sessions: 1, concurrency: 1 },
        databaseSchema: fixture.databaseSchema ?? null,
        databaseInstance: fixture.databaseInstance ?? null,
        redisNamespace: fixture.redisNamespace ?? null,
        redisInstance: fixture.redisInstance ?? null,
        sourceState: fixture.sourceState ?? null,
        buildIdentity: fixture.buildIdentity ?? null,
        preparation: fixture.preparation ?? null,
        ownership: fixture.ownership ?? null,
        transport: fixture.transport ?? null,
        lifecycle: fixture.lifecycle ?? null,
        root: relative(fixture.root),
        userStorageState: relative(fixture.user.storageStateFile),
        adminStorageState: relative(fixture.admin.storageStateFile)
    };
}
