import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const playwrightSessionModes = Object.freeze({
    legacyParallel: 'legacy-parallel',
    browserContract: 'browser-contract',
    browserDiagnostics: 'browser-diagnostics'
});

const supportedSessionModes = new Set(Object.values(playwrightSessionModes));

function sanitizeSegment(value, fallback)
{
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    return !normalized || normalized === '.' || normalized === '..' ? fallback : normalized;
}

function resolveConfiguredRoot(configured, repoRoot)
{
    if (!configured)
    {
        return null;
    }
    return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(repoRoot, configured);
}

export function resolvePlaywrightSessionMode(env = process.env)
{
    const mode = String(env.FSUSBLOG_PLAYWRIGHT_SESSION_MODE || playwrightSessionModes.legacyParallel).trim();
    if (!supportedSessionModes.has(mode))
    {
        throw new Error(
            `FSUSBLOG_PLAYWRIGHT_SESSION_MODE must be one of ${[...supportedSessionModes].join(', ')}, got ${mode || '(empty)'}`
        );
    }
    return mode;
}

export function resolveFixtureNamespace(env = process.env)
{
    const mode = resolvePlaywrightSessionMode(env);
    const configured = String(env.FSUSBLOG_TEST_NAMESPACE || '').trim();
    if (mode !== playwrightSessionModes.legacyParallel && !configured)
    {
        throw new Error(`FSUSBLOG_TEST_NAMESPACE is required for ${mode} fixtures`);
    }
    return sanitizeSegment(configured, 'local');
}

export function resolveFixtureRoot({ env = process.env, repoRoot = defaultRepoRoot } = {})
{
    const mode = resolvePlaywrightSessionMode(env);
    const namespace = resolveFixtureNamespace(env);
    const configured = resolveConfiguredRoot(env.FSUSBLOG_FIXTURE_ROOT, repoRoot);
    if (configured)
    {
        return configured;
    }

    if (mode === playwrightSessionModes.browserContract)
    {
        return path.join(repoRoot, '.tmp', 'browser-contract', 'fixtures', namespace);
    }
    if (mode === playwrightSessionModes.browserDiagnostics)
    {
        return path.join(repoRoot, '.tmp', 'browser-diagnostics', 'fixtures', namespace);
    }
    return path.join(repoRoot, '.tmp', 'fixtures', namespace);
}

export function resolvePublicFixtureFile(options = {})
{
    const env = options.env ?? process.env;
    return env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE
        ? path.resolve(env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE)
        : path.join(resolveFixtureRoot({ ...options, env }), 'public-content-projection.json');
}

export function resolveFixtureAssetDirectory(options = {})
{
    return path.join(resolveFixtureRoot(options), 'assets');
}

export function resolveAuthFixtureDirectory(options = {})
{
    return path.join(resolveFixtureRoot(options), 'auth');
}

export function resolveAuthFixtureManifest(options = {})
{
    return path.join(resolveAuthFixtureDirectory(options), 'auth-fixtures.json');
}

export function resolveSessionFixtureDirectory(options = {})
{
    return path.join(resolveFixtureRoot(options), 'sessions');
}

export function resolveSessionFixtureFile(session, options = {})
{
    return path.join(
        resolveSessionFixtureDirectory(options),
        `${sanitizeSegment(session, 'pw-0')}.aeds`
    );
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain)
{
    process.stdout.write(`${resolveFixtureRoot()}\n`);
}
