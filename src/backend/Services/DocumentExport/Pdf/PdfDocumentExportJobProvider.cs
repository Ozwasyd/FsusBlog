using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Adapts the PDF implementation to the sole document-export job contract.
/// Admission, persistence, lifecycle, registration and delivery remain job-owned.
/// </summary>
public sealed class PdfDocumentExportJobProvider : IDocumentExportJobProvider
{
    private readonly PdfDocumentExportProvider _provider;
    private readonly string _expectedHostBuildDigest;

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

    public string ProviderId => "document-export.pdf";

    public async Task<DocumentExportProviderResult> ExportAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken)
        => (await _provider.ExportAsync(task, input, cancellationToken)).ProviderResult;

    public async Task VerifyAsync(
        DocumentExportProviderResult result,
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken)
        => _ = await _provider.ValidateProviderResultAsync(
            result, task, input, _expectedHostBuildDigest, cancellationToken);
}
