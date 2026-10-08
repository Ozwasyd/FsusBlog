using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Adapts EPUB to the sole job API at its canonical boundary. Metadata resolution
/// must return the exact pre-admission projection, never latest article data.
/// The existing provider rechecks its digest on export and independent verification.
/// </summary>
public sealed class EpubDocumentExportJobProvider : IDocumentExportJobProvider
{
    private readonly DocumentExportEpubProvider _provider;
    private readonly Func<DocumentExportFrozenInput, EpubPublicationMetadata> _frozenMetadata;
    private readonly DocumentExportToolContract _tool;
    private readonly string _hostBuildDigest;
    private readonly IEpubFrozenResourceVerifier _resources;

    internal EpubDocumentExportJobProvider(DocumentExportEpubProvider provider,
        Func<DocumentExportFrozenInput, EpubPublicationMetadata> frozenMetadata,
        DocumentExportToolContract tool, string hostBuildDigest, IEpubFrozenResourceVerifier resources)
    {
        _provider = provider ?? throw new ArgumentNullException(nameof(provider));
        _frozenMetadata = frozenMetadata ?? throw new ArgumentNullException(nameof(frozenMetadata));
        _tool = tool ?? throw new ArgumentNullException(nameof(tool));
        DocumentExportContractValidator.RequireDigest(hostBuildDigest, nameof(hostBuildDigest));
        _hostBuildDigest = hostBuildDigest;
        _resources = resources ?? throw new ArgumentNullException(nameof(resources));
    }

    public string ProviderId => "document-export.epub";

    public Task<DocumentExportProviderResult> ExportAsync(DocumentExportTask task,
        DocumentExportFrozenInput input, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return _provider.ExportAsync(task, input, _frozenMetadata(input), cancellationToken);
    }

    public Task VerifyAsync(DocumentExportProviderResult result, DocumentExportTask task,
        DocumentExportFrozenInput input, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportEpubProvider.ValidateResult(result, task, input, _frozenMetadata(input),
            _tool, _hostBuildDigest, _resources, cancellationToken);
        return Task.CompletedTask;
    }
}
