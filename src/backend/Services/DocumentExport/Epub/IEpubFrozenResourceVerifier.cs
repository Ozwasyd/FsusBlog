namespace FsusBlog.Server.Services.DocumentExport;

/// <summary>
/// Required capability supplied by the canonical resource/tool owner. Verify
/// complete font/media semantics for the exact frozen bytes through the shared
/// no-network sandbox and pinned tools. Header/Brotli checks alone are insufficient.
/// There is deliberately no permissive or header-only implementation here.
/// </summary>
public interface IEpubFrozenResourceVerifier
{
    void Validate(DocumentExportFrozenInput input, CancellationToken cancellationToken);

    /// <summary>Requires explicit support for the caller's attempt; native validation cannot create independent stage budgets.</summary>
    void Validate(DocumentExportFrozenInput input, DocumentExportAttemptResources attempt, CancellationToken cancellationToken)
        => throw new InvalidOperationException("EPUB resource verifier does not support the sole attempt resource owner.");
}
