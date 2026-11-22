using System.Text;

namespace FsusBlog.V2.Contracts;

public sealed record ArticleSummaryCommand(int Id, long ExpectedRevision, Guid IdempotencyKey, string Text);
public sealed record ArticleSummary(int Id, long Revision, string Text);

public static partial class Wire
{
    public static byte[] EncodeArticleSummaryCommand(ArticleSummaryCommand value)
    {
        ValidateArticleSummaryCommand(value);
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.ExpectedRevision);
        writer.Uuid(value.IdempotencyKey);
        WriteArticleSummaryText(writer, value.Text, WireLimits.ArticleSummaryEditBytes);
        return Aeds.Encode(FrameType.ArticleSummaryCommand, writer.Written);
    }

    public static ArticleSummaryCommand DecodeArticleSummaryCommand(ReadOnlySpan<byte> frame)
    {
        var reader = Reader.Open(frame, FrameType.ArticleSummaryCommand, WireLimits.MaxArticleSummaryCommandFrameBytes,
            InvalidArticleSummary);
        var value = new ArticleSummaryCommand(reader.I32(), reader.I64(), reader.Uuid(),
            reader.Text(WireLimits.ArticleSummaryEditBytes));
        reader.Finish();
        ValidateArticleSummaryCommand(value);
        return value;
    }

    public static byte[] EncodeArticleSummary(ArticleSummary value)
    {
        ValidateArticleSummary(value.Id, value.Revision, value.Text, WireLimits.ArticleSummaryReadChars);
        var writer = new Writer();
        writer.I32(value.Id);
        writer.I64(value.Revision);
        WriteArticleSummaryText(writer, value.Text, WireLimits.ArticleSummaryReadBytes);
        return Aeds.Encode(FrameType.ArticleSummary, writer.Written);
    }

    public static ArticleSummary DecodeArticleSummary(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.ArticleSummary));
        var value = new ArticleSummary(reader.I32(), reader.I64(), reader.Text(WireLimits.ArticleSummaryReadBytes));
        reader.Finish();
        ValidateArticleSummary(value.Id, value.Revision, value.Text, WireLimits.ArticleSummaryReadChars);
        return value;
    }

    private static void WriteArticleSummaryText(Writer writer, string text, int maxBytes)
    {
        try
        {
            writer.Text(text, maxBytes);
        }
        catch (EncoderFallbackException)
        {
            throw InvalidArticleSummary();
        }
    }

    private static void ValidateArticleSummaryCommand(ArticleSummaryCommand value)
    {
        if (value.IdempotencyKey == Guid.Empty) throw InvalidArticleSummary();
        ValidateArticleSummary(value.Id, value.ExpectedRevision, value.Text, WireLimits.ArticleSummaryEditChars);
    }

    private static void ValidateArticleSummary(int id, long revision, string text, int maxChars)
    {
        if (id <= 0 || revision <= 0 || text.Length > maxChars || text.Contains('\0')) throw InvalidArticleSummary();
    }

    private static ProtocolException InvalidArticleSummary() => new("Invalid private article summary.");
}
