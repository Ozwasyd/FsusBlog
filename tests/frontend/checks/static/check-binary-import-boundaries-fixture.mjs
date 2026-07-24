#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const checkerPath = path.join(repoRoot, 'tests/frontend/checks/static/check-binary-import-boundaries.mjs');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binary-import-fixture-'));

try {
    const apiDir = path.join(tempDir, 'api');
    const adaptersDir = path.join(tempDir, 'adapters/binary');
    const contractsDir = path.join(tempDir, 'contracts');
    const servicesDir = path.join(tempDir, 'services');
    const compositionDir = path.join(tempDir, 'composition');

    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(adaptersDir, { recursive: true });
    fs.mkdirSync(contractsDir, { recursive: true });
    fs.mkdirSync(servicesDir, { recursive: true });
    fs.mkdirSync(compositionDir, { recursive: true });

    fs.writeFileSync(path.join(contractsDir, 'sample.ts'), 'export type Sample = string;\n');
    fs.writeFileSync(path.join(adaptersDir, 'sampleDecoder.ts'), 'export type SampleDecoder = { decode(): void };\n');
    fs.writeFileSync(path.join(servicesDir, 'binaryTransport.ts'), 'export const createBinaryTransport = null;\nexport const BinaryFramePayloadDecoder = null;\n');
    fs.writeFileSync(path.join(compositionDir, 'binaryDecoderRegistry.ts'), 'export const binaryFrameDecoderRegistry = Object.freeze({});\nexport const decodeBinaryFramePayload = null;\n');
    fs.writeFileSync(path.join(compositionDir, 'binaryTransport.ts'), 'export const transport = createBinaryTransport(decodeBinaryFramePayload);\n');

    fs.writeFileSync(path.join(apiDir, 'violatingApi.ts'), "import type { SampleDecoder } from '@/adapters/binary/sampleDecoder'\nexport type { SampleDecoder };\n");

    const result = spawnSync(process.execPath, [checkerPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            FSUSBLOG_BINARY_IMPORT_SOURCE_ROOT: tempDir
        }
    });

    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    if (result.status === 0) {
        console.error('[binary-import-boundaries-fixture] Expected type-only adapter import fixture to fail the checker');
        console.error(output);
        process.exit(1);
    }

    if (!output.includes('API must not import binary decoder adapter')) {
        console.error('[binary-import-boundaries-fixture] Output missing expected failure message');
        console.error(output);
        process.exit(1);
    }

    console.log('[binary-import-boundaries-fixture] ok');
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
