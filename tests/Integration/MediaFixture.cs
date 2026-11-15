using System.Runtime.Versioning;
using System.Security.Cryptography;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Sessions;
using Npgsql;
using SkiaSharp;

namespace FsusBlog.V2.Integration.Tests;

internal static class MediaFixture
{
    private const UnixFileMode OwnerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    internal sealed record Session(Guid Id, string Token, string SiteSessionId);

    internal static async Task<Session> CreateSession(NpgsqlDataSource source, string name, CancellationToken ct, bool canAuthor = true)
    {
        var id = Guid.NewGuid();
        var secret = RandomNumberGenerator.GetBytes(32);
        var digest = SHA256.HashData(secret);
        await using var db = await source.OpenConnectionAsync(ct);
        await FixtureSql.ExecuteAsync(db, null, ct, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)",
            id, name, canAuthor);
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.user_session(digest,user_id,generation,expires_at) values($1,$2,1,now()+interval '5 minutes')
            """, digest, id);
        return new(id, Convert.ToHexStringLower(secret), SiteSessions.Id(id, digest));
    }

    [UnsupportedOSPlatform("windows")]
    internal static DirectoryInfo CreateOwnedTemporaryDirectory(string prefix)
    {
        var directory = Directory.CreateTempSubdirectory(prefix);
        File.SetUnixFileMode(directory.FullName, OwnerOnly);
        return new(CanonicalPath(directory.FullName));
    }

    [UnsupportedOSPlatform("windows")]
    internal static string CreateOwnedDirectory(string parent, string leaf)
    {
        var directory = Path.Combine(parent, leaf);
        Directory.CreateDirectory(directory, OwnerOnly);
        return CanonicalPath(directory);
    }

    // macOS redirects its default temporary directory through /var.
    internal static string CanonicalPath(string path) =>
        OperatingSystem.IsMacOS() && path.StartsWith("/var/", StringComparison.Ordinal) ? "/private" + path : path;

    [UnsupportedOSPlatform("windows")]
    internal static async Task WithReplacedReadOnlyFile(string path, string held, byte[] bytes, Func<Task> check, CancellationToken ct)
    {
        File.Move(path, held);
        try
        {
            await File.WriteAllBytesAsync(path, bytes, ct);
            File.SetUnixFileMode(path, UnixFileMode.UserRead);
            await check();
        }
        finally
        {
            File.Delete(path);
            File.Move(held, path);
        }
    }

    internal static byte[] SolidImage(SKEncodedImageFormat format, SKColor color)
    {
        using var image = new SKBitmap(3, 2);
        image.Erase(color);
        using var encoded = image.Encode(format, 90);
        return encoded.ToArray();
    }

    internal static Dictionary<string, string> PublicSettings(string privateRoot, string publicRoot) => new()
    {
        [MediaEndpoints.StorageSetting] = privateRoot,
        [PublishedMediaEndpoints.StorageSetting] = publicRoot
    };
}
