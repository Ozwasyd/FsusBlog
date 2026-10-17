import { describe, expect, it } from 'vitest';

import { presentVaultDependencyPlan, type VaultDependencyPlanReviewDocument } from '@/services/articleVault/dependencyPlanPresentation';
import { filterVaultPlanItems, presentVaultPlan, vaultPlanDecisionLabel, type VaultPlanReviewDocument, type VaultPlanReviewItem } from '@/services/articleVault/planReview';

import schema from '../../../../src/shared/Contracts/ArticleVault/article-vault-sync-plan.schema.json';

const digest = 'a'.repeat(64);
const coordinate = {
    serverRevision: 12,
    contentSha256: digest,
    metadataManifestSha256: digest,
    dependencySha256: digest,
    permissionSha256: digest,
    lifecycle: 'draft'
};

function item(operationIdentity: string, decision: VaultPlanReviewItem['decision'] = 'pull-update'): VaultPlanReviewItem
{
    return {
        operationIdentity,
        sequence: 0,
        groupIdentity: 'group-one',
        portableArticleIdentity: `article-${operationIdentity}`,
        serverArticleIdentity: `server-${operationIdentity}`,
        decision,
        base: coordinate,
        local: coordinate,
        server: coordinate,
        preconditions: {
            articleManifestSha256: digest,
            serverObservationSha256: digest,
            expectedServerRevision: 12,
            expectedPermissionSha256: digest,
            expectedLifecycle: 'draft'
        },
        dependsOnOperationIdentities: []
    };
}

function plan(items: readonly VaultPlanReviewItem[] = [item('one'), item('two')]): VaultPlanReviewDocument
{
    return {
        siteIdentity: 'site-one',
        vaultIdentity: 'vault-one',
        deviceIdentity: 'device-one',
        direction: 'sync',
        createdAtUnixMs: 1,
        expiresAtUnixMs: 1000,
        status: 'ready',
        cancelPolicy: 'before-execution-only',
        contentSha256: digest,
        rootManifestSha256: digest,
        operationOrder: items.map((entry) => entry.operationIdentity).reverse(),
        groups: [{
            groupIdentity: 'group-one',
            allOrNothing: true,
            portableArticleIdentities: items.map((entry) => entry.portableArticleIdentity),
            dependencies: [{ prerequisitePortableArticleIdentity: 'article-one', dependentPortableArticleIdentity: 'article-two' }],
            items
        }],
        conflicts: [{ groupIdentity: 'group-one', portableArticleIdentity: 'article-one', reasonCode: 'missing_base' }]
    };
}

function extension(document: VaultPlanReviewDocument): VaultDependencyPlanReviewDocument
{
    return {
        syncPlanSha256: document.contentSha256,
        siteIdentity: document.siteIdentity,
        vaultIdentity: document.vaultIdentity,
        contentSha256: digest,
        operationOrder: document.operationOrder,
        items: document.groups.flatMap((group) => group.items).map((entry) =>
        {
            const binding = {
                siteIdentity: document.siteIdentity,
                vaultIdentity: document.vaultIdentity,
                portableArticleIdentity: entry.portableArticleIdentity
            };
            return {
                operationIdentity: entry.operationIdentity,
                groupIdentity: entry.groupIdentity,
                portableArticleIdentity: entry.portableArticleIdentity,
                dependencyOrder: ['asset-key'],
                manifest: {
                    binding,
                    sourceSide: 'Server',
                    graphSha256: digest,
                    relationSha256: digest,
                    contentSha256: digest,
                    nodes: [{
                        kind: 'asset',
                        binding,
                        admission: {
                            permission: 'Allowed',
                            requiredRights: 'Read, Materialize',
                            grantedRights: 'Read, Materialize',
                            permissionSha256: digest,
                            rightsSha256: digest,
                            authoritySha256: digest
                        }
                    }],
                    edges: [{ prerequisiteKey: 'asset-key', dependentKey: 'article-key', kind: 'FrozenRequires' }]
                }
            };
        })
    };
}

describe('canonical plan display membership', () =>
{
    it('preserves a thousand-item canonical order and both input documents', () =>
    {
        const document = plan(Array.from({ length: 1000 }, (_, index) => item(`op-${index}`)));
        const dependencies = extension(document);
        const before = JSON.stringify({ document, dependencies });
        const review = presentVaultPlan(document);
        const dependencyReview = presentVaultDependencyPlan(dependencies, document);
        expect(review.orderAvailable).toBe(true);
        expect(review.articleCount).toBe(1000);
        expect(review.items).toHaveLength(1000);
        expect(review.items[0]?.operationIdentity).toBe('op-999');
        expect(review.items[999]?.operationIdentity).toBe('op-0');
        expect(dependencyReview?.items[0]).toBe(dependencies.items[999]);
        expect(dependencyReview?.items[999]).toBe(dependencies.items[0]);
        expect(JSON.stringify({ document, dependencies })).toBe(before);
        expect(review).not.toHaveProperty('canExecute');
        expect(dependencyReview).not.toHaveProperty('canExecute');
        expect(dependencyReview).not.toHaveProperty('synced');
    });

    it.each([
        ['duplicate', ['one', 'one']],
        ['missing', ['one']],
        ['foreign', ['one', 'foreign']],
        ['extra', ['two', 'one', 'foreign']]
    ])('rejects %s order in both projections', (_, operationOrder) =>
    {
        const document = { ...plan(), operationOrder };
        expect(presentVaultPlan(document)).toMatchObject({ orderAvailable: false, items: [] });
        expect(presentVaultDependencyPlan(extension(document), document)).toBeNull();
    });

    it('rejects duplicate planned identities even when extension membership is unique', () =>
    {
        const document = { ...plan([item('one'), item('one')]), operationOrder: ['two', 'one'] };
        const dependencies = extension(plan());
        expect(presentVaultPlan(document)).toMatchObject({ orderAvailable: false, items: [] });
        expect(presentVaultDependencyPlan({ ...dependencies, operationOrder: document.operationOrder }, document)).toBeNull();
    });

    it('accepts an empty canonical operation set without granting execution', () =>
    {
        const document = plan([]);
        expect(presentVaultPlan(document)).toMatchObject({ orderAvailable: true, articleCount: 0, items: [] });
        expect(presentVaultDependencyPlan(extension(document), document)).toEqual({ items: [] });
    });

    it('counts the actual shared-schema decision roster and preserves conflict reasons', () =>
    {
        const decisions = schema.$defs.item.properties.decision.enum as VaultPlanReviewItem['decision'][];
        const document = plan(decisions.map((decision, index) => item(`op-${index}`, decision)));
        const review = presentVaultPlan(document);
        expect(review.counts.map((entry) => entry.decision)).toEqual(decisions);
        expect(review.counts.every((entry) => entry.count === 1)).toBe(true);
        expect(review.counts.map((entry) => entry.label)).toEqual(decisions.map(vaultPlanDecisionLabel));
        expect(review.dependencyCount).toBe(1);
        expect(review.conflictCount).toBe(1);
        expect(document.conflicts[0]?.reasonCode).toBe('missing_base');
    });

    it.each([
        ['pull', '仅拉取计划'],
        ['push', '仅推送计划'],
        ['sync', '同步计划']
    ] as const)('displays the %s direction', (direction, label) =>
    {
        expect(presentVaultPlan({ ...plan(), direction }).directionLabel).toBe(label);
    });

    it.each(['article-two', 'SERVER-TWO', '  TWO  ', 'group-one', ''])('filters identity query %s without changing canonical rows', (query) =>
    {
        const document = plan();
        const rows = presentVaultPlan(document).items;
        const before = JSON.stringify(rows);
        const selected = filterVaultPlanItems(rows, query);
        expect(selected[0]).toBe(rows[0]);
        expect(selected).toHaveLength(query === '' || query === 'group-one' ? 2 : 1);
        expect(JSON.stringify(rows)).toBe(before);
    });

    it('handles null server identity and unmatched identity without inventing rows', () =>
    {
        const rows = [{ ...item('one'), serverArticleIdentity: null }];
        expect(filterVaultPlanItems(rows, 'server-one')).toEqual([]);
        expect(filterVaultPlanItems(rows, 'article-one')).toEqual(rows);
    });
});

describe('dependency display scope', () =>
{
    it.each(['siteIdentity', 'vaultIdentity', 'syncPlanSha256'] as const)('rejects crossed extension %s', (field) =>
    {
        const document = plan();
        expect(presentVaultDependencyPlan({ ...extension(document), [field]: 'other' }, document)).toBeNull();
    });

    it.each(['missing', 'duplicate', 'foreign', 'extra'] as const)('rejects %s extension membership', (kind) =>
    {
        const document = plan();
        const dependencies = extension(document);
        const first = dependencies.items[0]!;
        const items = kind === 'missing' ? [first] : kind === 'duplicate' ? [first, first]
            : kind === 'foreign' ? [first, { ...first, operationIdentity: 'foreign' }]
                : [...dependencies.items, { ...first, operationIdentity: 'extra' }];
        expect(presentVaultDependencyPlan({ ...dependencies, items }, document)).toBeNull();
    });

    it.each(['groupIdentity', 'portableArticleIdentity'] as const)('rejects crossed item %s', (field) =>
    {
        const document = plan();
        const dependencies = extension(document);
        const items = dependencies.items.map((entry, index) => index === 0 ? { ...entry, [field]: 'other' } : entry);
        expect(presentVaultDependencyPlan({ ...dependencies, items }, document)).toBeNull();
    });

    it.each(['siteIdentity', 'vaultIdentity', 'portableArticleIdentity'] as const)('rejects crossed manifest and node %s', (field) =>
    {
        const document = plan();
        const dependencies = extension(document);
        for (const location of ['manifest', 'node'])
        {
            const items = dependencies.items.map((entry) => ({
                ...entry,
                manifest: {
                    ...entry.manifest,
                    ...(location === 'manifest' ? { binding: { ...entry.manifest.binding, [field]: 'other' } } : {
                        nodes: entry.manifest.nodes.map((node) => ({ ...node, binding: { ...node.binding, [field]: 'other' } }))
                    })
                }
            }));
            expect(presentVaultDependencyPlan({ ...dependencies, items }, document)).toBeNull();
        }
    });

    it('rejects extension order drift even if both operation sets remain complete', () =>
    {
        const document = plan();
        const dependencies = extension(document);
        expect(presentVaultDependencyPlan({ ...dependencies, operationOrder: ['one', 'two'] }, document)).toBeNull();
    });

    it('preserves codec enum spelling and exact dependency references', () =>
    {
        const document = plan();
        const review = presentVaultDependencyPlan(extension(document), document);
        expect(review?.items[0]?.manifest.sourceSide).toBe('Server');
        expect(review?.items[0]?.manifest.edges[0]?.kind).toBe('FrozenRequires');
        expect(review?.items[0]?.dependencyOrder).toEqual(['asset-key']);
        expect(review?.items[0]?.manifest.nodes[0]?.admission.requiredRights).toBe('Read, Materialize');
    });
});
