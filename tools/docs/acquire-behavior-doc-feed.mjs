#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { sealSourceIdentity } = await import(new URL('../fact-extractors/identity.mjs', import.meta.url));
const { behaviorDocNugetClosure, inventoryNugetOfflineFeed, inventoryPreparedNuget, validatePreparedNugetPackages } = await import(new URL('../test/behavior-doc-nuget-preparation.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = process.env.FSUSBLOG_TEST_RUN_ID;
if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(runId ?? ''))
{
    throw new Error('Explicit run identity required');
}
const source = sealSourceIdentity(root);
const closure = behaviorDocNugetClosure(root);
const parent = path.join(root, '.tmp/behavior-doc-feed-acquisition');
fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
if (fs.realpathSync(parent) !== parent)
{
    throw new Error('Acquisition parent is not canonical');
}
const attempt = fs.mkdtempSync(path.join(parent, `${runId}-`));
const packages = path.join(attempt, 'packages');
const artifacts = path.join(attempt, 'artifacts');
const feed = path.join(attempt, 'feed');
fs.mkdirSync(packages, { mode: 0o700 });
const result = spawnSync('dotnet', ['restore', 'tools/contracts/BehaviorDocRestore.slnx', '--locked-mode',
    '--packages', packages, '--artifacts-path', artifacts, '--configfile', 'config/build/backend-restore.xml',
    '/p:NuGetAudit=false', '/p:Configuration=Release', '--disable-parallel'], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0 || result.signal)
{
    throw new Error('Locked acquisition failed', { cause: result.error });
}
if (JSON.stringify(source) !== JSON.stringify(sealSourceIdentity(root)))
{
    throw new Error('Source drift during acquisition');
}
function seal(directory)
{
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory())
        {
            seal(file);
        }
        else if (entry.isFile())
        {
            fs.chmodSync(file, 0o444);
        }
        else
        {
            throw new Error('Non-regular acquired package input');
        }
    }
    fs.chmodSync(directory, 0o555);
}
seal(packages);
validatePreparedNugetPackages(inventoryPreparedNuget(packages), closure);
fs.mkdirSync(feed, { mode: 0o700 });
for (const record of closure.packages)
{
    const [id, version] = record.path.split('/');
    const name = `${id}.${version}.nupkg`;
    fs.copyFileSync(path.join(packages, record.path, name), path.join(feed, name), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(feed, name), 0o444);
}
fs.chmodSync(feed, 0o555);
const inventory = inventoryNugetOfflineFeed(feed, closure);
if (JSON.stringify(source) !== JSON.stringify(sealSourceIdentity(root)))
{
    throw new Error('Source drift before feed handoff');
}
fs.writeFileSync(path.join(attempt, 'acquisition.json'), JSON.stringify({
    schema: 'fsusblog.behavior-doc-feed-acquisition.v1', runId, source,
    sourceClosureDigests: closure.sourceClosureDigests, feedRoot: feed, feedDigest: inventory.treeDigest
}, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
if (!process.env.GITHUB_OUTPUT)
{
    throw new Error('Explicit output channel required');
}
fs.appendFileSync(process.env.GITHUB_OUTPUT, `feed_root=${feed}\nfeed_digest=${inventory.treeDigest}\n`);
