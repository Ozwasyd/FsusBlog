#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseMatrix } from '../test-matrix/parse-matrix.mjs';

import {
    backendEvidencePathAuthorityFile,
    buildBackendEvidencePathAuthority
} from './backend-evidence-path-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const matrixSource = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
const requirementCatalog = JSON.parse(fs.readFileSync(
    path.join(root, 'tests/backend/Fixtures/backend-test-requirements.json'),
    'utf8'));
const { errors, authority } = buildBackendEvidencePathAuthority(
    matrixSource,
    parseMatrix(matrixSource),
    requirementCatalog);
if (errors.length > 0)
{
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
}
else
{
    const output = path.join(root, backendEvidencePathAuthorityFile);
    const generated = `${JSON.stringify(authority, null, 4)}\n`;
    if (process.argv.includes('--write'))
    {
        fs.writeFileSync(output, generated);
        process.stdout.write(`${backendEvidencePathAuthorityFile}\n`);
    }
    else if (process.argv.includes('--check'))
    {
        if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== generated)
        {
            process.stderr.write(`${backendEvidencePathAuthorityFile} is stale\n`);
            process.exitCode = 1;
        }
    }
    else
    {
        process.stdout.write(generated);
    }
}
