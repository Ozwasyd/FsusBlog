import assert from 'node:assert/strict';
import test from 'node:test';

const { FindHardcodedLocaleLiterals } = await import(
    new URL('../../tools/frontend/check-i18n-literals.mjs', import.meta.url)
);

test('i18n literal governance returns actionable source locations', async () =>
{
    const findings = await FindHardcodedLocaleLiterals(['src/frontend/src/views/auth']);
    assert.ok(Array.isArray(findings));
    for (const finding of findings)
    {
        assert.match(finding.file, /^src\/frontend\/src\/views\/auth\//u);
        assert.ok(Number.isInteger(finding.line) && finding.line > 0);
        assert.equal(typeof finding.text, 'string');
    }
});
