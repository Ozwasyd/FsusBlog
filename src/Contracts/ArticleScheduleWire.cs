namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(ArticleSchedule value)
    {
        if (value.Id <= 0 || value.Revision <= 0 || value.DueUnixMs is < 0 or > 253402300799999L ||
            value.PublishedRevision < 0 || value.PublishedRevision > value.Revision)
            throw new ProtocolException("Invalid schedule coordinates");
    }

    internal static void Validate(ArticleScheduleCommand value)
    {
        if (value.Id <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.DueUnixMs is < 0 or > 253402300799999L)
            throw new ProtocolException("Invalid schedule command");
    }
}
