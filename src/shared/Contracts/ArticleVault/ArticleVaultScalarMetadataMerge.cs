using System.Collections.Immutable;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Provides original plan inputs and actual closed metadata bytes, never asserted field facts.</summary>
public sealed record ArticleVaultScalarMetadataInput(
    ArticleVaultSyncPlan Plan,
    ArticleVaultRootManifest Root,
    IReadOnlyList<ArticleVaultArticleManifest> Articles,
    IReadOnlyList<ArticleVaultServerObservation> Observations,
    ArticleVaultPlanVerificationContext Context,
    VaultConflictBinding Binding,
    ReadOnlyMemory<byte> BaseBytes,
    ReadOnlyMemory<byte> LocalBytes,
    ReadOnlyMemory<byte> ServerBytes);

/// <summary>Freezes only existing scalar metadata effects; it carries no writer or lifecycle request.</summary>
public sealed record ArticleVaultScalarMetadataCandidate(
    VaultConflictBinding Binding,
    string FieldRegistrySha256,
    ArticleVaultMetadataManifest Metadata,
    ImmutableArray<VaultConflictMetadataField> AppliedFields,
    VaultConflictMetadataFacts Facts,
    string ContentSha256);

/// <summary>Preserves exact field conflicts without converting them to a generic winner.</summary>
public sealed record ArticleVaultScalarMetadataResult(
    ArticleVaultScalarMetadataCandidate? Candidate,
    VaultConflictObservation? Conflict,
    ImmutableArray<VaultConflictMetadataField> ConflictingFields,
    string? ReasonCode);

/// <summary>
/// Reads actual original V1 metadata bytes and merges Title/Summary/Slug only. Taxonomy and property
/// option mappings are not exposed by V1; any change to their opaque digests fails closed.
/// </summary>
public static class ArticleVaultScalarMetadataMerge
{
    public static ImmutableArray<VaultConflictMetadataField> ScalarFields
    {
        get;
    } =
    [VaultConflictMetadataField.Title, VaultConflictMetadataField.Summary, VaultConflictMetadataField.Slug];

    public static string FieldRegistrySha256
    {
        get;
    } = ArticleVaultManifestCodec.ComputeSha256(
        ArticleVaultManifestCodec.SerializeCanonical(new
        {
            MetadataSchema = ArticleVaultSchemas.MetadataManifest,
            SchemaVersion = ArticleVaultSchemas.Version,
            ScalarFields,
            OpaqueFields = new[] { VaultConflictMetadataField.Taxonomy, VaultConflictMetadataField.Properties }
        }));

    public static ArticleVaultScalarMetadataResult Build(ArticleVaultScalarMetadataInput input)
    {
        ArticleVaultValidationResult read = ReadCurrent(input, out MetadataSnapshots? snapshots);
        if (!read.IsValid)
        {
            return Rejected(read.ReasonCode!);
        }

        MetadataSnapshots current = snapshots!;
        var changes = ImmutableArray.CreateBuilder<VaultConflictMetadataChange>();
        var conflicts = ImmutableArray.CreateBuilder<VaultConflictMetadataField>();
        var applied = ImmutableArray.CreateBuilder<VaultConflictMetadataField>();
        ArticleVaultMetadataManifest candidate = current.Local;
        foreach (VaultConflictMetadataField field in ScalarFields)
        {
            string? baseline = Value(current.Base, field);
            string? local = Value(current.Local, field);
            string? server = Value(current.Server, field);
            bool localChanged = local != baseline;
            bool serverChanged = server != baseline;
            if (localChanged || serverChanged)
            {
                changes.Add(new(field, null, ValueDigest(field, baseline), ValueDigest(field, local), ValueDigest(field, server)));
            }

            if (localChanged && serverChanged && local != server)
            {
                conflicts.Add(field);
                continue;
            }

            string? selected = localChanged ? local : server;
            candidate = WithValue(candidate, field, selected);
            if (selected != baseline)
            {
                applied.Add(field);
            }
        }

        VaultConflictMetadataFacts facts = new(FieldRegistrySha256, changes.ToImmutable());
        if (conflicts.Count != 0)
        {
            return new(null, new(VaultConflictType.MetadataOverlap, null, facts, null), conflicts.ToImmutable(),
                "article_vault_scalar_metadata_overlap");
        }

        candidate = candidate with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(candidate)
        };
        ArticleVaultValidationResult validity = ArticleVaultManifestValidator.Validate(candidate);
        if (!validity.IsValid)
        {
            return Rejected(validity.ReasonCode!);
        }

        ArticleVaultScalarMetadataCandidate result = new(input.Binding, FieldRegistrySha256, candidate,
            applied.ToImmutable(), facts, string.Empty);
        return new(result with
        {
            ContentSha256 = ComputeContentSha256(result)
        }, null, [], null);
    }

    /// <summary>Rereads the bytes and recomputes field decisions independently; never calls Build.</summary>
    public static ArticleVaultValidationResult VerifyCurrentCandidate(
        ArticleVaultScalarMetadataInput input,
        ArticleVaultScalarMetadataCandidate? candidate)
    {
        ArticleVaultValidationResult read = ReadCurrent(input, out MetadataSnapshots? snapshots);
        if (!read.IsValid)
        {
            return read;
        }

        if (candidate is null
            || candidate.Metadata is null
            || candidate.FieldRegistrySha256 != FieldRegistrySha256
            || candidate.Facts is null
            || candidate.Facts.FieldRegistrySha256 != FieldRegistrySha256
            || !CanonicalEqual(candidate.Binding, input.Binding)
            || !ArticleVaultManifestValidator.IsSha256(candidate.ContentSha256)
            || candidate.ContentSha256 != ComputeContentSha256(candidate))
        {
            return Invalid("candidate_binding_invalid");
        }

        MetadataSnapshots current = snapshots!;
        var expectedApplied = ImmutableArray.CreateBuilder<VaultConflictMetadataField>();
        var expectedFacts = ImmutableArray.CreateBuilder<VaultConflictMetadataChange>();
        foreach (VaultConflictMetadataField field in ScalarFields)
        {
            string? baseline = Value(current.Base, field);
            string? local = Value(current.Local, field);
            string? server = Value(current.Server, field);
            string? expected;
            if (local == server)
            {
                expected = local;
            }
            else if (local == baseline)
            {
                expected = server;
            }
            else if (server == baseline)
            {
                expected = local;
            }
            else
            {
                return Invalid("candidate_overwrites_overlap");
            }

            if (Value(candidate.Metadata, field) != expected)
            {
                return Invalid("candidate_value_mismatch");
            }

            if (expected != baseline)
            {
                expectedApplied.Add(field);
            }

            if (local != baseline || server != baseline)
            {
                expectedFacts.Add(new(field, null, ValueDigest(field, baseline), ValueDigest(field, local), ValueDigest(field, server)));
            }
        }

        if (candidate.AppliedFields.IsDefault
            || !candidate.AppliedFields.SequenceEqual(expectedApplied)
            || !CanonicalEqual(candidate.Facts, new VaultConflictMetadataFacts(FieldRegistrySha256, expectedFacts.ToImmutable()))
            || !SameMetadataIdentity(candidate.Metadata, current.Base)
            || candidate.Metadata.TaxonomySha256 != current.Base.TaxonomySha256
            || candidate.Metadata.PropertiesSha256 != current.Base.PropertiesSha256)
        {
            return Invalid("candidate_provenance_mismatch");
        }

        return ArticleVaultManifestValidator.Validate(candidate.Metadata);
    }

    public static string ComputeContentSha256(ArticleVaultScalarMetadataCandidate candidate)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(
            candidate with
            {
                ContentSha256 = string.Empty
            }));

    private static ArticleVaultValidationResult ReadCurrent(
        ArticleVaultScalarMetadataInput input,
        out MetadataSnapshots? snapshots)
    {
        snapshots = null;
        if (input is null || input.Binding is null)
        {
            return Invalid("input_missing");
        }

        ArticleVaultValidationResult plan = ArticleVaultSyncPlanVerifier.VerifyCurrent(
            input.Plan, input.Root, input.Articles, input.Observations, input.Context);
        if (!plan.IsValid)
        {
            return plan;
        }

        VaultConflictBinding binding = input.Binding;
        VaultSyncPlanItem[] items = input.Plan.Groups.Where(group => group.GroupIdentity == binding.GroupIdentity)
            .SelectMany(static group => group.Items).Where(item => item.OperationIdentity == binding.OperationIdentity).ToArray();
        if (items.Length != 1 || binding.SiteIdentity != input.Plan.SiteIdentity
            || binding.VaultIdentity != input.Plan.VaultIdentity || binding.DeviceIdentity != input.Plan.DeviceIdentity
            || binding.PlanCandidateIdentity != input.Plan.PlanCandidateIdentity || binding.PlanSha256 != input.Plan.ContentSha256)
        {
            return Invalid("plan_binding_drift");
        }

        VaultSyncPlanItem item = items[0];
        if (binding.PortableArticleIdentity != item.PortableArticleIdentity || binding.ServerArticleIdentity != item.ServerArticleIdentity
            || binding.ArticleManifestSha256 != item.Preconditions.ArticleManifestSha256
            || binding.ServerObservationSha256 != item.Preconditions.ServerObservationSha256
            || !CanonicalEqual(binding.Coordinates, new VaultArticleCoordinates(item.Base, item.Local, item.Server)))
        {
            return Invalid("coordinate_drift");
        }

        if (!item.Base.Present || item.Base.Deleted || !item.Local.Present || item.Local.Deleted || !item.Server.Present || item.Server.Deleted)
        {
            return Invalid("base_or_metadata_snapshot_missing");
        }

        ArticleVaultMetadataManifest baseline;
        ArticleVaultMetadataManifest local;
        ArticleVaultMetadataManifest server;
        try
        {
            baseline = ArticleVaultManifestCodec.DeserializeMetadata(input.BaseBytes.Span);
            local = ArticleVaultManifestCodec.DeserializeMetadata(input.LocalBytes.Span);
            server = ArticleVaultManifestCodec.DeserializeMetadata(input.ServerBytes.Span);
        }
        catch (InvalidDataException)
        {
            return Invalid("source_invalid");
        }

        if (!MatchesBinding(baseline, binding) || !MatchesBinding(local, binding) || !MatchesBinding(server, binding)
            || baseline.ContentSha256 != item.Base.MetadataManifestSha256
            || local.ContentSha256 != item.Local.MetadataManifestSha256 || server.ContentSha256 != item.Server.MetadataManifestSha256)
        {
            return Invalid("source_binding_mismatch");
        }

        if (baseline.TaxonomySha256 != local.TaxonomySha256 || baseline.TaxonomySha256 != server.TaxonomySha256)
        {
            return Invalid("taxonomy_mapping_missing");
        }

        if (baseline.PropertiesSha256 != local.PropertiesSha256 || baseline.PropertiesSha256 != server.PropertiesSha256)
        {
            return Invalid("property_mapping_missing");
        }

        if (item.Base.Lifecycle != item.Local.Lifecycle || item.Base.Lifecycle != item.Server.Lifecycle
            || item.Base.PermissionSha256 != item.Local.PermissionSha256 || item.Base.PermissionSha256 != item.Server.PermissionSha256
            || item.Base.DependencySha256 != item.Local.DependencySha256 || item.Base.DependencySha256 != item.Server.DependencySha256)
        {
            return Invalid("server_authority_drift");
        }

        snapshots = new(baseline, local, server);
        return ArticleVaultValidationResult.Valid();
    }

    private static bool MatchesBinding(ArticleVaultMetadataManifest metadata, VaultConflictBinding binding)
        => metadata.SiteIdentity == binding.SiteIdentity && metadata.VaultIdentity == binding.VaultIdentity
            && metadata.DeviceIdentity == binding.DeviceIdentity && metadata.PortableArticleIdentity == binding.PortableArticleIdentity
            && metadata.ServerArticleIdentity == binding.ServerArticleIdentity;

    private static bool SameMetadataIdentity(ArticleVaultMetadataManifest left, ArticleVaultMetadataManifest right)
        => left.Schema == right.Schema && left.SchemaVersion == right.SchemaVersion && left.SiteIdentity == right.SiteIdentity
            && left.VaultIdentity == right.VaultIdentity && left.DeviceIdentity == right.DeviceIdentity
            && left.PortableArticleIdentity == right.PortableArticleIdentity && left.ServerArticleIdentity == right.ServerArticleIdentity;

    private static string? Value(ArticleVaultMetadataManifest metadata, VaultConflictMetadataField field)
        => field switch
        {
            VaultConflictMetadataField.Title => metadata.Title,
            VaultConflictMetadataField.Summary => metadata.Summary,
            VaultConflictMetadataField.Slug => metadata.Slug,
            _ => throw new InvalidDataException("article_vault_scalar_metadata_field_unknown")
        };

    private static ArticleVaultMetadataManifest WithValue(ArticleVaultMetadataManifest metadata, VaultConflictMetadataField field, string? value)
        => field switch
        {
            VaultConflictMetadataField.Title => metadata with { Title = value! },
            VaultConflictMetadataField.Summary => metadata with { Summary = value },
            VaultConflictMetadataField.Slug => metadata with { Slug = value! },
            _ => throw new InvalidDataException("article_vault_scalar_metadata_field_unknown")
        };

    private static string ValueDigest(VaultConflictMetadataField field, string? value)
        => ArticleVaultManifestCodec.ComputeSha256(ArticleVaultManifestCodec.SerializeCanonical(new
        {
            Field = field,
            Value = value
        }));

    private static bool CanonicalEqual<T>(T left, T right)
        => ArticleVaultManifestCodec.SerializeCanonical(left).AsSpan().SequenceEqual(ArticleVaultManifestCodec.SerializeCanonical(right));

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid($"article_vault_scalar_metadata_{reason}");

    private static ArticleVaultScalarMetadataResult Rejected(string reason)
        => new(null, null, [], reason);

    private sealed record MetadataSnapshots(ArticleVaultMetadataManifest Base, ArticleVaultMetadataManifest Local, ArticleVaultMetadataManifest Server);
}
