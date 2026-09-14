#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_BOOTSTRAP_KINDS = ['Home', 'About', 'Archive', 'ArticleDetail', 'Filter'];

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function ensureKindCoverage(source, label)
{
    for (const kind of REQUIRED_BOOTSTRAP_KINDS)
    {
        assert(source.includes(`'${kind}'`), `${label} missing ${kind}`);
    }
}

function main()
{
    const root = resolve(process.cwd());
    const generatorScript = resolve(root, '../../tools/frontend/generate-public-page-manifest.mjs');
    const manifestHelper = resolve(root, 'src/public-renderers/generated/publicPageManifest.ts');
    const payloadTypesHelper = resolve(root, 'src/public-renderers/publicPayloadTypes.ts');
    const normalizerHelper = resolve(root, 'src/public-renderers/publicPayloadNormalizer.ts');

    execFileSync(process.execPath, [generatorScript, '--check'], {
        cwd: root,
        stdio: 'pipe'
    });

    const manifestText = readFileSync(manifestHelper, 'utf8');
    const payloadTypesText = readFileSync(payloadTypesHelper, 'utf8');
    const normalizerText = readFileSync(normalizerHelper, 'utf8');

    ensureKindCoverage(manifestText, 'src/public-renderers/generated/publicPageManifest.ts');
    ensureKindCoverage(payloadTypesText, 'src/public-renderers/publicPayloadTypes.ts');
    ensureKindCoverage(normalizerText, 'src/public-renderers/publicPayloadNormalizer.ts');

    console.log('[check-public-pageid-coverage] ok (shared manifest + public bootstrap kinds covered)');
}

try
{
    main();
}
catch (error)
{
    console.error('[check-public-pageid-coverage] failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
}
