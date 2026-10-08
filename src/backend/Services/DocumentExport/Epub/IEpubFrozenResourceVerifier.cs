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
}
