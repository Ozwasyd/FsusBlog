namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    private static void Validate(AdminSitePages value)
    {
        if (value.ConfiguredMask is < 0 or > 15)
            throw new ProtocolException("Invalid site page configuration states");
    }
}
