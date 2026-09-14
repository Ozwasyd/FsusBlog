import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const sources = [
    'src/frontend/src/router/appRouteRecords.ts',
    'src/frontend/src/public-renderers/publicRouteRegistry.ts',
    'src/frontend/src/composables/useSessionBootstrap.ts'
];

const frontendSourceRoot = resolve(root, 'src/frontend/src');
const frontendSources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
{
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory())
    {
        return frontendSources(entryPath);
    }
    return /\.(?:ts|vue)$/u.test(entry.name) ? [entryPath] : [];
});

const retiredResolver = resolve(root, 'src/frontend/src/locales/routeTitles.ts');
if (existsSync(retiredResolver))
{
    throw new Error('route title compatibility resolver must be removed');
}

for (const source of sources)
{
    const content = readFileSync(resolve(root, source), 'utf8');
    if (/resolveRouteTitleKey|routeTitleKeys|meta:\s*\{[^}]*\btitle\s*:/su.test(content))
    {
        throw new Error(`${source} retains a raw route title compatibility path`);
    }
    if (/titleKey:\s*['"][^'"]*AriaLabel['"]/u.test(content))
    {
        throw new Error(`${source} uses aria copy as a page title contract`);
    }
}

const titleContract = readFileSync(
    resolve(root, 'src/frontend/src/router/routeTitleContract.ts'),
    'utf8'
);
if (!/export type RouteTitleKey = Extract</u.test(titleContract)
  || !/must use a dedicated RouteTitleKey/u.test(titleContract))
{
    throw new Error('route title contract must expose and enforce dedicated RouteTitleKey');
}

for (const source of frontendSources(frontendSourceRoot))
{
    const content = readFileSync(source, 'utf8');
    if (/new\s+Map\s*<\s*string\s*,\s*TranslationKey\s*>/u.test(content))
    {
        throw new Error(`${source} introduces a display-title-to-key map`);
    }
}

process.stdout.write('route-title-contract: ok\n');
