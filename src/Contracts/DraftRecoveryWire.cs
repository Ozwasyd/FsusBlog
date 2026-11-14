namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(DraftRecoveryScope input)
    {
        if (input.SiteId == Guid.Empty || input.UserId == Guid.Empty)
            throw new ProtocolException("Invalid recovery scope.");
    }
}
