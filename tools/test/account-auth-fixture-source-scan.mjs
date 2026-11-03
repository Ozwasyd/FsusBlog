import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { assertAccountLocaleOwnershipCurrent } = await import(new URL('./account-locale-fixture-inventory.mjs', import.meta.url));
const { digestCanonical, freezeDeep } = await import(new URL('../test-fixtures/receipt/canonical.mjs', import.meta.url));


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireParser = createRequire(new URL('../test-inventory/ts-ast-adapter/package.json', import.meta.url));
const domains = ['account-locale', 'auth-fixture', 'auth-truth'];
const sourceExtensions = new Set(['.cs', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.sh', '.yml', '.yaml', '.json', '.md']);
const commonPatterns = [
    ['direct-auth-storage', /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:sys_user|sys_admin|user_session|admin_session|user_refresh_token|webauthn_credential|step_up_proof)\b/giu],
    ['token-signing', /\b(?:createHmac|JwtSecurityToken|JwtSecurityTokenHandler)\s*\(|\b(?:jwt|jsonwebtoken)\s*\.\s*sign\s*\(/gu],
    ['default-auth-account', /\b(?:binaryuser|binaryadmin|defaultAdminPermissions|defaultUserHandle|defaultAdminHandle)\b/gu],
    ['second-producer', /fixture-catalog:\s*producer\s+(?:auth-session|account-profile-preferences)\b/gu],
    ['warning-success', /\b(?:warningOnly|warningAndContinue|ignoreVerificationFailure)\s*[:=]\s*true\b/gu],
    ['legacy-wrapper', /\b(?:legacy|compat)[a-z0-9_]*(?:Auth|Session|Profile|Preference|Truth|Locale)[a-z0-9_]*(?:Reader|Producer|Prepare|Fixture)\b/giu]
];
const domainPatterns = {
    'account-locale': [
        ['direct-preference-storage', /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:user_locale_preference|sys_user)\b/giu],
        ['legacy-locale-key', /\b(?:fsusblog\.locale|fsus_locale|legacyLocaleStorage|legacyLocaleCookie)\b/gu],
        ['environment-account', /\b(?:FSUSBLOG_PROFILE_FIXTURE_USER_ID|FSUSBLOG_PROFILE_FIXTURE_HANDLE|firstExistingProfile|firstExistingUser)\b/gu],
        ['last-write-wins', /\b(?:lastWriteWins|ignoreRevisionConflict|overwriteNewerPreference)\b/gu],
        ['auth-account-crossing', /\b(?:resetMfa|resetPermissions|revokeAllSessions|resetBan)\s*\(/gu]
    ],
    'auth-fixture': [
        ['universal-reset', /\b(?:resetMfa|resetBan|unbanUser|resetDeleted|ensureUserFixtureSession|ensureAdminFixtureSession)\s*\(/gu],
        ['revoke-all', /\b(?:RevokeAll(?:User)?SessionsAsync|revokeAllSessions|revokeAllUserSessions)\s*\(/gu],
        ['full-admin-default', /\b(?:adminAllFull|defaultFullPermissions|defaultAdminPermissions)\b/gu],
        ['security-owner-cleanup', /\b(?:clearBanCache|clearRiskState|deleteCredentialAudit|resetSecurityState)\s*\(/gu],
        ['old-auth-entry', /\b(?:prepare-auth-smoke-users|auth-storage-manifest|legacyAuthManifest|compatAuthManifest)\b/gu],
        ['http-private-fallback', /\b(?:fallbackToPrivateFixture|httpToDbFallback|fixturePrivateFallback|testOnlyAuthBypass)\b/gu]
    ],
    'auth-truth': [
        ['placeholder-credential', /\b(?:placeholderCredential|placeholder_credential|syntheticWebAuthnCredential)\b/gu],
        ['legacy-strength', /\b(?:legacy_mfa|legacyStrength)\b/gu],
        ['claim-only-step-up', /\b(?:stepUpVerified|step_up_verified|hasStepUpProof)\s*[:=]\s*true\b/gu],
        ['permission-second-map', /\b(?:permissionMap|adminPermissionMap|hardcodedPermissions|defaultAdminPermissions)\s*[:=]/gu],
        ['duration-hardcode', /\b(?:cookieMaxAge|sessionIdleDays|sessionAbsoluteDays)\s*[:=]\s*\d+/gu],
        ['truth-inference', /\b(?:truthFromFilename|truthFromJwtClaims|inferTruthClass|defaultTruthClass)\b/gu],
        ['refresh-context-rebuild', /\b(?:refreshAuthTime|refreshStrength|carryConsumedProof)\s*[:=]/gu],
        ['cross-truth-root', /\b(?:sharedCanonicalLegacyRoot|sharedBypassCanonicalStorage|acceptLegacyAsCanonical)\b/gu]
    ]
};

function requireDomain(domain)
{
    if (!domains.includes(domain))
    {
        throw new Error('unknown account/auth fixture scanner domain');
    }
}

function javascriptViews(source, relativePath)
{
    const ts = requireParser('typescript');
    if (ts.version !== '6.0.3')
    {
        throw new Error('fixture scanner requires the pinned TypeScript parser');
    }
    const tree = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
    if (tree.parseDiagnostics.length > 0)
    {
        throw new Error('fixture scanner source syntax is unavailable');
    }
    const aliases = new Map();
    const views = [];
    function staticText(node, seen = new Set())
    {
        if (!node)
        {
            return null;
        }
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        {
            return node.text;
        }
        if (ts.isIdentifier(node))
        {
            if (seen.has(node.text))
            {
                return null;
            }
            if (!aliases.has(node.text))
            {
                return node.text;
            }
            return staticText(aliases.get(node.text), new Set([...seen, node.text]));
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
        {
            const left = staticText(node.left, seen);
            const right = staticText(node.right, seen);
            return left === null || right === null ? null : left + right;
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        {
            const owner = staticText(node.expression, seen);
            const member = ts.isPropertyAccessExpression(node) ? node.name.text : staticText(node.argumentExpression, seen);
            return owner === null || member === null ? null : `${owner}.${member}`;
        }
        return null;
    }
    function visit(node)
    {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        {
            aliases.set(node.name.text, node.initializer);
            views.push({ text: `${node.name.text}=${node.initializer.getText(tree)}`, start: node.getStart(tree),
                syntaxContext: ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)
                    ? 'literal-data' : 'executable-expression' });
        }
        if (ts.isCallExpression(node))
        {
            const name = staticText(node.expression);
            views.push({ text: `${name ?? node.expression.getText(tree)}(${node.arguments.map((argument) => staticText(argument) ?? argument.getText(tree)).join(',')})`, start: node.getStart(tree) });
        }
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        {
            views.push({ text: `${staticText(node.left) ?? node.left.getText(tree)}=${node.right.getText(tree)}`, start: node.getStart(tree) });
        }
        // Literal SQL and configured entry points are relevant; comments are not.
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        {
            views.push({ text: node.text, start: node.getStart(tree), syntaxContext: 'literal-data' });
        }
        ts.forEachChild(node, visit);
    }
    visit(tree);
    return views;
}

/** Candidate source findings only. This scanner cannot qualify cleanup or runtime parity. */
export function scanAccountAuthFixtureSources(domain, sources)
{
    requireDomain(domain);
    const violations = [];
    const identities = new Set();
    for (const item of sources)
    {
        if (!item || typeof item.path !== 'string' || typeof item.source !== 'string'
            || item.path.startsWith('/') || item.path.split(/[\\/]/u).includes('..') || identities.has(item.path))
        {
            throw new Error('fixture scanner requires unique repository-relative source paths');
        }
        identities.add(item.path);
        let views;
        try
        {
            views = /\.(?:[cm]?js|tsx?)$/u.test(item.path)
                ? javascriptViews(item.source, item.path) : [{ text: item.source, start: 0 }];
        }
        catch
        {
            violations.push({ ruleId: 'source-syntax-unavailable', path: item.path, line: 1 });
            continue;
        }
        const patterns = [...commonPatterns, ...domainPatterns[domain],
            ['manual-browser-storage', /\b(?:localStorage|sessionStorage)\.(?:setItem|removeItem|clear)\s*\(/gu],
            ['manual-cookie', /\b(?:document\.cookie\s*=|[\w.]+\.addCookies\s*\(|[\w.]+\.Cookie\s*=)/gu],
            ['ordinary-secret-output', /\b(?:console\.(?:log|error|warn)|writeFile(?:Sync)?|process\.env\.[\w]+\s*=)[^\n]*(?:accessToken|refreshToken|privateKey|recoveryCode|proofSecret|credentialSecret)/gu]];
        for (const view of views)
        {
            for (const [ruleId, pattern] of patterns)
            {
                for (const match of view.text.matchAll(pattern))
                {
                    const offset = /\.(?:[cm]?js|tsx?)$/u.test(item.path) ? view.start : view.start + match.index;
                    const line = item.source.slice(0, offset).split('\n').length;
                    violations.push({ ruleId, path: item.path, line,
                        sourceCategory: /(?:^docs\/|\.md$)/u.test(item.path) ? 'documentation'
                            : item.path.startsWith('tests/') ? 'test-source'
                                : item.path.startsWith('config/') ? 'configuration' : 'active-source',
                        syntaxContext: view.syntaxContext ?? (/\.(?:[cm]?js|tsx?)$/u.test(item.path) ? 'executable-expression' : 'text') });
                }
            }
        }
    }
    const unique = new Map(violations.map((item) => [`${item.path}\0${item.line}\0${item.ruleId}\0${item.syntaxContext ?? "text"}`, item]));
    return freezeDeep({ domain, phase: 'source-pattern-scan', sourceDigest: digestCanonical(sources),
        scannedFiles: sources.length, violations: [...unique.values()].sort((left, right) =>
            left.path.localeCompare(right.path) || left.line - right.line || left.ruleId.localeCompare(right.ruleId) || String(left.syntaxContext).localeCompare(String(right.syntaxContext))) });
}

/** Enumerate actual Git sources, including new files; never follow a worktree symlink. */
export function inspectAccountAuthFixtureRepository(domain, repositoryRoot = root)
{
    requireDomain(domain);
    const rootStat = lstatSync(repositoryRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    {
        throw new Error('fixture scanner requires a regular repository root');
    }
    const listing = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
    });
    if (listing.status !== 0)
    {
        throw new Error('fixture scanner cannot enumerate current repository sources');
    }
    const sources = [];
    const blockers = [];
    for (const relativePath of [...new Set(listing.stdout.split('\0').filter(Boolean))].sort())
    {
        if (!sourceExtensions.has(path.extname(relativePath)))
        {
            continue;
        }
        const absolute = path.join(repositoryRoot, relativePath);
        let unsafeAncestor = false;
        let directory = repositoryRoot;
        for (const component of relativePath.split('/').slice(0, -1))
        {
            directory = path.join(directory, component);
            try
            {
                const ancestor = lstatSync(directory);
                if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
                {
                    unsafeAncestor = true;
                    break;
                }
            }
            catch
            {
                unsafeAncestor = true;
                break;
            }
        }
        if (unsafeAncestor)
        {
            blockers.push({ code: 'source-ancestor-not-regular-directory', path: relativePath });
            continue;
        }
        let stat;
        try
        {
            stat = lstatSync(absolute);
        }
        catch
        {
            blockers.push({ code: 'source-unavailable', path: relativePath });
            continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
        {
            blockers.push({ code: 'source-not-bounded-regular-file', path: relativePath });
            continue;
        }
        sources.push({ path: relativePath, source: readFileSync(absolute, 'utf8') });
    }
    const scanned = scanAccountAuthFixtureSources(domain, sources);
    const inventoryPath = domain === 'auth-fixture'
        ? 'config/testing/auth-fixture-ownership.json' : domain === 'auth-truth'
            ? 'config/testing/auth-truth-consumers.json' : 'config/testing/account-locale-fixture-ownership.json';
    if (!sources.some((source) => source.path === inventoryPath))
    {
        blockers.push({ code: 'ownership-or-consumer-inventory-unavailable', path: inventoryPath });
    }
    else if (domain === 'account-locale')
    {
        try
        {
            assertAccountLocaleOwnershipCurrent(repositoryRoot);
        }
        catch
        {
            blockers.push({ code: 'ownership-inventory-stale-or-invalid', path: inventoryPath });
        }
    }
    // The cutover issues are deletion/consumer owners, not invented aggregate
    // APIs. Existing CleanupAsync/cleanupPrivate calls do not supply independent
    // cleanup completion readback. Source findings never authorize retirement.
    blockers.push({ code: 'canonical-cleanup-completion-verifier-unavailable',
        canonicalProducerId: domain === 'account-locale' ? 'account-profile-preferences' : 'auth-session',
        cutoverIssue: domain === 'auth-fixture' ? 2680 : domain === 'auth-truth' ? 2694 : 2688 });
    return freezeDeep({ ...scanned, status: 'blocked', blockers });
}

export function printAccountAuthFixtureSourceReport(domain)
{
    try
    {
        const report = inspectAccountAuthFixtureRepository(domain);
        process.stdout.write(`${JSON.stringify(report)}\n`);
    }
    catch
    {
        process.stderr.write('account/auth fixture source scan failed; no acceptance receipt was issued\n');
    }
    process.exitCode = 1;
}
