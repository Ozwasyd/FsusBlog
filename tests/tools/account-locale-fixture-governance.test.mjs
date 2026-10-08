import assert from 'node:assert/strict';
import test from 'node:test';

const { scanAccountAuthFixtureSources } = await import(new URL('../../tools/test/account-auth-fixture-source-scan.mjs', import.meta.url));


const examples = [
    ['direct-preference-storage', 'db.query("UPDATE user_locale_preference SET revision = 2");'],
    ['manual-cookie', 'document.cookie = localeValue;'],
    ['manual-cookie', 'browser.addCookies(values);'],
    ['manual-browser-storage', 'localStorage.setItem("locale", localeValue);'],
    ['legacy-locale-key', 'const key = "fsusblog.locale";'],
    ['environment-account', 'const id = process.env.FSUSBLOG_PROFILE_FIXTURE_USER_ID;'],
    ['environment-account', 'firstExistingProfile();'],
    ['last-write-wins', 'overwriteNewerPreference();'],
    ['auth-account-crossing', 'account.resetPermissions(userId);'],
    ['warning-success', 'const warningOnly = true;'],
    ['legacy-wrapper', 'compatProfileFixtureReader();'],
    ['ordinary-secret-output', 'writeFileSync(output, JSON.stringify({ privateKey }));'],
    ['manual-browser-storage', 'const store = localStorage; const write = store["set" + "Item"]; write("locale", value);']
];

for (const [ruleId, source] of examples)
{
    test(`account locale source scanner detects ${ruleId}: ${source.split('(')[0]}`, () =>
    {
        const report = scanAccountAuthFixtureSources('account-locale', [{ path: 'tests/account.ts', source }]);
        assert.ok(report.violations.some((item) => item.ruleId === ruleId));
    });
}

test('C#, shell, workflow, config and documentation source findings retain locations', () =>
{
    for (const extension of ['cs', 'sh', 'yml', 'json', 'md'])
    {
        const report = scanAccountAuthFixtureSources('account-locale', [{ path: `tests/account.${extension}`,
            source: 'first line\nUPDATE user_locale_preference SET revision = 2' }]);
        assert.ok(report.violations.some((item) => item.ruleId === 'direct-preference-storage' && item.line === 2));
    }
});

test('source identity changes with source bytes and cannot stand in for runtime precedence evidence', () =>
{
    const before = scanAccountAuthFixtureSources('account-locale', [{ path: 'tests/account.ts', source: 'const x = 1;' }]);
    const after = scanAccountAuthFixtureSources('account-locale', [{ path: 'tests/account.ts', source: 'const x = 2;' }]);
    assert.notEqual(before.sourceDigest, after.sourceDigest);
    assert.equal('status' in before, false);
    assert.equal('aotVerified' in before, false);
});
