using System.Security.Cryptography;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    private static readonly byte[] PermissionSessionDomain = "FsusBlog v2 administrator permission session"u8.ToArray();

    internal Task<(AdminSessionSnapshot Snapshot, string PermissionSession)> SessionWithPermissionBinding(
        string? token, CancellationToken ct) =>
        WithLiveAdmin(token, Permission, (_, _, admin) => Task.FromResult((admin.Snapshot, PermissionBinding(admin.Digest))), ct);

    internal Task<(AdminEffectivePermissions Permissions, string PermissionSession)> EffectivePermissions(
        string? token, CancellationToken ct) =>
        WithLiveAdmin(token, Permission, async (db, tx, admin) =>
        {
            await using var cmd = Store.Sql(db, tx, """
                select permission from public.admin_permission where principal_id=$1 order by permission collate "C"
                """, admin.Id);
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            var grants = new List<string>();
            while (await reader.ReadAsync(ct)) grants.Add(reader.GetString(0));
            return (new AdminEffectivePermissions(admin.Snapshot.Generation, grants), PermissionBinding(admin.Digest));
        }, ct);

    private static string PermissionBinding(byte[] digest)
    {
        Span<byte> material = stackalloc byte[PermissionSessionDomain.Length + 32];
        PermissionSessionDomain.CopyTo(material);
        digest.CopyTo(material[PermissionSessionDomain.Length..]);
        return Convert.ToHexStringLower(SHA256.HashData(material));
    }
}
