namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(AdminClusterStatus value)
    {
        if (value.Mode != 1 || value.InstanceId == Guid.Empty || !ValidClusterNodeId(value.NodeId) ||
            value.BuildVersion.Length is < 1 or > WireLimits.AdminClusterVersionBytes ||
            !value.BuildVersion.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '-' or '+') ||
            value.StartedAt is <= 0 or > 253_402_300_799_999 || value.ObservedAt is <= 0 or > 253_402_300_799_999 ||
            value.LeaseAgeMs is < 0 or >= 1000)
            throw new ProtocolException("Invalid standalone deployment observation.");
    }

    public static bool ValidClusterNodeId(string value) => value.Length <= WireLimits.AdminClusterNodeIdBytes &&
        value.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '-' or '_');
}
