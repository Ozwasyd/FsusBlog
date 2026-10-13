using System.Collections.Immutable;
using System.Globalization;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>Actual typed candidate and explicit owner-supplied bindings; neither is persisted authority.</summary>
public sealed record ArticleVaultPropertySnapshotInput(
    ArticlePropertyValueSnapshot Snapshot,
    ArticlePackagePropertyMappingBindings Bindings);

/// <summary>Original current source admission plus three closed metadata and typed property snapshots.</summary>
public sealed record ArticleVaultPropertyMetadataInput(
    ArticleVaultSourceAdmissionInput Source,
    ReadOnlyMemory<byte> BaseMetadataBytes,
    ReadOnlyMemory<byte> LocalMetadataBytes,
    ReadOnlyMemory<byte> ServerMetadataBytes,
    ArticleVaultPropertySnapshotInput Base,
    ArticleVaultPropertySnapshotInput Local,
    ArticleVaultPropertySnapshotInput Server);

/// <summary>Closed provenance of a pure proposal; these choices grant no write or resolution permission.</summary>
public enum VaultPropertyChoiceOrigin
{
    Base = 1,
    Local,
    Server,
    Equivalent,
    MergedOptions
}

/// <summary>Selected existing row, or a sorted definition-scoped portable option set derived from all three rows.</summary>
public sealed record ArticleVaultPropertyChoice(
    ArticlePackageIdentity PortableDefinition,
    VaultPropertyChoiceOrigin Origin,
    ImmutableArray<ArticlePackageIdentity> MergedOptions);

/// <summary>
/// Immutable portable computation only. Original mapped rows retain presence, default, typed payload,
/// source value/definition epochs and digests. No article/property revision is created here.
/// </summary>
public sealed class ArticleVaultPropertyMetadataCandidate(
    VaultConflictBinding binding,
    ArticlePackagePropertyMappingCandidate baseline,
    ArticlePackagePropertyMappingCandidate local,
    ArticlePackagePropertyMappingCandidate server,
    ImmutableArray<ArticleVaultPropertyChoice> choices,
    string contentSha256)
{
    public VaultConflictBinding Binding { get; } = binding;
    public ArticlePackagePropertyMappingCandidate Base { get; } = baseline;
    public ArticlePackagePropertyMappingCandidate Local { get; } = local;
    public ArticlePackagePropertyMappingCandidate Server { get; } = server;
    public ImmutableArray<ArticleVaultPropertyChoice> Choices { get; } = choices;
    public string ContentSha256 { get; } = contentSha256;
    public bool RequiresCurrentDefinitionAndRightsAdmission => true;
}

/// <summary>Same-property overlap remains explicit, without selecting a generic winner.</summary>
public sealed record ArticleVaultPropertyMetadataResult(
    ArticleVaultPropertyMetadataCandidate? Candidate,
    ImmutableArray<ArticlePackageIdentity> OverlappingDefinitions,
    string? ReasonCode);

/// <summary>
/// Pure typed property computation through the canonical mapper. It admits actual bytes and original
/// plan coordinates but cannot establish authorized persisted reads, current definitions or rights.
/// Draft/publication coordinates have no Vault context mapping and are explicitly refused.
/// </summary>
public static class ArticleVaultPropertyMetadataMerge
{
    public const string DigestDomain = "fsusblog.article-vault.property-metadata-proposal.v1";

    public static ArticleVaultPropertyMetadataResult Build(ArticleVaultPropertyMetadataInput? input)
    {
        ArticleVaultValidationResult read = ReadCurrent(input, out MappedSnapshots? current);
        if (!read.IsValid)
        {
            return new(null, [], read.ReasonCode);
        }

        ArticleVaultValidationResult computed = ComputeChoices(current!, out ImmutableArray<ArticleVaultPropertyChoice> choices,
            out ImmutableArray<ArticlePackageIdentity> overlaps);
        if (!computed.IsValid)
        {
            return new(null, overlaps, computed.ReasonCode);
        }

        ArticleVaultPropertyMetadataCandidate unsealed = new(input!.Source.Binding, current!.Base,
            current.Local, current.Server, choices, string.Empty);
        return new(new(unsealed.Binding, unsealed.Base, unsealed.Local, unsealed.Server, choices,
            ComputeContentSha256(unsealed)), [], null);
    }

    /// <summary>Rereads original bytes, remaps actual typed inputs and recomputes every choice; never calls Build.</summary>
    public static ArticleVaultValidationResult VerifyCurrentCandidate(
        ArticleVaultPropertyMetadataInput? input,
        ArticleVaultPropertyMetadataCandidate? candidate)
    {
        ArticleVaultValidationResult read = ReadCurrent(input, out MappedSnapshots? current);
        if (!read.IsValid)
        {
            return read;
        }

        if (candidate is null || candidate.Binding != input!.Source.Binding
            || candidate.Choices.IsDefault || candidate.Choices.Length > ArticlePackagePropertyMappingLimits.MaxDefinitions
            || candidate.Base is null || candidate.Local is null || candidate.Server is null
            || candidate.Choices.Any(static choice => choice is null || !Enum.IsDefined(choice.Origin) || choice.MergedOptions.IsDefault))
        {
            return Invalid("candidate_invalid");
        }

        foreach ((ArticleVaultPropertySnapshotInput actual, ArticlePackagePropertyMappingCandidate claimed) in new[]
        {
            (input.Base, candidate.Base), (input.Local, candidate.Local), (input.Server, candidate.Server)
        })
        {
            ArticlePackagePropertyMappingResult mapping = ArticlePackagePropertyMapper.ValidateCandidate(actual.Snapshot, actual.Bindings, claimed);
            if (!mapping.IsValid)
            {
                return ArticleVaultValidationResult.Invalid(mapping.ReasonCode!);
            }
        }

        ArticleVaultValidationResult computed = ComputeChoices(current!, out ImmutableArray<ArticleVaultPropertyChoice> expected, out _);
        if (!computed.IsValid)
        {
            return computed;
        }

        if (candidate.Choices.Length != expected.Length)
        {
            return Invalid("candidate_choice_mismatch");
        }

        for (int index = 0; index < expected.Length; index++)
        {
            ArticleVaultPropertyChoice actual = candidate.Choices[index];
            ArticleVaultPropertyChoice wanted = expected[index];
            if (actual.PortableDefinition != wanted.PortableDefinition || actual.Origin != wanted.Origin
                || !actual.MergedOptions.SequenceEqual(wanted.MergedOptions))
            {
                return Invalid("candidate_choice_mismatch");
            }
        }

        return candidate.ContentSha256 == ComputeContentSha256(candidate)
            ? ArticleVaultValidationResult.Valid() : Invalid("candidate_digest_mismatch");
    }

    /// <summary>A proposal never substitutes for current definition/rights, persisted reads or writer admission.</summary>
    public static ArticleVaultValidationResult RequireExecutionAdmission(
        ArticleVaultPropertyMetadataInput input, ArticleVaultPropertyMetadataCandidate? candidate)
    {
        ArticleVaultValidationResult validity = VerifyCurrentCandidate(input, candidate);
        return !validity.IsValid ? validity : Invalid("current_definition_rights_and_persisted_reader_missing");
    }

    public static string ComputeContentSha256(ArticleVaultPropertyMetadataCandidate candidate)
        => ArticleVaultExecutionIntegrity.Digest(new
        {
            Domain = DigestDomain,
            candidate.Binding,
            BaseMapping = candidate.Base.MappingDigest,
            LocalMapping = candidate.Local.MappingDigest,
            ServerMapping = candidate.Server.MappingDigest,
            candidate.Choices
        });

    private static ArticleVaultValidationResult ReadCurrent(ArticleVaultPropertyMetadataInput? input, out MappedSnapshots? mapped)
    {
        mapped = null;
        if (input is null || input.Source is null || input.Base?.Snapshot is null
            || input.Local?.Snapshot is null || input.Server?.Snapshot is null)
        {
            return Invalid("input_missing");
        }

        ArticleVaultSourceAdmissionResult source = ArticleVaultAdmittedSource.AdmitCurrent(input.Source);
        if (source.Source is null)
        {
            return ArticleVaultValidationResult.Invalid(source.ReasonCode!);
        }

        VaultConflictBinding binding = source.Source.Binding;
        if (!int.TryParse(binding.ServerArticleIdentity, NumberStyles.None, CultureInfo.InvariantCulture, out int articleId)
            || articleId <= 0 || binding.ServerArticleIdentity != articleId.ToString(CultureInfo.InvariantCulture))
        {
            return Invalid("server_article_identity_mapping_missing");
        }

        ArticleVaultMetadataManifest[] metadata;
        try
        {
            metadata = [ArticleVaultManifestCodec.DeserializeMetadata(input.BaseMetadataBytes.Span),
                ArticleVaultManifestCodec.DeserializeMetadata(input.LocalMetadataBytes.Span),
                ArticleVaultManifestCodec.DeserializeMetadata(input.ServerMetadataBytes.Span)];
        }
        catch (InvalidDataException)
        {
            return Invalid("metadata_bytes_invalid");
        }

        ArticleVaultPropertySnapshotInput[] typed = [input.Base, input.Local, input.Server];
        VaultArticleCoordinate[] coordinates = [binding.Coordinates.Base, binding.Coordinates.Local, binding.Coordinates.Server];
        var candidates = new ArticlePackagePropertyMappingCandidate[3];
        for (int index = 0; index < typed.Length; index++)
        {
            ArticleVaultMetadataManifest meta = metadata[index];
            ArticlePropertyValueSnapshot snapshot = typed[index].Snapshot;
            ArticlePropertySnapshotCoordinates propertyCoordinates = snapshot.Coordinates;
            if (meta.SiteIdentity != binding.SiteIdentity || meta.VaultIdentity != binding.VaultIdentity
                || meta.DeviceIdentity != binding.DeviceIdentity || meta.PortableArticleIdentity != binding.PortableArticleIdentity
                || meta.ServerArticleIdentity != binding.ServerArticleIdentity || meta.ContentSha256 != coordinates[index].MetadataManifestSha256
                || meta.PropertiesSha256 != snapshot.ContentDigest || propertyCoordinates.SiteScope != binding.SiteIdentity
                || propertyCoordinates.ArticleId != articleId || propertyCoordinates.ArticleRevisionId != coordinates[index].ServerRevision)
            {
                return Invalid("snapshot_binding_drift");
            }

            if (propertyCoordinates.DraftId.HasValue || propertyCoordinates.DraftServerRevision.HasValue || propertyCoordinates.PublicationId.HasValue)
            {
                return Invalid("snapshot_context_mapping_missing");
            }

            if (propertyCoordinates.DefinitionOwnerUserId != input.Base.Snapshot.Coordinates.DefinitionOwnerUserId
                || meta.TaxonomySha256 != metadata[0].TaxonomySha256
                || coordinates[index].Lifecycle != coordinates[0].Lifecycle
                || coordinates[index].PermissionSha256 != coordinates[0].PermissionSha256
                || coordinates[index].DependencySha256 != coordinates[0].DependencySha256)
            {
                return Invalid("definition_scope_or_server_authority_drift");
            }

            ArticlePackagePropertyMappingResult result = ArticlePackagePropertyMapper.TryMapCandidate(snapshot, typed[index].Bindings, out ArticlePackagePropertyMappingCandidate? candidate);
            if (!result.IsValid)
            {
                return ArticleVaultValidationResult.Invalid(result.ReasonCode!);
            }

            candidates[index] = candidate!;
        }

        // The mapper checks closure within a snapshot; reject aliases across the three explicit scopes too.
        var byPortable = new Dictionary<ArticlePackageIdentity, (Guid Definition, Guid Option)>();
        var bySource = new Dictionary<(Guid Definition, Guid Option), ArticlePackageIdentity>();
        foreach (ArticlePackagePropertyOptionBinding option in typed.SelectMany(static snapshot => snapshot.Bindings.Options))
        {
            var key = (option.SourceDefinitionId, option.SourceOptionId);
            if (byPortable.TryGetValue(option.PortableOption, out var previous) && previous != key
                || bySource.TryGetValue(key, out ArticlePackageIdentity previousPortable) && previousPortable != option.PortableOption)
            {
                return Invalid("option_definition_mapping_collision");
            }

            byPortable[option.PortableOption] = key;
            bySource[key] = option.PortableOption;
        }

        var articlesByPortable = new Dictionary<ArticlePackageIdentity, long>();
        var articlesBySource = new Dictionary<long, ArticlePackageIdentity>();
        foreach (ArticlePackagePropertyArticleBinding article in typed.SelectMany(static snapshot => snapshot.Bindings.Articles))
        {
            if (articlesByPortable.TryGetValue(article.PortableArticle, out long previousSource) && previousSource != article.SourceArticleId
                || articlesBySource.TryGetValue(article.SourceArticleId, out ArticlePackageIdentity previousIdentity) && previousIdentity != article.PortableArticle)
            {
                return Invalid("article_reference_mapping_collision");
            }

            articlesByPortable[article.PortableArticle] = article.SourceArticleId;
            articlesBySource[article.SourceArticleId] = article.PortableArticle;
        }

        mapped = new(candidates[0], candidates[1], candidates[2]);
        return ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult ComputeChoices(MappedSnapshots current,
        out ImmutableArray<ArticleVaultPropertyChoice> choices, out ImmutableArray<ArticlePackageIdentity> overlaps)
    {
        choices = [];
        overlaps = [];
        if (!current.Base.Properties.Select(static row => row.PortableDefinition).SequenceEqual(current.Local.Properties.Select(static row => row.PortableDefinition))
            || !current.Base.Properties.Select(static row => row.PortableDefinition).SequenceEqual(current.Server.Properties.Select(static row => row.PortableDefinition)))
        {
            return Invalid("definition_membership_mapping_missing");
        }

        var selected = ImmutableArray.CreateBuilder<ArticleVaultPropertyChoice>();
        var conflicting = ImmutableArray.CreateBuilder<ArticlePackageIdentity>();
        for (int index = 0; index < current.Base.Properties.Count; index++)
        {
            ArticlePackageMappedProperty baseline = current.Base.Properties[index];
            ArticlePackageMappedProperty local = current.Local.Properties[index];
            ArticlePackageMappedProperty server = current.Server.Properties[index];
            if (baseline.SourceDefinitionId != local.SourceDefinitionId || baseline.SourceDefinitionId != server.SourceDefinitionId
                || baseline.SourceSchemaRevision != local.SourceSchemaRevision || baseline.SourceSchemaRevision != server.SourceSchemaRevision
                || baseline.SourceDefinitionDigest != local.SourceDefinitionDigest || baseline.SourceDefinitionDigest != server.SourceDefinitionDigest)
            {
                return Invalid("definition_schema_drift");
            }

            if (baseline.DefaultApplied != local.DefaultApplied || baseline.DefaultApplied != server.DefaultApplied)
            {
                return Invalid("default_provenance_conflict");
            }

            int[] types = new[] { baseline, local, server }.Where(static row => row.Projection is not null)
                .Select(static row => ProjectionType(row.Projection!)).Distinct().ToArray();
            if (types.Length > 1)
            {
                return Invalid("typed_value_conflict");
            }

            VaultPropertyChoiceOrigin origin;
            ImmutableArray<ArticlePackageIdentity> options = [];
            if (local.PortableValueDigest == server.PortableValueDigest)
            {
                origin = local.PortableValueDigest == baseline.PortableValueDigest ? VaultPropertyChoiceOrigin.Base : VaultPropertyChoiceOrigin.Equivalent;
            }
            else if (local.PortableValueDigest == baseline.PortableValueDigest)
            {
                origin = VaultPropertyChoiceOrigin.Server;
            }
            else if (server.PortableValueDigest == baseline.PortableValueDigest)
            {
                origin = VaultPropertyChoiceOrigin.Local;
            }
            else if (baseline.Projection is ArticlePackageMultiOptionPropertyProjection baseOptions
                && local.Projection is ArticlePackageMultiOptionPropertyProjection localOptions
                && server.Projection is ArticlePackageMultiOptionPropertyProjection serverOptions)
            {
                var baseSet = baseOptions.Options.ToHashSet();
                var localSet = localOptions.Options.ToHashSet();
                var serverSet = serverOptions.Options.ToHashSet();
                options = baseSet.Where(option => localSet.Contains(option) && serverSet.Contains(option))
                    .Concat(localSet.Except(baseSet)).Concat(serverSet.Except(baseSet)).Distinct()
                    .OrderBy(static option => option.Value, StringComparer.Ordinal).ToImmutableArray();
                if (options.Length > ArticlePackagePropertyMappingLimits.MaxOptionsPerValue)
                {
                    return Invalid("merged_option_budget_exceeded");
                }
                origin = VaultPropertyChoiceOrigin.MergedOptions;
            }
            else
            {
                conflicting.Add(baseline.PortableDefinition);
                continue;
            }

            selected.Add(new(baseline.PortableDefinition, origin, options));
        }

        overlaps = conflicting.ToImmutable();
        if (!overlaps.IsEmpty)
        {
            return Invalid("overlap");
        }

        choices = selected.ToImmutable();
        return ArticleVaultValidationResult.Valid();
    }

    private static ArticleVaultValidationResult Invalid(string reason)
        => ArticleVaultValidationResult.Invalid($"article_vault_property_metadata_{reason}");

    private static int ProjectionType(ArticlePackagePropertyProjection projection)
        => projection switch
        {
            ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyTextValue } => 1,
            ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyNumberValue } => 2,
            ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyBooleanValue } => 3,
            ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyDateValue } => 4,
            ArticlePackagePrimitivePropertyProjection { Value: ArticlePropertyUrlValue } => 5,
            ArticlePackageSingleOptionPropertyProjection => 6,
            ArticlePackageMultiOptionPropertyProjection => 7,
            ArticlePackageArticleReferencePropertyProjection => 8,
            _ => throw new InvalidDataException("article_vault_property_metadata_projection_unknown")
        };

    private sealed record MappedSnapshots(
        ArticlePackagePropertyMappingCandidate Base,
        ArticlePackagePropertyMappingCandidate Local,
        ArticlePackagePropertyMappingCandidate Server);
}
