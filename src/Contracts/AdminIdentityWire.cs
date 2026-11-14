namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(AdminModerationIntent value)
    {
        if (value.ArticleId <= 0 || value.CommentId <= 0 || value.ExpectedStatus != 0 || value.Decision is not (1 or 2) ||
            value.Reason.Length == 0 || value.Reason != value.Reason.Trim() || value.Reason.Any(char.IsControl))
            throw new ProtocolException("Invalid pending comment moderation intent.");
    }

    internal static void Validate(AdminSessionSnapshot value)
    {
        if (value.Handle.Length is < 1 or > 64 || value.Generation <= 0 || value.ExpiresAt <= 0)
            throw new ProtocolException("Invalid administrator session.");
    }

    internal static void Validate(AdminOperationsStatus value)
    {
        if (value.PublicationWatermark < 0 || (!value.SnapshotReady && value.PublicationWatermark != 0) ||
            value.PendingPublicationEvents < 0 || value.OldestPendingAt < 0 ||
            (value.PendingPublicationEvents == 0) != (value.OldestPendingAt == 0))
            throw new ProtocolException("Invalid administrator operations status.");
    }
}
