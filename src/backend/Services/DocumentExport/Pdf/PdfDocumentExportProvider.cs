namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// PDF output and the canonical renderer evidence used to compose its print input.
/// The shared sandbox remains the sole execution and receipt authority.
/// Canonical renderer bytes contain private article HTML. Keep both byte arrays
/// unchanged until verification completes and retain them only through the job owner.
/// </summary>
public sealed record PdfDocumentExportResult(
    DocumentExportProviderResult ProviderResult,
    byte[] CanonicalRendererOutputBytes,
    DocumentExportSandboxPlan CanonicalSandboxPlan,
    DocumentExportSandboxReceipt CanonicalSandboxReceipt,
    int PageCount,
    int FontCount);

/// <summary>
/// Converts the one canonical renderer output into a verified, paginated PDF.
/// The provider stays unavailable until the shared registry admits its exact tool.
/// </summary>
public sealed class PdfDocumentExportProvider
{
    private readonly ICanonicalDocumentRendererAdapter _renderer;
    private readonly DocumentExportSandboxRuntime _sandbox;

    internal PdfDocumentExportProvider(ICanonicalDocumentRendererAdapter renderer, DocumentExportSandboxRuntime sandbox)
    {
        _renderer = renderer ?? throw new ArgumentNullException(nameof(renderer));
        _sandbox = sandbox ?? throw new ArgumentNullException(nameof(sandbox));
    }

    /// <summary>
    /// Seals the supplied article snapshot, executes the canonical renderer and
    /// registered PDF tool, and returns the PDF with both actual sandbox receipts.
    /// An unavailable registry binding or invalid evidence fails the operation;
    /// cancellation is propagated without creating provider-owned delivery state.
    /// </summary>
    public async Task<PdfDocumentExportResult> ExportAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportFrozenInput frozenInput = DocumentExportContractValidator.Seal(input);
        DocumentExportContractValidator.Validate(task, frozenInput);
        DocumentExportProviderContract provider = RequireActiveProvider(task.FormatId);
        DocumentExportToolContract tool = _sandbox.RequireRegisteredTool("pdf");
        CanonicalDocumentRendererResult canonical = await _renderer.RenderAsync(task, frozenInput, cancellationToken);
        ValidateCanonicalEvidence(canonical.ResponseBytes, canonical.SandboxPlan, canonical.SandboxReceipt,
            task, frozenInput, _renderer.Tool, _sandbox.HostBuildDigest);
        DocumentExportRendererResponse canonicalResponse = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(canonical.ResponseBytes);
        PdfPrintRenderRequest request = PdfPrintDocumentLayout.Compose(canonicalResponse, frozenInput, provider.Budgets.MaxOutputBytes);
        DocumentExportSandboxResult rendered = await ExecuteAsync(task, frozenInput, tool, request, cancellationToken);
        PdfPrintRenderResponse response = ReadResponse(rendered.OutputBytes, provider.Budgets.MaxOutputBytes);
        byte[] bytes = DecodePdf(response, provider.Budgets.MaxOutputBytes);
        string[] features = ValidateFeatures(canonicalResponse.ObservedFeatures, provider);
        string[] warnings = ExpectedWarnings(response.Warnings, features, provider);
        var unsigned = new DocumentExportProviderReceipt(
            DocumentExportContractCatalog.ResultSchema, task.ContentDigest, frozenInput.ContentDigest,
            provider.ProviderId, provider.ProviderVersion, frozenInput.RendererId, frozenInput.RendererVersion,
            frozenInput.RendererDigest, frozenInput.AssetManifestDigest, frozenInput.FontManifestDigest,
            frozenInput.ReadingStyleAuthorityDigest, tool.ToolId, tool.ToolVersion, rendered.Receipt.ContentDigest,
            provider.OutputMediaType, provider.OutputExtension, provider.NormalizationPolicy,
            DocumentExportDigest.ComputeBytes(bytes), response.SemanticDigest, bytes.LongLength,
            features, warnings, [], DocumentExportProviderResultStatus.Succeeded,
            (long)provider.Delivery.RetentionTtl.TotalSeconds, string.Empty);
        DocumentExportProviderReceipt receipt = unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
        DocumentExportContractValidator.Validate(receipt, task, frozenInput, provider);
        cancellationToken.ThrowIfCancellationRequested();
        return new PdfDocumentExportResult(
            new DocumentExportProviderResult(bytes, rendered.OutputBytes, receipt, rendered.Plan, rendered.Receipt),
            canonical.ResponseBytes, canonical.SandboxPlan, canonical.SandboxReceipt, response.PageCount, response.FontCount);
    }

    /// <summary>
    /// Rechecks the exact PDF with independent parsers in the registered sandbox
    /// and returns that execution's verification evidence. The expected host build
    /// digest must come from trusted host configuration, never from the result.
    /// Invalid input, receipt or visible semantics fails the operation. Verification
    /// preserves the supplied PDF bytes and propagates cancellation.
    /// </summary>
    public async Task<DocumentExportSandboxResult> ValidateResultAsync(
        PdfDocumentExportResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        string expectedHostBuildDigest,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(result);
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = RequireActiveProvider(task.FormatId);
        DocumentExportToolContract tool = _sandbox.RequireRegisteredTool("pdf");
        ValidateCanonicalEvidence(result.CanonicalRendererOutputBytes, result.CanonicalSandboxPlan,
            result.CanonicalSandboxReceipt, task, input, _renderer.Tool, expectedHostBuildDigest);
        DocumentExportRendererResponse canonical = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(result.CanonicalRendererOutputBytes);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(canonical, input);
        DocumentExportProviderResult output = result.ProviderResult;
        DocumentExportSandboxRuntime.ValidatePlan(output.SandboxPlan, task, input, provider, tool, expectedHostBuildDigest);
        DocumentExportSandboxRuntime.ValidateReceipt(output.SandboxReceipt, output.SandboxPlan,
            task, input, tool, expectedHostBuildDigest, output.SandboxOutputBytes);
        DocumentExportContractValidator.Validate(output.Receipt, task, input, provider);
        PdfPrintRenderResponse response = ReadResponse(output.SandboxOutputBytes, provider.Budgets.MaxOutputBytes);
        byte[] expectedBytes = DecodePdf(response, provider.Budgets.MaxOutputBytes);
        string[] features = ValidateFeatures(canonical.ObservedFeatures, provider);
        if (!output.Bytes.AsSpan().SequenceEqual(expectedBytes)
            || output.Receipt.OutputDigest != DocumentExportDigest.ComputeBytes(output.Bytes)
            || output.Receipt.OutputBytes != output.Bytes.LongLength
            || output.Receipt.SemanticDigest != response.SemanticDigest
            || output.Receipt.SandboxReceiptDigest != output.SandboxReceipt.ContentDigest
            || output.Receipt.Status != DocumentExportProviderResultStatus.Succeeded
            || output.Receipt.Errors.Count != 0
            || !output.Receipt.ObservedFeatures.SequenceEqual(features, StringComparer.Ordinal)
            || !output.Receipt.Warnings.SequenceEqual(ExpectedWarnings(response.Warnings, features, provider), StringComparer.Ordinal)
            || result.PageCount != response.PageCount || result.FontCount != response.FontCount)
        {
            throw new InvalidDataException("PDF result does not match its canonical input and sandbox output.");
        }
        PdfPrintRenderRequest request = PdfPrintDocumentLayout.Compose(canonical, input, provider.Budgets.MaxOutputBytes)
            with
        {
            PdfBase64 = response.PdfBase64
        };
        DocumentExportSandboxResult verified = await ExecuteAsync(task, input, tool, request, cancellationToken);
        DocumentExportSandboxRuntime.ValidatePlan(verified.Plan, task, input, provider, tool, expectedHostBuildDigest);
        PdfPrintRenderResponse verification = ReadResponse(verified.OutputBytes, provider.Budgets.MaxOutputBytes);
        if (!DecodePdf(verification, provider.Budgets.MaxOutputBytes).AsSpan().SequenceEqual(output.Bytes)
            || verification.SemanticDigest != response.SemanticDigest
            || verification.PageCount != response.PageCount || verification.FontCount != response.FontCount
            || !verification.Warnings.SequenceEqual(response.Warnings, StringComparer.Ordinal))
        {
            throw new InvalidDataException("Independent PDF verification disagrees with the sealed render result.");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return verified;
    }

    internal async Task<DocumentExportSandboxResult> ValidateProviderResultAsync(
        DocumentExportProviderResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        string expectedHostBuildDigest,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(result);
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = RequireActiveProvider(task.FormatId);
        DocumentExportToolContract tool = _sandbox.RequireRegisteredTool("pdf");
        DocumentExportContractValidator.Validate(result.Receipt, task, input, provider);
        DocumentExportSandboxRuntime.ValidatePlan(result.SandboxPlan, task, input, provider, tool, expectedHostBuildDigest);
        DocumentExportSandboxRuntime.ValidateReceipt(result.SandboxReceipt, result.SandboxPlan,
            task, input, tool, expectedHostBuildDigest, result.SandboxOutputBytes);
        PdfPrintRenderResponse response = ReadResponse(result.SandboxOutputBytes, provider.Budgets.MaxOutputBytes);
        // The job contract retains generic output evidence, so reconstruct the
        // canonical semantics from the same frozen input for independent checking.
        // This never renders a replacement PDF or creates provider-owned storage.
        CanonicalDocumentRendererResult canonical = await _renderer.RenderAsync(task, input, cancellationToken);
        return await ValidateResultAsync(new PdfDocumentExportResult(
            result, canonical.ResponseBytes, canonical.SandboxPlan, canonical.SandboxReceipt,
            response.PageCount, response.FontCount), task, input, expectedHostBuildDigest, cancellationToken);
    }

    private async Task<DocumentExportSandboxResult> ExecuteAsync(
        DocumentExportTask task, DocumentExportFrozenInput input, DocumentExportToolContract tool,
        PdfPrintRenderRequest request, CancellationToken cancellationToken)
    {
        DocumentExportSandboxResult result = await _sandbox.ExecuteAsync(task, input, tool,
            (stream, token) => DocumentExportDigest.SerializeAsync(stream, request, token), cancellationToken);
        DocumentExportSandboxRuntime.ValidateReceipt(result.Receipt, result.Plan, task, input,
            tool, _sandbox.HostBuildDigest, result.OutputBytes);
        return result;
    }

    internal static void ValidateCanonicalEvidence(
        byte[] bytes, DocumentExportSandboxPlan plan, DocumentExportSandboxReceipt receipt,
        DocumentExportTask task, DocumentExportFrozenInput input, DocumentExportToolContract tool,
        string expectedHostBuildDigest)
    {
        DocumentExportSandboxRuntime.ValidateCanonicalRendererReceipt(receipt, plan, task, input, tool,
            expectedHostBuildDigest, bytes);
        SelfContainedHtmlDocumentExportProvider.ValidateRendererResponse(
            DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(bytes), input);
    }

    private static DocumentExportProviderContract RequireActiveProvider(string formatId)
    {
        DocumentExportContractValidator.ValidateCatalog(DocumentExportContractCatalog.Providers);
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(formatId);
        if (provider.FormatId != "pdf" || !provider.ImplementationAvailable)
        {
            throw new InvalidOperationException("The PDF provider has no active shared-registry binding.");
        }
        return provider;
    }

    internal static PdfPrintRenderResponse ReadResponse(byte[] bytes, long maximumBytes)
    {
        PdfPrintRenderResponse response = DocumentExportDigest.Deserialize<PdfPrintRenderResponse>(bytes);
        if (response.PageCount <= 0 || response.FontCount <= 0
            || response.Warnings is null || response.Warnings.Any(string.IsNullOrWhiteSpace)
            || response.Warnings.Distinct(StringComparer.Ordinal).Count() != response.Warnings.Length
            || response.SemanticDigest is null || response.SemanticDigest.Length != 71
            || !response.SemanticDigest.StartsWith("sha256:", StringComparison.Ordinal)
            || response.SemanticDigest.AsSpan(7).ContainsAnyExcept("0123456789abcdef"))
        {
            throw new InvalidDataException("PDF tool verification report is incomplete or malformed.");
        }
        _ = DecodePdf(response, maximumBytes);
        return response;
    }

    private static byte[] DecodePdf(PdfPrintRenderResponse response, long maximumBytes)
    {
        if (string.IsNullOrEmpty(response.PdfBase64) || response.PdfBase64.Length > ((maximumBytes + 2) / 3) * 4)
        {
            throw new InvalidDataException("PDF tool output is empty or exceeds the output budget.");
        }
        try
        {
            byte[] bytes = Convert.FromBase64String(response.PdfBase64);
            if (bytes.LongLength > maximumBytes || !bytes.AsSpan().StartsWith("%PDF-"u8)
                || Convert.ToBase64String(bytes) != response.PdfBase64)
            {
                throw new InvalidDataException("PDF output has an invalid envelope.");
            }
            return bytes;
        }
        catch (FormatException exception)
        {
            throw new InvalidDataException("PDF tool output is not canonical base64.", exception);
        }
    }

    private static string[] ValidateFeatures(IReadOnlyList<string> observed, DocumentExportProviderContract provider)
    {
        string[] features = observed.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray();
        if (features.Length != observed.Count
            || features.Any(feature => !DocumentExportContractCatalog.FeatureIds.Contains(feature, StringComparer.Ordinal)
                || provider.Features.Single(item => item.FeatureId == feature).Disposition == DocumentExportFeatureDisposition.HardFail))
        {
            throw new InvalidDataException("PDF input contains an unknown, duplicate, or unsupported feature.");
        }
        return features;
    }

    private static string[] ExpectedWarnings(string[] toolWarnings, IReadOnlyList<string> features, DocumentExportProviderContract provider)
        => toolWarnings.Concat(provider.Features
            .Where(feature => features.Contains(feature.FeatureId, StringComparer.Ordinal)
                && feature.Disposition == DocumentExportFeatureDisposition.WarningWithPreservedFallback)
            .Select(feature => $"{feature.FeatureId}:{feature.PreservedFallback}"))
            .Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray();
}
