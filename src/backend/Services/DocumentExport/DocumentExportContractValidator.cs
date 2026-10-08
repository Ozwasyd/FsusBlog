using System.Collections.Immutable;
using System.Text.RegularExpressions;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Independent fail-closed validator for document-export catalog, frozen input
/// and task identities. Unknown schemas, states, formats and drift are rejected.
/// </summary>
public static partial class DocumentExportContractValidator
{
    private const int MaximumIdentifierLength = 160;
    private static readonly HashSet<string> s_embeddableImageMediaTypes = new(StringComparer.Ordinal)
    {
        "image/avif",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp"
    };

    public static DocumentExportFrozenInput Seal(DocumentExportFrozenInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        DocumentExportFrozenInput owned = input with
        {
            MarkdownUtf8 = input.MarkdownUtf8.AsSpan().ToArray().ToImmutableArray(),
            Assets = input.Assets
                .Select(asset => asset with { Bytes = asset.Bytes.AsSpan().ToArray().ToImmutableArray() })
                .ToImmutableArray(),
            FrozenEmbeds = DocumentExportFrozenEmbedContract.Own(input.FrozenEmbeds)
        };
        DocumentExportFrozenInput unsigned = owned with
        {
            ContentDigest = string.Empty
        };
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    public static DocumentExportTask Seal(DocumentExportTask task)
    {
        ArgumentNullException.ThrowIfNull(task);
        DocumentExportTask unsigned = task with
        {
            ContentDigest = string.Empty
        };
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    public static DocumentExportProviderReceipt Seal(DocumentExportProviderReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        DocumentExportProviderReceipt unsigned = receipt with
        {
            ContentDigest = string.Empty
        };
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    public static void ValidateCatalog(IReadOnlyList<DocumentExportProviderContract> providers)
        => ValidateCatalog(
            providers,
            DocumentExportContractCatalog.ExecutionBindings,
            DocumentExportContractCatalog.Normalizations,
            DocumentExportContractCatalog.StaticGovernance);

    public static void ValidateCatalog(
        IReadOnlyList<DocumentExportProviderContract> providers,
        IReadOnlyList<DocumentExportProviderExecutionBinding> executionBindings,
        IReadOnlyList<DocumentExportNormalizationContract> normalizations,
        DocumentExportStaticGovernance staticGovernance)
    {
        ArgumentNullException.ThrowIfNull(providers);
        ArgumentNullException.ThrowIfNull(executionBindings);
        ArgumentNullException.ThrowIfNull(normalizations);
        ArgumentNullException.ThrowIfNull(staticGovernance);
        if (providers.Count != DocumentExportContractCatalog.FormatIds.Count)
        {
            throw new InvalidOperationException("Document export catalog must contain exactly four formats.");
        }

        var formats = new HashSet<string>(StringComparer.Ordinal);
        var providerIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (DocumentExportProviderContract provider in providers)
        {
            DocumentExportProviderContract canonical = DocumentExportContractCatalog.Providers.SingleOrDefault(
                candidate => string.Equals(candidate.FormatId, provider.FormatId, StringComparison.Ordinal))
                ?? throw new InvalidOperationException($"Unknown document export format '{provider.FormatId}'.");
            if (!formats.Add(provider.FormatId)
                || !providerIds.Add(provider.ProviderId)
                || !DocumentExportContractCatalog.FormatIds.Contains(provider.FormatId, StringComparer.Ordinal))
            {
                throw new InvalidOperationException("Document export formats and providers must be exact and unique.");
            }
            if (string.IsNullOrWhiteSpace(provider.ProviderOwner)
                || string.IsNullOrWhiteSpace(provider.ProviderVersion)
                || string.IsNullOrWhiteSpace(provider.OutputMediaType)
                || provider.OutputExtension.Length < 2
                || provider.OutputExtension[0] != '.'
                || provider.InputSchema != DocumentExportContractCatalog.InputSchema
                || provider.ResultSchema != DocumentExportContractCatalog.ResultSchema
                || provider.SandboxClass != DocumentExportContractCatalog.SandboxClass
                || provider.NetworkPolicy != DocumentExportContractCatalog.NetworkPolicy
                || string.IsNullOrWhiteSpace(provider.RendererId)
                || string.IsNullOrWhiteSpace(provider.RendererVersion)
                || string.IsNullOrWhiteSpace(provider.ToolchainId)
                || string.IsNullOrWhiteSpace(provider.ToolchainVersion)
                || string.IsNullOrWhiteSpace(provider.NormalizationPolicy))
            {
                throw new InvalidOperationException($"Document export provider '{provider.ProviderId}' is incomplete.");
            }
            if (provider.ProviderId != canonical.ProviderId
                || provider.ProviderOwner != canonical.ProviderOwner
                || provider.ProviderVersion != canonical.ProviderVersion
                || provider.OutputMediaType != canonical.OutputMediaType
                || provider.OutputExtension != canonical.OutputExtension
                || provider.RendererId != canonical.RendererId
                || provider.RendererVersion != canonical.RendererVersion
                || provider.InputSchema != canonical.InputSchema
                || provider.ResultSchema != canonical.ResultSchema
                || provider.SandboxClass != canonical.SandboxClass
                || provider.NetworkPolicy != canonical.NetworkPolicy
                || provider.ToolchainId != canonical.ToolchainId
                || provider.ToolchainVersion != canonical.ToolchainVersion
                || provider.NormalizationPolicy != canonical.NormalizationPolicy
                || provider.ImplementationAvailable != canonical.ImplementationAvailable
                || provider.Budgets != canonical.Budgets
                || provider.Delivery != canonical.Delivery
                || !provider.Features.SequenceEqual(canonical.Features))
            {
                throw new InvalidOperationException($"Document export provider '{provider.ProviderId}' registry identity drifted.");
            }

            ValidateBudgets(provider.Budgets);
            ValidateDelivery(provider.Delivery);
            ValidateFeatures(provider.Features);
        }

        if (!formats.SetEquals(DocumentExportContractCatalog.FormatIds))
        {
            throw new InvalidOperationException("Document export catalog format set drifted.");
        }
        if (providers.Count(provider => provider.ImplementationAvailable) != 1
            || !DocumentExportContractCatalog.RequireProvider("self-contained-html").ImplementationAvailable)
        {
            throw new InvalidOperationException("Only the self-contained HTML provider may be active in this slice.");
        }

        ValidateExecutionBindings(providers, executionBindings);
        ValidateNormalizations(providers, normalizations);
        ValidateStaticGovernance(staticGovernance);
    }

    public static void Validate(DocumentExportFrozenInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        RequireExact(input.Schema, DocumentExportContractCatalog.InputSchema, nameof(input));
        RequireIdentifier(input.InputId, nameof(input.InputId));
        RequireOwnerScope(input.UserId, input.SiteScope);

        ValidateCoordinate(input.Coordinate);
        if (input.MarkdownUtf8.Length == 0 || input.MarkdownUtf8.Length > 32L * 1024 * 1024)
        {
            throw new ArgumentException("Frozen Markdown bytes must be non-empty and within the input budget.", nameof(input));
        }
        if (!string.Equals(input.SourceDigest, DocumentExportDigest.ComputeBytes(input.MarkdownUtf8.AsSpan()), StringComparison.Ordinal))
        {
            throw new InvalidDataException("Frozen document export source digest mismatch.");
        }

        RequireDigest(input.MetadataDigest, nameof(input.MetadataDigest));
        RequireDigest(input.PropertyDigest, nameof(input.PropertyDigest));
        RequireDigest(input.RendererDigest, nameof(input.RendererDigest));
        RequireIdentifier(input.RendererId, nameof(input.RendererId));
        RequireIdentifier(input.RendererVersion, nameof(input.RendererVersion));
        RequireIdentifier(input.LayoutProfile, nameof(input.LayoutProfile));
        RequireIdentifier(input.ThemeProfile, nameof(input.ThemeProfile));
        RequireIdentifier(input.Locale, nameof(input.Locale));
        if (input.ReadingStyleAuthorityDigest != DocumentExportReadingStyleAuthority.AuthorityDigest
            || input.LayoutProfile != DocumentExportReadingStyleAuthority.LayoutProfile
            || input.ThemeProfile is not (DocumentExportReadingStyleAuthority.LightThemeProfile
                or DocumentExportReadingStyleAuthority.DarkThemeProfile))
        {
            throw new InvalidDataException("Document export reading style authority or presentation profile drifted.");
        }
        ValidateAssets(input.Assets, input.AssetManifestDigest, input.FontManifestDigest);
        DocumentExportFrozenEmbedContract.Validate(input.FrozenEmbeds, input.MarkdownUtf8.Length);

        DocumentExportFrozenInput unsigned = input with
        {
            ContentDigest = string.Empty
        };
        RequireContentDigest(input.ContentDigest, DocumentExportDigest.Compute(unsigned), nameof(input));
    }

    public static void Validate(DocumentExportTask task, DocumentExportFrozenInput input)
    {
        ArgumentNullException.ThrowIfNull(task);
        Validate(input);
        DocumentExportFrozenEmbedContract.RequireMaterializer(input.FrozenEmbeds);
        RequireExact(task.Schema, DocumentExportContractCatalog.TaskSchema, nameof(task));
        RequireIdentifier(task.TaskId, nameof(task.TaskId));
        RequireIdentifier(task.RequestId, nameof(task.RequestId));
        RequireIdentifier(task.IdempotencyKey, nameof(task.IdempotencyKey));
        if (task.UserId != input.UserId
            || !string.Equals(task.SiteScope, input.SiteScope, StringComparison.Ordinal)
            || task.Coordinate != input.Coordinate
            || !string.Equals(task.InputId, input.InputId, StringComparison.Ordinal)
            || !string.Equals(task.InputDigest, input.ContentDigest, StringComparison.Ordinal)
            || !string.Equals(task.SourceDigest, input.SourceDigest, StringComparison.Ordinal)
            || !string.Equals(task.MetadataDigest, input.MetadataDigest, StringComparison.Ordinal)
            || !string.Equals(task.PropertyDigest, input.PropertyDigest, StringComparison.Ordinal)
            || !string.Equals(task.AssetManifestDigest, input.AssetManifestDigest, StringComparison.Ordinal)
            || !string.Equals(task.FontManifestDigest, input.FontManifestDigest, StringComparison.Ordinal)
            || !string.Equals(task.ReadingStyleAuthorityDigest, input.ReadingStyleAuthorityDigest, StringComparison.Ordinal)
            || !string.Equals(task.RendererDigest, input.RendererDigest, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Document export task is not bound to the exact frozen input identity.");
        }
        if (!Enum.IsDefined(task.Status))
        {
            throw new ArgumentException("Document export task status is not in the closed lifecycle.", nameof(task));
        }

        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (!string.Equals(task.ProviderId, provider.ProviderId, StringComparison.Ordinal)
            || !string.Equals(task.ProviderVersion, provider.ProviderVersion, StringComparison.Ordinal)
            || !string.Equals(input.RendererId, provider.RendererId, StringComparison.Ordinal)
            || !string.Equals(input.RendererVersion, provider.RendererVersion, StringComparison.Ordinal)
            || !string.Equals(task.LayoutProfile, input.LayoutProfile, StringComparison.Ordinal)
            || !string.Equals(task.ThemeProfile, input.ThemeProfile, StringComparison.Ordinal)
            || !string.Equals(task.Locale, input.Locale, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Document export task provider or presentation identity mismatch.");
        }

        DocumentExportTask unsigned = task with
        {
            ContentDigest = string.Empty
        };
        RequireContentDigest(task.ContentDigest, DocumentExportDigest.Compute(unsigned), nameof(task));
    }

    public static void ValidateFrozenIdentity(
        DocumentExportFrozenInput input,
        string sourceDigest,
        string metadataDigest,
        string propertyDigest,
        string assetManifestDigest,
        string fontManifestDigest,
        string rendererDigest,
        string readingStyleAuthorityDigest)
    {
        Validate(input);
        if (!string.Equals(input.SourceDigest, sourceDigest, StringComparison.Ordinal)
            || !string.Equals(input.MetadataDigest, metadataDigest, StringComparison.Ordinal)
            || !string.Equals(input.PropertyDigest, propertyDigest, StringComparison.Ordinal)
            || !string.Equals(input.AssetManifestDigest, assetManifestDigest, StringComparison.Ordinal)
            || !string.Equals(input.FontManifestDigest, fontManifestDigest, StringComparison.Ordinal)
            || !string.Equals(input.RendererDigest, rendererDigest, StringComparison.Ordinal)
            || !string.Equals(input.ReadingStyleAuthorityDigest, readingStyleAuthorityDigest, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Document export frozen input drifted after admission.");
        }
    }

    public static void Validate(
        DocumentExportProviderReceipt receipt,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportProviderContract provider)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        ArgumentNullException.ThrowIfNull(provider);
        Validate(task, input);
        if (provider.FormatId != task.FormatId
            || provider.ProviderId != task.ProviderId
            || provider.ProviderVersion != task.ProviderVersion)
        {
            throw new InvalidDataException("Document export result provider is not bound to the task.");
        }
        // Reuse the complete registry identity check before trusting provider-selected result limits.
        ValidateCatalog(
        [
            provider,
            .. DocumentExportContractCatalog.Providers.Where(candidate => candidate.FormatId != provider.FormatId)
        ]);
        RequireExact(receipt.Schema, DocumentExportContractCatalog.ResultSchema, nameof(receipt));
        RequireDigest(receipt.SandboxReceiptDigest, nameof(receipt.SandboxReceiptDigest));
        RequireDigest(receipt.OutputDigest, nameof(receipt.OutputDigest));
        RequireDigest(receipt.SemanticDigest, nameof(receipt.SemanticDigest));
        RequireIdentifier(receipt.ToolId, nameof(receipt.ToolId));
        RequireIdentifier(receipt.ToolVersion, nameof(receipt.ToolVersion));
        if (receipt.TaskDigest != task.ContentDigest
            || receipt.InputDigest != input.ContentDigest
            || receipt.ProviderId != provider.ProviderId
            || receipt.ProviderVersion != provider.ProviderVersion
            || receipt.ToolId != provider.ToolchainId
            || receipt.ToolVersion != provider.ToolchainVersion
            || receipt.RendererId != input.RendererId
            || receipt.RendererVersion != input.RendererVersion
            || receipt.RendererDigest != input.RendererDigest
            || receipt.AssetManifestDigest != input.AssetManifestDigest
            || receipt.FontManifestDigest != input.FontManifestDigest
            || receipt.ReadingStyleAuthorityDigest != input.ReadingStyleAuthorityDigest
            || receipt.OutputMediaType != provider.OutputMediaType
            || receipt.OutputExtension != provider.OutputExtension
            || receipt.NormalizationPolicy != provider.NormalizationPolicy
            || receipt.OutputBytes <= 0
            || receipt.OutputBytes > provider.Budgets.MaxOutputBytes
            || receipt.CleanupExpiresAfterSeconds != (long)provider.Delivery.RetentionTtl.TotalSeconds
            || !Enum.IsDefined(receipt.Status)
            || receipt.ObservedFeatures.Count != receipt.ObservedFeatures.Distinct(StringComparer.Ordinal).Count()
            || receipt.ObservedFeatures.Any(feature => !DocumentExportContractCatalog.FeatureIds.Contains(feature, StringComparer.Ordinal))
            || receipt.Status == DocumentExportProviderResultStatus.Succeeded && receipt.Errors.Count != 0)
        {
            throw new InvalidDataException("Document export provider receipt identity or result policy mismatch.");
        }
        foreach (DocumentExportFeatureSupport feature in provider.Features)
        {
            if (!receipt.ObservedFeatures.Contains(feature.FeatureId, StringComparer.Ordinal))
            {
                continue;
            }
            if (feature.Disposition == DocumentExportFeatureDisposition.WarningWithPreservedFallback
                    && !receipt.Warnings.Contains(
                        $"{feature.FeatureId}:{feature.PreservedFallback}", StringComparer.Ordinal)
                || feature.Disposition == DocumentExportFeatureDisposition.HardFail
                    && receipt.Status == DocumentExportProviderResultStatus.Succeeded)
            {
                throw new InvalidDataException("Document export provider receipt violates the observed feature policy.");
            }
        }
        DocumentExportNormalizationContract normalization = DocumentExportContractCatalog.Normalizations.Single(
            candidate => candidate.ProviderId == provider.ProviderId);
        if (normalization.ByteIdenticalForEqualFrozenInput && receipt.SemanticDigest != receipt.OutputDigest)
        {
            throw new InvalidDataException("Document export deterministic output and semantic digests must match.");
        }
        DocumentExportProviderReceipt unsigned = receipt with
        {
            ContentDigest = string.Empty
        };
        RequireContentDigest(receipt.ContentDigest, DocumentExportDigest.Compute(unsigned), nameof(receipt));
    }

    internal static void RequireDigest(string value, string parameterName)
    {
        if (!Sha256DigestRegex().IsMatch(value))
        {
            throw new ArgumentException("Document export digest must be canonical lowercase SHA-256.", parameterName);
        }
    }

    internal static void RequireOwnerScope(long userId, string siteScope)
    {
        try
        {
            // Reuse the existing administrator/site contract, without resolving
            // a numeric alias or normalizing a received identity into acceptance.
            AuthorRecentArticleHistoryContract.ValidateOwner(new AuthorRecentArticleHistoryOwner(userId, siteScope));
        }
        catch (AuthorRecentArticleHistoryValidationException exception)
        {
            throw new ArgumentException("Document export owner/site scope is outside the existing authority contract.",
                nameof(siteScope), exception);
        }
        if (!string.Equals(siteScope, siteScope.Trim().TrimEnd('/'), StringComparison.Ordinal))
        {
            throw new ArgumentException("Document export site scope must already equal its canonical authority value.", nameof(siteScope));
        }
    }

    internal static void RequireIdentifier(string value, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > MaximumIdentifierLength
            || value.Any(char.IsControl))
        {
            throw new ArgumentException("Document export identity is missing or malformed.", parameterName);
        }
    }

    private static void ValidateCoordinate(DocumentExportArticleCoordinate coordinate)
    {
        ArgumentNullException.ThrowIfNull(coordinate);
        if (!Enum.IsDefined(coordinate.Kind) || coordinate.ArticleId <= 0 || coordinate.SourceVersion <= 0)
        {
            throw new ArgumentException("Document export article coordinate is invalid.", nameof(coordinate));
        }

        bool valid = coordinate.Kind switch
        {
            DocumentExportCoordinateKind.Draft => !string.IsNullOrWhiteSpace(coordinate.DraftKey)
                && coordinate.RevisionId is null
                && coordinate.PublicationId is null,
            DocumentExportCoordinateKind.Revision => coordinate.DraftKey is null
                && coordinate.RevisionId > 0
                && coordinate.PublicationId is null,
            DocumentExportCoordinateKind.Publication => coordinate.DraftKey is null
                && coordinate.RevisionId > 0
                && coordinate.PublicationId > 0,
            _ => false
        };
        if (!valid)
        {
            throw new ArgumentException("Document export coordinate fields do not match its kind.", nameof(coordinate));
        }
    }

    internal static string ComputeAssetManifestDigest(IReadOnlyList<DocumentExportAsset> assets)
    {
        object manifest = assets
            .OrderBy(asset => asset.AssetId, StringComparer.Ordinal)
            .Select(asset => new
            {
                asset.AssetId,
                asset.MediaType,
                asset.Sha256,
                Length = (long)asset.Bytes.Length,
                asset.AltText,
                asset.Role,
                asset.FontFamily,
                asset.FontWeight,
                asset.FontStyle
            })
            .ToArray();
        return DocumentExportDigest.Compute(manifest);
    }

    internal static string ComputeFontManifestDigest(IReadOnlyList<DocumentExportAsset> assets)
    {
        object manifest = assets
            .Where(DocumentExportReadingStyleAuthority.IsFont)
            .OrderBy(asset => asset.FontFamily, StringComparer.Ordinal)
            .ThenBy(asset => asset.FontWeight)
            .Select(asset => new
            {
                asset.AssetId,
                asset.MediaType,
                asset.Sha256,
                Length = (long)asset.Bytes.Length,
                asset.FontFamily,
                asset.FontWeight,
                asset.FontStyle
            })
            .ToArray();
        return DocumentExportDigest.Compute(manifest);
    }

    private static void ValidateAssets(
        IReadOnlyList<DocumentExportAsset> assets,
        string manifestDigest,
        string fontManifestDigest)
    {
        ArgumentNullException.ThrowIfNull(assets);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        long totalBytes = 0;
        foreach (DocumentExportAsset asset in assets)
        {
            RequireIdentifier(asset.AssetId, nameof(asset.AssetId));
            if (!ids.Add(asset.AssetId)
                || string.IsNullOrWhiteSpace(asset.MediaType)
                || !asset.MediaType.Contains('/', StringComparison.Ordinal)
                || asset.AltText is null
                || asset.Role is null
                || asset.FontFamily is null
                || asset.FontStyle is null
                || asset.AltText.Length > 512)
            {
                throw new ArgumentException("Document export asset metadata is invalid.", nameof(assets));
            }
            RequireDigest(asset.Sha256, nameof(asset.Sha256));
            if (!string.Equals(asset.Sha256, DocumentExportDigest.ComputeBytes(asset.Bytes.AsSpan()), StringComparison.Ordinal))
            {
                throw new InvalidDataException($"Document export asset '{asset.AssetId}' digest mismatch.");
            }
            totalBytes = checked(totalBytes + asset.Bytes.Length);
            if (totalBytes > 32L * 1024 * 1024)
            {
                throw new ArgumentException("Document export assets exceed the frozen input budget.", nameof(assets));
            }

            bool validRole = asset.Role switch
            {
                "image" => s_embeddableImageMediaTypes.Contains(asset.MediaType)
                    && asset.FontFamily.Length == 0
                    && asset.FontWeight == 0
                    && asset.FontStyle == "normal",
                "font" => asset.MediaType == "font/woff2"
                    && asset.AltText.Length == 0
                    && asset.FontFamily.Length > 0
                    && asset.FontWeight is >= 100 and <= 900
                    && asset.FontWeight % 100 == 0
                    && asset.FontStyle == "normal"
                    && asset.Bytes.Length >= 4
                    && asset.Bytes.AsSpan()[..4].SequenceEqual("wOF2"u8),
                _ => false
            };
            if (!validRole)
            {
                throw new InvalidDataException($"Document export asset '{asset.AssetId}' role metadata is not closed.");
            }
        }

        DocumentExportRequiredFont[] actualFonts = assets
            .Where(DocumentExportReadingStyleAuthority.IsFont)
            .Select(asset => new DocumentExportRequiredFont(asset.FontFamily, asset.FontWeight, asset.FontStyle))
            .OrderBy(font => font.Family, StringComparer.Ordinal)
            .ThenBy(font => font.Weight)
            .ToArray();
        DocumentExportRequiredFont[] requiredFonts = DocumentExportReadingStyleAuthority.RequiredFonts
            .OrderBy(font => font.Family, StringComparer.Ordinal)
            .ThenBy(font => font.Weight)
            .ToArray();
        if (!actualFonts.SequenceEqual(requiredFonts))
        {
            throw new InvalidDataException("Document export font assets do not close the reading typography authority.");
        }

        RequireContentDigest(manifestDigest, ComputeAssetManifestDigest(assets), nameof(manifestDigest));
        RequireContentDigest(
            fontManifestDigest,
            ComputeFontManifestDigest(assets),
            nameof(fontManifestDigest));
    }

    private static void ValidateBudgets(DocumentExportResourceBudgets budgets)
    {
        if (budgets.WallTime <= TimeSpan.Zero
            || budgets.CpuTime <= TimeSpan.Zero
            || budgets.MaxWorkingSetBytes <= 0
            || budgets.MaxFileCount <= 0
            || budgets.MaxFileBytes <= 0
            || budgets.MaxInputBytes <= 0
            || budgets.MaxOutputBytes <= 0
            || budgets.MaxMessageBytes <= 0
            || budgets.MaxStandardOutputBytes <= 0
            || budgets.MaxStandardErrorBytes <= 0
            || budgets.MaxProcessCount <= 0
            || budgets.MaxConcurrency <= 0)
        {
            throw new InvalidOperationException("Document export resource budgets must be executable positive limits.");
        }
    }

    private static void ValidateDelivery(DocumentExportDeliveryPolicy delivery)
    {
        if (delivery.AuthorizationClass != "admin-principal-and-site-bound"
            || delivery.DownloadClass != "private-authorized-download"
            || delivery.StorageClass != "private-document-export-output"
            || delivery.PublicStaticRootPolicy != "prohibited"
            || delivery.RetentionTtl <= TimeSpan.Zero)
        {
            throw new InvalidOperationException("Document export delivery must remain private and TTL-bound.");
        }
    }

    private static void ValidateFeatures(IReadOnlyList<DocumentExportFeatureSupport> features)
    {
        if (features.Count != DocumentExportContractCatalog.FeatureIds.Count)
        {
            throw new InvalidOperationException("Document export feature matrix is incomplete.");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (DocumentExportFeatureSupport feature in features)
        {
            if (!ids.Add(feature.FeatureId)
                || !DocumentExportContractCatalog.FeatureIds.Contains(feature.FeatureId, StringComparer.Ordinal)
                || !Enum.IsDefined(feature.Disposition)
                || feature.Disposition == DocumentExportFeatureDisposition.WarningWithPreservedFallback
                    && string.IsNullOrWhiteSpace(feature.PreservedFallback)
                || feature.Disposition != DocumentExportFeatureDisposition.WarningWithPreservedFallback
                    && feature.PreservedFallback != "none")
            {
                throw new InvalidOperationException("Document export feature matrix contains unknown or silent behavior.");
            }
        }
    }

    private static void ValidateExecutionBindings(
        IReadOnlyList<DocumentExportProviderContract> providers,
        IReadOnlyList<DocumentExportProviderExecutionBinding> executionBindings)
    {
        if (executionBindings.Count != providers.Count
            || executionBindings.Select(binding => binding.ProviderId).Distinct(StringComparer.Ordinal).Count()
                != executionBindings.Count)
        {
            throw new InvalidOperationException("Document export execution bindings must be exact and unique.");
        }

        foreach (DocumentExportProviderContract provider in providers)
        {
            DocumentExportProviderExecutionBinding binding = executionBindings.SingleOrDefault(
                candidate => string.Equals(candidate.ProviderId, provider.ProviderId, StringComparison.Ordinal))
                ?? throw new InvalidOperationException($"Document export provider '{provider.ProviderId}' has no execution binding.");
            if (binding.ImplementationIdentity != provider.ProviderOwner
                || binding.ToolId != provider.ToolchainId
                || binding.ToolVersion != provider.ToolchainVersion
                || binding.InvocationPolicy != "exact-argv-v1"
                || !binding.ExactArguments.SequenceEqual(["render"], StringComparer.Ordinal)
                || binding.ExecutableIdentityPolicy != "absolute-path-plus-sha256"
                || binding.ShellPolicy != "prohibited")
            {
                throw new InvalidOperationException($"Document export provider '{provider.ProviderId}' execution identity drifted.");
            }
        }
    }

    private static void ValidateNormalizations(
        IReadOnlyList<DocumentExportProviderContract> providers,
        IReadOnlyList<DocumentExportNormalizationContract> normalizations)
    {
        if (normalizations.Count != providers.Count
            || normalizations.Select(normalization => normalization.ProviderId).Distinct(StringComparer.Ordinal).Count()
                != normalizations.Count)
        {
            throw new InvalidOperationException("Document export normalization registry must be exact and unique.");
        }

        foreach (DocumentExportProviderContract provider in providers)
        {
            DocumentExportNormalizationContract normalization = normalizations.SingleOrDefault(
                candidate => string.Equals(candidate.ProviderId, provider.ProviderId, StringComparison.Ordinal))
                ?? throw new InvalidOperationException($"Document export provider '{provider.ProviderId}' has no normalization contract.");
            DocumentExportNormalizationContract canonical = DocumentExportContractCatalog.Normalizations.Single(
                candidate => string.Equals(candidate.ProviderId, provider.ProviderId, StringComparison.Ordinal));
            bool isHtml = string.Equals(provider.FormatId, "self-contained-html", StringComparison.Ordinal);
            if (normalization.Policy != provider.NormalizationPolicy
                || normalization.Policy != canonical.Policy
                || normalization.ByteIdenticalForEqualFrozenInput != isHtml
                || normalization.ByteIdenticalForEqualFrozenInput != canonical.ByteIdenticalForEqualFrozenInput
                || !normalization.NormalizedMetadataFields.SequenceEqual(
                    canonical.NormalizedMetadataFields,
                    StringComparer.Ordinal)
                || isHtml && normalization.NormalizedMetadataFields.Count != 0
                || !isHtml && normalization.NormalizedMetadataFields.Count == 0
                || normalization.NormalizedMetadataFields.Any(string.IsNullOrWhiteSpace))
            {
                throw new InvalidOperationException($"Document export provider '{provider.ProviderId}' normalization contract drifted.");
            }
        }
    }

    private static void ValidateStaticGovernance(DocumentExportStaticGovernance governance)
    {
        if (governance != DocumentExportContractCatalog.StaticGovernance)
        {
            throw new InvalidOperationException("Document export static governance drifted.");
        }
    }

    private static void RequireExact(string actual, string expected, string parameterName)
    {
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            throw new ArgumentException($"Expected '{expected}' but found '{actual}'.", parameterName);
        }
    }

    private static void RequireContentDigest(string actual, string expected, string parameterName)
    {
        RequireDigest(actual, parameterName);
        if (!string.Equals(actual, expected, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Document export content digest mismatch.");
        }
    }

    [GeneratedRegex("^sha256:[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256DigestRegex();
}
