namespace FsusBlog.V2.Contracts;

public sealed record SavedRevisionMetadata(string Summary, TaxonomyName? Category, IReadOnlyList<TaxonomyName> Tags);

public static partial class Wire
{
    public static byte[] EncodeRevisionMetadataComparison(int id, long revision, long sourceRevision,
        SavedRevisionMetadata current, SavedRevisionMetadata source)
    {
        var writer = new Writer();
        writer.I32(id);
        writer.I64(revision);
        writer.I64(sourceRevision);
        WriteRevisionMetadata(writer, current);
        WriteRevisionMetadata(writer, source);
        return Aeds.Encode(FrameType.RevisionMetadataComparison, writer.Written);
    }

    private static void WriteRevisionMetadata(Writer writer, SavedRevisionMetadata metadata)
    {
        writer.Text(metadata.Summary, WireLimits.ArticleSummaryReadBytes);
        writer.I32(metadata.Category?.Id ?? 0);
        if (metadata.Category is { } category) writer.Text(category.Name, WireLimits.TaxonomyNameBytes);
        if (metadata.Tags.Count > WireLimits.TaxonomyTagCount)
            throw new ProtocolException("Too many tags on the saved revision.");
        writer.I32(metadata.Tags.Count);
        foreach (var tag in metadata.Tags)
        {
            writer.I32(tag.Id);
            writer.Text(tag.Name, WireLimits.TaxonomyNameBytes);
        }
    }
}
