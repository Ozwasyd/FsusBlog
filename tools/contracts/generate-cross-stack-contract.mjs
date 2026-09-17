#!/usr/bin/env node
import fs from 'node:fs';

import {
    generatedMatrixFromOpenApi,
    generatedMatrixPath,
    loadMatrix,
    loadOpenApi,
    writeJson
} from './lib/openapi-contracts.mjs';
import {
    observationPaths,
    produceOpenApiObservation
} from './lib/openapi-observation.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const writeOpenApiIndex = args.indexOf('--write-openapi');
const writeOpenApiPath = writeOpenApiIndex >= 0 ? args[writeOpenApiIndex + 1] : null;
const fromObservation = args.includes('--from-observation') || writeOpenApiPath != null;

if (writeOpenApiPath)
{
    // OpenAPI is a projection of compiled endpoint observation only — never matrix.
    const produced = produceOpenApiObservation({ rebuild: !args.includes('--no-rebuild') });
    fs.mkdirSync(new URL('../../.tmp/contracts/openapi/', import.meta.url), { recursive: true });
    fs.copyFileSync(produced.observedOpenApiPath, writeOpenApiPath);
    console.log(`[cross-stack-contract] wrote observed OpenAPI projection to ${writeOpenApiPath}`);
    process.exit(0);
}

// Matrix generation consumes current OpenAPI projection / observation only.
const openapi = fromObservation && fs.existsSync(observationPaths().observedOpenApiPath)
    ? JSON.parse(fs.readFileSync(observationPaths().observedOpenApiPath, 'utf8'))
    : loadOpenApi({ preferGenerated: true });

const generated = generatedMatrixFromOpenApi(openapi, loadMatrix());
const text = `${JSON.stringify(generated, null, 2)}\n`;

if (check)
{
    const current = fs.existsSync(generatedMatrixPath) ? fs.readFileSync(generatedMatrixPath, 'utf8') : '';
    if (current !== text)
    {
        console.error('[cross-stack-contract] generated matrix drifted; run tools/contracts/generate-cross-stack-contract.mjs');
        process.exit(1);
    }
    console.log('[cross-stack-contract] generated matrix in sync');
}
else
{
    fs.mkdirSync(new URL('../../tests/frontend/fixtures/', import.meta.url), { recursive: true });
    fs.writeFileSync(generatedMatrixPath, text);
    console.log(`[cross-stack-contract] wrote ${generatedMatrixPath}`);
}
