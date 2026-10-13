using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Supplied canonical inputs and an owned raw-byte copy. These are caller assertions, not
/// persisted reads, authority observations, or an instruction to execute an import.
/// </summary>
public sealed class ArticlePackageManifestCandidateInput
{
    private readonly byte[] _sourceBytes;

    public ArticlePackageManifestCandidateInput(
        ArticleCanonicalInput article,
        ArticlePackageTitleSummaryBinding titleBinding,
        ArticlePropertyValueSnapshot propertySnapshot,
        ArticlePackagePropertyMappingBindings propertyBindings,
        ReadOnlySpan<byte> sourceBytes)
    {
        if (sourceBytes.Length > ArticlePackageSourceBytes.MaximumByteLength)
        {
            throw new ArgumentException("article_package_manifest_source_byte_budget_exceeded");
        }
        Article = article;
        TitleBinding = titleBinding;
        PropertySnapshot = propertySnapshot;
        PropertyBindings = propertyBindings;
        _sourceBytes = sourceBytes.ToArray();
    }

    public ArticleCanonicalInput Article
    {
        get;
    }
    public ArticlePackageTitleSummaryBinding TitleBinding
    {
        get;
    }
    public ArticlePropertyValueSnapshot PropertySnapshot
    {
        get;
    }
    public ArticlePackagePropertyMappingBindings PropertyBindings
    {
        get;
    }

    internal ReadOnlySpan<byte> SourceBytes => _sourceBytes;
}

/// <summary>Owned article projections; no target resolution, write command or permission receipt.</summary>
public sealed class ArticlePackageManifestPlannedArticle
{
    private readonly byte[] _sourceBytes;

    internal ArticlePackageManifestPlannedArticle(
        ArticlePackageManifestArticle manifest,
        ArticlePackageTitleSummaryCandidate titleSummary,
        ArticlePackagePropertyMappingCandidate properties,
        ReadOnlySpan<byte> sourceBytes)
    {
        Manifest = manifest;
        TitleSummary = titleSummary;
        Properties = properties;
        _sourceBytes = sourceBytes.ToArray();
    }

    public ArticlePackageManifestArticle Manifest
    {
        get;
    }
    public ArticlePackageTitleSummaryCandidate TitleSummary
    {
        get;
    }
    public ArticlePackagePropertyMappingCandidate Properties
    {
        get;
    }

    /// <summary>Returns a detached byte copy; a consumer cannot mutate the frozen candidate.</summary>
    public byte[] CopySourceBytes() => (byte[])_sourceBytes.Clone();
}

/// <summary>
/// Immutable pure candidate plan. Its digest binds the manifest and exact source bytes, but
/// it contains no actions, target identities, writer calls, idempotency receipt or authority.
/// </summary>
public sealed class ArticlePackageManifestCandidatePlan
{
    internal ArticlePackageManifestCandidatePlan(
        ArticlePackageManifestCandidate manifest,
        ArticlePackageManifestPlannedArticle[] articles)
    {
        Manifest = manifest;
        Articles = Array.AsReadOnly((ArticlePackageManifestPlannedArticle[])articles.Clone());
    }

    public ArticlePackageManifestCandidate Manifest
    {
        get;
    }
    public IReadOnlyList<ArticlePackageManifestPlannedArticle> Articles
    {
        get;
    }

    /// <summary>
    /// Pure self-consistency never admits a complete package. Asset, syntax, reference, rights,
    /// responsibility, privacy and persisted-source authorities have not been integrated here.
    /// </summary>
    public ArticlePackageManifestCandidateResult RequirePackageAuthority()
        => new(false, "article_package_manifest_authority_unavailable");
}

/// <summary>
/// Reuses the canonical text and eight-type mappers, verifies raw Markdown bytes, and freezes
/// a bounded candidate set. This component reads no stores or archives and performs no writes.
/// </summary>
public static partial class ArticlePackageManifestCandidatePlanner
{
    public const long MaxTotalSourceBytes = 64L * 1024 * 1024;
    public const long MaxTotalTextCodeUnits = 16L * 1024 * 1024;
    public const int MaxTotalPropertyValues = 20000;
    public const int MaxTotalPropertyBindings = 20000;
    public const int MaxTotalProjectedIdentities = 20000;
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    public static ArticlePackageManifestCandidateResult TryCreateCandidatePlan(
        IReadOnlyList<ArticlePackageManifestCandidateInput>? inputs,
        out ArticlePackageManifestCandidatePlan? plan)
    {
        plan = null;
        if (inputs is null)
        {
            return Invalid("article_package_manifest_input_invalid");
        }
        int count = inputs.Count;
        if (count is < 1 or > ArticlePackageManifestCandidateCodec.MaxArticles)
        {
            return Invalid("article_package_manifest_article_budget_exceeded");
        }
        try
        {
            // Freeze count once and use bounded indexes: a hostile collection cannot extend traversal.
            var articles = new ArticlePackageManifestPlannedArticle[count];
            var entries = new ArticlePackageManifestArticle[count];
            var ownedInputs = new ArticlePackageManifestCandidateInput[count];
            for (int index = 0; index < count; index++)
            {
                ArticlePackageManifestCandidateInput input = inputs[index];
                if (input is null || input.Article is null || input.TitleBinding is null
                    || input.PropertySnapshot is null || input.PropertyBindings is null)
                {
                    return Invalid("article_package_manifest_input_invalid");
                }
                ownedInputs[index] = input;
            }
            ArticlePackageManifestCandidateResult preflight = Preflight(ownedInputs);
            if (!preflight.IsValid)
            {
                return preflight;
            }
            for (int index = 0; index < count; index++)
            {
                ArticlePackageManifestCandidateInput input = ownedInputs[index];
                ArticlePackageManifestCandidateResult result = TryProject(input, out var article);
                if (!result.IsValid || article is null)
                {
                    return result;
                }
                articles[index] = article;
                entries[index] = article.Manifest;
            }
            ArticlePackageManifestCandidateResult validation = ArticlePackageManifestCandidateCodec.TryCreateCandidate(entries, out var manifest);
            if (!validation.IsValid || manifest is null)
            {
                return validation;
            }
            Array.Sort(articles, static (left, right) => string.CompareOrdinal(
                left.Manifest.PortableArticle.Value, right.Manifest.PortableArticle.Value));
            plan = new ArticlePackageManifestCandidatePlan(manifest, articles);
            return new(true, null);
        }
        catch (ArgumentException)
        {
            return Invalid("article_package_manifest_input_invalid");
        }
        catch (IndexOutOfRangeException)
        {
            return Invalid("article_package_manifest_input_invalid");
        }
    }

    /// <summary>
    /// Reprojects actual supplied sources and bytes rather than trusting a copied manifest digest.
    /// No partial plan escapes a failed or incomplete binding.
    /// </summary>
    public static ArticlePackageManifestCandidateResult TryBindCandidatePlan(
        ArticlePackageManifestCandidate? manifest,
        IReadOnlyList<ArticlePackageManifestCandidateInput>? inputs,
        out ArticlePackageManifestCandidatePlan? plan)
    {
        plan = null;
        if (manifest is null)
        {
            return Invalid("article_package_manifest_input_invalid");
        }
        ArticlePackageManifestCandidateResult manifestResult = ArticlePackageManifestCandidateCodec.TryCreateCandidate(
            manifest.Articles, out var revalidated);
        if (!manifestResult.IsValid || revalidated is null
            || !string.Equals(manifest.SemanticDigest, revalidated.SemanticDigest, StringComparison.Ordinal))
        {
            return Invalid("article_package_manifest_candidate_mismatch");
        }
        ArticlePackageManifestCandidateResult result = TryCreateCandidatePlan(inputs, out var expected);
        if (!result.IsValid || expected is null)
        {
            return result;
        }
        if (!string.Equals(manifest.SemanticDigest, expected.Manifest.SemanticDigest, StringComparison.Ordinal))
        {
            return Invalid("article_package_manifest_source_mismatch");
        }
        plan = expected;
        return new(true, null);
    }

    private static ArticlePackageManifestCandidateResult TryProject(
        ArticlePackageManifestCandidateInput input,
        out ArticlePackageManifestPlannedArticle? article)
    {
        article = null;
        ArticlePackageTitleSummaryMappingResult textResult = ArticlePackageTitleSummaryMapper.TryMapCandidate(
            input.Article, input.TitleBinding, out var text);
        if (!textResult.IsValid || text is null)
        {
            return Invalid(textResult.ReasonCode!);
        }
        ArticlePackagePropertyMappingResult propertyResult = ArticlePackagePropertyMapper.TryMapCandidate(
            input.PropertySnapshot, input.PropertyBindings, out var properties);
        if (!propertyResult.IsValid || properties is null)
        {
            return Invalid(propertyResult.ReasonCode!);
        }
        // Even empty ArticleReference sets lack an integrated observation provider. Do not
        // substitute self-sealed relation facts for required canonical reference authority.
        if (input.PropertyBindings.Articles.Count != 0
            || input.PropertySnapshot.Values.Any(static value => value.Value is ArticlePropertyArticleReferenceValue))
        {
            return Invalid("article_package_manifest_reference_authority_unavailable");
        }
        ArticlePropertySnapshotCoordinates coordinates = properties.SourceCoordinates;
        if (coordinates.ArticleId != text.SourceArticleId || coordinates.ArticleRevisionId != text.SourceRevisionId)
        {
            return Invalid("article_package_manifest_revision_mismatch");
        }
        if (coordinates.DraftId.HasValue)
        {
            return Invalid("article_package_manifest_draft_authority_unavailable");
        }
        if (coordinates.PublicationId.HasValue)
        {
            return Invalid("article_package_manifest_publication_authority_unavailable");
        }
        ArticlePackageByteValidationResult byteResult = ArticlePackageSourceBytes.Inspect(input.SourceBytes, out var metadata);
        if (!byteResult.IsValid || metadata is null)
        {
            return Invalid(byteResult.ReasonCode!);
        }
        ReadOnlySpan<byte> content = metadata.HasUtf8Bom ? input.SourceBytes[3..] : input.SourceBytes;
        if (!string.Equals(s_utf8.GetString(content), input.Article.MarkdownContent, StringComparison.Ordinal))
        {
            return Invalid("article_package_manifest_markdown_bytes_mismatch");
        }
        var source = new ArticlePackageManifestSource(text.SourceArticleId, text.SourceRevisionId,
            text.SourceRevisionNo, text.SourceCanonicalHash, coordinates.SiteScope, coordinates.PropertyRevision,
            coordinates.DraftId, coordinates.DraftServerRevision, coordinates.PublicationId);
        var lifecycle = new ArticlePackageManifestLifecycle(input.Article.Status,
            input.Article.PublishedAt, input.Article.ScheduledPublishAt);
        var entry = new ArticlePackageManifestArticle(text.PortableArticle, source, text.Title, text.Summary,
            text.MappingDigest, properties.SourceSnapshotDigest, properties.MappingDigest, metadata, lifecycle);
        article = new ArticlePackageManifestPlannedArticle(entry, text, properties, input.SourceBytes);
        return new(true, null);
    }

    private static ArticlePackageManifestCandidateResult Preflight(ArticlePackageManifestCandidateInput[] inputs)
    {
        long totalBytes = 0;
        long totalText = 0;
        long totalValues = 0;
        long totalBindings = 0;
        long totalIdentities = 0;
        var definitions = new Dictionary<Guid, ArticlePackagePropertyDefinitionBinding>();
        var portableDefinitions = new Dictionary<ArticlePackageIdentity, Guid>();
        var options = new Dictionary<(Guid Definition, Guid Option), ArticlePackageIdentity>();
        var portableOptions = new Dictionary<ArticlePackageIdentity, (Guid Definition, Guid Option)>();
        ArticlePropertySnapshotCoordinates scope = inputs[0].PropertySnapshot.Coordinates;
        foreach (ArticlePackageManifestCandidateInput input in inputs)
        {
            ArticleCanonicalInput source = input.Article;
            ArticlePropertyValueSnapshot snapshot = input.PropertySnapshot;
            ArticlePackagePropertyMappingBindings bindings = input.PropertyBindings;
            if (snapshot.Coordinates.DefinitionOwnerUserId != scope.DefinitionOwnerUserId
                || !string.Equals(snapshot.Coordinates.SiteScope, scope.SiteScope, StringComparison.Ordinal))
            {
                return Invalid("article_package_manifest_source_scope_mismatch");
            }
            int valueCount = snapshot.Values.Count;
            if (valueCount > ArticlePackagePropertyMappingLimits.MaxDefinitions)
            {
                return Invalid("article_package_manifest_property_budget_exceeded");
            }
            totalBytes += input.SourceBytes.Length;
            totalText += (long)(source.Title?.Length ?? 0) + (source.Summary?.Length ?? 0)
                + (source.MarkdownContent?.Length ?? 0) + (source.PublicRouteKey?.Length ?? 0)
                + (source.CoverImageUrl?.Length ?? 0);
            totalValues += valueCount;
            totalBindings += (long)bindings.Definitions.Count + bindings.Options.Count + bindings.Articles.Count;
            for (int index = 0; index < valueCount; index++)
            {
                ArticlePropertyValueEntry value = snapshot.Values[index];
                if (value is null)
                {
                    return Invalid("article_package_manifest_input_invalid");
                }
                totalText += value.Value switch
                {
                    ArticlePropertyTextValue text => text.Text?.Length ?? 0,
                    ArticlePropertyUrlValue url => url.Url?.Length ?? 0,
                    _ => 0
                };
                totalIdentities += value.Value switch
                {
                    ArticlePropertyMultiSelectValue multi => multi.OptionIds.Count,
                    ArticlePropertyArticleReferenceValue references => references.ArticleIds.Count,
                    ArticlePropertySingleSelectValue => 1,
                    _ => 0
                };
            }
            if (totalBytes > MaxTotalSourceBytes)
            {
                return Invalid("article_package_manifest_source_byte_budget_exceeded");
            }
            if (totalText > MaxTotalTextCodeUnits || totalValues > MaxTotalPropertyValues
                || totalBindings > MaxTotalPropertyBindings || totalIdentities > MaxTotalProjectedIdentities)
            {
                return Invalid("article_package_manifest_property_budget_exceeded");
            }
            foreach (ArticlePackagePropertyDefinitionBinding definition in bindings.Definitions)
            {
                if (definitions.TryGetValue(definition.SourceDefinitionId, out var existing)
                    && (existing.PortableDefinition != definition.PortableDefinition
                        || existing.SourceSchemaRevision != definition.SourceSchemaRevision
                        || !string.Equals(existing.SourceDefinitionDigest, definition.SourceDefinitionDigest, StringComparison.Ordinal))
                    || portableDefinitions.TryGetValue(definition.PortableDefinition, out Guid sourceDefinition)
                        && sourceDefinition != definition.SourceDefinitionId)
                {
                    return Invalid("article_package_manifest_definition_binding_conflict");
                }
                definitions[definition.SourceDefinitionId] = definition;
                portableDefinitions[definition.PortableDefinition] = definition.SourceDefinitionId;
            }
            foreach (ArticlePackagePropertyOptionBinding option in bindings.Options)
            {
                var key = (option.SourceDefinitionId, option.SourceOptionId);
                if (options.TryGetValue(key, out ArticlePackageIdentity existing) && existing != option.PortableOption
                    || portableOptions.TryGetValue(option.PortableOption, out var sourceOption) && sourceOption != key)
                {
                    return Invalid("article_package_manifest_option_binding_conflict");
                }
                options[key] = option.PortableOption;
                portableOptions[option.PortableOption] = key;
            }
        }
        return new(true, null);
    }

    private static ArticlePackageManifestCandidateResult Invalid(string reason) => new(false, reason);
}
