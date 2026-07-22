#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { decodePublicAotPayload, readAedsResponse } from '../../support/aeds-envelope.mjs';
import {
    authBinary,
    baseUrl,
    fetchChallenge,
    loginWithFixtureSessionBypass,
    requestTimeoutMs
} from '../../support/auth-helpers.mjs';
import { fetchWithTimeout } from '../../support/http.mjs';
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs';
import { resolveRuntimeBrowserTimeoutPlan } from '../../support/runtime-browser-timeout.mjs';
import { createAdminStepUpProofToken } from '../../support/session-fixtures.mjs';
import { resolveTestSession } from '../../support/test-session.mjs';

const adminUsername = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin';
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD ?? '';
const publicBaseUrl = process.env.FSUSBLOG_PUBLIC_BASE_URL || baseUrl;
const trustedOrigin = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || publicBaseUrl || baseUrl;
const timeoutPlan = resolveRuntimeBrowserTimeoutPlan();
const timeoutMs = Math.max(requestTimeoutMs, 30_000, timeoutPlan.requestTimeoutMs);
// This test observes an asynchronous DB -> cache -> feed -> AOT convergence
// boundary. Keep every surface assertion, but scale its polling horizon by the
// scheduler's real CPU contention just as the other runtime browser checks do.
const coherenceTimeoutMs = Math.max(
    timeoutMs * 6,
    Math.ceil(150_000 * timeoutPlan.contentionMultiplier)
);
const testSessionIsolation = process.env.FSUSBLOG_TEST_SESSION_ISOLATION === '1';
const execFileAsync = promisify(execFile);
const resetSecurityTestState = process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE !== '0';
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || process.env.FSUSBLOG_REDIS_CONTAINER_NAME || 'fsusblog-redis';
const postgresContainer = process.env.FSUSBLOG_PG_CONTAINER || process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || '';
const postgresUser = process.env.FSUSBLOG_PG_USER || 'fsusblog';
const postgresDatabase = process.env.FSUSBLOG_PG_DB || 'fsusblog';
const testSession = resolveTestSession();
const maxDeterministicPowDifficulty = Number.parseInt(process.env.FSUSBLOG_ACCEPTANCE_POW_MAX_DIFFICULTY ?? '20', 10) || 20;
const ArticleStatus = Object.freeze({
    Draft: 0,
    Scheduled: 1,
    Published: 2,
    Archived: 3,
    Deleted: 4
});

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function delay(ms)
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetLocalSecurityRiskState()
{
    if (!resetSecurityTestState)
    {
        return;
    }

    try
    {
        await execFileAsync('docker', [
            'exec',
            redisContainer,
            'sh',
            '-c',
            "redis-cli --scan --pattern '*fsus:sec:pow-risk:*' | xargs -r redis-cli DEL"
        ], { timeout: 5000 });
    }
    catch
    {
    // Non-local environments may not use the developer docker container.
    }
}

async function waitForDeterministicPow(label)
{
    let lastDifficulty = 'unknown';
    for (let attempt = 0; attempt < 30; attempt += 1)
    {
        try
        {
            const challenge = await fetchChallenge(5000);
            const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 999);
            lastDifficulty = Number.isFinite(difficulty) ? String(difficulty) : 'unknown';
            if (difficulty <= maxDeterministicPowDifficulty)
            {
                return;
            }
        }
        catch
        {
            lastDifficulty = 'unreachable';
        }

        await delay(1000);
    }

    throw new Error(`${label} pow difficulty did not settle below ${maxDeterministicPowDifficulty}; last=${lastDifficulty}`);
}

async function resetAndWaitForMutationBudget(label)
{
    await resetLocalSecurityRiskState();
    await waitForDeterministicPow(label);
}

async function eventually(label, assertion, timeout = coherenceTimeoutMs, interval = 600)
{
    const deadline = Date.now() + timeout;
    let lastError = null;
    do
    {
        try
        {
            return await assertion();
        }
        catch (error)
        {
            lastError = error;
            await delay(interval);
        }
    } while (Date.now() < deadline);

    throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function fetchText(path, base = publicBaseUrl)
{
    let response;
    try
    {
        response = await fetchWithTimeout(`${base}${path}`, {
            headers: {
                'User-Agent': 'FsusBlog distribution coherence smoke'
            }
        }, timeoutMs);
    }
    catch (error)
    {
        throw new Error(`${path} request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(response.status < 500, `${path} returned ${response.status}`);
    return {
        status: response.status,
        text: await response.text()
    };
}

async function fetchNavigationSnapshotText(path)
{
    let response;
    try
    {
        response = await fetchWithTimeout(`${baseUrl}/api/public/navigation-snapshot.aeds?path=${encodeURIComponent(path)}`, {
            headers: {
                Accept: 'application/octet-stream',
                'Cache-Control': 'no-cache',
                'User-Agent': 'FsusBlog distribution coherence smoke'
            }
        }, timeoutMs);
    }
    catch (error)
    {
        throw new Error(`${path} navigation snapshot request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(response.status < 500, `${path} navigation snapshot failed: ${response.status}`);
    if (!response.ok)
    {
        return {
            status: response.status,
            text: ''
        };
    }
    const frame = Buffer.from(await response.arrayBuffer());
    const envelope = (() =>
    {
        try
        {
            return decodePublicAotPayload(frame.toString('base64url'));
        }
        catch (error)
        {
            throw new Error(`${path} navigation snapshot decode failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    })();
    const bootstrap = (() =>
    {
        try
        {
            return decodePublicAotPayload(envelope.bootstrapPayload);
        }
        catch (error)
        {
            throw new Error(`${path} navigation bootstrap decode failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    })();
    const hydration = (() =>
    {
        try
        {
            return decodePublicAotPayload(envelope.hydrationPropsPayload);
        }
        catch (error)
        {
            throw new Error(`${path} navigation hydration decode failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    })();
    if (!bootstrap || !hydration)
    {
        throw new Error(`${path} navigation snapshot payload is empty`);
    }
    return {
        status: response.status,
        text: JSON.stringify({ envelope, bootstrap, hydration })
    };
}

async function fetchSearchIndexText()
{
    let response;
    try
    {
        response = await fetchWithTimeout(`${baseUrl}/search/index.bin`, {}, timeoutMs);
    }
    catch (error)
    {
        throw new Error(`/search/index.bin request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert(response.ok, `search index alias failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer()).toString('utf8');
}

async function fetchArticlePage(cookieHeader, isDeleted = false, status = undefined)
{
    if (!cookieHeader)
    {
        let response;
        try
        {
            response = await fetchWithTimeout(`${baseUrl}/api/binary/article/list/home/1/10.aeds`, {
                headers: {
                    Accept: 'application/octet-stream',
                    'X-Fsus-Device-Fp': 'distribution-public-list'
                }
            }, timeoutMs);
        }
        catch (error)
        {
            throw new Error(`public article list request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const payload = await readAedsResponse(response).catch(() => null);
        assert(response.ok, `article list public failed: ${response.status}`);
        return Array.isArray(payload?.items) ? payload.items : [];
    }

    const params = new URLSearchParams({
        page: '1',
        size: '50',
        isDeleted: isDeleted ? 'true' : 'false'
    });
    if (status !== undefined)
    {
        params.set('status', String(status));
    }

    const { response, payload } = await authBinary(`/api/Article?${params.toString()}`, {
        cookieHeader
    });
    assert(response.ok, `article list ${isDeleted ? 'deleted' : 'public'} failed: ${response.status}`);
    return Array.isArray(payload?.items) ? payload.items : [];
}

async function fetchArticleDetail(articleId, cookieHeader = null)
{
    if (!cookieHeader)
    {
        let response;
        try
        {
            response = await fetchWithTimeout(`${baseUrl}/api/binary/article/${articleId}.aeds`, {
                headers: {
                    Accept: 'application/octet-stream',
                    'X-Fsus-Device-Fp': 'distribution-public-detail'
                }
            }, timeoutMs);
        }
        catch (error)
        {
            throw new Error(`public article detail ${articleId} request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const payload = await readAedsResponse(response).catch(() => null);
        return { response, payload };
    }

    return await authBinary(`/api/Article/${articleId}`, { cookieHeader });
}

async function warmPublicSurfaces(articleId, categoryId, tagId)
{
    await Promise.allSettled([
        fetchArticlePage(null),
        fetchText('/feed/rss.xml', baseUrl),
        fetchText('/feed/atom.xml', baseUrl),
        fetchText('/feed/feed.json', baseUrl),
        fetchText('/sitemap.xml', baseUrl),
        fetchNavigationSnapshotText(`/article/${articleId}`),
        fetchText(`/category/${categoryId}`, baseUrl),
        fetchText(`/tag/${tagId}`, baseUrl),
        fetchSearchIndexText()
    ]);
}

async function assertAnonymousPublicReadsRecovered(stableArticleId)
{
    const [publicItems, stableDetail] = await Promise.all([
        fetchArticlePage(null),
        fetchArticleDetail(stableArticleId)
    ]);
    assert(
        publicItems.some((item) => Number(item?.id) === stableArticleId),
        `stable fixture article ${stableArticleId} missing after mutation revocation recovery`
    );
    assert(
        stableDetail.response.ok,
        `stable fixture article ${stableArticleId} remained revoked after mutation recovery: ${stableDetail.response.status}`
    );
}

async function assertArticleMutationOutboxSettled(articleId)
{
    if (!postgresContainer)
    {
        return;
    }

    const numericArticleId = Number(articleId);
    assert(Number.isSafeInteger(numericArticleId) && numericArticleId > 0, `invalid article id for outbox query: ${articleId}`);
    const sessionSchema = testSession ? `fsus_e2e_${testSession.replaceAll('-', '_')}` : '';
    const searchPath = sessionSchema ? `SET search_path TO "${sessionSchema}", public;` : '';
    const sql = `
    ${searchPath}
    SELECT
      count(*) FILTER (WHERE status <> 'processed') || '|' ||
      count(*) FILTER (WHERE status = 'poison') || '|' ||
      count(*)
    FROM article_mutation_outbox
    WHERE aggregate_type = 'article'
      AND aggregate_id = ${numericArticleId};
  `;
    const result = await execFileAsync('docker', [
        'exec', '-i', postgresContainer,
        'psql', '-U', postgresUser, '-d', postgresDatabase,
        '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql
    ], { timeout: timeoutMs });
    const [activeRaw, poisonRaw, totalRaw] = result.stdout.trim().split('|');
    const active = Number(activeRaw);
    const poison = Number(poisonRaw);
    const total = Number(totalRaw);
    assert(
        [active, poison, total].every(Number.isSafeInteger),
        `article mutation outbox returned an invalid state: ${result.stdout.trim()}`
    );
    assert(total > 0, `article mutation outbox has no events for article ${articleId}`);
    assert(poison === 0, `article mutation outbox poisoned ${poison} event(s) for article ${articleId}`);
    assert(active === 0, `article mutation outbox still has ${active} unsettled event(s) for article ${articleId}`);
}

async function readPublicSurfaces(articleId, categoryId, tagId, cookieHeader)
{
    const publicItemsPromise = testSessionIsolation
        ? fetchArticlePage(cookieHeader, false, ArticleStatus.Published)
        : fetchArticlePage(null);
    const scopedDetailPromise = testSessionIsolation
        ? fetchArticleDetail(articleId, cookieHeader)
        : Promise.resolve(null);
    const [publicItems, deletedItems, detail, scopedDetail, rss, atom, jsonFeed, sitemap, articleHtml, categoryHtml, tagHtml, searchIndex] =
        await Promise.all([
            publicItemsPromise,
            fetchArticlePage(cookieHeader, true),
            fetchArticleDetail(articleId),
            scopedDetailPromise,
            fetchText('/feed/rss.xml', baseUrl),
            fetchText('/feed/atom.xml', baseUrl),
            fetchText('/feed/feed.json', baseUrl),
            fetchText('/sitemap.xml', baseUrl),
            fetchNavigationSnapshotText(`/article/${articleId}`),
            fetchText(`/category/${categoryId}`, baseUrl),
            fetchText(`/tag/${tagId}`, baseUrl),
            fetchSearchIndexText()
        ]);

    return {
        publicItems,
        deletedItems,
        detail,
        scopedDetail,
        rss: rss.text,
        atom: atom.text,
        jsonFeed: jsonFeed.text,
        sitemap: sitemap.text,
        articleHtml: articleHtml.text,
        categoryHtml: categoryHtml.text,
        tagHtml: tagHtml.text,
        searchIndex
    };
}

function assertPublicPresent(snapshot, articleId, title, marker)
{
    const readableDetail = snapshot.scopedDetail ?? snapshot.detail;
    assert(
        snapshot.publicItems.some((item) => Number(item?.id) === articleId && item?.title === title),
        `${title} missing from public article list; got ${formatPublicItemSummary(snapshot.publicItems)}`
    );
    assert(readableDetail.response.ok, `${title} detail should be readable, got ${readableDetail.response.status}`);
    assert(readableDetail.payload?.title === title, `${title} detail title mismatch`);
    assert(snapshot.rss.includes(title) && snapshot.rss.includes(marker), `${title} missing from RSS`);
    assert(snapshot.atom.includes(title) && snapshot.atom.includes(marker), `${title} missing from Atom`);
    assert(snapshot.jsonFeed.includes(title) && snapshot.jsonFeed.includes(marker), `${title} missing from JSON Feed`);
    assert(snapshot.sitemap.includes(`/article/${articleId}`), `${title} missing from sitemap`);
    assert(snapshot.articleHtml.includes(title), `${title} missing from article AOT page`);
    assert(snapshot.categoryHtml.includes(title), `${title} missing from category AOT page`);
    assert(snapshot.tagHtml.includes(title), `${title} missing from tag AOT page`);
    assert(snapshot.searchIndex.includes(title) && snapshot.searchIndex.includes(marker), `${title} missing from search index alias`);
}

function formatPublicItemSummary(items)
{
    if (!Array.isArray(items) || items.length === 0)
    {
        return '[]';
    }

    return `[${items.map((item) =>
    {
        const id = Number(item?.id);
        const title = typeof item?.title === 'string' ? item.title : '';
        const createTime = typeof item?.createTime === 'string' ? item.createTime : '';
        const status = item?.status ?? '';
        return `{id:${Number.isFinite(id) ? id : 'n/a'},title:${JSON.stringify(title)},createTime:${createTime},status:${status}}`;
    }).join(', ')}]`;
}

function assertPublicAbsent(snapshot, articleId, title, marker)
{
    assert(!snapshot.publicItems.some((item) => Number(item?.id) === articleId), `${title} leaked in public article list`);
    assert(!snapshot.detail.response.ok, `${title} detail should be unavailable, got ${snapshot.detail.response.status}`);
    assertPublicContentAbsent(snapshot, title, marker);
    assert(!snapshot.sitemap.includes(`/article/${articleId}`), `${title} leaked in sitemap`);
}

function assertPublicContentAbsent(snapshot, title, marker)
{
    assert(snapshot.detail.payload?.title !== title, `${title} leaked in article detail title`);
    for (const [name, value] of [
        ['RSS', snapshot.rss],
        ['Atom', snapshot.atom],
        ['JSON Feed', snapshot.jsonFeed],
        ['article AOT', snapshot.articleHtml],
        ['category AOT', snapshot.categoryHtml],
        ['tag AOT', snapshot.tagHtml],
        ['search index', snapshot.searchIndex]
    ])
    {
        assert(!value.includes(title), `${title} leaked in ${name}`);
        assert(!value.includes(marker), `${marker} leaked in ${name}`);
    }
}

async function assertAdminState(session, articleId, title, status, isDeleted = false)
{
    const [items, detail] = await Promise.all([
        fetchArticlePage(session.cookieHeader, isDeleted, status),
        fetchArticleDetail(articleId, session.cookieHeader)
    ]);

    assert(items.some((item) => Number(item?.id) === articleId && item?.title === title && Number(item?.status) === status), `${title} missing from admin status ${status} list`);
    assert(detail.response.ok, `${title} admin detail failed: ${detail.response.status}`);
    assert(detail.payload?.title === title, `${title} admin detail title mismatch`);
    assert(Number(detail.payload?.status) === status, `${title} admin detail status mismatch: ${detail.payload?.status}`);
}

function articleMutationHeaders(extra = {})
{
    return {
        Origin: trustedOrigin,
        'X-Fsus-Client-Mutation-Id': randomUUID(),
        ...extra
    };
}

async function createArticle(session, categoryId, tagId, title, marker, options = {})
{
    const { response, payload } = await authBinary('/api/Article', {
        method: 'POST',
        cookieHeader: session.cookieHeader,
        requiresPow: true,
        headers: articleMutationHeaders(),
        deviceFingerprint: `distribution-create-${marker}`,
        body: {
            title,
            content: `# ${title}\n\n${marker} body proves distribution coherence.`,
            summary: `${marker} summary proves feed and search coherence.`,
            categoryId,
            tagIds: [tagId],
            status: options.status ?? ArticleStatus.Published,
            scheduledPublishAt: options.scheduledPublishAt ?? null
        }
    });
    assert(response.ok, `article create failed: ${response.status}`);
    const id = Number(payload?.id);
    assert(Number.isFinite(id) && id > 0, 'article create missing mutation id');
    return id;
}

async function updateArticle(session, articleId, categoryId, tagId, title, marker, options = {})
{
    const { response } = await authBinary(`/api/Article/${articleId}`, {
        method: 'PUT',
        cookieHeader: session.cookieHeader,
        requiresPow: true,
        headers: articleMutationHeaders(),
        deviceFingerprint: `distribution-update-${marker}`,
        body: {
            title,
            content: `# ${title}\n\n${marker} updated body proves distribution coherence.`,
            summary: `${marker} updated summary proves feed and search coherence.`,
            categoryId,
            tagIds: [tagId],
            status: options.status ?? ArticleStatus.Published,
            scheduledPublishAt: options.scheduledPublishAt ?? null
        }
    });
    assert(response.ok, `article update failed: ${response.status}`);
}

async function mutateArticle(session, path, method, operation, marker)
{
    const proofToken = createAdminStepUpProofToken({
        adminId: session.adminId,
        sessionId: session.sessionId
    });
    let { response } = await authBinary(path, {
        method,
        cookieHeader: session.cookieHeader,
        requiresPow: true,
        headers: articleMutationHeaders({ 'X-Fsus-Mfa-Proof': proofToken }),
        deviceFingerprint: `distribution-${operation}-${marker}`
    });
    if (response.status === 428)
    {
        await resetAndWaitForMutationBudget(`distribution ${operation}`);
        const retryProofToken = createAdminStepUpProofToken({
            adminId: session.adminId,
            sessionId: session.sessionId
        });
        ({ response } = await authBinary(path, {
            method,
            cookieHeader: session.cookieHeader,
            requiresPow: true,
            headers: articleMutationHeaders({ 'X-Fsus-Mfa-Proof': retryProofToken }),
            deviceFingerprint: `distribution-${operation}-retry-${marker}`
        }));
    }
    assert(response.ok, `article ${operation} failed: ${response.status}`);
}

async function main()
{
    await resetAndWaitForMutationBudget('distribution coherence');
    const session = await loginWithFixtureSessionBypass(adminUsername, adminPassword, false, 'distribution-admin-login', timeoutMs);
    // The integration lane prepared this namespace immediately before runtime
    // checks. Reuse only that current-run fixture contract; fail closed instead
    // of querying/creating taxonomy again or accepting a stale historical file.
    const {
        articleId: stableArticleId,
        categoryId,
        tagId
    } = readPublicFixtureIds({}, { requireCurrent: true });
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const markerV1 = `dc${stamp}alpha`;
    const markerV2 = `dc${stamp}beta`;
    const titleV1 = `Distribution Coherence ${stamp} Alpha`;
    const titleV2 = `Distribution Coherence ${stamp} Beta`;
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    let articleId = 0;
    let permanentlyDeleted = false;

    try
    {
        await warmPublicSurfaces(stableArticleId, categoryId, tagId);
        articleId = await createArticle(session, categoryId, tagId, titleV1, markerV1, {
            status: ArticleStatus.Draft
        });

        await eventually('draft publication boundary', async () =>
        {
            const [snapshot] = await Promise.all([
                readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader),
                assertAdminState(session, articleId, titleV1, ArticleStatus.Draft)
            ]);
            assertPublicAbsent(snapshot, articleId, titleV1, markerV1);
        });
        console.log('[distribution-version-coherence] ok: draft-hidden');

        await updateArticle(session, articleId, categoryId, tagId, titleV1, markerV1, {
            status: ArticleStatus.Scheduled,
            scheduledPublishAt: scheduledAt
        });
        await eventually('scheduled publication boundary', async () =>
        {
            const [snapshot] = await Promise.all([
                readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader),
                assertAdminState(session, articleId, titleV1, ArticleStatus.Scheduled)
            ]);
            assertPublicAbsent(snapshot, articleId, titleV1, markerV1);
        });
        console.log('[distribution-version-coherence] ok: scheduled-hidden');

        await updateArticle(session, articleId, categoryId, tagId, titleV1, markerV1, {
            status: ArticleStatus.Archived
        });
        await eventually('archived publication boundary', async () =>
        {
            const [snapshot] = await Promise.all([
                readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader),
                assertAdminState(session, articleId, titleV1, ArticleStatus.Archived)
            ]);
            assertPublicAbsent(snapshot, articleId, titleV1, markerV1);
        });
        console.log('[distribution-version-coherence] ok: archived-hidden');

        await updateArticle(session, articleId, categoryId, tagId, titleV1, markerV1, {
            status: ArticleStatus.Published
        });

        await eventually('create distribution coherence', async () =>
        {
            const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
            assertPublicPresent(snapshot, articleId, titleV1, markerV1);
        });
        console.log('[distribution-version-coherence] ok: create');

        await updateArticle(session, articleId, categoryId, tagId, titleV2, markerV2);
        await eventually('update distribution coherence', async () =>
        {
            const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
            assertPublicPresent(snapshot, articleId, titleV2, markerV2);
            assertPublicContentAbsent(snapshot, titleV1, markerV1);
        });
        console.log('[distribution-version-coherence] ok: update');

        await mutateArticle(session, `/api/Article/${articleId}`, 'DELETE', 'delete', markerV2);
        await eventually('delete distribution coherence', async () =>
        {
            const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
            assertPublicAbsent(snapshot, articleId, titleV2, markerV2);
            assert(snapshot.deletedItems.some((item) => Number(item?.id) === articleId), `${titleV2} missing from admin trash list`);
        });
        console.log('[distribution-version-coherence] ok: delete');

        await mutateArticle(session, `/api/Article/restore/${articleId}`, 'PUT', 'restore', markerV2);
        await eventually('restore draft boundary', async () =>
        {
            const [snapshot] = await Promise.all([
                readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader),
                assertAdminState(session, articleId, titleV2, ArticleStatus.Draft)
            ]);
            assertPublicAbsent(snapshot, articleId, titleV2, markerV2);
        });
        console.log('[distribution-version-coherence] ok: restore-draft-hidden');

        await updateArticle(session, articleId, categoryId, tagId, titleV2, markerV2, {
            status: ArticleStatus.Published
        });
        await eventually('restore republish distribution coherence', async () =>
        {
            const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
            assertPublicPresent(snapshot, articleId, titleV2, markerV2);
        });
        console.log('[distribution-version-coherence] ok: restore-republish');

        await mutateArticle(session, `/api/Article/${articleId}`, 'DELETE', 'delete-before-permanent', markerV2);
        await mutateArticle(session, `/api/Article/permanent/${articleId}`, 'DELETE', 'permanent-delete', markerV2);
        permanentlyDeleted = true;
        await eventually('permanent delete distribution coherence', async () =>
        {
            const snapshot = await readPublicSurfaces(articleId, categoryId, tagId, session.cookieHeader);
            assertPublicAbsent(snapshot, articleId, titleV2, markerV2);
            assert(!snapshot.deletedItems.some((item) => Number(item?.id) === articleId), `${titleV2} leaked in admin trash after permanent delete`);
        });
        console.log('[distribution-version-coherence] ok: permanent-delete');

        // The request path runs its side effects synchronously, while the durable
        // outbox can replay the same idempotent edges on its next poll. Hold the DAG
        // barrier until every event for this test-owned article is processed; a
        // one-shot public read can otherwise pass immediately before a replay opens
        // a newer revocation generation and hand the hydration lane an HTTP 410.
        await eventually('post-mutation outbox settlement', async () =>
        {
            await assertArticleMutationOutboxSettled(articleId);
        });

        // With no remaining replay able to publish a later tombstone, require the
        // anonymous aggregate and stable detail to recover from the final rebuild.
        await eventually('post-mutation anonymous public-read recovery', async () =>
        {
            await assertAnonymousPublicReadsRecovered(stableArticleId);
        });
        console.log('[distribution-version-coherence] ok: anonymous-public-read-recovered');

        console.log('[distribution-version-coherence] all checks passed');
    }
    finally
    {
        if (articleId > 0 && !permanentlyDeleted)
        {
            await mutateArticle(session, `/api/Article/${articleId}`, 'DELETE', 'cleanup-delete', markerV2).catch(() => null);
            await mutateArticle(session, `/api/Article/permanent/${articleId}`, 'DELETE', 'cleanup-permanent-delete', markerV2).catch(() => null);
        }
    }
}

main().catch((error) =>
{
    console.error('[distribution-version-coherence] fatal:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
