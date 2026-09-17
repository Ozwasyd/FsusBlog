import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    generateFontLicenseEvidence,
    readAndValidateFontLicenseEvidence,
    validateFontLicenseEvidence
} from '../../tools/release/font-license-evidence.mjs';

function validEvidence(overrides = {})
{
    return {
        schema: 'fsusblog.font.license.v1',
        status: 'ok',
        fonts: [{
            id: 'fsusblog.font.fixture',
            license: 'OFL-1.1',
            source: '@fontsource/fixture@1.0.0',
            hashVerified: true
        }],
        violations: [],
        ...overrides
    };
}

test('release consumer accepts verified local font provenance evidence', () =>
{
    assert.deepEqual(validateFontLicenseEvidence(validEvidence()), []);
});

test('release consumer fails closed on unknown license, remote source, or hash failure', () =>
{
    const errors = validateFontLicenseEvidence(validEvidence({
        fonts: [{
            id: 'fsusblog.font.fixture',
            license: 'unknown',
            source: 'https://fonts.example/fixture@1.0.0',
            hashVerified: false
        }]
    })).join('\n');

    assert.match(errors, /license is unknown/u);
    assert.match(errors, /source is invalid/u);
    assert.match(errors, /hashVerified must be true/u);
});

test('release consumer rejects blocked evidence and symlink input', t =>
{
    assert.match(
        validateFontLicenseEvidence(validEvidence({
            status: 'blocked',
            violations: [{ code: 'font_asset_hash_mismatch', fontId: 'fsusblog.font.fixture' }]
        })).join('\n'),
        /status must be ok[\s\S]*violations must be an empty array/u);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'font-license-evidence-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const target = path.join(directory, 'target.json');
    const link = path.join(directory, 'summary.json');
    fs.writeFileSync(target, JSON.stringify(validEvidence()));
    fs.symlinkSync(target, link);

    assert.throws(
        () => readAndValidateFontLicenseEvidence(link),
        /regular non-symlink file/u);
});

test('release collector and release-final both consume font license evidence', () =>
{
    const root = path.resolve(import.meta.dirname, '../..');
    const collector = fs.readFileSync(
        path.join(root, 'tools/operations/collect-release-evidence.sh'),
        'utf8');
    const releaseFinal = fs.readFileSync(
        path.join(root, 'tools/release/check-release-final.mjs'),
        'utf8');

    assert.match(collector, /font-license-summary\.json/u);
    assert.match(collector, /FONT_LICENSE_STATUS_VALUE.*!= "ok"/su);
    assert.match(collector, /"fontLicenseSummary": \$FONT_LICENSE_SUMMARY/u);
    assert.match(releaseFinal, /fontLicenseSummary release evidence artifact is required/u);
});

test('release generator rehashes local registry assets and reports tampering', t =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'font-license-registry-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const assets = path.join(directory, 'assets');
    fs.mkdirSync(assets);
    const content = Buffer.from([0x77, 0x4f, 0x46, 0x32, 1, 2, 3]);
    const hash = crypto.createHash('sha256')
        .update(content)
        .digest('hex');
    const source = {
        kind: 'npm-fontsource',
        package: '@fontsource/fixture',
        version: '1.0.0',
        upstream: 'Fixture upstream'
    };
    const manifest = {
        id: 'fsusblog.font.fixture',
        license: { name: 'OFL-1.1' },
        source,
        faces: [{ weight: 400, style: 'normal', contentHash: hash }]
    };
    fs.writeFileSync(path.join(assets, `${hash}.woff2`), content);
    fs.writeFileSync(path.join(directory, 'registry.json'), JSON.stringify({
        fonts: [{
            id: manifest.id,
            manifestJson: JSON.stringify(manifest),
            licenseText: 'fixture license',
            licenseSourceJson: JSON.stringify(source),
            builtIn: false,
            faces: [{
                weight: 400,
                style: 'normal',
                contentHash: hash,
                sizeBytes: content.length
            }]
        }]
    }));

    const valid = generateFontLicenseEvidence(directory);
    assert.equal(valid.status, 'ok');
    assert.equal(valid.fonts[0].hashVerified, true);

    fs.writeFileSync(path.join(assets, `${hash}.woff2`), Buffer.from('tampered'));
    const blocked = generateFontLicenseEvidence(directory);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.fonts[0].hashVerified, false);
    assert.deepEqual(blocked.violations, [{
        code: 'font_asset_hash_mismatch',
        fontId: manifest.id
    }]);
});
