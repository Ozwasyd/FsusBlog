using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Uses the existing closed canonical serializer for a separate conflict contract.</summary>
public static class ArticleVaultConflictCodec
{
    public static string ComputeContentSha256(ArticleVaultConflictEvidence evidence)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(
            evidence with
            {
                ContentSha256 = string.Empty
            }));

    public static byte[] Serialize(ArticleVaultConflictEvidence evidence)
    {
        ArticleVaultValidationResult validation = ArticleVaultConflictVerifier.ValidateStructure(evidence);
        if (!validation.IsValid)
        {
            throw new InvalidDataException(validation.ReasonCode);
        }

        return ArticleVaultManifestCodec.SerializeCanonical(evidence);
    }

    public static ArticleVaultConflictEvidence Deserialize(ReadOnlySpan<byte> utf8)
    {
        ArticleVaultConflictEvidence evidence;
        try
        {
            evidence = ArticleVaultManifestCodec.DeserializeCanonical<ArticleVaultConflictEvidence>(utf8)
                ?? throw new InvalidDataException("article_vault_conflict_evidence_missing");
        }
        catch (JsonException exception)
        {
            throw new InvalidDataException("article_vault_conflict_schema_invalid", exception);
        }

        ArticleVaultValidationResult validation = ArticleVaultConflictVerifier.ValidateStructure(evidence);
        return validation.IsValid ? evidence : throw new InvalidDataException(validation.ReasonCode);
    }
}

/// <summary>
/// Recomputes classification eligibility from typed facts and compares evidence to current independent
/// observations. It neither parses/merges source nor executes selected actions or a sync plan.
/// </summary>
public static class ArticleVaultConflictVerifier
{
    public static ArticleVaultValidationResult ValidateStructure(ArticleVaultConflictEvidence? evidence)
    {
        if (evidence is null)
        {
            return Invalid("evidence_missing");
        }

        if (evidence.Schema != ArticleVaultConflictSchemas.Evidence
            || evidence.SchemaVersion != ArticleVaultConflictSchemas.Version)
        {
            return Invalid("schema_unknown");
        }

        if (evidence.RegistrySha256 != ArticleVaultConflictRegistry.ContentSha256)
        {
            return Invalid("registry_drift");
        }

        VaultConflictBinding? binding = evidence.Binding;
        if (binding is null
            || !ArticleVaultManifestValidator.IsIdentity(binding.SiteIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(binding.VaultIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(binding.DeviceIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(binding.PortableArticleIdentity)
            || binding.ServerArticleIdentity is not null && !ArticleVaultManifestValidator.IsIdentity(binding.ServerArticleIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(binding.PlanCandidateIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(binding.GroupIdentity)
            || !ArticleVaultManifestValidator.IsIdentity(binding.OperationIdentity)
            || !ArticleVaultManifestValidator.IsSha256(binding.PlanSha256)
            || !ArticleVaultManifestValidator.IsSha256(binding.ArticleManifestSha256)
            || !ArticleVaultManifestValidator.IsSha256(binding.ServerObservationSha256)
            || binding.Coordinates is null
            || binding.Coordinates.Base is null
            || binding.Coordinates.Local is null
            || binding.Coordinates.Server is null)
        {
            return Invalid("binding_invalid");
        }

        // Registry coverage of create-create is not permission to invent a missing common ancestor.
        if (!binding.Coordinates.Base.Present)
        {
            return Invalid("base_missing");
        }

        if (!CoordinateSealed(binding.Coordinates.Base)
            || !CoordinateSealed(binding.Coordinates.Local)
            || !CoordinateSealed(binding.Coordinates.Server))
        {
            return Invalid("coordinate_invalid");
        }

        if (evidence.Items.IsDefaultOrEmpty)
        {
            return Invalid("items_missing");
        }

        VaultConflictType previous = 0;
        foreach (VaultConflictItem? item in evidence.Items)
        {
            if (item is null || !Enum.IsDefined(item.Type) || (int)item.Type <= (int)previous)
            {
                return Invalid("type_unknown_or_duplicate");
            }

            previous = item.Type;
            VaultConflictRegistryEntry entry = ArticleVaultConflictRegistry.Find(item.Type)!;
            if (item.Disposition != entry.Disposition
                || item.AllowedActions.IsDefault
                || !item.AllowedActions.SequenceEqual(entry.AllowedActions)
                || item.Observation is null
                || item.Observation.Type != item.Type)
            {
                return Invalid("authority_or_action_drift");
            }

            ArticleVaultValidationResult facts = ValidateFacts(item, binding.Coordinates, entry);
            if (!facts.IsValid)
            {
                return facts;
            }
        }

        if (!ArticleVaultManifestValidator.IsSha256(evidence.ContentSha256)
            || !DigestEquals(evidence.ContentSha256, ArticleVaultConflictCodec.ComputeContentSha256(evidence)))
        {
            return Invalid("digest_mismatch");
        }

        return ArticleVaultValidationResult.Valid();
    }

    /// <summary>
    /// The caller supplies original current plan inputs and independently reread typed diagnostics.
    /// This proves binding and recomputes geometry only. The absent #2117 byte/parser reader and #2118
    /// stable-field reader are still required to establish automatic eligibility; this method cannot
    /// return a candidate, resolution plan, writer command or qualification receipt.
    /// </summary>
    public static ArticleVaultValidationResult VerifyCurrentBinding(
        ArticleVaultConflictEvidence? evidence,
        ArticleVaultSyncPlan? plan,
        ArticleVaultRootManifest? root,
        IReadOnlyList<ArticleVaultArticleManifest>? articles,
        IReadOnlyList<ArticleVaultServerObservation>? observations,
        ArticleVaultPlanVerificationContext? context,
        IReadOnlyList<VaultConflictObservation>? currentFacts)
    {
        ArticleVaultValidationResult structure = ValidateStructure(evidence);
        if (!structure.IsValid)
        {
            return structure;
        }

        ArticleVaultValidationResult current = ArticleVaultSyncPlanVerifier.VerifyCurrent(
            plan, root, articles, observations, context);
        if (!current.IsValid)
        {
            return current;
        }

        VaultConflictBinding binding = evidence!.Binding;
        VaultSyncPlanItem[] matches = plan!.Groups
            .Where(group => group.GroupIdentity == binding.GroupIdentity)
            .SelectMany(static group => group.Items)
            .Where(item => item.OperationIdentity == binding.OperationIdentity)
            .ToArray();
        if (binding.SiteIdentity != plan.SiteIdentity
            || binding.VaultIdentity != plan.VaultIdentity
            || binding.DeviceIdentity != plan.DeviceIdentity
            || binding.PlanCandidateIdentity != plan.PlanCandidateIdentity
            || binding.PlanSha256 != plan.ContentSha256
            || matches.Length != 1)
        {
            return Invalid("plan_binding_drift");
        }

        VaultSyncPlanItem original = matches[0];
        if (binding.PortableArticleIdentity != original.PortableArticleIdentity
            || binding.ServerArticleIdentity != original.ServerArticleIdentity
            || binding.ArticleManifestSha256 != original.Preconditions.ArticleManifestSha256
            || binding.ServerObservationSha256 != original.Preconditions.ServerObservationSha256
            || !SameCoordinate(binding.Coordinates.Base, original.Base)
            || !SameCoordinate(binding.Coordinates.Local, original.Local)
            || !SameCoordinate(binding.Coordinates.Server, original.Server))
        {
            return Invalid("coordinate_drift");
        }

        if (currentFacts is null
            || currentFacts.Count != evidence.Items.Length
            || currentFacts.Any(static fact => fact is null)
            || currentFacts.Select(static fact => fact.Type).Distinct().Count() != currentFacts.Count)
        {
            return Invalid("current_facts_missing_or_duplicate");
        }

        foreach (VaultConflictItem item in evidence.Items)
        {
            VaultConflictObservation? observed = currentFacts.SingleOrDefault(fact => fact.Type == item.Type);
            if (observed is null
                || !ArticleVaultManifestCodec.SerializeCanonical(observed).AsSpan().SequenceEqual(
                    ArticleVaultManifestCodec.SerializeCanonical(item.Observation)))
            {
                return Invalid("current_facts_drift");
            }
        }

        return ArticleVaultValidationResult.Valid();
    }

    /// <summary>
    /// Refuses automatic admission until the canonical source/metadata owners supply actual independent
    /// readers. A successful structure or current-binding check must never be promoted to this gate.
    /// </summary>
    public static ArticleVaultValidationResult ValidateAutomaticEligibility(ArticleVaultConflictEvidence? evidence)
    {
        ArticleVaultValidationResult structure = ValidateStructure(evidence);
        if (!structure.IsValid)
        {
            return structure;
        }

        foreach (VaultConflictItem item in evidence!.Items)
        {
            if (item.Type == VaultConflictType.SourceDisjoint)
            {
                return Invalid("independent_source_reader_missing");
            }

            if (item.Type == VaultConflictType.MetadataDisjoint)
            {
                return Invalid("independent_metadata_reader_missing");
            }
        }

        return Invalid("automatic_disposition_unavailable");
    }

    private static ArticleVaultValidationResult ValidateFacts(
        VaultConflictItem item,
        VaultArticleCoordinates coordinates,
        VaultConflictRegistryEntry entry)
    {
        VaultConflictObservation facts = item.Observation;
        if (entry.RequiredFact == VaultConflictFactKind.SourceChanges)
        {
            if (facts.Source is null || facts.Metadata is not null || facts.Authority is not null)
            {
                return Invalid("source_facts_missing");
            }

            return ValidateSource(item.Type, facts.Source, coordinates);
        }

        if (entry.RequiredFact == VaultConflictFactKind.MetadataChanges)
        {
            if (facts.Metadata is null || facts.Source is not null || facts.Authority is not null)
            {
                return Invalid("metadata_facts_missing");
            }

            return ValidateMetadata(item.Type, facts.Metadata, coordinates);
        }

        if (facts.Source is not null
            || facts.Metadata is not null
            || facts.Authority is null
            || facts.Authority.Kind != entry.RequiredFact
            || facts.Authority.BaseCoordinateSha256 != coordinates.Base.ContentSha256
            || facts.Authority.LocalCoordinateSha256 != coordinates.Local.ContentSha256
            || facts.Authority.ServerCoordinateSha256 != coordinates.Server.ContentSha256)
        {
            return Invalid("authority_facts_missing");
        }

        VaultConflictAuthorityFact authority = facts.Authority;
        if (authority.Kind == VaultConflictFactKind.IdentityProjection)
        {
            if (authority.Rename is null || authority.Git is not null
                || !ProjectionValid(authority.Rename.Base)
                || !ProjectionValid(authority.Rename.Local)
                || !ProjectionValid(authority.Rename.Server)
                || authority.Rename.Base.RelativePath == authority.Rename.Local.RelativePath
                    && authority.Rename.Base.RelativePath == authority.Rename.Server.RelativePath)
            {
                return Invalid("rename_facts_invalid");
            }

            // Current manifests retain one projection, not independently reread historic path facts.
            return Invalid("identity_observer_missing");
        }

        if (authority.Kind == VaultConflictFactKind.GitMarkers)
        {
            if (authority.Git is null || authority.Rename is not null
                || !ArticleVaultManifestValidator.IsIdentity(authority.Git.WorktreeIdentity)
                || !ArticleVaultManifestValidator.IsSha256(authority.Git.HeadFactsSha256)
                || !ArticleVaultManifestValidator.IsSha256(authority.Git.IndexFactsSha256)
                || authority.Git.MarkerRanges.IsDefaultOrEmpty
                || coordinates.Local.Source is null
                || !ValidateRanges(authority.Git.MarkerRanges, coordinates.Local.Source.ByteLength))
            {
                return Invalid("git_facts_invalid");
            }

            return Invalid("git_observer_missing");
        }

        if (authority.Rename is not null || authority.Git is not null)
        {
            return Invalid("authority_payload_invalid");
        }

        bool observed = authority.Kind switch
        {
            VaultConflictFactKind.Deletion => coordinates.Local.Deleted != coordinates.Server.Deleted
                && !SameCoordinate(coordinates.Base, coordinates.Local)
                && !SameCoordinate(coordinates.Base, coordinates.Server),
            VaultConflictFactKind.Lifecycle => coordinates.Base.Lifecycle != coordinates.Local.Lifecycle
                || coordinates.Base.Lifecycle != coordinates.Server.Lifecycle,
            VaultConflictFactKind.Permission => coordinates.Base.PermissionSha256 != coordinates.Local.PermissionSha256
                || coordinates.Base.PermissionSha256 != coordinates.Server.PermissionSha256,
            VaultConflictFactKind.Schema => coordinates.Base.Schema != coordinates.Local.Schema
                || coordinates.Base.Schema != coordinates.Server.Schema
                || coordinates.Base.SchemaVersion != coordinates.Local.SchemaVersion
                || coordinates.Base.SchemaVersion != coordinates.Server.SchemaVersion,
            VaultConflictFactKind.Dependency => coordinates.Base.DependencySha256 != coordinates.Local.DependencySha256
                || coordinates.Base.DependencySha256 != coordinates.Server.DependencySha256,
            // A present common ancestor cannot establish a create-create fact; absent ancestry fails earlier.
            VaultConflictFactKind.Creation => false,
            _ => false
        };
        return observed ? ArticleVaultValidationResult.Valid() : Invalid("authority_fact_not_observed");
    }

    private static bool ProjectionValid(VaultPathProjection? projection)
        => projection is not null
            && ArticleVaultManifestValidator.IsSafeProjection(projection.RelativePath)
            && projection.ProjectionSha256 == ArticleVaultManifestCodec.ComputeProjectionSha256(projection.RelativePath);

    private static ArticleVaultValidationResult ValidateSource(
        VaultConflictType type,
        VaultConflictSourceFacts facts,
        VaultArticleCoordinates coordinates)
    {
        VaultSourceByteIdentity? baseline = coordinates.Base.Source;
        if (baseline is null
            || coordinates.Local.Source is null
            || coordinates.Server.Source is null
            || baseline.Sha256 == coordinates.Local.Source.Sha256
            || baseline.Sha256 == coordinates.Server.Source.Sha256
            || !ArticleVaultManifestValidator.IsIdentity(facts.ParserIdentity)
            || facts.ParserVersion <= 0
            || !ArticleVaultManifestValidator.IsSha256(facts.ParserSha256)
            || !ArticleVaultManifestValidator.IsSha256(facts.AlgorithmSha256)
            || facts.LocalChanges.IsDefaultOrEmpty
            || facts.ServerChanges.IsDefaultOrEmpty
            || !ValidateRanges(facts.LocalChanges, baseline.ByteLength)
            || !ValidateRanges(facts.ServerChanges, baseline.ByteLength))
        {
            return Invalid("source_facts_invalid");
        }

        bool overlapping = facts.LocalChanges.Any(local => facts.ServerChanges.Any(server =>
            local.SemanticNodeIdentity == server.SemanticNodeIdentity || Overlaps(local, server)));
        if ((type == VaultConflictType.SourceDisjoint) == overlapping)
        {
            return Invalid("source_disposition_mismatch");
        }

        return type == VaultConflictType.SourceDisjoint
            ? ValidateAutomaticAuthority(coordinates)
            : ArticleVaultValidationResult.Valid();
    }

    private static bool ValidateRanges(
        ImmutableArray<VaultConflictSourceChange> changes,
        long byteLength)
    {
        long previousEnd = -1;
        long previousStart = -1;
        foreach (VaultConflictSourceChange? change in changes)
        {
            if (change is null
                || change.Start < 0
                || change.End < change.Start
                || change.End > byteLength
                || change.Start < previousEnd
                || change.Start == previousStart
                || !ArticleVaultManifestValidator.IsIdentity(change.SemanticNodeIdentity))
            {
                return false;
            }

            previousStart = change.Start;
            previousEnd = change.End;
        }

        return true;
    }

    private static bool Overlaps(VaultConflictSourceChange left, VaultConflictSourceChange right)
        => left.Start == left.End
            ? left.Start >= right.Start && left.Start <= right.End
            : right.Start == right.End
                ? right.Start >= left.Start && right.Start <= left.End
                : left.Start < right.End && right.Start < left.End;

    private static ArticleVaultValidationResult ValidateMetadata(
        VaultConflictType type,
        VaultConflictMetadataFacts facts,
        VaultArticleCoordinates coordinates)
    {
        if (!ArticleVaultManifestValidator.IsSha256(facts.FieldRegistrySha256)
            || facts.Changes.IsDefaultOrEmpty
            || coordinates.Base.MetadataManifestSha256 == coordinates.Local.MetadataManifestSha256
            || coordinates.Base.MetadataManifestSha256 == coordinates.Server.MetadataManifestSha256)
        {
            return Invalid("metadata_facts_invalid");
        }

        HashSet<(VaultConflictMetadataField Field, string? Entity)> fields = [];
        bool localChanged = false;
        bool serverChanged = false;
        bool overlapping = false;
        VaultConflictMetadataField previousField = 0;
        string? previousEntity = null;
        foreach (VaultConflictMetadataChange? change in facts.Changes)
        {
            if (change is null
                || !Enum.IsDefined(change.Field)
                || change.EntityIdentity is not null && !ArticleVaultManifestValidator.IsIdentity(change.EntityIdentity)
                || change.EntityIdentity is not null && change.Field is not (VaultConflictMetadataField.Taxonomy or VaultConflictMetadataField.Properties)
                || (int)change.Field < (int)previousField
                || change.Field == previousField && string.CompareOrdinal(previousEntity, change.EntityIdentity) >= 0
                || !fields.Add((change.Field, change.EntityIdentity))
                || !ArticleVaultManifestValidator.IsSha256(change.BaseValueSha256)
                || !ArticleVaultManifestValidator.IsSha256(change.LocalValueSha256)
                || !ArticleVaultManifestValidator.IsSha256(change.ServerValueSha256))
            {
                return Invalid("metadata_field_invalid");
            }

            previousField = change.Field;
            previousEntity = change.EntityIdentity;
            bool local = change.BaseValueSha256 != change.LocalValueSha256;
            bool server = change.BaseValueSha256 != change.ServerValueSha256;
            if (!local && !server)
            {
                return Invalid("metadata_change_missing");
            }

            localChanged |= local;
            serverChanged |= server;
            overlapping |= local && server && change.LocalValueSha256 != change.ServerValueSha256;
        }

        if (!localChanged || !serverChanged || (type == VaultConflictType.MetadataDisjoint) == overlapping)
        {
            return Invalid("metadata_disposition_mismatch");
        }

        return type == VaultConflictType.MetadataDisjoint
            ? ValidateAutomaticAuthority(coordinates)
            : ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult ValidateAutomaticAuthority(VaultArticleCoordinates coordinates)
    {
        VaultArticleCoordinate baseline = coordinates.Base;
        if (baseline.Lifecycle != coordinates.Local.Lifecycle
            || baseline.Lifecycle != coordinates.Server.Lifecycle
            || baseline.PermissionSha256 != coordinates.Local.PermissionSha256
            || baseline.PermissionSha256 != coordinates.Server.PermissionSha256
            || baseline.DependencySha256 != coordinates.Local.DependencySha256
            || baseline.DependencySha256 != coordinates.Server.DependencySha256)
        {
            return Invalid("automatic_authority_drift");
        }

        return ArticleVaultValidationResult.Valid();
    }

    private static bool CoordinateSealed(VaultArticleCoordinate coordinate)
        => coordinate.Schema == ArticleVaultSchemas.Coordinate
            && coordinate.SchemaVersion == ArticleVaultSchemas.Version
            && ArticleVaultManifestValidator.IsSha256(coordinate.ContentSha256)
            && DigestEquals(coordinate.ContentSha256, ArticleVaultManifestCodec.ComputeContentSha256(coordinate));

    private static bool SameCoordinate(VaultArticleCoordinate left, VaultArticleCoordinate right)
        => ArticleVaultManifestCodec.SerializeCanonical(left).AsSpan().SequenceEqual(
            ArticleVaultManifestCodec.SerializeCanonical(right));

    private static bool DigestEquals(string left, string right)
        => CryptographicOperations.FixedTimeEquals(Convert.FromHexString(left), Convert.FromHexString(right));

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid($"article_vault_conflict_{reason}");
}
