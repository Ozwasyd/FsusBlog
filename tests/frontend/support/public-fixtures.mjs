/**
 * @typedef {{ articleId?: number; categoryId?: number; tagId?: number; articleTitle?: string; searchKeyword?: string; }} PublicFixtureDefaults
 * @typedef {{ requireCurrent?: boolean; env?: Record<string, string | undefined>; repoRoot?: string; }} PublicFixtureOptions
 * @typedef {{ articleId: number; categoryId: number; tagId: number; }} PublicFixtureIds
 * @typedef {{ kind: string; id: number | string; handle?: string; }} PublicFixtureEntity
 * Projection metadata passes through without a complete metadata shape check.
 * @typedef {PublicFixtureIds & Record<string, unknown> & {
 *   articleTitle: string; searchKeyword: string;
 *   schema?: string; notAuthoritative?: true; projectionDigest?: string;
 * }} PublicFixtures
 */

import { existsSync, readFileSync } from 'node:fs';

import { resolvePublicFixtureFile } from './fixture-paths.mjs';

const { digestCanonical } = await import(
    new URL('../../../tools/test-fixtures/receipt/canonical.mjs', import.meta.url)
);

const verifiedProjectionSchema = 'fsusblog.fixture-id-projection.v1';
const preparedProjectionSchema = 'fsusblog.prepared-public-id-projection.v1';

/**
 * Read public entity IDs from a verified-receipt projection (#1710/#1712).
 * Old TSV public.aeds is not accepted as authority or compat input.
 */
function readProjectionDocument({ env = process.env, repoRoot } = {})
{
    const candidates = [
        env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE,
        resolvePublicFixtureFile({
            env,
            ...(repoRoot ? { repoRoot } : {})
        })
    ].filter(Boolean);

    const fixturePath = candidates.find((candidate) => existsSync(candidate));
    if (!fixturePath)
    {
        return null;
    }

    const raw = readFileSync(fixturePath, 'utf8');
    // Fail closed on legacy TSV public.aeds (tab-separated base64url rows).
    if (raw.includes('\t') && !raw.trimStart().startsWith('{'))
    {
        throw new Error(
            `legacy public fixture TSV is not accepted (${fixturePath}); use fsusblog.fixture-id-projection.v1 from a verified FixtureReceipt`
        );
    }

    let document;
    try
    {
        document = JSON.parse(raw);
    }
    catch
    {
        throw new Error(`public fixture projection is not valid JSON: ${fixturePath}`);
    }

    if (document?.schema !== verifiedProjectionSchema && document?.schema !== preparedProjectionSchema)
    {
        throw new Error(
            `public fixture file has unsupported schema: ${fixturePath}`
        );
    }
    if (document?.schema === 'fsusblog.fixture-receipt.v1' || document?.schema === 'fsusblog.fixture-receipt.v2')
    {
        throw new Error('FixtureReceipt cannot be consumed as a public ID projection');
    }
    if (document.notAuthoritative !== true)
    {
        throw new Error(`public fixture projection must be non-authoritative: ${fixturePath}`);
    }
    if (document.schema === preparedProjectionSchema)
    {
        if (document.authority !== 'derived-from-current-run-prepared-public-content'
      || document.evidenceUse !== 'navigation-input-only'
      || !/^sha256:[0-9a-f]{64}$/u.test(String(document.sourcePrepareStateDigest ?? '')))
        {
            throw new Error(`prepared public fixture projection has an invalid authority: ${fixturePath}`);
        }
        for (const [name, expected] of [
            ['namespace', env.FSUSBLOG_TEST_NAMESPACE],
            ['catalogDigest', env.FSUSBLOG_SEALED_FIXTURE_CATALOG_DIGEST]
        ])
        {
            if (expected && document[name] !== expected)
            {
                throw new Error(`prepared public fixture projection ${name} mismatch: ${fixturePath}`);
            }
        }
        const expectedSource = {
            commit: env.FSUSBLOG_TEST_SOURCE_COMMIT,
            worktreeFingerprint: env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
        };
        for (const [name, expected] of Object.entries(expectedSource))
        {
            if (expected && document.sourceIdentity?.[name] !== expected)
            {
                throw new Error(`prepared public fixture projection source ${name} mismatch: ${fixturePath}`);
            }
        }
    }
    const expectedDigest = digestCanonical({ ...document, projectionDigest: undefined });
    if (document.projectionDigest !== expectedDigest)
    {
        throw new Error(`public fixture projection digest mismatch: ${fixturePath}`);
    }
    return document;
}

function positiveInt(value, fallback)
{
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function firstIdByKind(document, kind)
{
    if (document?.idsByKind?.[kind]?.[0])
    {
        return document.idsByKind[kind][0];
    }
    const match = (document?.entities ?? []).find((item) => item.kind === kind);
    return match?.id ?? null;
}

/**
 * @param {PublicFixtureDefaults} [defaults]
 * @param {PublicFixtureOptions} [options]
 * @returns {PublicFixtureIds}
 */
export function readPublicFixtureIds(defaults = {}, {
    requireCurrent = false,
    env = process.env,
    repoRoot
} = {})
{
    const document = readProjectionDocument({ env, repoRoot });
    if (!document)
    {
        if (requireCurrent)
        {
            throw new Error('current-run public fixture projection is missing');
        }
        return {
            articleId: positiveInt(defaults.articleId, 0),
            categoryId: positiveInt(defaults.categoryId, 0),
            tagId: positiveInt(defaults.tagId, 0)
        };
    }

    const articleId = positiveInt(document.articleId ?? firstIdByKind(document, 'article'), 0);
    const categoryId = positiveInt(document.categoryId ?? firstIdByKind(document, 'category'), 0);
    const tagId = positiveInt(document.tagId ?? firstIdByKind(document, 'tag'), 0);

    if (requireCurrent)
    {
        const missing = [];
        if (!articleId)
        {
            missing.push('articleId');
        }
        if (!categoryId)
        {
            missing.push('categoryId');
        }
        if (!tagId)
        {
            missing.push('tagId');
        }
        if (missing.length)
        {
            throw new Error(`current-run public fixtures are missing: ${missing.join(', ')}`);
        }
    }

    return {
        articleId: articleId || positiveInt(defaults.articleId, 0),
        categoryId: categoryId || positiveInt(defaults.categoryId, 0),
        tagId: tagId || positiveInt(defaults.tagId, 0)
    };
}

/**
 * @param {PublicFixtureDefaults} [defaults]
 * @param {PublicFixtureOptions} [options]
 * @returns {PublicFixtures}
 */
export function readPublicFixtures(defaults = {}, {
    requireCurrent = false,
    env = process.env,
    repoRoot
} = {})
{
    const document = readProjectionDocument({ env, repoRoot });
    if (!document && requireCurrent)
    {
        throw new Error('current-run public fixture projection is missing');
    }
    const effectiveDocument = document ?? {};
    const ids = readPublicFixtureIds(defaults, { requireCurrent, env, repoRoot });
    const article = (effectiveDocument.entities ?? []).find((item) => item.kind === 'article');
    return {
        ...effectiveDocument,
        ...ids,
        articleTitle: String(effectiveDocument.articleTitle || article?.handle || defaults.articleTitle || ''),
        searchKeyword: String(effectiveDocument.searchKeyword || defaults.searchKeyword || '')
    };
}
