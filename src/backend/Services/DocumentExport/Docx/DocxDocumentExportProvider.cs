namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// DOCX format implementation for the shared canonical renderer and sandbox.
/// Generic registration and tool activation remain with the integration owner;
/// an inactive catalog entry never produces a downloadable success result.
/// </summary>
public sealed class DocxDocumentExportProvider : IDocumentExportAttemptJobProvider
{
    private readonly ICanonicalDocumentRendererAdapter _renderer;
    private readonly string _hostBuildDigest;
    private readonly DocumentExportSandboxRuntime? _sandbox;

    internal DocxDocumentExportProvider(ICanonicalDocumentRendererAdapter renderer, string expectedHostBuildDigest,
        DocumentExportSandboxRuntime? sandbox = null)
    {
        _renderer = renderer ?? throw new ArgumentNullException(nameof(renderer));
        if (string.IsNullOrWhiteSpace(expectedHostBuildDigest))
        {
            throw new ArgumentException("DOCX requires the integration authority's frozen host build identity.", nameof(expectedHostBuildDigest));
        }
        if (sandbox is not null && sandbox.HostBuildDigest != expectedHostBuildDigest)
        {
            throw new InvalidDataException("DOCX resource factory and renderer host build identities differ.");
        }
        _hostBuildDigest = expectedHostBuildDigest;
        _sandbox = sandbox;
    }

    public string ProviderId => "document-export.docx";

    public DocumentExportAttemptResources CreateAttemptResources(
        DocumentExportTask task, DocumentExportFrozenInput input, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(time);
        DocumentExportContractValidator.Validate(task, input);
        _ = RequireActiveProvider(task.FormatId);
        DocumentExportSandboxRuntime sandbox = _sandbox
            ?? throw new InvalidOperationException("DOCX attempt resource factory has not been bound by the shared sandbox owner.");
        return sandbox.CreateAttemptResources(task, input, time);
    }

    public Task VerifyAsync(DocumentExportProviderResult result, DocumentExportTask task,
        DocumentExportFrozenInput input, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        throw new InvalidOperationException("DOCX job verification requires its explicit shared attempt resource owner.");
    }

    public Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task, DocumentExportFrozenInput input, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.Validate(task, input);
        _ = RequireActiveProvider(task.FormatId);
        throw new InvalidOperationException("DOCX job execution requires its explicit shared attempt resource owner.");
    }

    public Task VerifyAsync(DocumentExportProviderResult result, DocumentExportTask task,
        DocumentExportFrozenInput input, DocumentExportAttemptResources resources, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(resources);
        DocumentExportContractValidator.Validate(task, input);
        _ = RequireActiveProvider(task.FormatId);
        ValidateResult(result, task, input, _renderer.Tool, _hostBuildDigest, cancellationToken);
        // Only the shared sandbox records real stage completion. This check
        // binds and seals the caller-owned frozen attempt after artifact verification.
        resources.RequireCompleted(task, input);
        return Task.CompletedTask;
    }

    public async Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task, DocumentExportFrozenInput input,
        DocumentExportAttemptResources resources, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(resources);
        DocumentExportFrozenInput frozen = DocumentExportContractValidator.Seal(input);
        DocumentExportContractValidator.Validate(task, frozen);
        DocumentExportProviderContract provider = RequireActiveProvider(task.FormatId);
        CanonicalDocumentRendererResult rendered = await _renderer.RenderAsync(task, frozen, resources, cancellationToken);
        if (!ReferenceEquals(resources, rendered.AttemptResources))
        {
            throw new InvalidDataException("DOCX canonical renderer did not retain the supplied attempt resource owner.");
        }
        // Renderer-stage receipts retain the final DOCX task identity. They do
        // not attest resource enforcement for the subsequent host conversion.
        DocumentExportSandboxRuntime.ValidateCanonicalRendererPlan(rendered.SandboxPlan, task, frozen, rendered.Tool, _hostBuildDigest);
        DocumentExportSandboxRuntime.ValidateCanonicalRendererReceipt(rendered.SandboxReceipt, rendered.SandboxPlan,
            task, frozen, rendered.Tool, _hostBuildDigest, rendered.ResponseBytes);
        DocumentExportRendererResponse response = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(rendered.ResponseBytes);
        if (response.ContentDigest != rendered.Response.ContentDigest)
        {
            throw new InvalidDataException("DOCX adapter response differs from its sandbox output bytes.");
        }
        DocumentExportDocxProjection projection = DocumentExportDocxProjection.Create(response, frozen, cancellationToken);
        byte[] bytes = DocumentExportDocxPackage.Render(projection, cancellationToken);
        resources.AccountHostOutputBytes(bytes.LongLength);
        string semanticDigest = DocumentExportDocxVerifier.Validate(bytes, projection, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        var unsigned = new DocumentExportProviderReceipt(
            DocumentExportContractCatalog.ResultSchema, task.ContentDigest, frozen.ContentDigest,
            provider.ProviderId, provider.ProviderVersion, frozen.RendererId, frozen.RendererVersion, frozen.RendererDigest,
            frozen.AssetManifestDigest, frozen.FontManifestDigest, frozen.ReadingStyleAuthorityDigest,
            rendered.Tool.ToolId, rendered.Tool.ToolVersion, rendered.SandboxReceipt.ContentDigest,
            provider.OutputMediaType, provider.OutputExtension, provider.NormalizationPolicy,
            DocumentExportDigest.ComputeBytes(bytes), semanticDigest, bytes.LongLength,
            projection.Features, projection.Warnings, [], DocumentExportProviderResultStatus.Succeeded,
            (long)provider.Delivery.RetentionTtl.TotalSeconds, string.Empty);
        DocumentExportProviderReceipt receipt = unsigned with
        {
            ContentDigest = DocumentExportDigest.Compute(unsigned)
        };
        DocumentExportContractValidator.Validate(receipt, task, frozen, provider);
        return new DocumentExportProviderResult(bytes, rendered.ResponseBytes, receipt, rendered.SandboxPlan, rendered.SandboxReceipt);
    }

    public static void ValidateResult(
        DocumentExportProviderResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportToolContract tool,
        string expectedHostBuildDigest,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(result);
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = RequireActiveProvider(task.FormatId);
        DocumentExportSandboxRuntime.ValidateCanonicalRendererPlan(result.SandboxPlan, task, input, tool, expectedHostBuildDigest);
        DocumentExportSandboxRuntime.ValidateCanonicalRendererReceipt(result.SandboxReceipt, result.SandboxPlan,
            task, input, tool, expectedHostBuildDigest, result.SandboxOutputBytes);
        DocumentExportRendererResponse response = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(result.SandboxOutputBytes);
        DocumentExportDocxProjection projection = DocumentExportDocxProjection.Create(response, input, cancellationToken);
        string semanticDigest = DocumentExportDocxVerifier.Validate(result.Bytes, projection, cancellationToken);
        DocumentExportContractValidator.Validate(result.Receipt, task, input, provider);
        DocumentExportProviderReceipt receipt = result.Receipt;
        if (receipt.ToolId != tool.ToolId || receipt.ToolVersion != tool.ToolVersion
            || receipt.SandboxReceiptDigest != result.SandboxReceipt.ContentDigest
            || receipt.OutputDigest != DocumentExportDigest.ComputeBytes(result.Bytes) || receipt.OutputBytes != result.Bytes.LongLength
            || receipt.SemanticDigest != semanticDigest || !receipt.ObservedFeatures.SequenceEqual(projection.Features, StringComparer.Ordinal)
            || !receipt.Warnings.SequenceEqual(projection.Warnings, StringComparer.Ordinal) || receipt.Errors.Count != 0
            || receipt.Status != DocumentExportProviderResultStatus.Succeeded)
        {
            throw new InvalidDataException("DOCX result/receipt does not match the verified frozen projection.");
        }
    }

    private static DocumentExportProviderContract RequireActiveProvider(string format)
    {
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(format);
        if (provider.FormatId != "docx" || !provider.ImplementationAvailable
            || provider.ProviderOwner != typeof(DocxDocumentExportProvider).FullName)
        {
            throw new InvalidOperationException("DOCX implementation has not been bound by the shared integration authority.");
        }
        return provider;
    }
}
