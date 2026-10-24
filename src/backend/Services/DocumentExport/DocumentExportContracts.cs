using System.Collections.Immutable;
using System.Collections.ObjectModel;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Identifies the immutable article coordinate frozen before export admission.
/// A task cannot resolve or substitute a newer coordinate after admission.
/// </summary>
public enum DocumentExportCoordinateKind
{
    Draft = 1,
    Revision = 2,
    Publication = 3
}

public enum DocumentExportTaskStatus
{
    Queued = 1,
    Preparing = 2,
    Running = 3,
    Cancelling = 4,
    Cancelled = 5,
    Succeeded = 6,
    Failed = 7,
    Blocked = 8,
    Expired = 9,
    CleanupRequired = 10
}

public enum DocumentExportFeatureDisposition
{
    Supported = 1,
    WarningWithPreservedFallback = 2,
    HardFail = 3
}

public enum DocumentExportProviderResultStatus
{
    Succeeded = 1,
    Failed = 2,
    Blocked = 3,
    Cancelled = 4,
    Expired = 5,
    CleanupRequired = 6
}

public sealed record DocumentExportArticleCoordinate(
    DocumentExportCoordinateKind Kind,
    long ArticleId,
    string? DraftKey,
    long? RevisionId,
    long? PublicationId,
    long SourceVersion);

public sealed record DocumentExportAsset(
    string AssetId,
    string MediaType,
    string Sha256,
    ImmutableArray<byte> Bytes,
    string AltText,
    string Role,
    string FontFamily,
    int FontWeight,
    string FontStyle);

/// <summary>
/// Complete immutable provider input. The content digest covers the source bytes,
/// every authority digest, renderer identity, coordinate and embedded asset byte.
/// </summary>
public sealed record DocumentExportFrozenInput(
    string Schema,
    string InputId,
    long UserId,
    string SiteScope,
    DocumentExportArticleCoordinate Coordinate,
    ImmutableArray<byte> MarkdownUtf8,
    string SourceDigest,
    string MetadataDigest,
    string PropertyDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string RendererId,
    string RendererVersion,
    string RendererDigest,
    string LayoutProfile,
    string ThemeProfile,
    string Locale,
    ImmutableArray<DocumentExportAsset> Assets,
    string ReadingStyleAuthorityDigest,
    string ContentDigest);

public sealed record DocumentExportTask(
    string Schema,
    string TaskId,
    string RequestId,
    string IdempotencyKey,
    long UserId,
    string SiteScope,
    DocumentExportArticleCoordinate Coordinate,
    string InputId,
    string InputDigest,
    string SourceDigest,
    string MetadataDigest,
    string PropertyDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string ReadingStyleAuthorityDigest,
    string RendererDigest,
    string FormatId,
    string ProviderId,
    string ProviderVersion,
    string LayoutProfile,
    string ThemeProfile,
    string Locale,
    DocumentExportTaskStatus Status,
    string ContentDigest);

public sealed record DocumentExportFeatureSupport(
    string FeatureId,
    DocumentExportFeatureDisposition Disposition,
    string PreservedFallback);

public sealed record DocumentExportResourceBudgets(
    TimeSpan WallTime,
    TimeSpan CpuTime,
    long MaxWorkingSetBytes,
    int MaxFileCount,
    long MaxFileBytes,
    long MaxInputBytes,
    long MaxOutputBytes,
    long MaxMessageBytes,
    long MaxStandardOutputBytes,
    long MaxStandardErrorBytes,
    int MaxProcessCount,
    int MaxConcurrency);

public sealed record DocumentExportDeliveryPolicy(
    string AuthorizationClass,
    string DownloadClass,
    string StorageClass,
    string PublicStaticRootPolicy,
    TimeSpan RetentionTtl);

public sealed record DocumentExportProviderContract(
    string FormatId,
    string ProviderId,
    string ProviderOwner,
    string ProviderVersion,
    string OutputMediaType,
    string OutputExtension,
    string RendererId,
    string RendererVersion,
    string InputSchema,
    string ResultSchema,
    string SandboxClass,
    string NetworkPolicy,
    string ToolchainId,
    string ToolchainVersion,
    string NormalizationPolicy,
    bool ImplementationAvailable,
    DocumentExportResourceBudgets Budgets,
    DocumentExportDeliveryPolicy Delivery,
    IReadOnlyList<DocumentExportFeatureSupport> Features);

public sealed record DocumentExportProviderExecutionBinding(
    string ProviderId,
    string ImplementationIdentity,
    string ToolId,
    string ToolVersion,
    string InvocationPolicy,
    IReadOnlyList<string> ExactArguments,
    string ExecutableIdentityPolicy,
    string ShellPolicy);

public sealed record DocumentExportNormalizationContract(
    string ProviderId,
    string Policy,
    bool ByteIdenticalForEqualFrozenInput,
    IReadOnlyList<string> NormalizedMetadataFields);

public sealed record DocumentExportStaticGovernance(
    string InputResolutionPolicy,
    string ParserAuthorityPolicy,
    string PdfAuthorityPolicy,
    string FormatFallbackPolicy,
    string CommandPolicy,
    string RegistryPolicy);

public sealed record DocumentExportProviderReceipt(
    string Schema,
    string TaskDigest,
    string InputDigest,
    string ProviderId,
    string ProviderVersion,
    string RendererId,
    string RendererVersion,
    string RendererDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string ReadingStyleAuthorityDigest,
    string ToolId,
    string ToolVersion,
    string SandboxReceiptDigest,
    string OutputMediaType,
    string OutputExtension,
    string NormalizationPolicy,
    string OutputDigest,
    string SemanticDigest,
    long OutputBytes,
    IReadOnlyList<string> ObservedFeatures,
    IReadOnlyList<string> Warnings,
    IReadOnlyList<string> Errors,
    DocumentExportProviderResultStatus Status,
    long CleanupExpiresAfterSeconds,
    string ContentDigest);

/// <summary>
/// The single closed document-export contract catalog. It declares all initial
/// formats while only the self-contained HTML implementation is activated here.
/// </summary>
public static class DocumentExportContractCatalog
{
    public const string InputSchema = "fsusblog.document-export-frozen-input.v3";
    public const string TaskSchema = "fsusblog.document-export-task.v3";
    public const string ResultSchema = "fsusblog.document-export-provider-result.v3";
    public const string AttemptReceiptSchema = "fsusblog.document-export-attempt-receipt.v2";
    public const string SandboxPlanSchema = "fsusblog.document-export-sandbox-plan.v2";
    public const string RendererRequestSchema = "fsusblog.document-export-renderer-request.v3";
    public const string RendererResponseSchema = "fsusblog.document-export-renderer-response.v3";
    public const string SandboxClass = "document-export-isolated-process-v1";
    public const string NetworkPolicy = "deny-all-except-declared-loopback-v1";

    public static readonly IReadOnlyList<string> FormatIds = Array.AsReadOnly(
    [
        "self-contained-html",
        "pdf",
        "docx",
        "epub"
    ]);

    public static readonly IReadOnlyList<string> FeatureIds = Array.AsReadOnly(
    [
        "headings",
        "links",
        "images",
        "tables",
        "code-shiki",
        "mermaid",
        "katex-latex",
        "footnotes",
        "anchors",
        "embeds",
        "captions",
        "cjk",
        "rtl",
        "emoji",
        "page-ebook-limits"
    ]);

    public static readonly IReadOnlyList<DocumentExportProviderContract> Providers =
        new ReadOnlyCollection<DocumentExportProviderContract>(
        [
            CreateProvider(
                "self-contained-html",
                "document-export.self-contained-html",
                "FsusBlog.Server.Services.DocumentExport.SelfContainedHtmlDocumentExportProvider",
                "2",
                "text/html",
                ".html",
                "fsusui.markdown-renderer",
                "current-v1",
                "canonical-markdown-renderer",
                "current-v1",
                "deterministic-html-v2",
                implementationAvailable: true,
                pageEbookDisposition: DocumentExportFeatureDisposition.WarningWithPreservedFallback),
            CreateProvider(
                "pdf",
                "document-export.pdf",
                "issue-2429-provider-owner",
                "1",
                "application/pdf",
                ".pdf",
                "fsusui.markdown-renderer",
                "current-v1",
                "document-export-pdf-toolchain",
                "unimplemented-v1",
                "normalized-pdf-v1",
                implementationAvailable: false,
                pageEbookDisposition: DocumentExportFeatureDisposition.Supported),
            CreateProvider(
                "docx",
                "document-export.docx",
                "issue-2430-provider-owner",
                "1",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ".docx",
                "fsusui.markdown-renderer",
                "current-v1",
                "document-export-docx-toolchain",
                "unimplemented-v1",
                "normalized-docx-v1",
                implementationAvailable: false,
                pageEbookDisposition: DocumentExportFeatureDisposition.WarningWithPreservedFallback),
            CreateProvider(
                "epub",
                "document-export.epub",
                "issue-2432-provider-owner",
                "1",
                "application/epub+zip",
                ".epub",
                "fsusui.markdown-renderer",
                "current-v1",
                "document-export-epub-toolchain",
                "unimplemented-v1",
                "normalized-epub-v1",
                implementationAvailable: false,
                pageEbookDisposition: DocumentExportFeatureDisposition.Supported)
        ]);

    public static readonly IReadOnlyList<DocumentExportProviderExecutionBinding> ExecutionBindings =
        new ReadOnlyCollection<DocumentExportProviderExecutionBinding>(
        [
            CreateExecutionBinding(
                "document-export.self-contained-html",
                "FsusBlog.Server.Services.DocumentExport.SelfContainedHtmlDocumentExportProvider",
                "canonical-markdown-renderer",
                "current-v1"),
            CreateExecutionBinding(
                "document-export.pdf",
                "issue-2429-provider-owner",
                "document-export-pdf-toolchain",
                "unimplemented-v1"),
            CreateExecutionBinding(
                "document-export.docx",
                "issue-2430-provider-owner",
                "document-export-docx-toolchain",
                "unimplemented-v1"),
            CreateExecutionBinding(
                "document-export.epub",
                "issue-2432-provider-owner",
                "document-export-epub-toolchain",
                "unimplemented-v1")
        ]);

    public static readonly IReadOnlyList<DocumentExportNormalizationContract> Normalizations =
        new ReadOnlyCollection<DocumentExportNormalizationContract>(
        [
            new(
                "document-export.self-contained-html",
                "deterministic-html-v2",
                true,
                Array.Empty<string>()),
            new(
                "document-export.pdf",
                "normalized-pdf-v1",
                false,
                Array.AsReadOnly(["creation-date", "modification-date", "document-id", "instance-id"])),
            new(
                "document-export.docx",
                "normalized-docx-v1",
                false,
                Array.AsReadOnly(["created", "modified", "last-modified-by", "revision"])),
            new(
                "document-export.epub",
                "normalized-epub-v1",
                false,
                Array.AsReadOnly(["modified", "archive-entry-order", "archive-entry-timestamp"]))
        ]);

    public static readonly DocumentExportStaticGovernance StaticGovernance = new(
        "frozen-input-only-no-latest-resolution",
        "single-canonical-markdown-renderer-no-per-format-parser",
        "semantic-provider-no-screenshot-only-pdf-authority",
        "prohibited-no-provider-or-format-switch",
        "exact-argv-no-arbitrary-command-or-string-shell",
        "single-closed-task-provider-registry");

    public static DocumentExportProviderContract RequireProvider(string formatId)
        => Providers.SingleOrDefault(provider => string.Equals(provider.FormatId, formatId, StringComparison.Ordinal))
            ?? throw new ArgumentException($"Unknown document export format '{formatId}'.", nameof(formatId));

    private static DocumentExportProviderContract CreateProvider(
        string formatId,
        string providerId,
        string providerOwner,
        string providerVersion,
        string outputMediaType,
        string outputExtension,
        string rendererId,
        string rendererVersion,
        string toolchainId,
        string toolchainVersion,
        string normalizationPolicy,
        bool implementationAvailable,
        DocumentExportFeatureDisposition pageEbookDisposition)
    {
        DocumentExportFeatureSupport[] features = FeatureIds
            .Select(featureId => new DocumentExportFeatureSupport(
                featureId,
                string.Equals(featureId, "page-ebook-limits", StringComparison.Ordinal)
                    ? pageEbookDisposition
                    : DocumentExportFeatureDisposition.Supported,
                string.Equals(featureId, "page-ebook-limits", StringComparison.Ordinal)
                    && pageEbookDisposition == DocumentExportFeatureDisposition.WarningWithPreservedFallback
                        ? "preserve-semantic-flow-with-explicit-warning"
                        : "none"))
            .ToArray();

        return new DocumentExportProviderContract(
            formatId,
            providerId,
            providerOwner,
            providerVersion,
            outputMediaType,
            outputExtension,
            rendererId,
            rendererVersion,
            InputSchema,
            ResultSchema,
            SandboxClass,
            NetworkPolicy,
            toolchainId,
            toolchainVersion,
            normalizationPolicy,
            implementationAvailable,
            new DocumentExportResourceBudgets(
                TimeSpan.FromSeconds(30),
                TimeSpan.FromSeconds(20),
                512L * 1024 * 1024,
                64,
                64L * 1024 * 1024,
                32L * 1024 * 1024,
                64L * 1024 * 1024,
                64L * 1024 * 1024,
                1L * 1024 * 1024,
                1L * 1024 * 1024,
                8,
                2),
            new DocumentExportDeliveryPolicy(
                "admin-principal-and-site-bound",
                "private-authorized-download",
                "private-document-export-output",
                "prohibited",
                TimeSpan.FromHours(24)),
            Array.AsReadOnly(features));
    }

    private static DocumentExportProviderExecutionBinding CreateExecutionBinding(
        string providerId,
        string implementationIdentity,
        string toolId,
        string toolVersion)
        => new(
            providerId,
            implementationIdentity,
            toolId,
            toolVersion,
            "exact-argv-v1",
            Array.AsReadOnly(["render"]),
            "absolute-path-plus-sha256",
            "prohibited");
}
