using System.Buffers.Binary;
using System.Net.Http.Headers;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Sessions;
using Npgsql;
using SkiaSharp;

namespace FsusBlog.V2.Integration.Tests;

internal static class MediaFixture
{
    internal sealed class DirectoryCleanup(DirectoryInfo directory) : IDisposable
    {
        public void Dispose() => directory.Delete(recursive: true);
    }

    private const UnixFileMode OwnerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    internal sealed record Session(Guid Id, string Token, string SiteSessionId);

    internal static async Task<Session> CreateSession(NpgsqlDataSource source, string name, CancellationToken ct, bool canAuthor = true)
    {
        var id = Guid.NewGuid();
        var secret = RandomNumberGenerator.GetBytes(32);
        var digest = SHA256.HashData(secret);
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await db.BeginTransactionAsync(ct);
        if (canAuthor)
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, FixtureSql.AdminSessionSql, FixtureSql.AdminSessionArguments(
                id, ScratchDatabase.AdminHandle(name, id), RandomNumberGenerator.GetBytes(32),
                RandomNumberGenerator.GetBytes(8), [1], digest, 5));
        }
        else
        {
            await FixtureSql.SiteAccountAsync(db, tx, ct, id, name, canAuthor: false);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.user_session(digest,user_id,generation,expires_at)
                values($1,$2,1,clock_timestamp()+interval '5 minutes')
                """, digest, id);
        }
        await tx.CommitAsync(ct);
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

    internal static Guid FirstListedAsset(byte[] frame, int total)
    {
        var page = Aeds.Decode(frame, FrameType.PrivateMediaItems);
        Assert.Equal(total, BinaryPrimitives.ReadInt32LittleEndian(page[5..]));
        return total == 0 ? Guid.Empty : new Guid(page[9..25], bigEndian: true);
    }

    internal static async Task<HttpResponseMessage> Upload(HttpClient client, MediaFixture.Session session, Guid key, string name, string type,
        byte[] bytes, CancellationToken ct)
    {
        using var request = SiteAedsFixture.Request(HttpMethod.Post, WireRoutes.PrivateMediaUpload + "?name=" + Uri.EscapeDataString(name),
            null, session.Token, session.SiteSessionId, SiteAedsFixture.IsHttps(client));
        request.Headers.Add(WireHeaders.ClientMutationId, key.ToString("D"));
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
        return await client.SendAsync(request, ct);
    }

    internal static Dictionary<string, string> PublicSettings(string privateRoot, string publicRoot) => new()
    {
        [MediaEndpoints.StorageSetting] = privateRoot,
        [PublishedMediaEndpoints.StorageSetting] = publicRoot
    };
}
