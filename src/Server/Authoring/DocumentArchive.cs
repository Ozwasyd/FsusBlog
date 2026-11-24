namespace FsusBlog.V2.Server.Authoring;

internal static class DocumentArchive
{
    private static readonly DateTimeOffset Epoch = new(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);

    internal static Stream Open(ZipArchive zip, string name, CompressionLevel compression = CompressionLevel.Fastest)
    {
        var entry = zip.CreateEntry(name, compression);
        entry.LastWriteTime = Epoch;
        return entry.Open();
    }

    internal static void Write(ZipArchive zip, string name, ReadOnlySpan<byte> contents,
        CompressionLevel compression = CompressionLevel.Fastest)
    {
        using var part = Open(zip, name, compression);
        part.Write(contents);
    }
}
