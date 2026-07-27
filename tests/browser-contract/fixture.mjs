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
} from '../frontend/support/fixture-paths.mjs';

import { BrowserContractFailure, contractAssert } from './contract.mjs';
import {
    browserContractFixedFixtureTopology,
    browserContractFixtureManifestSchema,
    readSealedBrowserContractFixture,
    resolveBrowserContractRunIdentity
} from './fixture-lifecycle.mjs';

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

function decodePublicFixture(raw)
{
    const values = {};
    for (const line of raw.split(/\r?\n/u))
    {
        const separator = line.indexOf('\t');
        if (separator <= 0)
        {
            continue;
        }
        const key = line.slice(0, separator).trim();
        const encoded = line.slice(separator + 1).trim();
        if (!key || !encoded)
        {
            continue;
        }
        values[key] = Buffer.from(encoded, 'base64url').toString('utf8');
    }
    return values;
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
            storageState: adminStorageState
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

    const publicFixture = decodePublicFixture(await readFile(publicFixtureFile, 'utf8'));
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
            storageState: adminStorageState
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
