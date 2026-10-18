#!/usr/bin/env node
/**
 * FsusBlog consumer contract for FsusUI canonical viewport / safe-area tokens (#1786).
 *
 * Blog runtime sources must consume only:
 *   --fsus-safe-area-inset-{top,right,bottom,left}
 *   --fsus-viewport-block-size
 *
 * Forbidden:
 *   - direct env(safe-area-inset-*)
 *   - Blog-owned synonymous safe-area custom properties
 *   - 100vh / 100dvh dual-write compatibility patterns
 *   - bare 100vh / 100dvh block-size units (use the canonical viewport token)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const RUNTIME_ROOT = 'src/frontend/src';
const RUNTIME_EXTENSIONS = new Set(['.css', '.vue', '.scss']);

const SAFE_AREA_ENV_PATTERN =
    /env\(\s*safe-area-inset-(?:top|right|bottom|left)\b/giu;

const FORBIDDEN_SAFE_AREA_ALIASES = [
    /--fsusblog-safe(?:-area)?(?:-inset)?(?:-top|-right|-bottom|-left)?\b/gu,
    /--blog-safe(?:-area)?(?:-inset)?(?:-top|-right|-bottom|-left)?\b/gu,
    /--safe-area-(?:inset-)?(?:top|right|bottom|left)\b/gu,
    /--fsus-safe-(?:top|right|bottom|left)\b/gu,
    /--fsus-safe-area-(?:top|right|bottom|left)\b(?!-)/gu
];

/** Same property written with 100vh then 100dvh (with optional calc wrappers). */
const DUAL_VH_DVH_PROPERTY =
    /(?:^|[;{])\s*((?:min-|max-)?(?:height|block-size))\s*:\s*[^;]*\b100vh\b[^;]*;\s*\1\s*:\s*[^;]*\b100dvh\b/giu;

/** Bare 100vh / 100dvh as a block-size unit (including calc / min / Tailwind-ish fragments). */
const BARE_VIEWPORT_BLOCK_UNIT =
    /(?:^|[^-\w])(?:100(?:vh|dvh)|(?:\d+(?:\.\d+)?)dvh)\b/gu;

const REQUIRED_SURFACE_TOKENS = [
    {
        path: 'src/frontend/src/assets/motion.css',
        needles: [
            'bottom: calc(var(--fsus-safe-area-inset-bottom) + 1rem);'
        ]
    },
    {
        path: 'src/frontend/src/assets/account-shell-base.css',
        needles: [
            'height: var(--fsus-viewport-block-size);',
            'max-height: var(--fsus-viewport-block-size);',
            'padding-bottom: var(--fsus-safe-area-inset-bottom);'
        ]
    },
    {
        path: 'src/frontend/src/components/article/ArticleTocPanel.vue',
        needles: [
            'max-height: calc(var(--fsus-viewport-block-size) - 11rem);',
            'padding-bottom: calc(var(--fsus-safe-area-inset-bottom) + 1rem);'
        ]
    }
];

function stripComments(source)
{
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/(^|[^:])\/\/.*$/gmu, '$1')
        .replace(/<!--[\s\S]*?-->/gu, '')
        .replace(/^\s*\/\/.*$/gmu, '');
}

function lineForIndex(source, index)
{
    return source.slice(0, index).split(/\r?\n/u).length;
}

function shouldSkipDirectory(name)
{
    return ['node_modules', 'dist', 'generated', 'bin', 'obj', 'coverage', '.git'].includes(name);
}

function walkRuntimeFiles(absoluteRoot, files = [])
{
    if (!fs.existsSync(absoluteRoot))
    {
        return files;
    }

    for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true }))
    {
        if (entry.name.startsWith('.') && entry.name !== '.')
        {
            continue;
        }

        const absolutePath = path.join(absoluteRoot, entry.name);
        if (entry.isDirectory())
        {
            if (shouldSkipDirectory(entry.name))
            {
                continue;
            }
            walkRuntimeFiles(absolutePath, files);
            continue;
        }

        if (!entry.isFile())
        {
            continue;
        }

        if (RUNTIME_EXTENSIONS.has(path.extname(entry.name)))
        {
            files.push(absolutePath);
        }
    }

    return files;
}

/**
 * Scan a single source string for contract violations.
 * @param {string} relativePath
 * @param {string} raw
 * @returns {string[]}
 */
export function findSourceViolations(relativePath, raw)
{
    const violations = [];
    const source = stripComments(raw);

    SAFE_AREA_ENV_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(SAFE_AREA_ENV_PATTERN))
    {
        violations.push(
            `${relativePath}:${lineForIndex(source, match.index ?? 0)} direct env(safe-area-inset-*) is forbidden; consume --fsus-safe-area-inset-*`
        );
    }

    for (const pattern of FORBIDDEN_SAFE_AREA_ALIASES)
    {
        pattern.lastIndex = 0;
        for (const match of source.matchAll(pattern))
        {
            violations.push(
                `${relativePath}:${lineForIndex(source, match.index ?? 0)} forbidden synonymous safe-area token ${match[0]}`
            );
        }
    }

    DUAL_VH_DVH_PROPERTY.lastIndex = 0;
    for (const match of source.matchAll(DUAL_VH_DVH_PROPERTY))
    {
        violations.push(
            `${relativePath}:${lineForIndex(source, match.index ?? 0)} dual ${match[1]} 100vh/100dvh fallback is forbidden; use --fsus-viewport-block-size`
        );
    }

    BARE_VIEWPORT_BLOCK_UNIT.lastIndex = 0;
    for (const match of source.matchAll(BARE_VIEWPORT_BLOCK_UNIT))
    {
        violations.push(
            `${relativePath}:${lineForIndex(source, match.index ?? 0)} bare viewport unit ${match[0].trim()} is forbidden; use --fsus-viewport-block-size`
        );
    }

    return violations;
}

/**
 * Scan Blog runtime sources under src/frontend/src.
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function findCanonicalViewportSafeAreaViolations(options = {})
{
    const baseRoot = options.root ? path.resolve(options.root) : repoRoot;
    const runtimeRoot = path.join(baseRoot, RUNTIME_ROOT);
    const violations = [];

    for (const absolutePath of walkRuntimeFiles(runtimeRoot))
    {
        const relativePath = path.relative(baseRoot, absolutePath).split(path.sep).join('/');
        const raw = fs.readFileSync(absolutePath, 'utf8');
        violations.push(...findSourceViolations(relativePath, raw));
    }

    return violations;
}

/**
 * Assert required consumer surfaces keep the migrated formulas.
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function findRequiredSurfaceFormulaViolations(options = {})
{
    const baseRoot = options.root ? path.resolve(options.root) : repoRoot;
    const violations = [];

    for (const surface of REQUIRED_SURFACE_TOKENS)
    {
        const absolutePath = path.join(baseRoot, surface.path);
        if (!fs.existsSync(absolutePath))
        {
            violations.push(`${surface.path}: required surface file is missing`);
            continue;
        }

        const source = fs.readFileSync(absolutePath, 'utf8');
        for (const needle of surface.needles)
        {
            if (!source.includes(needle))
            {
                violations.push(`${surface.path}: missing required formula ${needle}`);
            }
        }
    }

    return violations;
}

/**
 * Geometry arithmetic helpers used by unit probes (0px tolerance).
 */
/**
 * @param {number} insetBottomPx
 * @param {number} [baseRemPx]
 * @returns {number}
 */
export function toastBottomOffsetPx(insetBottomPx, baseRemPx = 16)
{
    return insetBottomPx + baseRemPx;
}

/**
 * @param {number} viewportBlockSizePx
 * @returns {number}
 */
export function accountDrawerBlockSizePx(viewportBlockSizePx)
{
    return viewportBlockSizePx;
}

/**
 * @param {number} insetBottomPx
 * @param {number} [baseRemPx]
 * @returns {number}
 */
export function articleTocDrawerPaddingBottomPx(insetBottomPx, baseRemPx = 16)
{
    return insetBottomPx + baseRemPx;
}

function runLiveCheck()
{
    const failures = [
        ...findCanonicalViewportSafeAreaViolations(),
        ...findRequiredSurfaceFormulaViolations()
    ];

    // In-process mutation proofs (no re-exec).
    let mutationProofs = 0;
    const assertMutationRejected = (label, messages) =>
    {
        if (!Array.isArray(messages) || messages.length === 0)
        {
            failures.push(`mutation ${label}: expected non-zero validation failures`);
            return;
        }
        mutationProofs += 1;
    };

    assertMutationRejected(
        'direct-env-safe-area',
        findSourceViolations(
            'src/frontend/src/assets/motion.css',
            '.leak { bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem); }\n'
        )
    );

    assertMutationRejected(
        'synonymous-blog-safe-token',
        findSourceViolations(
            'src/frontend/src/assets/main.css',
            ':root { --fsusblog-safe-bottom: 0px; }\n'
        )
    );

    assertMutationRejected(
        'dual-vh-dvh-height',
        findSourceViolations(
            'src/frontend/src/assets/account-shell-base.css',
            '.account-mobile-drawer { height: 100vh; height: 100dvh; }\n'
        )
    );

    assertMutationRejected(
        'bare-100vh-fallback',
        findSourceViolations(
            'src/frontend/src/assets/public-shell-foundation.css',
            '#fsus-aot-shell { min-height: 100vh; }\n'
        )
    );

    if (mutationProofs < 4)
    {
        failures.push(`expected 4 mutation proofs, got ${mutationProofs}`);
    }

    if (failures.length > 0)
    {
        for (const message of failures)
        {
            console.error(`[check-canonical-viewport-safe-area] ${message}`);
        }
        process.exit(1);
    }

    console.log(
        `[check-canonical-viewport-safe-area] ok surfaces=${REQUIRED_SURFACE_TOKENS.length} mutations=${mutationProofs}`
    );
}

const isDirectRun = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun)
{
    runLiveCheck();
}
