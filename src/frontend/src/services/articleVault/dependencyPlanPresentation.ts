import type { VaultPlanReviewDocument } from '@/services/articleVault/planReview';

/**
 * Read-only subset of ArticleVaultDependencyPlan/PortableDependencyManifest at
 * 80a2736711edff3a711ec854d55c65433a127a5f. PortableDependencyCodec owns the
 * PascalCase enum encoding; this projection never validates/adopts a graph or grants execution.
 */
export type VaultDependencyPlanReviewDocument = Readonly<{
    syncPlanSha256: string;
    siteIdentity: string;
    vaultIdentity: string;
    contentSha256: string;
    operationOrder: readonly string[];
    items: readonly Readonly<{
        operationIdentity: string;
        groupIdentity: string;
        portableArticleIdentity: string;
        dependencyOrder: readonly string[];
        manifest: Readonly<{
            binding: VaultDependencyReviewBinding;
            sourceSide: 'Base' | 'Local' | 'Server';
            graphSha256: string;
            relationSha256: string;
            contentSha256: string;
            nodes: readonly Readonly<{
                kind: 'asset' | 'link' | 'anchor' | 'frozen-embed';
                binding: VaultDependencyReviewBinding;
                admission: Readonly<{
                    permission: 'Allowed' | 'Denied' | 'Unknown';
                    requiredRights: string;
                    grantedRights: string;
                    permissionSha256: string;
                    rightsSha256: string;
                    authoritySha256: string;
                }>;
            }>[];
            edges: readonly Readonly<{
                prerequisiteKey: string;
                dependentKey: string;
                kind: 'Requires' | 'FrozenRequires';
            }>[];
        }>;
    }>[];
}>;

type VaultDependencyReviewBinding = Readonly<{
    siteIdentity: string;
    vaultIdentity: string;
    portableArticleIdentity: string;
}>;

/** Rejects crossed display membership only; canonical current verification is still required. */
export function presentVaultDependencyPlan(extension: VaultDependencyPlanReviewDocument, plan: VaultPlanReviewDocument)
{
    if (extension.syncPlanSha256 !== plan.contentSha256
        || extension.siteIdentity !== plan.siteIdentity || extension.vaultIdentity !== plan.vaultIdentity
        || extension.operationOrder.length !== plan.operationOrder.length
        || !extension.operationOrder.every((identity, index) => identity === plan.operationOrder[index]))
    {
        return null;
    }
    const plannedItems = plan.groups.flatMap((group) => group.items);
    const extensionItems = new Map(extension.items.map((item) => [item.operationIdentity, item]));
    if (extensionItems.size !== extension.items.length || extension.items.length !== plannedItems.length
        || plan.operationOrder.length !== plannedItems.length
        || new Set(plan.operationOrder).size !== plan.operationOrder.length)
    {
        return null;
    }
    for (const item of plannedItems)
    {
        const dependency = extensionItems.get(item.operationIdentity);
        if (dependency?.groupIdentity !== item.groupIdentity
            || dependency.portableArticleIdentity !== item.portableArticleIdentity)
        {
            return null;
        }
        const bindings = [dependency.manifest.binding, ...dependency.manifest.nodes.map((node) => node.binding)];
        if (bindings.some((binding) => binding.siteIdentity !== plan.siteIdentity
            || binding.vaultIdentity !== plan.vaultIdentity
            || binding.portableArticleIdentity !== item.portableArticleIdentity))
        {
            return null;
        }
    }
    return { items: plan.operationOrder.map((identity) => extensionItems.get(identity)!) };
}
