namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Adapts EPUB to the sole job API at its canonical boundary. Metadata resolution
/// must return the exact pre-admission projection, never latest article data.
/// The existing provider rechecks its digest on export and independent verification.
/// </summary>
public sealed class EpubDocumentExportJobProvider : IDocumentExportAttemptJobProvider
{
    private readonly DocumentExportEpubProvider _provider;
    private readonly Func<DocumentExportFrozenInput, EpubPublicationMetadata> _frozenMetadata;
    private readonly DocumentExportToolContract _tool;
    private readonly string _hostBuildDigest;
    private readonly IEpubFrozenResourceVerifier _resources;
    private readonly Func<DocumentExportTask, DocumentExportFrozenInput, TimeProvider, DocumentExportAttemptResources> _createAttemptResources;

    internal EpubDocumentExportJobProvider(DocumentExportEpubProvider provider,
        Func<DocumentExportFrozenInput, EpubPublicationMetadata> frozenMetadata,
        DocumentExportToolContract tool, string hostBuildDigest, IEpubFrozenResourceVerifier resources,
        Func<DocumentExportTask, DocumentExportFrozenInput, TimeProvider, DocumentExportAttemptResources> createAttemptResources)
    {
        _provider = provider ?? throw new ArgumentNullException(nameof(provider));
        _frozenMetadata = frozenMetadata ?? throw new ArgumentNullException(nameof(frozenMetadata));
        _tool = tool ?? throw new ArgumentNullException(nameof(tool));
        DocumentExportContractValidator.RequireDigest(hostBuildDigest, nameof(hostBuildDigest));
        _hostBuildDigest = hostBuildDigest;
        _resources = resources ?? throw new ArgumentNullException(nameof(resources));
        _createAttemptResources = createAttemptResources ?? throw new ArgumentNullException(nameof(createAttemptResources));
    }

    public string ProviderId => "document-export.epub";

    /// <summary>Delegates only to the shared sandbox factory supplied by the composition owner; the job calls it after claim.</summary>
    public DocumentExportAttemptResources CreateAttemptResources(DocumentExportTask task,
        DocumentExportFrozenInput input, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(time);
        return _createAttemptResources(task, input, time);
    }

    public Task<DocumentExportProviderResult> ExportAsync(DocumentExportTask task,
        DocumentExportFrozenInput input, DocumentExportAttemptResources attempt, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(attempt);
        return _provider.ExportAsync(task, input, _frozenMetadata(input), attempt, cancellationToken);
    }

    public Task VerifyAsync(DocumentExportProviderResult result, DocumentExportTask task,
        DocumentExportFrozenInput input, DocumentExportAttemptResources attempt, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(attempt);
        DocumentExportEpubProvider.ValidateResult(result, task, input, _frozenMetadata(input),
            _tool, _hostBuildDigest, _resources, attempt, cancellationToken);
        attempt.RequireCompleted(task, input);
        return Task.CompletedTask;
    }

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
