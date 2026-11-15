namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(AdminRiskReadiness value)
    {
        if (value.PublicReadMode != 1 || value.RootWriteMode is < 0 or > 1 ||
            value.ReplyWriteMode is < 0 or > 2 || (value.RootWriteMode == 0 && value.ReplyWriteMode != 0) ||
            value.ForwardingMode is < 0 or > 1 || value.DynamicRisk != 0 || value.StrongAnonymous != 0)
            throw new ProtocolException("Invalid installed risk controls.");
    }
}
