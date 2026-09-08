using System.Collections.Immutable;
using System.Text.RegularExpressions;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Independent fail-closed validator for document-export catalog, frozen input
/// and task identities. Unknown schemas, states, formats and drift are rejected.
/// </summary>
public static partial class DocumentExportContractValidator
{
    private const int MaximumIdentifierLength = 160;

    public static DocumentExportFrozenInput Seal(DocumentExportFrozenInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        DocumentExportFrozenInput owned = input with
        {
            MarkdownUtf8 = input.MarkdownUtf8.AsSpan().ToArray().ToImmutableArray(),
            Assets = input.Assets
                .Select(asset => asset with { Bytes = asset.Bytes.AsSpan().ToArray().ToImmutableArray() })
                .ToImmutableArray()
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
                || provider.ImplementationAvailable != canonical.ImplementationAvailable)
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
        if (input.UserId <= 0 || input.SiteId <= 0)
        {
            throw new ArgumentException("Document export user and site identities must be positive.", nameof(input));
        }

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
        ValidateAssets(input.Assets, input.AssetManifestDigest);

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
        RequireExact(task.Schema, DocumentExportContractCatalog.TaskSchema, nameof(task));
        RequireIdentifier(task.TaskId, nameof(task.TaskId));
        RequireIdentifier(task.RequestId, nameof(task.RequestId));
        RequireIdentifier(task.IdempotencyKey, nameof(task.IdempotencyKey));
        if (task.UserId != input.UserId
            || task.SiteId != input.SiteId
            || task.Coordinate != input.Coordinate
            || !string.Equals(task.InputId, input.InputId, StringComparison.Ordinal)
            || !string.Equals(task.InputDigest, input.ContentDigest, StringComparison.Ordinal)
            || !string.Equals(task.SourceDigest, input.SourceDigest, StringComparison.Ordinal)
            || !string.Equals(task.MetadataDigest, input.MetadataDigest, StringComparison.Ordinal)
            || !string.Equals(task.PropertyDigest, input.PropertyDigest, StringComparison.Ordinal)
            || !string.Equals(task.AssetManifestDigest, input.AssetManifestDigest, StringComparison.Ordinal)
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
        string rendererDigest)
    {
        Validate(input);
        if (!string.Equals(input.SourceDigest, sourceDigest, StringComparison.Ordinal)
            || !string.Equals(input.MetadataDigest, metadataDigest, StringComparison.Ordinal)
            || !string.Equals(input.PropertyDigest, propertyDigest, StringComparison.Ordinal)
            || !string.Equals(input.AssetManifestDigest, assetManifestDigest, StringComparison.Ordinal)
            || !string.Equals(input.RendererDigest, rendererDigest, StringComparison.Ordinal))
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
        Validate(task, input);
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
            || receipt.RendererId != input.RendererId
            || receipt.RendererVersion != input.RendererVersion
            || receipt.RendererDigest != input.RendererDigest
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

    private static void ValidateAssets(IReadOnlyList<DocumentExportAsset> assets, string manifestDigest)
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
        }

        object manifest = assets
            .OrderBy(asset => asset.AssetId, StringComparer.Ordinal)
            .Select(asset => new { asset.AssetId, asset.MediaType, asset.Sha256, Length = (long)asset.Bytes.Length })
            .ToArray();
        RequireContentDigest(manifestDigest, DocumentExportDigest.Compute(manifest), nameof(manifestDigest));
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
            bool isHtml = string.Equals(provider.FormatId, "self-contained-html", StringComparison.Ordinal);
            if (normalization.Policy != provider.NormalizationPolicy
                || normalization.ByteIdenticalForEqualFrozenInput != isHtml
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
