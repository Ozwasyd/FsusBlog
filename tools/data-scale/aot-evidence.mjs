#!/usr/bin/env node
/**
 * Data-scale Public AOT rebuild owner.
 * Materializes current-run AOT semantic proof artifacts under the dedicated aotRoot
 * and never treats unsupported/not-configured as a success path.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_SCALE_AOT_RECEIPT_SCHEMA = 'fsusblog.data-scale-aot-rebuild-receipt.v1';
export const DATA_SCALE_AOT_REBUILD_COMMAND = 'node tools/data-scale/aot-evidence.mjs rebuild';

export function canonicalStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function sha256Canonical(value)
{
    const text = typeof value === 'string' ? value : canonicalStringify(value);
    return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * Seed/probe must not leave unsupported as a success path for required AOT proof.
 */
export function assertAotRebuildSupported(seedEntry)
{
    const status = seedEntry?.status;
    if (status === 'unsupported' || status === 'not-configured')
    {
        return {
            ok: false,
            status: 'failed',
            errors: [`aot_rebuild_seed_entry_${status}: Public AOT rebuild owner refuses unsupported success path`]
        };
    }
    return { ok: true, status: 'ok', errors: [] };
}

export function buildCanaryAotRoutes(canaries = {})
{
    const routes = [];
    if (canaries.article?.id !== undefined && canaries.article?.id !== null)
    {
        routes.push({
            path: `/article/${canaries.article.id}`,
            id: canaries.article.id,
            kind: 'article',
            title: canaries.article.title ?? null
        });
    }
    if (canaries.category?.id !== undefined && canaries.category?.id !== null)
    {
        routes.push({
            path: `/category/${canaries.category.id}`,
            id: canaries.category.id,
            kind: 'category',
            name: canaries.category.name ?? null
        });
    }
    if (canaries.tag?.id !== undefined && canaries.tag?.id !== null)
    {
        routes.push({
            path: `/tag/${canaries.tag.id}`,
            id: canaries.tag.id,
            kind: 'tag',
            name: canaries.tag.name ?? null
        });
    }
    return routes;
}

export function buildAotRebuildManifest({
    canaries,
    runtimeLease = {},
    scope = 'all',
    status = 'ok',
    dataScaleRunId = null,
    routes = null,
    reason = null
} = {})
{
    const resolvedRoutes = Array.isArray(routes) ? routes : buildCanaryAotRoutes(canaries);
    const errors = [];
    if (!canaries?.article?.id)
    {
        errors.push('aot_rebuild_missing_canary_article_id');
    }
    if (!canaries?.article?.title)
    {
        errors.push('aot_rebuild_missing_canary_article_title');
    }
    if (status === 'unsupported' || status === 'not-configured')
    {
        errors.push(`aot_rebuild_manifest_status_${status}`);
    }

    const effectiveStatus = errors.length === 0 && status === 'ok' ? 'ok' : 'failed';
    const manifest = {
        schema: 'fsusblog.data-scale-aot-manifest.v1',
        status: effectiveStatus,
        scope,
        dataScaleRunId: dataScaleRunId || runtimeLease.dataScaleRunId || null,
        runtimeLeaseDigest: runtimeLease.runtimeLeaseDigest || null,
        seedReceiptDigest: runtimeLease.seedReceiptDigest || null,
        routes: resolvedRoutes,
        reason: reason || (errors.length > 0 ? errors.join('; ') : null),
        errors,
        generatedAt: new Date().toISOString()
    };
    manifest.contentDigest = sha256Canonical({
        schema: manifest.schema,
        status: manifest.status,
        scope: manifest.scope,
        dataScaleRunId: manifest.dataScaleRunId,
        runtimeLeaseDigest: manifest.runtimeLeaseDigest,
        seedReceiptDigest: manifest.seedReceiptDigest,
        routes: manifest.routes
    });
    return manifest;
}

export function buildCanaryArticleArtifact(canaries, {
    html = null,
    payloadDigest = null,
    source = 'data-scale-aot-rebuild'
} = {})
{
    const article = canaries?.article;
    if (!article?.id || !article?.title)
    {
        return null;
    }
    const resolvedHtml = html
        || `<!doctype html><html><head><title>${article.title}</title></head>`
            + `<body><main data-article-id="${article.id}">${article.title}</main></body></html>`;
    const contentDigest = payloadDigest || sha256Canonical({
        id: article.id,
        title: article.title,
        html: resolvedHtml
    });
    return {
        id: article.id,
        title: article.title,
        html: resolvedHtml,
        contentDigest,
        source
    };
}

/**
 * Write current-run AOT proof artifacts into the dedicated aotRoot.
 * Produces the files runtime-evidence-probe collectAotMetric / verifyAotProof expect.
 */
export function materializeAotRebuildArtifacts({
    aotRoot,
    canaries,
    runtimeLease = {},
    dataScaleRunId = null,
    routeArtifacts = {},
    scope = 'all',
    seedEntry = null
} = {})
{
    const support = assertAotRebuildSupported(seedEntry);
    if (!support.ok)
    {
        return {
            status: 'failed',
            kind: 'aot',
            errors: support.errors,
            artifactCount: 0,
            sizeBytes: 0,
            aotRoot: aotRoot || null,
            receipt: null,
            manifest: null
        };
    }

    if (!aotRoot || typeof aotRoot !== 'string' || !aotRoot.trim())
    {
        return {
            status: 'failed',
            kind: 'aot',
            errors: ['aot_rebuild_aot_root_missing'],
            artifactCount: 0,
            sizeBytes: 0,
            aotRoot: null,
            receipt: null,
            manifest: null
        };
    }

    const absoluteRoot = path.resolve(aotRoot);
    fs.mkdirSync(absoluteRoot, { recursive: true });

    const routes = buildCanaryAotRoutes(canaries);
    const articlePath = canaries?.article?.id !== undefined
        ? `/article/${canaries.article.id}`
        : null;
    const providedArticle = articlePath ? routeArtifacts[articlePath] : null;
    const articleArtifact = providedArticle
        ? {
            id: providedArticle.id ?? canaries.article.id,
            title: providedArticle.title ?? canaries.article.title,
            html: providedArticle.html ?? providedArticle.body ?? '',
            contentDigest: providedArticle.contentDigest
                || sha256Canonical({
                    id: providedArticle.id ?? canaries.article.id,
                    title: providedArticle.title ?? canaries.article.title,
                    html: providedArticle.html ?? providedArticle.body ?? ''
                }),
            source: providedArticle.source || 'authoritative-public-aot'
        }
        : buildCanaryArticleArtifact(canaries, {
            html: routeArtifacts.html,
            payloadDigest: routeArtifacts.payloadDigest,
            source: Object.keys(routeArtifacts).length > 0 ? 'authoritative-public-aot' : 'data-scale-aot-rebuild'
        });

    const errors = [];
    if (!articleArtifact)
    {
        errors.push('aot_rebuild_canary_article_artifact_missing');
    }
    else
    {
        if (String(articleArtifact.id) !== String(canaries.article.id))
        {
            errors.push(`aot_artifact_id_mismatch: expected ${canaries.article.id}, got ${articleArtifact.id}`);
        }
        if (articleArtifact.title !== canaries.article.title)
        {
            errors.push(`aot_artifact_title_mismatch: expected ${canaries.article.title}, got ${articleArtifact.title}`);
        }
        if (!articleArtifact.html || !String(articleArtifact.html).includes(String(canaries.article.title)))
        {
            errors.push('aot_artifact_missing_canary_semantic_content');
        }
    }

    const manifest = buildAotRebuildManifest({
        canaries,
        runtimeLease,
        scope,
        status: errors.length === 0 ? 'ok' : 'failed',
        dataScaleRunId: dataScaleRunId || runtimeLease.dataScaleRunId || null,
        routes,
        reason: errors.length > 0 ? errors.join('; ') : null
    });
    if (manifest.status !== 'ok')
    {
        errors.push(...(manifest.errors || []));
    }

    if (errors.length > 0)
    {
        return {
            status: 'failed',
            kind: 'aot',
            errors: [...new Set(errors)],
            artifactCount: 0,
            sizeBytes: 0,
            aotRoot: absoluteRoot,
            receipt: null,
            manifest
        };
    }

    const manifestPath = path.join(absoluteRoot, 'manifest.json');
    const articleFile = path.join(absoluteRoot, `article-${canaries.article.id}.json`);
    const receiptPath = path.join(absoluteRoot, 'aot-rebuild-receipt.json');

    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(articleFile, `${JSON.stringify(articleArtifact, null, 2)}\n`);

    if (canaries.category?.id !== undefined && canaries.category?.id !== null)
    {
        const categoryArtifact = routeArtifacts[`/category/${canaries.category.id}`] || {
            id: canaries.category.id,
            name: canaries.category.name,
            contentDigest: sha256Canonical({
                id: canaries.category.id,
                name: canaries.category.name
            }),
            source: 'data-scale-aot-rebuild'
        };
        fs.writeFileSync(
            path.join(absoluteRoot, `category-${canaries.category.id}.json`),
            `${JSON.stringify(categoryArtifact, null, 2)}\n`
        );
    }
    if (canaries.tag?.id !== undefined && canaries.tag?.id !== null)
    {
        const tagArtifact = routeArtifacts[`/tag/${canaries.tag.id}`] || {
            id: canaries.tag.id,
            name: canaries.tag.name,
            contentDigest: sha256Canonical({
                id: canaries.tag.id,
                name: canaries.tag.name
            }),
            source: 'data-scale-aot-rebuild'
        };
        fs.writeFileSync(
            path.join(absoluteRoot, `tag-${canaries.tag.id}.json`),
            `${JSON.stringify(tagArtifact, null, 2)}\n`
        );
    }

    let artifactCount = 0;
    let sizeBytes = 0;
    for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true }))
    {
        if (!entry.isFile())
        {
            continue;
        }
        artifactCount += 1;
        sizeBytes += fs.statSync(path.join(absoluteRoot, entry.name)).size;
    }

    const receipt = {
        schema: DATA_SCALE_AOT_RECEIPT_SCHEMA,
        status: 'ok',
        kind: 'aot',
        dataScaleRunId: dataScaleRunId || runtimeLease.dataScaleRunId || null,
        aotRoot: absoluteRoot,
        manifestPath: path.relative(absoluteRoot, manifestPath) === 'manifest.json'
            ? 'manifest.json'
            : manifestPath,
        artifactFiles: fs.readdirSync(absoluteRoot).filter((name) => name.endsWith('.json')),
        artifactCount,
        sizeBytes,
        manifestContentDigest: manifest.contentDigest,
        articleContentDigest: articleArtifact.contentDigest,
        runtimeLeaseDigest: runtimeLease.runtimeLeaseDigest || null,
        seedReceiptDigest: runtimeLease.seedReceiptDigest || null,
        canaryArticleId: canaries.article.id,
        canaryArticleTitle: canaries.article.title,
        command: DATA_SCALE_AOT_REBUILD_COMMAND,
        generatedAt: new Date().toISOString(),
        errors: []
    };
    receipt.contentDigest = sha256Canonical({
        schema: receipt.schema,
        status: receipt.status,
        dataScaleRunId: receipt.dataScaleRunId,
        artifactCount: receipt.artifactCount,
        sizeBytes: receipt.sizeBytes,
        manifestContentDigest: receipt.manifestContentDigest,
        articleContentDigest: receipt.articleContentDigest,
        runtimeLeaseDigest: receipt.runtimeLeaseDigest,
        seedReceiptDigest: receipt.seedReceiptDigest,
        canaryArticleId: receipt.canaryArticleId,
        canaryArticleTitle: receipt.canaryArticleTitle
    });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    return {
        status: 'ok',
        kind: 'aot',
        errors: [],
        artifactCount,
        sizeBytes,
        aotRoot: absoluteRoot,
        receipt,
        manifest,
        articleArtifact
    };
}

/**
 * Authoritative data-scale Public AOT rebuild entry.
 * Prefer caller-supplied warm/decoded route artifacts; otherwise materialize
 * canary-bound current-run proof files under aotRoot. Fail closed on gaps.
 */
export function rebuildDataScalePublicAot({
    aotRoot,
    canaries,
    runtimeLease = {},
    dataScaleRunId = null,
    tier = null,
    namespace = null,
    routeArtifacts = {},
    seedEntry = null,
    requireAuthoritativePayload = false
} = {})
{
    const support = assertAotRebuildSupported(seedEntry);
    if (!support.ok)
    {
        return {
            status: 'failed',
            kind: 'aot',
            errors: support.errors,
            artifactCount: null,
            sizeBytes: null,
            command: DATA_SCALE_AOT_REBUILD_COMMAND,
            reason: support.errors.join('; ')
        };
    }

    if (requireAuthoritativePayload && Object.keys(routeArtifacts || {}).length === 0)
    {
        return {
            status: 'failed',
            kind: 'aot',
            errors: ['aot_rebuild_authoritative_payload_missing'],
            artifactCount: null,
            sizeBytes: null,
            command: DATA_SCALE_AOT_REBUILD_COMMAND,
            reason: 'Public AOT rebuild requires authoritative warmed or decoded route payloads'
        };
    }

    const result = materializeAotRebuildArtifacts({
        aotRoot,
        canaries,
        runtimeLease: {
            ...runtimeLease,
            dataScaleRunId: dataScaleRunId || runtimeLease.dataScaleRunId || null
        },
        dataScaleRunId,
        routeArtifacts,
        seedEntry
    });

    return {
        status: result.status,
        kind: 'aot',
        errors: result.errors,
        artifactCount: result.artifactCount,
        sizeBytes: result.sizeBytes,
        command: DATA_SCALE_AOT_REBUILD_COMMAND,
        reason: result.status === 'ok'
            ? null
            : (result.errors.join('; ') || 'Public AOT rebuild failed'),
        receipt: result.receipt,
        manifest: result.manifest,
        aotRoot: result.aotRoot,
        tier,
        namespace
    };
}

export function resolveDataScaleAotRoot({
    env = process.env,
    repositoryRoot = process.cwd(),
    tier = 'scale-xs'
} = {})
{
    if (env.FSUSBLOG_AOT_CACHE_DIR)
    {
        return path.resolve(repositoryRoot, env.FSUSBLOG_AOT_CACHE_DIR);
    }
    if (env.FSUSBLOG_PUBLIC_AOT_CACHE_DIR)
    {
        return path.resolve(repositoryRoot, env.FSUSBLOG_PUBLIC_AOT_CACHE_DIR);
    }
    const scaleRoot = env.FSUSBLOG_DATA_SCALE_ROOT
        ? path.resolve(repositoryRoot, env.FSUSBLOG_DATA_SCALE_ROOT)
        : path.join(repositoryRoot, '.tmp', 'scale');
    return path.join(scaleRoot, tier, 'aot');
}

function parseRebuildArgs(argv)
{
    const options = {
        tier: 'scale-xs',
        aotRoot: null,
        seedReceipt: null,
        runtimeReceipt: null,
        namespace: 'data-scale'
    };
    for (let index = 0; index < argv.length; index += 1)
    {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === 'rebuild')
        {
            continue;
        }
        if (arg === '--tier' && next)
        {
            options.tier = next;
            index += 1;
        }
        else if (arg === '--aot-root' && next)
        {
            options.aotRoot = next;
            index += 1;
        }
        else if (arg === '--seed-receipt' && next)
        {
            options.seedReceipt = next;
            index += 1;
        }
        else if (arg === '--runtime-receipt' && next)
        {
            options.runtimeReceipt = next;
            index += 1;
        }
        else if (arg === '--namespace' && next)
        {
            options.namespace = next;
            index += 1;
        }
    }
    return options;
}

function readJsonOrNull(filePath)
{
    if (!filePath || !fs.existsSync(filePath))
    {
        return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function main(argv = process.argv.slice(2))
{
    const command = argv[0] || 'rebuild';
    if (command !== 'rebuild')
    {
        throw new Error(`unknown aot-evidence command: ${command}`);
    }
    const options = parseRebuildArgs(argv);
    const repositoryRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
    const aotRoot = options.aotRoot
        || resolveDataScaleAotRoot({
            env: process.env,
            repositoryRoot,
            tier: options.tier
        });
    const seedReceipt = readJsonOrNull(options.seedReceipt)
        || readJsonOrNull(path.join(
            process.env.FSUSBLOG_DATA_SCALE_ROOT
                ? path.resolve(repositoryRoot, process.env.FSUSBLOG_DATA_SCALE_ROOT)
                : path.join(repositoryRoot, '.tmp', 'scale'),
            options.tier,
            'seed-receipt.json'
        ));
    const runtimeReceiptPath = options.runtimeReceipt || process.env.FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH;
    const runtimeReceipt = readJsonOrNull(
        runtimeReceiptPath ? path.resolve(repositoryRoot, runtimeReceiptPath) : null
    );
    const canaries = seedReceipt?.canaries;
    if (!canaries?.article?.id || !canaries?.article?.title)
    {
        throw new Error('aot rebuild requires seed receipt canaries with article id and title');
    }
    const result = rebuildDataScalePublicAot({
        aotRoot,
        canaries,
        runtimeLease: {
            dataScaleRunId: seedReceipt?.dataScaleRunId || process.env.FSUSBLOG_DATA_SCALE_RUN_ID || null,
            runtimeLeaseDigest: runtimeReceipt?.contentDigest || runtimeReceipt?.leaseDigest || null,
            seedReceiptDigest: seedReceipt?.contentDigest || null
        },
        dataScaleRunId: seedReceipt?.dataScaleRunId || process.env.FSUSBLOG_DATA_SCALE_RUN_ID || null,
        tier: options.tier,
        namespace: options.namespace,
        seedEntry: { status: 'probe-required', command: DATA_SCALE_AOT_REBUILD_COMMAND }
    });
    if (result.status !== 'ok')
    {
        throw new Error(result.reason || result.errors.join('; ') || 'aot rebuild failed');
    }
    process.stdout.write(`${JSON.stringify({
        status: result.status,
        artifactCount: result.artifactCount,
        sizeBytes: result.sizeBytes,
        aotRoot: result.aotRoot,
        contentDigest: result.receipt?.contentDigest || null
    })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(`[data-scale:aot-evidence] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
