using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Adapts the PDF implementation to the sole document-export job contract.
/// Admission, persistence, lifecycle, registration and delivery remain job-owned.
/// </summary>
public sealed class PdfDocumentExportJobProvider : IDocumentExportAttemptJobProvider
{
    private readonly PdfDocumentExportProvider _provider;
    private readonly string _expectedHostBuildDigest;
    private readonly PdfDocumentExportAttemptEvidence _evidence = new();

    /// <summary>
    /// Binds the provider to the trusted host build digest used for verification.
    /// Invalid dependencies or a malformed digest fail construction.
    /// </summary>
    public PdfDocumentExportJobProvider(PdfDocumentExportProvider provider, string expectedHostBuildDigest)
    {
        _provider = provider ?? throw new ArgumentNullException(nameof(provider));
        if (string.IsNullOrEmpty(expectedHostBuildDigest) || expectedHostBuildDigest.Length != 71
            || !expectedHostBuildDigest.StartsWith("sha256:", StringComparison.Ordinal)
            || expectedHostBuildDigest.AsSpan(7).ContainsAnyExcept("0123456789abcdef"))
        {
            throw new ArgumentException("PDF verification requires the trusted host build digest.", nameof(expectedHostBuildDigest));
        }
        _expectedHostBuildDigest = expectedHostBuildDigest;
    }

    /// <summary>Identifies the PDF implementation to the shared job owner.</summary>
    public string ProviderId => "document-export.pdf";

    /// <summary>
    /// Renders the frozen article through the canonical and PDF sandbox phases,
    /// returning generic output evidence without adding persistence or delivery.
    /// Registry refusal, invalid evidence and cancellation propagate to the job owner.
    /// </summary>
    public async Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken)
        => _evidence.Retain(await _provider.ExportAsync(task, input, cancellationToken));

    public DocumentExportAttemptResources CreateAttemptResources(
        DocumentExportTask task, DocumentExportFrozenInput input, TimeProvider time)
        => _provider.CreateAttemptResources(task, input, time);

    public async Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportAttemptResources resources,
        CancellationToken cancellationToken)
        => _evidence.Retain(await _provider.ExportAsync(task, input, resources, cancellationToken));

    public async Task VerifyAsync(
        DocumentExportProviderResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        PdfDocumentExportResult evidence = _evidence.Take(result);
        _ = await _provider.ValidateResultAsync(evidence, task, input, _expectedHostBuildDigest, cancellationToken);
    }

    /// <summary>
    /// Re-runs the canonical renderer for the same frozen article and verifies the
    /// supplied PDF bytes against it without creating a replacement PDF or state.
    /// Verification failures and cancellation propagate to the job owner.
    /// </summary>
    public async Task VerifyAsync(
        DocumentExportProviderResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        DocumentExportAttemptResources resources,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(resources);
        cancellationToken.ThrowIfCancellationRequested();
        PdfDocumentExportResult evidence = _evidence.Take(result, resources);
        _ = await _provider.ValidateResultAsync(evidence, task, input, _expectedHostBuildDigest, resources, cancellationToken);
    }
}
