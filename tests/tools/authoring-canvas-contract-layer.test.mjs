import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderCanvasClientContract } from '../../tools/contracts/generate-authoring-canvas-wire.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const schema = JSON.parse(read('src/shared/Contracts/Validation/authoring-canvas-wire.json'));
const domains = ['Document', 'Operation', 'Reference', 'Transport'].map(name =>
    read(`src/shared/Contracts/AuthoringCanvas/AuthoringCanvas${name}Contracts.cs`));
const contractPath = 'src/frontend/src/contracts/authoringCanvas.ts';
const source = read(contractPath);
const load = text => import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(text)).toString('base64'));

test('canonical generated client budgets remain immutable and equal the original wire limits', async () =>
{
    const contract = await load(source);
    const wire = await load(read('src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts'));
    assert.deepEqual(contract.AUTHORING_CANVAS_BUDGETS, {
        MAX_NODES: wire.authoringCanvasLimits.maxNodesPerCanvas,
        MAX_EDGES: wire.authoringCanvasLimits.maxEdgesPerCanvas,
        MAX_TITLE_LENGTH: wire.authoringCanvasLimits.maxTitleLength,
        MAX_NOTE_TEXT_LENGTH: wire.authoringCanvasLimits.maxNoteSourceLength,
        MAX_FRAME_LABEL_LENGTH: wire.authoringCanvasLimits.maxFrameLabelLength,
        MAX_EDGE_LABEL_LENGTH: wire.authoringCanvasLimits.maxEdgeLabelLength,
        MAX_COORDINATE_MAGNITUDE: wire.authoringCanvasLimits.maxCoordinateMagnitude,
        MIN_NODE_EXTENT: wire.authoringCanvasLimits.minNodeExtent,
        MAX_NODE_EXTENT: wire.authoringCanvasLimits.maxNodeExtent,
        MIN_ZOOM: wire.authoringCanvasLimits.minZoom,
        MAX_ZOOM: wire.authoringCanvasLimits.maxZoom,
        MAX_CANVASES_PER_USER: wire.authoringCanvasLimits.maxCanvasesPerOwner
    });
    assert.equal(Object.isFrozen(contract.AUTHORING_CANVAS_BUDGETS), true);
    assert.equal(renderCanvasClientContract(source, schema, domains), source);
});

test('client budget producer refuses missing duplicate reversed markers and invalid owners', () =>
{
    for (const candidate of [source.replace('// <generated-canvas-client-budgets>', ''),
        source + '\n// <generated-canvas-client-budgets>',
        '// </generated-canvas-client-budgets>\n// <generated-canvas-client-budgets>'])
    {
        assert.throws(() => renderCanvasClientContract(candidate, schema, domains), /markers must occur exactly once/u);
    }
    for (const owner of [undefined, 'AuthoringCanvasContract.Unknown'])
    {
        const changed = structuredClone(schema);
        changed.clientLimits.maxNodesPerCanvas = owner;
        assert.throws(() => renderCanvasClientContract(source, changed, domains), /invalid client limit owner|unsupported domain constant/u);
    }
    assert.equal(renderCanvasClientContract(source.replace('MAX_NODES: 10000', 'MAX_NODES: 1'), schema, domains), source);
});

// Scope is the actual contract and four actual original architecture files. This
// executes the unchanged original rule for that contract; it is not a full graph audit.
const scopedFiles = [contractPath,
    'src/frontend/src/codecs/binary/authoringCanvasWire.generated.ts',
    'src/frontend/src/services/binaryTransport.ts',
    'src/frontend/src/composition/binaryDecoderRegistry.ts',
    'src/frontend/src/composition/binaryTransport.ts'];

for (const injectOriginalViolation of [false, true])
{
    test(`original contracts-layer rule ${injectOriginalViolation ? 'rejects the exact old runtime import' : 'accepts the actual canonical contract'} and cleans its scoped input`, () =>
    {
        const directory = mkdtempSync(path.join(tmpdir(), 'fsus-canvas-contract-layer-'));
        try
        {
            for (const name of scopedFiles)
            {
                const target = path.join(directory, path.relative('src/frontend/src', name));
                mkdirSync(path.dirname(target), { recursive: true });
                writeFileSync(target, read(name));
            }
            if (injectOriginalViolation)
            {
                writeFileSync(path.join(directory, 'contracts/authoringCanvas.ts'),
                    "import { authoringCanvasLimits } from '@/codecs/binary/authoringCanvasWire.generated';\n" + source);
            }
            const run = spawnSync(process.execPath, ['tests/frontend/checks/static/check-binary-import-boundaries.mjs'], {
                cwd: root, encoding: 'utf8', env: { ...process.env, FSUSBLOG_BINARY_IMPORT_SOURCE_ROOT: directory }
            });
            assert.equal(run.status, injectOriginalViolation ? 1 : 0, run.stdout + run.stderr);
            if (injectOriginalViolation)
            {
                assert.match(run.stderr, /contracts must not have runtime import @\/codecs\/binary\/authoringCanvasWire.generated/u);
            }
            else
            {
                assert.match(run.stdout, /PASSED files=5/u);
            }
        }
        finally
        {
            rmSync(directory, { recursive: true, force: true });
            assert.equal(existsSync(directory), false);
        }
    });
}
