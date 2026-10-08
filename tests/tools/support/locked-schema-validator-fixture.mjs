import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const packagePath = 'tools/test-matrix/schema-validator';

function literalTree(directory)
{
    const files = [];
    function visit(file)
    {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || fs.realpathSync(file) !== file)
        {
            throw new Error(`schema validator fixture dependency must be literal: ${file}`);
        }
        if (stat.isDirectory())
        {
            for (const name of fs.readdirSync(file))
            {
                visit(path.join(file, name));
            }
        }
        else if (stat.isFile() && stat.nlink === 1)
        {
            files.push(file);
        }
        else
        {
            throw new Error(`schema validator fixture dependency must be a single-link regular file: ${file}`);
        }
    }
    visit(directory);
    return files;
}

// npm's content-addressed cache supplies only lock-selected, integrity-checked tarballs.
// The installer uses a fresh private cache and disables network and lifecycle scripts.
const seedCache = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { createRequire } = require('node:module');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "const cache = createRequire(input.npmCli)('cacache');",
    '(async () => {',
    '  for (const entry of input.entries) {',
    "    const bytes = await cache.get.byDigest(path.join(input.sourceCache, '_cacache'), entry.integrity);",
    "    await cache.put(path.join(input.targetCache, '_cacache'), entry.resolved, bytes, { integrity: entry.integrity });",
    '  }',
    '})().catch(error => { console.error(error.message); process.exitCode = 1; });'
].join('\n');

export function provisionLockedSchemaValidator(fixtureRoot, { npmCache } = {})
{
    const directory = path.resolve(fixtureRoot, packagePath);
    if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory())
    {
        throw new Error('schema validator fixture package must be a literal directory');
    }
    const readMetadata = (name) =>
    {
        const file = path.join(directory, name);
        if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file)
        {
            throw new Error('schema validator fixture metadata must be literal regular files');
        }
        return fs.readFileSync(file);
    };
    const manifestBytes = readMetadata('package.json');
    const lockBytes = readMetadata('package-lock.json');
    const manifest = JSON.parse(manifestBytes);
    const lock = JSON.parse(lockBytes);
    if (lock.lockfileVersion !== 3 || manifest.name !== lock.name
        || manifest.version !== lock.version
        || JSON.stringify(manifest.dependencies) !== JSON.stringify(lock.packages?.['']?.dependencies))
    {
        throw new Error('schema validator fixture manifest and lock disagree');
    }
    const entries = Object.entries(lock.packages).filter(([name]) => name !== '');
    if (entries.length === 0 || entries.some(([name, entry]) =>
        !/^node_modules\/(?:@[a-z\d._-]+\/)?[a-z\d._-]+$/u.test(name)
        || entry.link || !/^https:\/\/registry\.npmjs\.org\//u.test(entry.resolved ?? '')
        || !/^sha512-[A-Za-z\d+/]{86}==$/u.test(entry.integrity ?? '')))
    {
        throw new Error('schema validator fixture requires a closed integrity-bound registry lock');
    }
    const npmExecutable = process.env.npm_execpath || (process.env.PATH ?? '').split(path.delimiter)
        .map((item) => path.join(item, process.platform === 'win32' ? 'npm.cmd' : 'npm'))
        .find((item) => fs.existsSync(item));
    if (!npmExecutable)
    {
        throw new Error('schema validator fixture requires npm tooling');
    }
    let npmCli = fs.realpathSync(npmExecutable);
    if (npmCli.endsWith('.cmd'))
    {
        npmCli = path.join(path.dirname(npmCli), 'node_modules/npm/bin/npm-cli.js');
    }
    if (!fs.lstatSync(npmCli).isFile() || fs.realpathSync(npmCli) !== npmCli)
    {
        throw new Error('schema validator fixture npm CLI must be a literal regular file');
    }
    const sourceCache = npmCache ?? process.env.npm_config_cache
        ?? execFileSync(process.execPath, [npmCli, 'config', 'get', 'cache', '--logs-max=0'], { encoding: 'utf8' }).trim();
    const destination = path.join(directory, 'node_modules');
    if (fs.existsSync(destination) || fs.lstatSync(destination, { throwIfNoEntry: false }))
    {
        literalTree(destination);
    }
    const stage = fs.mkdtempSync(path.join(directory, '.fixture-npm-'));
    try
    {
        fs.writeFileSync(path.join(stage, 'package.json'), manifestBytes);
        fs.writeFileSync(path.join(stage, 'package-lock.json'), lockBytes);
        fs.writeFileSync(path.join(stage, 'user.npmrc'), '');
        fs.writeFileSync(path.join(stage, 'global.npmrc'), '');
        const environment = {
            PATH: process.env.PATH ?? '',
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
            TMPDIR: stage, TMP: stage, TEMP: stage
        };
        const targetCache = path.join(stage, 'cache');
        execFileSync(process.execPath, ['-e', seedCache], {
            input: JSON.stringify({ npmCli, sourceCache, targetCache, entries: entries.map(([, entry]) => entry) }),
            env: environment, stdio: ['pipe', 'pipe', 'pipe']
        });
        execFileSync(process.execPath, [npmCli, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
            '--update-notifier=false', '--logs-max=0', '--cache', targetCache,
            '--userconfig', path.join(stage, 'user.npmrc'), '--globalconfig', path.join(stage, 'global.npmrc')],
        { cwd: stage, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
        const installed = path.join(stage, 'node_modules');
        literalTree(installed);
        const installedLock = JSON.parse(fs.readFileSync(path.join(installed, '.package-lock.json'), 'utf8'));
        if (JSON.stringify(installedLock.packages) !== JSON.stringify(Object.fromEntries(entries)))
        {
            throw new Error('schema validator fixture installed dependency roster differs from lock');
        }
        if (fs.existsSync(destination))
        {
            fs.renameSync(destination, path.join(stage, 'previous-node_modules'));
        }
        fs.renameSync(installed, destination);
        return literalTree(destination).map((file) => path.relative(fixtureRoot, file).replaceAll(path.sep, '/'));
    }
    catch (error)
    {
        const previous = path.join(stage, 'previous-node_modules');
        if (!fs.existsSync(destination) && fs.existsSync(previous))
        {
            fs.renameSync(previous, destination);
        }
        throw new Error('schema validator fixture locked dependency provisioning failed; warm the source npm cache with npm ci --ignore-scripts --prefix tools/test-matrix/schema-validator', { cause: error });
    }
    finally
    {
        fs.rmSync(stage, { recursive: true, force: true });
    }
}
