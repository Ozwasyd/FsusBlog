using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.Execution;

namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Sole EPUB format module. The shared composition owner must activate it with
/// the existing canonical sandbox adapter and exact catalog/tool binding.
/// Missing registration or frozen metadata fails before renderer execution.
/// </summary>
public sealed class DocumentExportEpubProvider
{
    private readonly ICanonicalDocumentRendererAdapter _renderer;
    private readonly IEpubFrozenResourceVerifier _resources;

    internal DocumentExportEpubProvider(ICanonicalDocumentRendererAdapter renderer, IEpubFrozenResourceVerifier resources)
    {
        _renderer = renderer ?? throw new ArgumentNullException(nameof(renderer));
        _resources = resources ?? throw new ArgumentNullException(nameof(resources));
    }

    /// <summary>Exports only EPUB bytes and the existing sandbox-bound provider result; no storage or lifecycle is owned here.</summary>
    public Task<DocumentExportProviderResult> ExportAsync(DocumentExportTask task,
        DocumentExportFrozenInput input, EpubPublicationMetadata metadata, CancellationToken cancellationToken = default)
        => ExportAttemptAsync(task, input, metadata, null, cancellationToken);

    /// <summary>Retains the caller's sole attempt resource owner through rendering and host output accounting.</summary>
    public Task<DocumentExportProviderResult> ExportAsync(DocumentExportTask task,
        DocumentExportFrozenInput input, EpubPublicationMetadata metadata, DocumentExportAttemptResources attempt,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(attempt);
        return ExportAttemptAsync(task, input, metadata, attempt, cancellationToken);
    }

    private async Task<DocumentExportProviderResult> ExportAttemptAsync(DocumentExportTask task,
        DocumentExportFrozenInput input, EpubPublicationMetadata metadata, DocumentExportAttemptResources? attempt,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.ValidateCatalog(DocumentExportContractCatalog.Providers);
        DocumentExportContractValidator.Validate(task, input);
        metadata.Validate(input);
        DocumentExportProviderContract provider = RequireActiveProvider(task);
        DocumentExportToolContract rendererTool = _renderer.Tool;
        rendererTool = rendererTool with
        {
            Arguments = rendererTool.Arguments.ToArray().ToImmutableArray()
        };
        RequireCanonicalToolBinding(provider, rendererTool);
        DocumentExportFrozenInput frozen = DocumentExportContractValidator.Seal(input);
        metadata = metadata with
        {
            Authors = metadata.Authors.ToArray().ToImmutableArray()
        };
        using var deadline = TimeoutCancellationScope.Create(provider.Budgets.WallTime, cancellationToken);
        try
        {
            return await ExportCoreAsync(task, frozen, metadata, provider, rendererTool, attempt, deadline.Token);
        }
        catch (OperationCanceledException) when (deadline.IsTimeoutCancellationRequested)
        {
            throw new DocumentExportBudgetExceededException("EPUB execution exceeded its wall-time budget.", "wall-time-budget");
        }
    }

    private async Task<DocumentExportProviderResult> ExportCoreAsync(DocumentExportTask task, DocumentExportFrozenInput frozen,
        EpubPublicationMetadata metadata, DocumentExportProviderContract provider, DocumentExportToolContract rendererTool,
        DocumentExportAttemptResources? attempt, CancellationToken cancellationToken)
    {
        CanonicalDocumentRendererResult rendered = attempt is null
            ? await _renderer.RenderAsync(task, frozen, cancellationToken)
            : await _renderer.RenderAsync(task, frozen, attempt, cancellationToken);
        if (attempt is not null && !ReferenceEquals(attempt, rendered.AttemptResources))
        {
            throw new InvalidDataException("EPUB canonical renderer did not retain the sole attempt resource owner.");
        }
        if (DocumentExportDigest.Compute(rendered.Tool) != DocumentExportDigest.Compute(rendererTool))
        {
            throw new InvalidDataException("EPUB canonical renderer substituted its frozen tool identity.");
        }
        DocumentExportSandboxRuntime.ValidateCanonicalRendererReceipt(rendered.SandboxReceipt, rendered.SandboxPlan,
            task, frozen, rendererTool, rendered.SandboxPlan.HostBuildDigest, rendered.ResponseBytes);
        DocumentExportAttemptResources? resourceOwner = attempt ?? rendered.AttemptResources;
        if (resourceOwner is null)
        {
            _resources.Validate(frozen, cancellationToken);
        }
        else
        {
            _resources.Validate(frozen, resourceOwner, cancellationToken);
        }
        RequireCanonicalToolBinding(provider, rendererTool);
        DocumentExportRendererResponse response = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(rendered.ResponseBytes);
        EpubPackageBuildResult package = EpubPackageBuilder.Build(frozen, response, metadata,
            provider.Budgets, cancellationToken);
        resourceOwner?.AccountHostOutputBytes(package.Bytes.LongLength);
        EpubPackageValidation validation = package.Validation;
        DocumentExportProviderReceipt receipt = DocumentExportContractValidator.Seal(new DocumentExportProviderReceipt(
            DocumentExportContractCatalog.ResultSchema, task.ContentDigest, frozen.ContentDigest,
            provider.ProviderId, provider.ProviderVersion, frozen.RendererId, frozen.RendererVersion, frozen.RendererDigest,
            frozen.AssetManifestDigest, frozen.FontManifestDigest, frozen.ReadingStyleAuthorityDigest,
            rendererTool.ToolId, rendererTool.ToolVersion, rendered.SandboxReceipt.ContentDigest,
            provider.OutputMediaType, provider.OutputExtension, provider.NormalizationPolicy,
            validation.OutputDigest, validation.SemanticDigest, validation.OutputBytes, validation.ObservedFeatures,
            validation.Warnings, [], DocumentExportProviderResultStatus.Succeeded,
            (long)provider.Delivery.RetentionTtl.TotalSeconds, string.Empty));
        DocumentExportContractValidator.Validate(receipt, task, frozen, provider);
        cancellationToken.ThrowIfCancellationRequested();
        return new DocumentExportProviderResult(package.Bytes, rendered.ResponseBytes, receipt,
            rendered.SandboxPlan, rendered.SandboxReceipt);
    }

    /// <summary>Revalidates actual EPUB bytes and existing receipts against the caller's exact frozen identities.</summary>
    public static EpubPackageValidation ValidateResult(DocumentExportProviderResult result, DocumentExportTask task,
        DocumentExportFrozenInput input, EpubPublicationMetadata metadata, DocumentExportToolContract tool,
        string expectedHostBuildDigest, IEpubFrozenResourceVerifier resources, CancellationToken cancellationToken = default)
        => ValidateResultCore(result, task, input, metadata, tool, expectedHostBuildDigest, resources, null, cancellationToken);

    /// <summary>Validates resource facts using the caller's exact attempt without creating or finalizing a stage.</summary>
    public static EpubPackageValidation ValidateResult(DocumentExportProviderResult result, DocumentExportTask task,
        DocumentExportFrozenInput input, EpubPublicationMetadata metadata, DocumentExportToolContract tool,
        string expectedHostBuildDigest, IEpubFrozenResourceVerifier resources, DocumentExportAttemptResources attempt,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(attempt);
        return ValidateResultCore(result, task, input, metadata, tool, expectedHostBuildDigest, resources, attempt, cancellationToken);
    }

    private static EpubPackageValidation ValidateResultCore(DocumentExportProviderResult result, DocumentExportTask task,
        DocumentExportFrozenInput input, EpubPublicationMetadata metadata, DocumentExportToolContract tool,
        string expectedHostBuildDigest, IEpubFrozenResourceVerifier resources, DocumentExportAttemptResources? attempt,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(result);
        cancellationToken.ThrowIfCancellationRequested();
        DocumentExportContractValidator.Validate(task, input);
        DocumentExportProviderContract provider = RequireActiveProvider(task);
        RequireCanonicalToolBinding(provider, tool);
        DocumentExportSandboxRuntime.ValidateCanonicalRendererPlan(result.SandboxPlan, task, input, tool, expectedHostBuildDigest);
        DocumentExportSandboxRuntime.ValidateCanonicalRendererReceipt(result.SandboxReceipt, result.SandboxPlan, task, input, tool,
            expectedHostBuildDigest, result.SandboxOutputBytes);
        DocumentExportRendererResponse response = DocumentExportDigest.Deserialize<DocumentExportRendererResponse>(result.SandboxOutputBytes);
        ArgumentNullException.ThrowIfNull(resources);
        if (attempt is null)
        {
            resources.Validate(input, cancellationToken);
        }
        else
        {
            resources.Validate(input, attempt, cancellationToken);
        }
        EpubPackageValidation validation = DocumentExportEpubPackageValidator.Validate(result.Bytes, input, response,
            metadata, provider.Budgets, cancellationToken);
        DocumentExportContractValidator.Validate(result.Receipt, task, input, provider);
        if (result.Receipt.SandboxReceiptDigest != result.SandboxReceipt.ContentDigest
            || result.Receipt.OutputDigest != validation.OutputDigest || result.Receipt.SemanticDigest != validation.SemanticDigest
            || result.Receipt.OutputBytes != validation.OutputBytes || result.Receipt.Errors.Count != 0
            || result.Receipt.Status != DocumentExportProviderResultStatus.Succeeded
            || !result.Receipt.ObservedFeatures.SequenceEqual(validation.ObservedFeatures, StringComparer.Ordinal)
            || !result.Receipt.Warnings.SequenceEqual(validation.Warnings, StringComparer.Ordinal))
        {
            throw new InvalidDataException("EPUB output or receipt facts are tampered or unqualified.");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return validation;
    }

    private static DocumentExportProviderContract RequireActiveProvider(DocumentExportTask task)
    {
        DocumentExportProviderContract provider = DocumentExportContractCatalog.RequireProvider(task.FormatId);
        if (provider.FormatId != "epub" || provider.ProviderId != "document-export.epub"
            || provider.ProviderVersion != "1" || !provider.ImplementationAvailable
            || provider.OutputMediaType != "application/epub+zip" || provider.OutputExtension != ".epub"
            || provider.NormalizationPolicy != "normalized-epub-v1"
            || DocumentExportContractCatalog.ExecutionBindings.Single(candidate => candidate.ProviderId == provider.ProviderId)
                .ImplementationIdentity != typeof(DocumentExportEpubProvider).FullName)
        {
            throw new InvalidOperationException("EPUB has no active exact provider/tool registration; format fallback is prohibited.");
        }
        return provider;
    }

    private static void RequireCanonicalToolBinding(DocumentExportProviderContract provider, DocumentExportToolContract tool)
    {
        DocumentExportProviderContract renderer = DocumentExportContractCatalog.RequireProvider("self-contained-html");
        DocumentExportProviderExecutionBinding binding = DocumentExportContractCatalog.ExecutionBindings.Single(
            candidate => candidate.ProviderId == renderer.ProviderId);
        if (!renderer.ImplementationAvailable || provider.RendererId != renderer.RendererId
            || provider.RendererVersion != renderer.RendererVersion
            || binding.ToolId != tool.ToolId || binding.ToolVersion != tool.ToolVersion
            || renderer.ToolchainId != tool.ToolId || renderer.ToolchainVersion != tool.ToolVersion
            || !binding.ExactArguments.SequenceEqual(tool.Arguments, StringComparer.Ordinal))
        {
            throw new InvalidDataException("EPUB canonical renderer adapter does not match the shared closed registry.");
        }
    }
}
