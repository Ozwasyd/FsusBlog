import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildVectors } from './perception-character-v3-reference.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputPath = path.join(root, 'tests/fixtures/security/perception-character-v3-vectors.json');
const expected = `${JSON.stringify(buildVectors(), null, 4)}\n`;

if (process.argv.includes('--check'))
{
    if (readFileSync(outputPath, 'utf8') !== expected)
    {
        throw new Error('PerceptionCharacterV3 vectors are stale; run this generator without --check');
    }
    console.log('[perception-character-v3] test vectors are in sync');
}
else
{
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, expected);
    console.log('[perception-character-v3] wrote cross-language test vectors');
}
