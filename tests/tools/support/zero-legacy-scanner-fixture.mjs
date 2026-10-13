import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const parserInputPaths = Object.freeze([
    'src/frontend/package.json',
    'src/frontend/package-lock.json',
    'src/frontend/node_modules/playwright-core/package.json',
    'src/frontend/node_modules/playwright-core/lib/utilsBundleImpl/index.js',
    'src/frontend/node_modules/typescript/package.json',
    'src/frontend/node_modules/typescript/lib/typescript.js'
]);

export function createZeroLegacyScannerFixture(files)
{
    if (!files || typeof files !== 'object'
        || ![Object.prototype, null].includes(Object.getPrototypeOf(files))
        || Object.getOwnPropertySymbols(files).length !== 0)
    {
        throw new Error('scanner fixture requires a plain file map');
    }
    const inputEntries = Object.entries(Object.getOwnPropertyDescriptors(files)).map(([relative, descriptor]) =>
    {
        if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
            || !relative || isAbsolute(relative) || relative.includes('\\')
            || relative.split('/').some((part) => !part || part === '.' || part === '..')
            || parserInputPaths.includes(relative))
        {
            throw new Error('scanner fixture file identity is invalid');
        }
        return [relative, Buffer.from(descriptor.value, 'utf8')];
    });
    const parserEntries = parserInputPaths.map((relative) =>
    {
        const absolute = join(repositoryRoot, relative);
        if (realpathSync(absolute) !== absolute)
        {
            throw new Error('scanner fixture parser input is not canonical');
        }
        return [relative, readFileSync(absolute)];
    });
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'fsusblog-owned-scanner-fixture-'));
    const dispose = () => rmSync(root, { recursive: true, force: true });
    try
    {
        for (const [relative, content] of [...parserEntries, ...inputEntries])
        {
            const absolute = join(root, relative);
            mkdirSync(dirname(absolute), { recursive: true });
            writeFileSync(absolute, content, { flag: 'wx' });
            if (parserInputPaths.includes(relative))
            {
                chmodSync(absolute, 0o644);
            }
            if (!readFileSync(absolute).equals(content))
            {
                throw new Error('scanner fixture write readback mismatch');
            }
        }
        return Object.freeze({ root, dispose });
    }
    catch (error)
    {
        dispose();
        throw error;
    }
}
