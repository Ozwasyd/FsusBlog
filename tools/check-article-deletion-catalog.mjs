import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'docs/architecture/article-deletion-data-catalog.json');
const kernelPath = path.join(root, 'src/backend/Services/Articles/ArticleDeletionKernel.cs');
const lifecyclePath = path.join(root, 'src/backend/Services/ArticleService.LifecycleAndReadModels.cs');

const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const kernel = fs.readFileSync(kernelPath, 'utf8');
const lifecycle = fs.readFileSync(lifecyclePath, 'utf8');
const allowedPolicies = new Set(['delete', 'nullify', 'preserve', 'async_cleanup']);
const requiredRelations = [
    'article',
    'article_body',
    'article_draft',
    'article_revision',
    'article_publication',
    'article_responsibility_snapshot',
    'article_rights_policy',
    'article_rights_snapshot',
    'article_rights_proof',
    'article_publish_proof',
    'content_asset',
    'content_asset_reference:article',
    'content_asset_reference:draft',
    'content_asset_reference:revision',
    'content_asset_cleanup_queue',
    'article_mutation_outbox',
    'local illustration file'
];
const retiredAssetRelations = [
    'article_asset_reference:article',
    'article_asset_reference:draft',
    'article_asset_reference:revision',
    'article_asset_cleanup_queue',
    'asset_library_article_ref',
    'asset_library_item.source_article_id'
];

const failures = [];
if (catalog.schemaVersion !== 1 || catalog.issue !== 1217)
{
    failures.push('catalog identity is invalid');
}
if (!Array.isArray(catalog.relations) || catalog.relations.length === 0)
{
    failures.push('catalog relations are empty');
}

const byName = new Map();
for (const relation of catalog.relations ?? [])
{
    if (!relation?.name || byName.has(relation.name))
    {
        failures.push(`duplicate or empty relation: ${relation?.name ?? '<empty>'}`);
    }
    byName.set(relation.name, relation);
    if (!allowedPolicies.has(relation.policy))
    {
        failures.push(`invalid policy for ${relation.name}: ${relation.policy}`);
    }
    if (!relation.reason?.trim())
    {
        failures.push(`missing reason for ${relation.name}`);
    }
}
for (const required of requiredRelations)
{
    if (!byName.has(required))
    {
        failures.push(`required relation is uncatalogued: ${required}`);
    }
}
for (const retired of retiredAssetRelations)
{
    if (byName.has(retired))
    {
        failures.push(`retired asset relation is still catalogued: ${retired}`);
    }
}

for (const table of ['article', 'article_body', 'article_draft', 'article_tag', 'public_article_projection', 'article_public_taxonomy_projection', 'article_view_seed'])
{
    if (byName.get(table)?.policy !== 'delete')
    {
        failures.push(`${table} must use delete policy`);
    }
    if (!kernel.includes(table))
    {
        failures.push(`${table} is absent from ArticleDeletionKernel`);
    }
}
for (const mutableSource of ['content_asset_reference:article', 'content_asset_reference:draft'])
{
    if (byName.get(mutableSource)?.policy !== 'delete')
    {
        failures.push(`${mutableSource} must use delete policy`);
    }
}
if (byName.get('content_asset_reference:revision')?.policy !== 'preserve')
{
    failures.push('content_asset_reference:revision must use preserve policy');
}
for (const delayedCleanup of ['content_asset', 'content_asset_cleanup_queue', 'local illustration file'])
{
    if (byName.get(delayedCleanup)?.policy !== 'async_cleanup')
    {
        failures.push(`${delayedCleanup} must use async_cleanup policy`);
    }
}
for (const retained of ['article_revision', 'article_publication', 'article_rights_snapshot', 'article_mutation_outbox', 'comment_moderation_event'])
{
    if (byName.get(retained)?.policy !== 'preserve')
    {
        failures.push(`${retained} must use preserve policy`);
    }
    if (new RegExp(`DELETE\\s+FROM\\s+${retained}`, 'i').test(kernel))
    {
        failures.push(`${retained} is deleted by ArticleDeletionKernel`);
    }
}

const kernelCalls = lifecycle.match(/new ArticleDeletionKernel\(_db\)\.DeleteLockedAsync/g) ?? [];
if (kernelCalls.length !== 2)
{
    failures.push(`expected two shared-kernel entry points, found ${kernelCalls.length}`);
}
if (!kernel.includes('deleted != targets.Length'))
{
    failures.push('kernel does not fail closed on target-count drift');
}
if (!kernel.includes('RemoveMutableArticleSourcesAndScheduleAsync'))
{
    failures.push('kernel does not enqueue reference-safe cleanup');
}

if (failures.length > 0)
{
    console.error(`Article deletion catalog check failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
}

console.log(`Article deletion catalog check passed (${catalog.relations.length} policies).`);
