using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using Npgsql;
using SkiaSharp;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PrivateMediaPostgresTests
{
    [PostgresFact]
    public async Task NativeImagesRequireAnAuthorAndTheirFilesStayPrivateThroughDeletion()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var primary = await Author(db.DataSource, "media-owner", true, ct);
        var another = await Author(db.DataSource, "media-outsider", true, ct);
        var reader = await Author(db.DataSource, "media-reader", false, ct);
        var directory = Directory.CreateTempSubdirectory("fsusblog-media-test-");
        File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        // macOS redirects /var to /private/var. Use our owned canonical path.
        var storage = OperatingSystem.IsMacOS() && directory.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + directory.FullName : directory.FullName;
        try
        {
            await using var server = await ServerProcess.Start(db.ConnectionString, ct,
                new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = storage });
            var png = EncodeImage(SKEncodedImageFormat.Png);
            var jpeg = EncodeImage(SKEncodedImageFormat.Jpeg);
            var command = Guid.NewGuid();
            using var unsupported = await Upload(server.Client, primary, command, "sample.svg", "image/svg+xml", "<svg/>"u8.ToArray(), ct);
            Assert.Equal(HttpStatusCode.UnsupportedMediaType, unsupported.StatusCode);
            using var wrongType = await Upload(server.Client, primary, command, "sample.png", "image/png", jpeg, ct);
            Assert.Equal(HttpStatusCode.BadRequest, wrongType.StatusCode);
            using var truncated = await Upload(server.Client, primary, command, "sample.png", "image/png", png[..24], ct);
            Assert.Equal(HttpStatusCode.BadRequest, truncated.StatusCode);
            using var unable = await Upload(server.Client, reader, command, "sample.png", "image/png", png, ct);
            Assert.Equal(HttpStatusCode.Forbidden, unable.StatusCode);
            Assert.Empty(directory.EnumerateFiles());

            // Trailing payload/metadata is removed by rendering decoded pixels into a new PNG.
            byte[] source = [.. png, .. "private marker"u8.ToArray()];
            using var created = await Upload(server.Client, primary, command, "sample.png", "image/png", source, ct);
            Assert.Equal(HttpStatusCode.OK, created.StatusCode);
            var asset = First(await created.Content.ReadAsByteArrayAsync(ct), 1);
            using var replay = await Upload(server.Client, primary, command, "sample.png", "image/png", source, ct);
            Assert.Equal(asset, First(await replay.Content.ReadAsByteArrayAsync(ct), 1));
            using var collision = await Upload(server.Client, primary, command, "another.png", "image/png", source, ct);
            Assert.Equal(HttpStatusCode.Conflict, collision.StatusCode);

            using var list = await Send(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaList, primary, ct);
            Assert.Equal(asset, First(await list.Content.ReadAsByteArrayAsync(ct), 1));
            using var otherList = await Send(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaList, another, ct);
            Assert.Equal(Guid.Empty, First(await otherList.Content.ReadAsByteArrayAsync(ct), 0));

            var raw = WireRoutes.PrivateMediaRead.Replace("{id}", asset.ToString("D"), StringComparison.Ordinal);
            await AssertHidden(server.Client, HttpMethod.Get, raw, null, ct);
            await AssertHidden(server.Client, HttpMethod.Get, raw, another, ct);
            await AssertHidden(server.Client, HttpMethod.Head, raw, reader, ct);
            await AssertHidden(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaRead.Replace("{id}", Guid.NewGuid().ToString("D"), StringComparison.Ordinal), primary, ct);
            await AssertHidden(server.Client, HttpMethod.Get, WireRoutes.PrivateMediaRead.Replace("{id}", "missing", StringComparison.Ordinal), primary, ct);
            using var content = await Send(server.Client, HttpMethod.Get, raw, primary, ct);
            Assert.Equal(HttpStatusCode.OK, content.StatusCode);
            Assert.Equal("image/png", content.Content.Headers.ContentType?.MediaType);
            byte[] canonical = await content.Content.ReadAsByteArrayAsync(ct);
            Assert.True(canonical.AsSpan().IndexOf("private marker"u8) < 0);
            using var bitmap = SKBitmap.Decode(canonical);
            Assert.Equal((3, 2), (bitmap.Width, bitmap.Height));
            using var head = await Send(server.Client, HttpMethod.Head, raw, primary, ct);
            Assert.Equal(HttpStatusCode.OK, head.StatusCode);
            Assert.Equal(canonical.Length, head.Content.Headers.ContentLength);
            Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));

            var leaf = Assert.Single(directory.EnumerateFiles());
            Assert.Equal($"{asset:N}.media", leaf.Name);
            Assert.Equal(UnixFileMode.UserRead, File.GetUnixFileMode(leaf.FullName));
            var remove = WireRoutes.PrivateMediaRemove.Replace("{id}", asset.ToString("D"), StringComparison.Ordinal);
            using var foreignRemove = await Send(server.Client, HttpMethod.Post, remove, another, ct);
            Assert.Equal(HttpStatusCode.NotFound, foreignRemove.StatusCode);
            using var removed = await Send(server.Client, HttpMethod.Post, remove, primary, ct);
            Assert.Equal(HttpStatusCode.OK, removed.StatusCode);
            using var repeat = await Send(server.Client, HttpMethod.Post, remove, primary, ct);
            Assert.Equal(HttpStatusCode.OK, repeat.StatusCode);
            await AssertHidden(server.Client, HttpMethod.Get, raw, primary, ct);
            Assert.Empty(directory.EnumerateFiles());

            using var jpegUpload = await Upload(server.Client, primary, Guid.NewGuid(), "sample.jpeg", "image/jpeg", jpeg, ct);
            Assert.Equal(HttpStatusCode.OK, jpegUpload.StatusCode);
            var jpegId = First(await jpegUpload.Content.ReadAsByteArrayAsync(ct), 1);
            var jpegPath = WireRoutes.PrivateMediaRead.Replace("{id}", jpegId.ToString("D"), StringComparison.Ordinal);
            using var jpegContent = await Send(server.Client, HttpMethod.Get, jpegPath, primary, ct);
            Assert.Equal(HttpStatusCode.OK, jpegContent.StatusCode);
            Assert.Equal("image/jpeg", jpegContent.Content.Headers.ContentType?.MediaType);
            using var jpegBitmap = SKBitmap.Decode(await jpegContent.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal((3, 2), (jpegBitmap.Width, jpegBitmap.Height));
        }
        finally { directory.Delete(recursive: true); }
    }

    [PostgresFact]
    public async Task PendingUploadCanResumeAndDeletionRefusesUnownedFileBytes()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var owner = await Author(db.DataSource, "media-owner", true, ct);
        var directory = Directory.CreateTempSubdirectory("fsusblog-media-recovery-");
        File.SetUnixFileMode(directory.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var storage = OperatingSystem.IsMacOS() && directory.FullName.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + directory.FullName : directory.FullName;
        try
        {
            var png = EncodeImage(SKEncodedImageFormat.Png);
            var command = Guid.NewGuid();
            Guid reserved;
            using (var files = new MediaFiles(storage, AppContext.BaseDirectory))
            {
                var media = new MediaStore(files);
                var image = await MediaImage.ReadAsync(new MemoryStream(png), png.Length, "pending.png", "image/png", ct);
                await using (var connection = await db.DataSource.OpenConnectionAsync(ct))
                await using (var transaction = await connection.BeginTransactionAsync(ct))
                {
                    reserved = await media.Reserve(connection, transaction, owner.Id, command, image, ct);
                    await transaction.CommitAsync(ct);
                }
                // Model a process interrupted after the immutable path exists but before the DB made it readable.
                await files.Materialize(reserved, image, ct);
            }

            await using var server = await ServerProcess.Start(db.ConnectionString, ct,
                new Dictionary<string, string> { [MediaEndpoints.StorageSetting] = storage });
            var raw = WireRoutes.PrivateMediaRead.Replace("{id}", reserved.ToString("D"), StringComparison.Ordinal);
            await AssertHidden(server.Client, HttpMethod.Head, raw, owner, ct);
            using var resumed = await Upload(server.Client, owner, command, "pending.png", "image/png", png, ct);
            Assert.Equal(reserved, First(await resumed.Content.ReadAsByteArrayAsync(ct), 1));

            var leaf = Assert.Single(directory.EnumerateFiles());
            var original = await File.ReadAllBytesAsync(leaf.FullName, ct);
            var unrelated = new byte[original.Length];
            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await File.WriteAllBytesAsync(leaf.FullName, unrelated, ct);
            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead);
            await AssertHidden(server.Client, HttpMethod.Get, raw, owner, ct);
            var remove = WireRoutes.PrivateMediaRemove.Replace("{id}", reserved.ToString("D"), StringComparison.Ordinal);
            using var blocked = await Send(server.Client, HttpMethod.Post, remove, owner, ct);
            Assert.Equal(HttpStatusCode.InternalServerError, blocked.StatusCode);
            Assert.Equal(unrelated, await File.ReadAllBytesAsync(leaf.FullName, ct));
            await AssertHidden(server.Client, HttpMethod.Get, raw, owner, ct);

            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await File.WriteAllBytesAsync(leaf.FullName, original, ct);
            File.SetUnixFileMode(leaf.FullName, UnixFileMode.UserRead);
            using var retry = await Send(server.Client, HttpMethod.Post, remove, owner, ct);
            Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
            Assert.Empty(directory.EnumerateFiles());
        }
        finally { directory.Delete(recursive: true); }
    }

    private static byte[] EncodeImage(SKEncodedImageFormat format)
    {
        using var image = new SKBitmap(3, 2);
        image.Erase(SKColors.SteelBlue);
        using var encoded = image.Encode(format, 90);
        return encoded.ToArray();
    }

    private static async Task AssertHidden(HttpClient client, HttpMethod method, string path, SessionFixture? session, CancellationToken ct)
    {
        using var response = await Send(client, method, path, session, ct);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, response.Content.Headers.ContentLength);
        Assert.Null(response.Content.Headers.ContentType);
        Assert.True(response.Headers.CacheControl?.Private);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static Guid First(byte[] frame, int total)
    {
        var page = Aeds.Decode(frame, FrameType.PrivateMediaItems);
        Assert.Equal(total, BinaryPrimitives.ReadInt32LittleEndian(page[5..]));
        return total == 0 ? Guid.Empty : new Guid(page[9..25], bigEndian: true);
    }

    private static async Task<HttpResponseMessage> Upload(HttpClient client, SessionFixture session, Guid key, string name, string type,
        byte[] bytes, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, WireRoutes.PrivateMediaUpload + "?name=" + Uri.EscapeDataString(name), session);
        request.Headers.Add(WireHeaders.ClientMutationId, key.ToString("D"));
        request.Content = new ByteArrayContent(bytes);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
        return await client.SendAsync(request, ct);
    }

    private static async Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string path, SessionFixture? session, CancellationToken ct)
    {
        using var request = Request(method, path, session);
        return await client.SendAsync(request, ct);
    }

    private static HttpRequestMessage Request(HttpMethod method, string path, SessionFixture? session)
    {
        var request = new HttpRequestMessage(method, path);
        if (session is not null) request.Headers.Add("Cookie", $"fsus-v2-session={session.Token}");
        return request;
    }

    private static async Task<SessionFixture> Author(NpgsqlDataSource source, string name, bool canAuthor, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var bytes = RandomNumberGenerator.GetBytes(32);
        await using (var user = source.CreateCommand("INSERT INTO public.blog_user VALUES ($1,$2,$3,true,1)"))
        {
            user.Parameters.AddWithValue(id);
            user.Parameters.AddWithValue(name);
            user.Parameters.AddWithValue(canAuthor);
            await user.ExecuteNonQueryAsync(ct);
        }
        await using var session = source.CreateCommand("""
            INSERT INTO public.user_session (digest,user_id,generation,expires_at) VALUES ($1,$2,1,now()+interval '5 minutes')
            """);
        session.Parameters.AddWithValue(SHA256.HashData(bytes));
        session.Parameters.AddWithValue(id);
        await session.ExecuteNonQueryAsync(ct);
        return new(id, Convert.ToHexStringLower(bytes));
    }

    private sealed record SessionFixture(Guid Id, string Token);
}
