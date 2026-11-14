namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
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
