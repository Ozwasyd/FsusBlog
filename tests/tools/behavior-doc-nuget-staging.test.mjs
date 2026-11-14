import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeStagedFeedFile } from '../../tools/docs/prepare-behavior-doc-nuget.mjs';

test('staged feed retains its sealed mode under a restrictive umask', (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-feed-mode-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const previous = process.umask(0o077);
    try
    {
        const file = path.join(root, 'package.nupkg');
        writeStagedFeedFile(file, Buffer.from('archive'), 0o444);
        assert.equal(fs.statSync(file).mode & 0o777, 0o444);
        assert.equal(fs.readFileSync(file, 'utf8'), 'archive');
        assert.throws(() => writeStagedFeedFile(file, Buffer.from('replacement'), 0o444), { code: 'EEXIST' });
    }
    finally
    {
        process.umask(previous);
    }
});
