namespace FsusBlog.V2.Contracts;

public sealed record AdminEffectivePermissions(long Generation, IReadOnlyList<string> Grants);

public static partial class Wire
{
    private const int AdminPermissionCount = 5;
    private const int AdminPermissionBytes = 32;

    public static byte[] EncodeAdminEffectivePermissions(AdminEffectivePermissions value)
    {
        if (value.Generation <= 0 || value.Grants.Count is < 1 or > AdminPermissionCount)
            throw new ProtocolException("Invalid effective administrator permissions.");
        var writer = new Writer();
        writer.I64(value.Generation);
        writer.I32(value.Grants.Count);
        string? previous = null;
        var canManage = false;
        foreach (var grant in value.Grants)
        {
            if (!IsAdminPermission(grant) || previous is not null && string.CompareOrdinal(previous, grant) >= 0)
                throw new ProtocolException("Invalid effective administrator grant.");
            canManage |= grant == "admin.manage";
            writer.Text(grant, AdminPermissionBytes);
            previous = grant;
        }
        if (!canManage) throw new ProtocolException("Effective administrator permissions lack the session grant.");
        return Aeds.Encode(FrameType.AdminEffectivePermissions, writer.Written);
    }

    private static bool IsAdminPermission(string value) =>
        value is "admin.manage" or "article.write" or "audit.read" or "comment.moderate" or "system.config";
}
