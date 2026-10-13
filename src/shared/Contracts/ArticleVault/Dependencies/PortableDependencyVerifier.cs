using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

/// <summary>Independent structural and current-authority checks; never resolves, fetches or writes dependencies.</summary>
public static class PortableDependencyVerifier
{
    public static ArticleVaultValidationResult ValidateStructure(PortableDependencyManifest? manifest)
    {
        if (manifest is null || manifest.Schema != PortableDependencySchemas.Manifest
            || manifest.SchemaVersion != PortableDependencySchemas.Version)
        {
            return Invalid("schema_unknown");
        }
        if (manifest.Binding is null || !IsBinding(manifest.Binding)
            || manifest.Coordinates is null || !Enum.IsDefined(manifest.SourceSide)
            || manifest.Source is null || manifest.Nodes is null || manifest.Edges is null
            || !ArticleEmbedContractDigest.IsSha256(manifest.RelationSha256))
        {
            return Invalid("manifest_invalid");
        }
        if (manifest.Nodes.Count > ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound
            || manifest.Edges.Count > ArticleEmbedResolutionBudgetLimits.AuthorityMessagesBound)
        {
            return Invalid("size_exceeded");
        }
        foreach (VaultArticleCoordinate? coordinate in new[]
        {
            manifest.Coordinates.Base, manifest.Coordinates.Local, manifest.Coordinates.Server
        })
        {
            if (coordinate is null || coordinate.Schema != ArticleVaultSchemas.Coordinate
                || coordinate.SchemaVersion != ArticleVaultSchemas.Version
                || (coordinate.Source is not null && (!Enum.IsDefined(coordinate.Source.NewlineStyle)
                    || !ArticleEmbedContractDigest.IsSha256(coordinate.Source.Sha256)
                    || coordinate.Source.ByteLength < 0 || coordinate.Source.TrailingWhitespaceLineCount < 0))
                || !ArticleEmbedContractDigest.IsSha256(coordinate.ContentSha256)
                || coordinate.ContentSha256 != ArticleVaultManifestCodec.ComputeContentSha256(coordinate))
            {
                return Invalid("coordinate_invalid");
            }
        }
        VaultArticleCoordinate selected = SelectedCoordinate(manifest);
        if (!selected.Present || selected.Deleted || selected.Source != manifest.Source
            || !ArticleEmbedContractDigest.IsSha256(manifest.Source.Sha256)
            || manifest.Source.ByteLength < 0 || !Enum.IsDefined(manifest.Source.NewlineStyle))
        {
            return Invalid("source_coordinate_mismatch");
        }
        Dictionary<string, VaultDependencyNode> nodes = new(StringComparer.Ordinal);
        foreach (VaultDependencyNode? node in manifest.Nodes)
        {
            ArticleVaultValidationResult validation = ValidateNode(node, manifest.Binding);
            if (!validation.IsValid)
            {
                return validation;
            }
            if (!nodes.TryAdd(PortableDependencyCodec.NodeKey(node!), node!))
            {
                return Invalid("node_duplicate");
            }
        }
        HashSet<(string, string, VaultDependencyEdgeKind)> edges = [];
        foreach (VaultDependencyEdge? edge in manifest.Edges)
        {
            if (edge is null || !Enum.IsDefined(edge.Kind)
                || edge.PrerequisiteKey is null || edge.DependentKey is null
                || !nodes.ContainsKey(edge.PrerequisiteKey) || !nodes.ContainsKey(edge.DependentKey)
                || edge.PrerequisiteKey == edge.DependentKey)
            {
                return Invalid("edge_invalid");
            }
            if (!edges.Add((edge.PrerequisiteKey, edge.DependentKey, edge.Kind)))
            {
                return Invalid("edge_duplicate");
            }
            if (edge.Kind == VaultDependencyEdgeKind.FrozenRequires
                && nodes[edge.DependentKey] is not VaultFrozenEmbedDependency)
            {
                return Invalid("edge_target_kind_invalid");
            }
        }
        if (manifest.GraphSha256 != PortableDependencyCodec.GraphDigest(manifest)
            || selected.DependencySha256 != manifest.GraphSha256
            || manifest.ContentSha256 != PortableDependencyCodec.ManifestDigest(manifest))
        {
            return Invalid("digest_mismatch");
        }
        return ArticleVaultValidationResult.Valid();
    }

    /// <summary>Requires the actual article manifest and freshly supplied canonical authority projections.</summary>
    public static ArticleVaultValidationResult VerifyCurrent(
        PortableDependencyManifest? manifest,
        ArticleVaultArticleManifest? article,
        ReadOnlySpan<byte> sourceBytes,
        IReadOnlyList<VaultDependencyNode>? currentAuthorityNodes,
        IReadOnlyList<VaultDependencyEdge>? currentAuthorityEdges,
        string currentRelationSha256,
        ArticleEmbedResolutionBudgetLimits? budgets,
        TimeProvider? timeProvider = null,
        VaultArticleCoordinate? currentServerCoordinate = null)
    {
        ArticleVaultValidationResult structure = ValidateStructure(manifest);
        if (!structure.IsValid)
        {
            return structure;
        }
        ArticleVaultValidationResult articleValidation = ArticleVaultManifestValidator.Validate(article);
        if (!articleValidation.IsValid)
        {
            return articleValidation;
        }
        if (manifest!.Binding != new VaultDependencyBinding(article!.SiteIdentity, article.VaultIdentity, article.PortableArticleIdentity)
            || manifest.ServerArticleIdentity != article.ServerArticleIdentity
            || manifest.Coordinates.Base != article.Coordinates.Base
            || manifest.Coordinates.Local != article.Coordinates.Local
            || manifest.Coordinates.Server != (currentServerCoordinate ?? article.Coordinates.Server)
            || manifest.RelationSha256 != currentRelationSha256)
        {
            return Invalid("article_or_relation_drift");
        }
        ArticleVaultValidationResult source = ArticleVaultManifestValidator.ValidateSourceBytes(manifest.Source, sourceBytes);
        if (!source.IsValid)
        {
            return source;
        }
        if (currentAuthorityNodes is null || currentAuthorityNodes.Count != manifest.Nodes.Count)
        {
            return Invalid("authority_missing");
        }
        Dictionary<string, string> current = new(StringComparer.Ordinal);
        foreach (VaultDependencyNode? node in currentAuthorityNodes)
        {
            ArticleVaultValidationResult nodeCheck = ValidateNode(node, manifest.Binding);
            if (!nodeCheck.IsValid)
            {
                return nodeCheck;
            }
            if (!current.TryAdd(PortableDependencyCodec.NodeKey(node!), PortableDependencyCodec.NodeDigest(node!)))
            {
                return Invalid("authority_ambiguous");
            }
        }
        if (currentAuthorityEdges is null || currentAuthorityEdges.Any(static edge => edge is null)
            || currentAuthorityEdges.Count != manifest.Edges.Count
            || !currentAuthorityEdges.OrderBy(static edge => edge.PrerequisiteKey, StringComparer.Ordinal)
                .ThenBy(static edge => edge.DependentKey, StringComparer.Ordinal).ThenBy(static edge => edge.Kind)
                .SequenceEqual(manifest.Edges.OrderBy(static edge => edge.PrerequisiteKey, StringComparer.Ordinal)
                    .ThenBy(static edge => edge.DependentKey, StringComparer.Ordinal).ThenBy(static edge => edge.Kind)))
        {
            return Invalid("relation_edges_drift");
        }
        foreach (VaultDependencyNode node in manifest.Nodes)
        {
            if (!current.TryGetValue(PortableDependencyCodec.NodeKey(node), out string? digest)
                || digest != PortableDependencyCodec.NodeDigest(node))
            {
                return Invalid("authority_drift");
            }
        }
        return VerifyBudgets(manifest, budgets, out _, timeProvider);
    }

    /// <summary>Uses the embed owner's sole bounded budget contract and iterative traversal.</summary>
    public static ArticleVaultValidationResult VerifyBudgets(
        PortableDependencyManifest manifest,
        ArticleEmbedResolutionBudgetLimits? budgets,
        out IReadOnlyList<string> order,
        TimeProvider? timeProvider = null)
    {
        order = [];
        TimeProvider time = timeProvider ?? TimeProvider.System;
        long started = time.GetTimestamp();
        ArticleVaultValidationResult structure = ValidateStructure(manifest);
        if (!structure.IsValid)
        {
            return structure;
        }
        if (!ArticleEmbedAuthoringContractValidator.ValidateBudgets(budgets).IsValid)
        {
            return Invalid("budgets_invalid");
        }
        if (manifest.Nodes.Count > budgets!.MaxExpandedNodes || manifest.Edges.Count > budgets.MaxAuthorityMessages)
        {
            return Invalid("size_exceeded");
        }
        long remainingBytes = budgets.MaxSourceBytes - manifest.Source.ByteLength;
        foreach (VaultDependencyNode node in manifest.Nodes)
        {
            long bytes = node switch
            {
                VaultAssetDependency asset => asset.SizeBytes,
                VaultFrozenEmbedDependency embed => embed.FrozenSourceByteLength,
                _ => 0
            };
            if (bytes < 0 || bytes > remainingBytes)
            {
                return Invalid("size_exceeded");
            }
            remainingBytes -= bytes;
        }
        if (remainingBytes < 0)
        {
            return Invalid("size_exceeded");
        }
        Dictionary<string, int> degrees = manifest.Nodes.ToDictionary(PortableDependencyCodec.NodeKey, static _ => 0, StringComparer.Ordinal);
        Dictionary<string, int> depths = degrees.Keys.ToDictionary(static key => key, static _ => 1, StringComparer.Ordinal);
        Dictionary<string, List<string>> children = degrees.Keys.ToDictionary(static key => key, static _ => new List<string>(), StringComparer.Ordinal);
        foreach (VaultDependencyEdge edge in manifest.Edges)
        {
            degrees[edge.DependentKey]++;
            children[edge.PrerequisiteKey].Add(edge.DependentKey);
        }
        SortedSet<string> ready = new(degrees.Where(static pair => pair.Value == 0).Select(static pair => pair.Key), StringComparer.Ordinal);
        List<string> result = [];
        while (ready.Count > 0)
        {
            if (time.GetElapsedTime(started).TotalMilliseconds > budgets.MaxElapsedMilliseconds)
            {
                return Invalid("time_exceeded");
            }
            string key = ready.Min!;
            ready.Remove(key);
            if (depths[key] > budgets.MaxDepth)
            {
                return Invalid("depth_exceeded");
            }
            result.Add(key);
            foreach (string child in children[key])
            {
                depths[child] = Math.Max(depths[child], depths[key] + 1);
                if (--degrees[child] == 0)
                {
                    ready.Add(child);
                }
            }
        }
        if (time.GetElapsedTime(started).TotalMilliseconds > budgets.MaxElapsedMilliseconds)
        {
            return Invalid("time_exceeded");
        }
        if (result.Count != degrees.Count)
        {
            return Invalid("cycle");
        }
        order = result.ToArray();
        return ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult ValidateNode(VaultDependencyNode? node, VaultDependencyBinding binding)
    {
        if (node is null || node.Binding != binding || node.Admission is null)
        {
            return Invalid("binding_mismatch");
        }
        VaultDependencyAdmission admission = node.Admission;
        const VaultDependencyRight KnownRights = VaultDependencyRight.Read | VaultDependencyRight.Reference
            | VaultDependencyRight.Materialize | VaultDependencyRight.Upload;
        if (admission.Permission != ArticleEmbedPermissionStatus.Allowed
            || admission.RequiredRights == 0 || (admission.RequiredRights & ~KnownRights) != 0
            || (admission.GrantedRights & ~KnownRights) != 0
            || (admission.GrantedRights & admission.RequiredRights) != admission.RequiredRights
            || !ArticleEmbedContractDigest.IsSha256(admission.PermissionSha256)
            || !ArticleEmbedContractDigest.IsSha256(admission.RightsSha256)
            || !ArticleEmbedContractDigest.IsSha256(admission.AuthoritySha256))
        {
            return Invalid("permission_or_rights_invalid");
        }
        bool valid = node switch
        {
            VaultAssetDependency asset => asset.AssetIdentity != Guid.Empty
                && ArticleEmbedContractDigest.IsSha256(asset.ContentSha256)
                && !string.IsNullOrEmpty(asset.MimeType) && !string.IsNullOrEmpty(asset.Extension)
                && asset.SizeBytes >= 0 && asset.ServerRevision > 0
                && asset.OwnerAdminPrincipalId is not <= 0
                && asset.WidthPixels is not <= 0 && asset.HeightPixels is not <= 0
                && (asset.WidthPixels is null) == (asset.HeightPixels is null),
            VaultLinkDependency link => ArticleEmbedTargetCodec.Validate(link.Target).IsValid
                && IsTargetBinding(link.TargetBinding, link.Target.PortableArticleIdentity, binding)
                && ArticleEmbedContractDigest.IsSha256(link.MappingSha256),
            VaultAnchorDependency anchor => BlockAnchorContractValidator.Validate(anchor.Target).IsValid
                && anchor.Target.ArticleIdentity == binding.PortableArticleIdentity
                && anchor.AnchorContractSha256 == BlockAnchorSchemas.ContractDigest,
            VaultFrozenEmbedDependency embed => ArticleEmbedContractValidator.Validate(embed.Coordinate).IsValid
                && IsTargetBinding(embed.TargetBinding, embed.Coordinate.Target.PortableArticleIdentity, binding)
                && ArticleEmbedContractDigest.IsSha256(embed.PublicationReceiptSha256)
                && embed.FrozenSourceByteLength >= 0,
            _ => false
        };
        return valid ? ArticleVaultValidationResult.Valid() : Invalid("node_invalid");
    }

    private static VaultArticleCoordinate SelectedCoordinate(PortableDependencyManifest manifest)
        => manifest.SourceSide switch
        {
            VaultDependencySourceSide.Base => manifest.Coordinates.Base,
            VaultDependencySourceSide.Local => manifest.Coordinates.Local,
            _ => manifest.Coordinates.Server
        };

    private static bool IsTargetBinding(VaultDependencyBinding? target, string articleIdentity, VaultDependencyBinding host)
        => target is not null && target.SiteIdentity == host.SiteIdentity && target.VaultIdentity == host.VaultIdentity
            && target.PortableArticleIdentity == articleIdentity;

    private static bool IsBinding(VaultDependencyBinding binding)
        => !string.IsNullOrEmpty(binding.SiteIdentity) && !string.IsNullOrEmpty(binding.VaultIdentity)
            && ArticleEmbedTargetCodec.IsPortableArticleIdentity(binding.PortableArticleIdentity);

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid("portable_dependency_" + reason);
}
