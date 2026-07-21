import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../../tools/security/check-retired-character-challenge-residue.mjs', import.meta.url));
const retiredToken = Buffer.from(['Q2Fwd', 'GNoYVYx'].join(''), 'base64').toString('utf8');
const retiredBase64 = ['Q2Fwd', 'GNoYVYx'].join('');
const retiredHex = ['43617074', '6368615631'].join('');

function run(root)
{
    return spawnSync(process.execPath, [checker, '--root', root], { encoding: 'utf8' });
}

function write(root, relative, value)
{
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, value);
}

function git(root, ...args)
{
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
}

function fixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-residue-'));
    git(root, 'init', '--quiet');
    write(root, '.gitignore', ['src/frontend/dist/', 'src/backend/wwwroot/', '*.tgz', '*.wasm', ''].join('\n'));
    write(root, 'README.md', 'current protocol only\n');
    git(root, 'add', '.gitignore', 'README.md');
    return root;
}

function expectRejected(result, relative)
{
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, new RegExp(relative.replaceAll('.', '\\.')));
}

test('gate accepts a clean tracked and untracked repository', () =>
{
    const root = fixture();
    write(root, 'notes.txt', 'ordinary untracked source\n');
    write(root, 'generic-text-task.ts', "export const presentation = 'text-task'\nexport const property = { textTask: true }\n");
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /repository and package outputs are clean/u);
});

test('gate rejects a character-to-text-task alias but permits the independent generic primitive', () =>
{
    const root = fixture();
    write(root, 'generic-text-task.ts', "export const presentation = 'text-task'\n");
    assert.equal(run(root).status, 0);

    const retiredCharacterPresentation = ['char', 'acter'].join('');
    const genericTextTaskPresentation = ['text', 'task'].join('-');
    write(root, 'retired-alias.ts', `export const aliases = { '${retiredCharacterPresentation}': '${genericTextTaskPresentation}' }\n`);
    const result = run(root);
    expectRejected(result, 'retired-alias.ts');
    assert.match(result.stderr, /retired character-to-text-task presentation alias/u);

    fs.rmSync(path.join(root, 'retired-alias.ts'));
    write(root, 'archive-source/alias.ts', `export const aliases = { '${retiredCharacterPresentation}': '${genericTextTaskPresentation}' }\n`);
    const archive = path.join(root, 'artifacts/alias-package.tgz');
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const packed = spawnSync('tar', ['-czf', archive, '-C', path.join(root, 'archive-source'), '.'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    fs.rmSync(path.join(root, 'archive-source'), { recursive: true });
    expectRejected(run(root), 'artifacts/alias-package.tgz');

    fs.rmSync(archive);
    for (const separator of [' ', '_', ''])
    {
        write(root, 'retired-alias.ts', `export const aliases = { '${retiredCharacterPresentation}': 'text${separator}task' }\n`);
        expectRejected(run(root), 'retired-alias.ts');
        fs.rmSync(path.join(root, 'retired-alias.ts'));
    }
});

test('gate rejects retired bytes in tracked and unignored untracked files', () =>
{
    const root = fixture();
    write(root, 'tracked.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(retiredToken, 'utf16le')]));
    git(root, 'add', 'tracked.bin');
    expectRejected(run(root), 'tracked.bin');

    fs.rmSync(path.join(root, 'tracked.bin'));
    write(root, 'untracked.txt', retiredToken);
    expectRejected(run(root), 'untracked.txt');
});

test('gate rejects encoded retired identifiers used by base64 and hex decoders', () =>
{
    const root = fixture();
    write(root, 'base64-decoder.js', `globalThis.atob('${retiredBase64}')\n`);
    expectRejected(run(root), 'base64-decoder.js');

    fs.rmSync(path.join(root, 'base64-decoder.js'));
    write(root, 'hex-decoder.js', `Buffer.from('${retiredHex}', 'hex')\n`);
    expectRejected(run(root), 'hex-decoder.js');

    fs.rmSync(path.join(root, 'hex-decoder.js'));
    write(root, 'utf16-encoded.bin', Buffer.from(retiredBase64, 'utf16le'));
    expectRejected(run(root), 'utf16-encoded.bin');
});

test('gate explicitly scans ignored static, package and wasm outputs', () =>
{
    const root = fixture();
    write(root, 'src/frontend/dist/assets/app.js', retiredToken);
    expectRejected(run(root), 'src/frontend/dist/assets/app.js');
    fs.rmSync(path.join(root, 'src/frontend/dist'), { recursive: true });

    write(root, 'src/backend/wwwroot/assets/app.bin', Buffer.from(retiredToken));
    expectRejected(run(root), 'src/backend/wwwroot/assets/app.bin');
    fs.rmSync(path.join(root, 'src/backend/wwwroot'), { recursive: true });

    write(root, 'artifacts/module.wasm', Buffer.concat([Buffer.from([0, 97, 115, 109]), Buffer.from(retiredToken)]));
    expectRejected(run(root), 'artifacts/module.wasm');
    fs.rmSync(path.join(root, 'artifacts/module.wasm'));

    const archiveSource = path.join(root, 'archive-source');
    write(root, 'archive-source/payload.txt', retiredToken);
    const archive = path.join(root, 'artifacts/package.tgz');
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const packed = spawnSync('tar', ['-czf', archive, '-C', archiveSource, '.'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    fs.rmSync(archiveSource, { recursive: true });
    expectRejected(run(root), 'artifacts/package.tgz');
});

test('only the non-executable historical note may contain retired names', () =>
{
    const root = fixture();
    write(root, 'docs/history/retired-character-challenges.md', `# Historical migration note\n\n${retiredToken} was retired.\n`);
    assert.equal(run(root).status, 0);

    write(root, 'docs/history/retired-character-challenges.md', `# Historical migration note\n\n\`\`\`text\nkind = ${retiredToken}\n\`\`\`\n`);
    const executable = run(root);
    expectRejected(executable, 'docs/history/retired-character-challenges.md');

    fs.rmSync(path.join(root, 'docs/history/retired-character-challenges.md'));
    write(root, 'docs/history/another-note.md', `${retiredToken} was retired.\n`);
    expectRejected(run(root), 'docs/history/another-note.md');
});

test('clean scan cost remains proportional to owned bytes', { timeout: 15_000 }, () =>
{
    const smallRoot = fixture();
    const largeRoot = fixture();
    write(smallRoot, 'owned-bundle.js', 'ordinaryCurrentProtocolValue'.repeat(10_000));
    write(largeRoot, 'owned-bundle.js', 'ordinaryCurrentProtocolValue'.repeat(160_000));

    const smallStarted = performance.now();
    const small = run(smallRoot);
    const smallElapsed = performance.now() - smallStarted;
    assert.equal(small.status, 0, small.stderr);

    const largeStarted = performance.now();
    const large = run(largeRoot);
    const largeElapsed = performance.now() - largeStarted;
    assert.equal(large.status, 0, large.stderr);
    assert.ok(
        largeElapsed <= Math.max(2_500, smallElapsed * 24),
        `large scan ${largeElapsed.toFixed(0)}ms exceeded proportional budget from ${smallElapsed.toFixed(0)}ms`
    );
});
