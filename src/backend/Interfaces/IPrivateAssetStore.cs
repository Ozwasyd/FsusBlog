using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Interfaces;

public enum PrivateAssetWritePurpose
{
    BinaryAttachment,
    PortableDocument,
    ArchiveExport,
    DataExport,
    ImageOriginal
}

public sealed record PrivateAssetWriteRequest(
    AssetId AssetId,
    Stream Content,
    PrivateAssetWritePurpose Purpose);

public sealed record PrivateAssetReadHandle(
    AssetId AssetId,
    AssetStorageKey StorageKey,
    string MediaType,
    string Extension,
    long SizeBytes,
    string Sha256,
    Stream? Content = null) : IAsyncDisposable
{
    public ValueTask DisposeAsync()
        => Content?.DisposeAsync() ?? ValueTask.CompletedTask;
}

public interface IPrivateAssetStore
{
    Task<AssetStorageKey> CreateAsync(
        PrivateAssetWriteRequest request,
        CancellationToken cancellationToken = default);

    Task<PrivateAssetReadHandle?> OpenReadAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default);

    Task<PrivateAssetReadHandle?> ValidateAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default);

    Task DeleteAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default);
}
