using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.DocumentExport;

public sealed record DocumentExportRendererRequest(
    string Schema,
    string InputId,
    string InputDigest,
    string SourceDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string ReadingStyleAuthorityDigest,
    ImmutableArray<byte> MarkdownUtf8,
    string RendererId,
    string RendererVersion,
    string RendererDigest,
    string LayoutProfile,
    string ThemeProfile,
    string Locale,
    ImmutableArray<DocumentExportAsset> Assets);

public sealed record DocumentExportRendererResponse(
    string Schema,
    string InputId,
    string InputDigest,
    string SourceDigest,
    string AssetManifestDigest,
    string FontManifestDigest,
    string ReadingStyleAuthorityDigest,
    string RendererId,
    string RendererVersion,
    string RendererDigest,
    string Title,
    string HtmlFragment,
    ImmutableArray<string> ObservedFeatures,
    string ContentDigest);

public sealed record DocumentExportProviderResult(
    byte[] Bytes,
    byte[] SandboxOutputBytes,
    DocumentExportProviderReceipt Receipt,
    DocumentExportSandboxPlan SandboxPlan,
    DocumentExportSandboxReceipt SandboxReceipt);

/// <summary>
/// Packages canonical renderer output without interpreting Markdown. The result
/// is one deterministic, offline HTML document with embedded frozen assets.
/// </summary>
public sealed class SelfContainedHtmlDocumentExportProvider
{
    private readonly ICanonicalDocumentRendererAdapter _renderer;

    internal SelfContainedHtmlDocumentExportProvider(ICanonicalDocumentRendererAdapter renderer)
    {
        _renderer = renderer ?? throw new ArgumentNullException(nameof(renderer));
    }

    public async Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken = default)
        => await ExportCoreAsync(task, input, null, cancellationToken);

    public async Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportAttemptResources resources,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(resources);
        return await ExportCoreAsync(task, input, resources, cancellationToken);
    }

    private async Task<DocumentExportProviderResult> ExportCoreAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportAttemptResources? resources,
        CancellationToken cancellationToken)
    {
        DocumentExportContractValidator.ValidateCatalog(DocumentExportContractCatalog.Providers);
        DocumentExportFrozenInput frozenInput = DocumentExportContractValidator.Seal(input);
        DocumentExportContractValidator.Validate(task, frozenInput);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (!provider.ImplementationAvailable || provider.FormatId != "self-contained-html")
        {
            throw new InvalidOperationException("Only the self-contained HTML provider is implemented in this slice.");
        }

        CanonicalDocumentRendererResult rendererResult = resources is null
            ? await _renderer.RenderAsync(task, frozenInput, cancellationToken)
            : await _renderer.RenderAsync(task, frozenInput, resources, cancellationToken);
        if (resources is not null && !ReferenceEquals(resources, rendererResult.AttemptResources))
        {
            throw new InvalidDataException("Canonical renderer did not retain the attempt resource owner.");
        }
        DocumentExportRendererResponse response = rendererResult.Response;
        ValidateRendererResponse(response, frozenInput);

        IReadOnlyList<string> observedFeatures = ValidateFeatures(response.ObservedFeatures, provider);
        byte[] fragmentBytes = DocumentExportHtmlSanitizer.Sanitize(
            response.HtmlFragment,
            frozenInput.Assets,
            provider.Budgets.MaxOutputBytes);
        byte[] outputBytes = ComposeDocument(
            response.Title,
            frozenInput,
            fragmentBytes,
            provider.Budgets.MaxOutputBytes);
        resources?.AccountHostOutputBytes(outputBytes.LongLength);

        string[] warnings = WarningsFor(observedFeatures, provider);
        DocumentExportToolContract tool = rendererResult.Tool;
        DocumentExportProviderReceipt unsigned = new(
            DocumentExportContractCatalog.ResultSchema,
            task.ContentDigest,
            frozenInput.ContentDigest,
            provider.ProviderId,
            provider.ProviderVersion,
            frozenInput.RendererId,
            frozenInput.RendererVersion,
            frozenInput.RendererDigest,
            frozenInput.AssetManifestDigest,
            frozenInput.FontManifestDigest,
            frozenInput.ReadingStyleAuthorityDigest,
            tool.ToolId,
            tool.ToolVersion,
            rendererResult.SandboxReceipt.ContentDigest,
            provider.OutputMediaType,
            provider.OutputExtension,
            provider.NormalizationPolicy,
            DocumentExportDigest.ComputeBytes(outputBytes),
            DocumentExportDigest.ComputeBytes(outputBytes),
            outputBytes.LongLength,
            observedFeatures,
            warnings,
            [],
            DocumentExportProviderResultStatus.Succeeded,
            (long)provider.Delivery.RetentionTtl.TotalSeconds,
            string.Empty);
        DocumentExportProviderReceipt receipt = unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
        return new DocumentExportProviderResult(
            outputBytes,
            rendererResult.ResponseBytes,
            receipt,
            rendererResult.SandboxPlan,
            rendererResult.SandboxReceipt);
    }

    public static DocumentExportRendererResponse SealRendererResponse(DocumentExportRendererResponse response)
    {
        DocumentExportRendererResponse unsigned = response with
        {
            ObservedFeatures = response.ObservedFeatures.ToArray().ToImmutableArray(),
            ContentDigest = string.Empty
        };
        return unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
    }

    public static void ValidateResult(
        DocumentExportProviderResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest)
    {
        ArgumentNullException.ThrowIfNull(result);
        ArgumentNullException.ThrowIfNull(task);
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(tool);
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (!provider.ImplementationAvailable || provider.FormatId != "self-contained-html")
        {
            throw new InvalidDataException("The result is not owned by the self-contained HTML provider.");
        }
        DocumentExportSandboxRuntime.ValidatePlan(
            result.SandboxPlan,
            task,
            input,
            provider,
            tool,
            expectedHostBuildDigest);
        DocumentExportSandboxRuntime.ValidateReceipt(
            result.SandboxReceipt,
            result.SandboxPlan,
            task,
            input,
            tool,
            expectedHostBuildDigest,
            result.SandboxOutputBytes);

        DocumentExportRendererResponse response = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(
            result.SandboxOutputBytes);
        ValidateRendererResponse(response, input);
        IReadOnlyList<string> observedFeatures = ValidateFeatures(response.ObservedFeatures, provider);
        byte[] fragmentBytes = DocumentExportHtmlSanitizer.Sanitize(
            response.HtmlFragment,
            input.Assets,
            provider.Budgets.MaxOutputBytes);
        byte[] expectedBytes = ComposeDocument(
            response.Title,
            input,
            fragmentBytes,
            provider.Budgets.MaxOutputBytes);
        string[] expectedWarnings = WarningsFor(observedFeatures, provider);
        DocumentExportProviderReceipt receipt = result.Receipt;
        if (receipt.Schema != DocumentExportContractCatalog.ResultSchema
            || receipt.TaskDigest != task.ContentDigest
            || receipt.InputDigest != input.ContentDigest
            || receipt.ProviderId != provider.ProviderId
            || receipt.ProviderVersion != provider.ProviderVersion
            || receipt.RendererId != input.RendererId
            || receipt.RendererVersion != input.RendererVersion
            || receipt.RendererDigest != input.RendererDigest
            || receipt.AssetManifestDigest != input.AssetManifestDigest
            || receipt.FontManifestDigest != input.FontManifestDigest
            || receipt.ReadingStyleAuthorityDigest != input.ReadingStyleAuthorityDigest
            || receipt.ToolId != tool.ToolId
            || receipt.ToolVersion != tool.ToolVersion
            || receipt.SandboxReceiptDigest != result.SandboxReceipt.ContentDigest
            || receipt.OutputMediaType != provider.OutputMediaType
            || receipt.OutputExtension != provider.OutputExtension
            || receipt.NormalizationPolicy != provider.NormalizationPolicy
            || receipt.OutputBytes != result.Bytes.LongLength
            || !result.Bytes.AsSpan().SequenceEqual(expectedBytes)
            || receipt.OutputDigest != DocumentExportDigest.ComputeBytes(result.Bytes)
            || receipt.SemanticDigest != receipt.OutputDigest
            || !receipt.ObservedFeatures.SequenceEqual(observedFeatures, StringComparer.Ordinal)
            || !receipt.Warnings.SequenceEqual(expectedWarnings, StringComparer.Ordinal)
            || receipt.Errors.Count != 0
            || receipt.Status != DocumentExportProviderResultStatus.Succeeded
            || receipt.CleanupExpiresAfterSeconds != (long)provider.Delivery.RetentionTtl.TotalSeconds)
        {
            throw new InvalidDataException("Self-contained HTML result identity mismatch.");
        }
        DocumentExportProviderReceipt unsigned = receipt with
        {
            ContentDigest = string.Empty
        };
        if (receipt.ContentDigest != DocumentExportDigest.Compute(unsigned))
        {
            throw new InvalidDataException("Self-contained HTML receipt digest mismatch.");
        }
        DocumentExportHtmlVerifier.Validate(result.Bytes, input, provider.Budgets.MaxOutputBytes);
    }

    internal static void ValidateRendererResponse(
        DocumentExportRendererResponse response,
        DocumentExportFrozenInput input)
    {
        if (response.Schema != DocumentExportContractCatalog.RendererResponseSchema
            || response.InputId != input.InputId
            || response.InputDigest != input.ContentDigest
            || response.SourceDigest != input.SourceDigest
            || response.AssetManifestDigest != input.AssetManifestDigest
            || response.FontManifestDigest != input.FontManifestDigest
            || response.ReadingStyleAuthorityDigest != input.ReadingStyleAuthorityDigest
            || response.RendererId != input.RendererId
            || response.RendererVersion != input.RendererVersion
            || response.RendererDigest != input.RendererDigest
            || string.IsNullOrWhiteSpace(response.Title)
            || response.Title.Length > 512
            || response.Title.Any(char.IsControl)
            || string.IsNullOrEmpty(response.HtmlFragment)
            || response.ObservedFeatures.IsDefault
            || response.ContentDigest != DocumentExportDigest.Compute(response with
            {
                ContentDigest = string.Empty
            }))
        {
            throw new InvalidDataException("Canonical renderer response identity is missing, drifted or tampered.");
        }
    }

    private static IReadOnlyList<string> ValidateFeatures(
        IReadOnlyList<string> observed,
        DocumentExportProviderContract provider)
    {
        ArgumentNullException.ThrowIfNull(observed);
        string[] ordered = observed.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray();
        if (ordered.Length != observed.Count
            || ordered.Any(feature => !DocumentExportContractCatalog.FeatureIds.Contains(feature, StringComparer.Ordinal)))
        {
            throw new InvalidDataException("Canonical renderer reported an unknown or duplicate feature.");
        }
        foreach (string feature in ordered)
        {
            if (provider.Features.Single(item => item.FeatureId == feature).Disposition == DocumentExportFeatureDisposition.HardFail)
            {
                throw new InvalidDataException($"Feature '{feature}' is not supported by the selected provider.");
            }
        }
        return ordered;
    }

    private static string[] WarningsFor(
        IReadOnlyList<string> observedFeatures,
        DocumentExportProviderContract provider)
        => provider.Features
            .Where(feature => observedFeatures.Contains(feature.FeatureId, StringComparer.Ordinal)
                && feature.Disposition == DocumentExportFeatureDisposition.WarningWithPreservedFallback)
            .Select(feature => $"{feature.FeatureId}:{feature.PreservedFallback}")
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();

    internal static byte[] ComposeDocument(
        string title,
        DocumentExportFrozenInput input,
        ReadOnlySpan<byte> fragmentBytes,
        long maximumBytes)
    {
        byte[] styleBytes = DocumentExportReadingStyleAuthority.BuildStyleBytes(
            input.Assets,
            input.ThemeProfile,
            maximumBytes);
        string styleHash = Convert.ToBase64String(SHA256.HashData(styleBytes));
        string direction = System.Globalization.CultureInfo.GetCultureInfo(input.Locale).TextInfo.IsRightToLeft
            ? "rtl"
            : "ltr";
        string escapedTitle = System.Net.WebUtility.HtmlEncode(title);
        string escapedLocale = System.Net.WebUtility.HtmlEncode(input.Locale);
        string csp = DocumentExportHtmlVerifier.BuildCsp(styleHash);

        using var output = new DocumentExportBoundedMemoryStream(
            maximumBytes,
            "Self-contained HTML exceeds its output budget.",
            "output-budget");
        WriteUtf8(output, "<!doctype html>\n");
        WriteUtf8(output, $"<html lang=\"{escapedLocale}\" dir=\"{direction}\">\n<head>\n");
        WriteUtf8(output, "<meta charset=\"utf-8\" />\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\" />\n");
        WriteUtf8(output, $"<meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\" />\n");
        WriteUtf8(output, $"<meta name=\"fsus-reading-authority\" content=\"{input.ReadingStyleAuthorityDigest}\" />\n");
        WriteUtf8(output, $"<title>{escapedTitle}</title>\n<style>");
        output.Write(styleBytes);
        WriteUtf8(output, "</style>\n</head>\n<body><main><article>");
        output.Write(fragmentBytes);
        WriteUtf8(output, "</article></main></body>\n</html>\n");
        return output.ToArray();
    }

    private static void WriteUtf8(Stream output, string value)
    {
        int maximumBytes = Encoding.UTF8.GetMaxByteCount(value.Length);
        byte[] rented = System.Buffers.ArrayPool<byte>.Shared.Rent(maximumBytes);
        try
        {
            int written = Encoding.UTF8.GetBytes(value, rented);
            output.Write(rented, 0, written);
        }
        finally
        {
            System.Buffers.ArrayPool<byte>.Shared.Return(rented);
        }
    }
}
