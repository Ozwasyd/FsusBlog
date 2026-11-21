namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private const long MaxReaderUnixMs = 8_640_000_000_000_000L;

    internal static void Validate(AdminReaderAccountPage value)
    {
        if (value is null || value.Items is null ||
            value.Total < 0 || value.EnabledTotal < 0 || value.DisabledTotal < 0 ||
            value.Total > value.EnabledTotal + value.DisabledTotal ||
            value.Items.Count > WireLimits.AdminReaderPageSize ||
            value.NextCursorAccountId < 0 ||
            (value.HasMore ? value.NextCursorUserId == Guid.Empty || value.Items.Count == 0
                : value.NextCursorAccountId != 0 || value.NextCursorUserId != Guid.Empty))
            throw new ProtocolException("Invalid administrator reader account page.");

        foreach (var item in value.Items)
        {
            if (item is null || item.UserId == Guid.Empty || item.AccountId < 0 ||
                string.IsNullOrEmpty(item.Name) || item.Generation <= 0 ||
                item.PasskeyCount < 0 || item.ActiveSessionCount < 0 || item.CommentCount < 0 ||
                item.RegisteredAtUnixMs < 0 || item.RegisteredAtUnixMs > MaxReaderUnixMs ||
                item.LastUsedAtUnixMs < 0 || item.LastUsedAtUnixMs > MaxReaderUnixMs ||
                item.LastGovernanceAtUnixMs < 0 || item.LastGovernanceAtUnixMs > MaxReaderUnixMs ||
                (item.LastGovernanceAtUnixMs == 0
                    ? item.LastGovernanceActor.Length > 0 || item.LastGovernanceReason.Length > 0
                    : item.LastGovernanceActor.Length == 0 || item.LastGovernanceReason.Length == 0))
                throw new ProtocolException("Invalid administrator reader account entry.");
        }
    }

    internal static void Validate(AdminReaderStatusCommand value)
    {
        if (value is null || value.UserId == Guid.Empty || value.ExpectedGeneration <= 0 ||
            value.IdempotencyKey == Guid.Empty || value.Reason.Length == 0 ||
            value.Reason.Length > WireLimits.AdminReaderReasonChars)
            throw new ProtocolException("Invalid administrator reader status command.");
    }

    internal static void Validate(AdminReaderStatusReceipt value)
    {
        if (value is null || value.UserId == Guid.Empty || value.Generation <= 1 ||
            value.RevokedSessionCount < 0 || value.HappenedAtUnixMs <= 0 ||
            value.HappenedAtUnixMs > MaxReaderUnixMs)
            throw new ProtocolException("Invalid administrator reader status receipt.");
    }
}
