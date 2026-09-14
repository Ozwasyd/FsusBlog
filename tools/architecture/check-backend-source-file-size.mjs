#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const maxExclusive = 1500;
const components = [
    {
        id: 'search-index',
        roots: ['src/backend/Services/SearchIndexService.cs'],
        minimumFiles: 5
    },
    {
        id: 'schema-migration-registry',
        roots: [
            'src/migration/SchemaMigrationRegistry.cs',
            'src/migration/SchemaMigrationManifest.cs'
        ],
        directories: [
            'src/migration/Catalogs',
            'src/migration/Definitions'
        ],
        minimumFiles: 13
    },
    {
        id: 'theme-registry',
        roots: [],
        directories: [
            'src/backend/Infrastructure/Themes'
        ],
        minimumFiles: 5
    },
    {
        id: 'authoring-workflow',
        roots: [
            'src/backend/Services/Authoring/AuthoringAnalyticsReadService.cs',
            'src/backend/Services/Authoring/AuthoringAssetLibraryService.cs',
            'src/backend/Services/Authoring/AuthoringDraftLifecycleService.cs',
            'src/backend/Services/Authoring/AuthoringContentTransferService.cs',
            'src/backend/Services/Authoring/AuthoringModerationWorkflowService.cs',
            'src/backend/Services/Authoring/AuthoringPolicies.cs',
            'src/backend/Services/Authoring/AuthoringUseCasePorts.cs'
        ],
        minimumFiles: 7
    },
    {
        id: 'authoring-endpoints',
        roots: ['src/backend/Modules/Endpoints/AuthoringEndpoints.cs'],
        minimumFiles: 4
    },
    {
        id: 'article-service',
        roots: ['src/backend/Services/ArticleService.cs'],
        minimumFiles: 3
    },
    {
        id: 'public-hot-read',
        roots: [
            'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs',
            'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs'
        ],
        minimumFiles: 4
    },
    {
        id: 'web-application-composition',
        roots: [
            'src/backend/Infrastructure/Bootstrap/WebApplicationCompositionExtensions.cs',
            'src/backend/Infrastructure/Bootstrap/PublicWebRuntime.cs',
            'src/backend/Infrastructure/Bootstrap/PublicWebRuntime.HtmlMaterialization.cs'
        ],
        minimumFiles: 2
    }
];

function countLines(source)
{
    if (source.length === 0)
    {
        return 0;
    }
    const newlineCount = source.match(/\n/gu)?.length ?? 0;
    return source.endsWith('\n') ? newlineCount : newlineCount + 1;
}

function componentFiles(component)
{
    const selected = new Set();
    for (const rootPath of component.roots)
    {
        const absoluteRoot = resolve(root, rootPath);
        const directory = dirname(absoluteRoot);
        const rootName = basename(absoluteRoot, '.cs');
        for (const entry of readdirSync(directory, { withFileTypes: true }))
        {
            if (!entry.isFile() || !entry.name.endsWith('.cs'))
            {
                continue;
            }
            const entryName = basename(entry.name, '.cs');
            if (entryName === rootName || entryName.startsWith(`${rootName}.`))
            {
                selected.add(resolve(directory, entry.name));
            }
        }
    }
    for (const directoryPath of component.directories ?? [])
    {
        const directory = resolve(root, directoryPath);
        for (const entry of readdirSync(directory, { withFileTypes: true }))
        {
            if (entry.isFile() && entry.name.endsWith('.cs'))
            {
                selected.add(resolve(directory, entry.name));
            }
        }
    }
    return [...selected].sort();
}

const errors = [];
const report = [];
for (const component of components)
{
    const files = componentFiles(component);
    if (files.length < component.minimumFiles)
    {
        errors.push(`${component.id}: expected at least ${component.minimumFiles} capability files, found ${files.length}`);
    }

    const fileReports = files.map((path) => ({
        path: relative(root, path).replace(/\\/gu, '/'),
        lines: countLines(readFileSync(path, 'utf8'))
    }));
    for (const file of fileReports)
    {
        if (file.lines >= maxExclusive)
        {
            errors.push(`${component.id}: ${file.path} has ${file.lines} lines; required < ${maxExclusive}`);
        }
    }
    report.push({
        id: component.id,
        files: fileReports,
        maximumLines: Math.max(0, ...fileReports.map((file) => file.lines))
    });
}

if (process.argv.includes('--json'))
{
    process.stdout.write(`${JSON.stringify({
        schema: 'fsusblog.backend-source-file-size.v1',
        status: errors.length === 0 ? 'success' : 'failed',
        maxExclusive,
        components: report,
        errors
    }, null, 2)}\n`);
}
else if (errors.length === 0)
{
    process.stdout.write(`backend source file size governance passed: ${report.length} components, every capability file < ${maxExclusive} lines\n`);
}

if (errors.length > 0)
{
    for (const error of errors)
    {
        process.stderr.write(`[backend-source-file-size] ${error}\n`);
    }
    process.exitCode = 1;
}
