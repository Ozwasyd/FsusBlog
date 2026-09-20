import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const parserRoot = fileURLToPath(new URL('./javascript-format-parser/', import.meta.url));
const requireParser = createRequire(new URL('./javascript-format-parser/package.json', import.meta.url));
let parser;
let loadedTreeDigest;

const entryPaths = {
    espree: 'dist/espree.cjs',
    acorn: 'dist/acorn.js',
    'acorn-jsx': 'index.js',
    'eslint-visitor-keys': 'dist/eslint-visitor-keys.cjs'
};

function regularEntry(path)
{
    if (realpathSync(path) !== path || !lstatSync(path).isFile())
    {
        throw new Error('JavaScript parser entry must be a canonical regular file');
    }
    return path;
}

function packageTreeDigest(directory, hash)
{
    for (const name of readdirSync(directory).sort())
    {
        const path = resolve(directory, name);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink())
        {
            throw new Error('JavaScript parser package contains a symlink');
        }
        hash.update(path).update('\0');
        if (stat.isDirectory())
        {
            packageTreeDigest(path, hash);
        }
        else if (stat.isFile())
        {
            hash.update(readFileSync(path)).update('\0');
        }
        else
        {
            throw new Error('JavaScript parser package contains a non-regular entry');
        }
    }
}

function canonicalParser()
{
    const lock = JSON.parse(readFileSync(resolve(parserRoot, 'package-lock.json'), 'utf8'));
    const expectedPackages = Object.keys(entryPaths).map((name) => `node_modules/${name}`).sort();
    if (JSON.stringify(Object.keys(lock.packages).filter(Boolean).sort()) !== JSON.stringify(expectedPackages))
    {
        throw new Error('unexpected JavaScript format parser dependency roster');
    }
    const tree = createHash('sha256').update(JSON.stringify(lock));
    for (const [relative, entry] of Object.entries(lock.packages))
    {
        if (!relative)
        {
            continue;
        }
        if (!/^node_modules\/(?:espree|acorn|acorn-jsx|eslint-visitor-keys)$/u.test(relative))
        {
            throw new Error('unexpected JavaScript format parser dependency');
        }
        const directory = resolve(parserRoot, relative);
        if (realpathSync(directory) !== directory)
        {
            throw new Error('JavaScript format parser dependency must be local');
        }
        const name = relative.slice('node_modules/'.length);
        const installed = JSON.parse(readFileSync(regularEntry(resolve(directory, 'package.json')), 'utf8'));
        if (installed.name !== name || installed.version !== entry.version)
        {
            throw new Error('JavaScript format parser dependency differs from trusted lock');
        }
        const localRequire = createRequire(resolve(directory, 'package.json'));
        for (const dependency of new Set([name, ...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {})]))
        {
            if (!Object.hasOwn(entryPaths, dependency))
            {
                throw new Error('unexpected parser transitive dependency');
            }
            const expectedEntry = regularEntry(resolve(parserRoot, `node_modules/${dependency}`, entryPaths[dependency]));
            if (regularEntry(localRequire.resolve(dependency)) !== expectedEntry)
            {
                throw new Error('JavaScript parser dependency entry redirected');
            }
        }
        packageTreeDigest(directory, tree);
    }
    const entry = regularEntry(requireParser.resolve('espree'));
    if (entry !== resolve(parserRoot, 'node_modules/espree', entryPaths.espree))
    {
        throw new Error('JavaScript format parser must resolve from its trusted tool directory');
    }
    const digest = tree.digest('hex');
    if (parser)
    {
        if (digest !== loadedTreeDigest)
        {
            throw new Error('JavaScript parser authority changed after loading');
        }
        return parser;
    }
    parser = requireParser(entry);
    loadedTreeDigest = digest;
    return parser;
}

function withoutLocations(value)
{
    if (Array.isArray(value))
    {
        return value.map(withoutLocations);
    }
    if (value && typeof value === 'object')
    {
        return Object.fromEntries(Object.entries(value)
            .filter(([key]) => !['start', 'end', 'loc', 'range', 'comments', 'tokens'].includes(key))
            .map(([key, child]) => [key, withoutLocations(child)]));
    }
    return typeof value === 'bigint' ? { bigintValue: value.toString() } : value;
}

export function javascriptFormatFingerprint(source, path)
{
    if (Buffer.byteLength(source, 'utf8') > 16 * 1024 * 1024)
    {
        throw new Error('JavaScript format input exceeds limit');
    }
    const ast = canonicalParser().parse(source, {
        ecmaVersion: 2025,
        sourceType: path.endsWith('.cjs') ? 'commonjs' : 'module',
        tokens: true,
        comment: true,
        loc: true,
        range: true
    });
    const tokens = ast.tokens;
    const gap = (left, right) => Math.min(2, right - left);
    let followingToken = 0;
    const comments = ast.comments.map((comment) =>
    {
        while (followingToken < tokens.length && tokens[followingToken].range[0] < comment.range[1])
        {
            followingToken += 1;
        }
        const next = followingToken < tokens.length ? followingToken : -1;
        const previous = next < 0 ? tokens.length - 1 : next - 1;
        return {
            type: comment.type,
            value: comment.value,
            previous,
            next,
            previousLineGap: previous < 0 ? null : gap(tokens[previous].loc.end.line, comment.loc.start.line),
            nextLineGap: next < 0 ? null : gap(comment.loc.end.line, tokens[next].loc.start.line)
        };
    });
    return JSON.stringify({
        ast: withoutLocations(ast),
        tokens: tokens.map((token) => ({ type: token.type, raw: source.slice(...token.range) })),
        comments
    });
}
