namespace FsusBlog.Server.Services.DocumentExport;

internal sealed record CanonicalDocumentRendererResult(
    DocumentExportRendererResponse Response,
    byte[] ResponseBytes,
    DocumentExportSandboxPlan SandboxPlan,
    DocumentExportSandboxReceipt SandboxReceipt,
    DocumentExportToolContract Tool);

/// <summary>
/// The replaceable boundary to the one canonical Markdown renderer. It owns the
/// exact registered tool contract; callers and providers cannot supply a tool,
/// command, parser, or fallback per invocation.
/// </summary>
internal interface ICanonicalDocumentRendererAdapter
{
    DocumentExportToolContract Tool
    {
        get;
    }

    Task<CanonicalDocumentRendererResult> RenderAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken = default);
}

internal sealed class SandboxCanonicalDocumentRendererAdapter : ICanonicalDocumentRendererAdapter
{
    private readonly DocumentExportSandboxRuntime _sandbox;
    private readonly DocumentExportToolContract _tool;

    internal SandboxCanonicalDocumentRendererAdapter(
        DocumentExportSandboxRuntime sandbox,
        DocumentExportToolContract tool)
    {
        _sandbox = sandbox ?? throw new ArgumentNullException(nameof(sandbox));
        _tool = tool ?? throw new ArgumentNullException(nameof(tool));
        DocumentExportProviderExecutionBinding binding = DocumentExportContractCatalog.ExecutionBindings.Single(
            candidate => candidate.ProviderId == "document-export.self-contained-html");
        if (_tool.ToolId != binding.ToolId
            || _tool.ToolVersion != binding.ToolVersion
            || !_tool.Arguments.SequenceEqual(binding.ExactArguments, StringComparer.Ordinal))
        {
            throw new InvalidDataException("Canonical renderer adapter tool identity drifted from the closed registry.");
        }
    }

    public DocumentExportToolContract Tool => _tool;

    public async Task<CanonicalDocumentRendererResult> RenderAsync(
        DocumentExportTask task,
        DocumentExportFrozenInput input,
        CancellationToken cancellationToken = default)
    {
        var request = new DocumentExportRendererRequest(
            DocumentExportContractCatalog.RendererRequestSchema,
            input.InputId,
            input.ContentDigest,
            input.SourceDigest,
            input.AssetManifestDigest,
            input.FontManifestDigest,
            input.ReadingStyleAuthorityDigest,
            input.MarkdownUtf8,
            input.RendererId,
            input.RendererVersion,
            input.RendererDigest,
            input.LayoutProfile,
            input.ThemeProfile,
            input.Locale,
            input.Assets);

        DocumentExportSandboxResult sandboxResult = await _sandbox.ExecuteAsync(
            task,
            input,
            _tool,
            (output, token) => DocumentExportDigest.SerializeAsync(output, request, token),
            cancellationToken);
        DocumentExportSandboxRuntime.ValidateReceipt(
            sandboxResult.Receipt,
            sandboxResult.Plan,
            task,
            input,
            _tool,
            sandboxResult.Plan.HostBuildDigest,
            sandboxResult.OutputBytes);
        DocumentExportRendererResponse response = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(
            sandboxResult.OutputBytes);
        return new CanonicalDocumentRendererResult(
            response,
            sandboxResult.OutputBytes,
            sandboxResult.Plan,
            sandboxResult.Receipt,
            _tool);
    }
}

/// <summary>
/// Closed composition root for implemented document export providers. The
/// sandbox remains the sole tool registry and supplies its own frozen binding.
/// </summary>
public sealed class DocumentExportProviderRegistry
{
    private readonly SelfContainedHtmlDocumentExportProvider _html;

    public DocumentExportProviderRegistry(DocumentExportSandboxRuntime sandbox)
    {
        ArgumentNullException.ThrowIfNull(sandbox);
        DocumentExportContractValidator.ValidateCatalog(DocumentExportContractCatalog.Providers);
        DocumentExportToolContract tool = sandbox.RequireRegisteredTool("self-contained-html");
        _html = new SelfContainedHtmlDocumentExportProvider(
            new SandboxCanonicalDocumentRendererAdapter(sandbox, tool));
    }

    public SelfContainedHtmlDocumentExportProvider RequireSelfContainedHtml(string formatId)
    {
        DocumentExportProviderContract contract = DocumentExportContractCatalog.RequireProvider(formatId);
        if (!contract.ImplementationAvailable || contract.FormatId != "self-contained-html")
        {
            throw new InvalidOperationException($"Document export format '{formatId}' has no active provider.");
        }
        return _html;
    }
}

internal sealed class DocumentExportBoundedMemoryStream : MemoryStream
{
    private readonly long _maximumBytes;
    private readonly string _message;
    private readonly string _failureCode;

    internal DocumentExportBoundedMemoryStream(
        long maximumBytes,
        string message,
        string failureCode = "resource-budget")
    {
        if (maximumBytes <= 0 || maximumBytes > int.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        }
        _maximumBytes = maximumBytes;
        _message = message;
        _failureCode = failureCode;
    }

    public override void Write(byte[] buffer, int offset, int count)
    {
        EnsureCapacityFor(count);
        base.Write(buffer, offset, count);
    }

    public override void Write(ReadOnlySpan<byte> buffer)
    {
        EnsureCapacityFor(buffer.Length);
        base.Write(buffer);
    }

    public override async ValueTask WriteAsync(
        ReadOnlyMemory<byte> buffer,
        CancellationToken cancellationToken = default)
    {
        EnsureCapacityFor(buffer.Length);
        await base.WriteAsync(buffer, cancellationToken);
    }

    private void EnsureCapacityFor(int count)
    {
        if (count < 0 || Position > _maximumBytes - count)
        {
            throw new DocumentExportBudgetExceededException(_message, _failureCode);
        }
    }
}
