import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directories = [
    'src/shared/Contracts/ArticleVault/Dependencies',
    'src/backend/Services/ArticleVault/Assets'
];
const prohibited = [
    ['remote-fetch', /\b(?:HttpClient|WebClient|HttpWebRequest|WebRequest|HttpRequestMessage)\b/],
    ['direct-storage', /\b(?:File|Directory|FileStream|DirectoryInfo|FileInfo|Path)\s*\./],
    ['direct-ledger', /\b(?:SqlSugar|ISqlSugarClient|DbContext|DbConnection|NpgsqlConnection|ContentAssetReference)\b/],
    ['rendered-scan', /\b(?:HtmlDocument|HtmlParser|IElement|querySelector|innerHTML|outerHTML)\b/],
    ['second-index', /\b(?:ConcurrentDictionary|IMemoryCache|IDistributedCache)\b/],
    ['string-target', /\bstring\??\s+(?:Target|AssetIdentity|AnchorId|TargetKind|Mode)\s*[,);{]/]
];

/** Audits these adapters only; a static check never qualifies runtime authority, permissions or native IO. */
export function inspectDependencySource(source, file)
{
    const errors = [];
    for (const [reason, pattern] of prohibited)
    {
        if (pattern.test(source))
        {
            errors.push(`${file}: article-vault-dependency-${reason}`);
        }
    }
    return errors;
}

export function checkDependencyBoundary(repositoryRoot = root)
{
    const errors = [];
    for (const directory of directories)
    {
        const absolute = path.join(repositoryRoot, directory);
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true }))
        {
            if (entry.name.endsWith('.cs'))
            {
                if (!entry.isFile())
                {
                    errors.push(`${directory}/${entry.name}: article-vault-dependency-nonregular-source`);
                    continue;
                }
                errors.push(...inspectDependencySource(fs.readFileSync(path.join(absolute, entry.name), 'utf8'), `${directory}/${entry.name}`));
            }
        }
    }
    return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    if (process.argv.length !== 2)
    {
        throw new Error('article-vault-dependency-boundary-arguments-invalid');
    }
    const errors = checkDependencyBoundary();
    if (errors.length)
    {
        console.error(errors.join('\n'));
        process.exitCode = 1;
    }
    else
    {
        console.log('Article Vault dependency adapter static boundaries passed; runtime qualification remains separate.');
    }
}
