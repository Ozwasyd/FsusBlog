using FsusBlog.V2.Platform;

namespace FsusBlog.V2.Server.Content;

internal sealed class MediaFiles(string path, string publicRoot) : IDisposable
{
    private readonly MediaObjectDirectory objects = new(path, MediaImage.MaxBytes,
        [publicRoot, Path.Combine(publicRoot, "assets"), Path.Combine(publicRoot, "dist")]);

    internal string Root => objects.Root;

    internal Task<byte[]?> Read(Guid id, int length, byte[] hash, CancellationToken token) =>
        objects.Read(Name(id), length, hash, token);

    internal Task Materialize(Guid id, MediaImage image, CancellationToken token) =>
        objects.Materialize(Name(id), image.Bytes, image.Hash, token);

    internal Task Delete(Guid id, int length, byte[] hash, CancellationToken token) =>
        objects.Delete(Name(id), length, hash, token);

    public void Dispose() => objects.Dispose();

    private static string Name(Guid id) => $"{id:N}.media";
}
