namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(AdminModerationIntent value)
    {
        if (value.ArticleId <= 0 || value.CommentId <= 0 || value.ExpectedStatus != 0 || value.Decision is not (1 or 2) ||
            value.Reason.Length == 0 || value.Reason != value.Reason.Trim() || value.Reason.Any(char.IsControl))
            throw new ProtocolException("Invalid pending comment moderation intent.");
    }

    internal static void Validate(AdminModerationClaimRequest value)
    {
        if (value.ArticleId <= 0 || value.CommentId <= 0) throw new ProtocolException("Invalid pending comment coordinates.");
    }

    internal static void Validate(AdminModerationClaim value)
    {
        Validate(new AdminModerationClaimRequest(value.ArticleId, value.CommentId));
        ValidateClaim(value.CommentVersion, value.ClaimGeneration, value.ClaimVersion, value.ClaimToken);
        if (value.ExpiresAt <= 0) throw new ProtocolException("Invalid comment claim expiry.");
    }

    internal static void Validate(AdminModerationDecision value)
    {
        Validate(new AdminModerationIntent(value.ArticleId, value.CommentId, value.ExpectedStatus, value.Decision, value.Reason));
        ValidateClaim(value.CommentVersion, value.ClaimGeneration, value.ClaimVersion, value.ClaimToken);
    }

    private static void ValidateClaim(long commentVersion, long generation, long version, string token)
    {
        if (commentVersion <= 0 || generation <= 0 || version <= 0 || token.Length != WireLimits.AdminModerationClaimTokenBytes ||
            !token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
            throw new ProtocolException("Invalid comment claim coordinates.");
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
