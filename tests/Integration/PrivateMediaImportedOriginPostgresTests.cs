using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;
using FsusBlogV2.Storage;
using Npgsql;
using SkiaSharp;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class PrivateMediaPostgresTests
{
    [CaddyPostgresFact(requiresMigrate: true)]
    public async Task ImportedOriginKeepsTheLegacyAssetAndRevisionPrivateAcrossNativeTlsAndBackup()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var owner = await MediaFixture.CreateSession(db.DataSource, "imported-asset-owner", ct, canAuthor: true);
        var outsider = await MediaFixture.CreateSession(db.DataSource, "imported-asset-outsider", ct, canAuthor: true);
        var directory = Directory.CreateTempSubdirectory("fsusblog-imported-media-");
        var root = MediaFixture.CanonicalPath(directory.FullName);
        var media = MediaFixture.CreateOwnedDirectory(root, "media");
        var succeeded = false;
        try
        {
            var asset = Guid.Parse("239c7c69-7ef5-4d5d-9c43-c1f3cc2d7e84");
            var name = asset.ToString("N") + ".png";
            byte[] raw = [.. EncodeImage(SKEncodedImageFormat.Png), .. "source metadata fixture"u8.ToArray()];
            var normalized = MediaImage.Normalize(name, MediaFormat.Png, raw, ct);
            byte[] originDigest = SHA256.HashData("fixture approval"u8);
            byte[] rawDigest = SHA256.HashData(raw);
            Assert.False(normalized.Hash.AsSpan().SequenceEqual(rawDigest));
            using (var files = new MediaFiles(media, Path.Combine(root, "web")))
                await files.Materialize(asset, normalized, ct);
            await using var connection = await db.DataSource.OpenConnectionAsync(ct);
            var schemaFile = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
                "../../../../../src/Migrate/OptionalSchema/private-media-import-origin.sql"));
            await FixtureSql.ExecuteAsync(connection, null, ct, await File.ReadAllTextAsync(schemaFile, ct));
            await CurrentSchema.VerifyAsync(connection, ct);
            int article;
            long revision;
            await using (var tx = await connection.BeginTransactionAsync(ct))
            {
                var actor = new Identity(owner.Id, "imported-asset-owner", 1, true, DateTimeOffset.UtcNow.AddMinutes(5));
                var (draft, _) = await Store.Execute(connection, tx, actor, ArticleAction.Save,
                    new Edit(0, 0, Guid.NewGuid(), "Verified import fixture", "Private content."), ct);
                (article, revision) = (draft.Id, draft.Revision);
                Assert.Equal(1, await FixtureSql.ExecuteAsync(connection, tx, ct, """
                    insert into public.private_media_import
                      (asset_id,owner_id,source_site_id,target_site_id,source_owner_id,activation_sha256,plan_sha256,
                       projection_sha256,custody_manifest_sha256,request_sha256,prepared_manifest_sha256,normalizer_sha256,raw_sha256)
                    select $1,$2,$3,site_id,73,$4,$4,$4,$4,$4,$4,$4,$5 from public.authoring_recovery_site where singleton
                    """, asset, owner.Id, Guid.NewGuid(), originDigest, rawDigest));
                await FixtureSql.ExecuteAsync(connection, tx, ct, """
                    insert into public.private_media(id,owner_id,import_origin_id,content_hash,name,format,length,width,height,phase)
                    values($1,$2,$1,$3,$4,1,$5,$6,$7,1)
                    """, asset, owner.Id, normalized.Hash, name, normalized.Bytes.Length, normalized.Width, normalized.Height);
                await FixtureSql.ExecuteAsync(connection, tx, ct, "insert into public.article_revision_media(article_id,revision,asset_id) values($1,$2,$3)", article, revision, asset);
                await FixtureSql.ExecuteAsync(connection, tx, ct, """
                    insert into public.article_revision_media_import
                      (article_id,revision,asset_id,source_revision_id,reference_count,alt_text)
                    values($1,$2,$3,5000000003,2,'Original private alternative');
                    """, article, revision, asset);
                await tx.CommitAsync(ct);
            }
            await using (var source = Store.Sql(connection, null, """
                select r.source_revision_id,r.reference_count,r.alt_text,m.command_id,m.request_hash
                from public.article_revision_media_import r join public.private_media m on m.id=r.asset_id where r.asset_id=$1
                """, asset))
            await using (var row = await source.ExecuteReaderAsync(ct))
            {
                Assert.True(await row.ReadAsync(ct));
                Assert.Equal(5_000_000_003L, row.GetInt64(0));
                Assert.Equal(2, row.GetInt32(1));
                Assert.Equal("Original private alternative", row.GetString(2));
                Assert.True(row.IsDBNull(3));
                Assert.True(row.IsDBNull(4));
                Assert.False(await row.ReadAsync(ct));
            }
            await using (var wrongOwner = Store.Sql(connection, null, "update public.private_media_import set owner_id=$1 where asset_id=$2", outsider.Id, asset))
                Assert.Equal(PostgresErrorCodes.ForeignKeyViolation,
                    (await Assert.ThrowsAsync<PostgresException>(() => wrongOwner.ExecuteNonQueryAsync(ct))).SqlState);
            await using (var fakeUpload = Store.Sql(connection, null,
                "update public.private_media set command_id=$1,request_hash=$2 where id=$3", Guid.NewGuid(), rawDigest, asset))
                Assert.Equal(PostgresErrorCodes.CheckViolation,
                    (await Assert.ThrowsAsync<PostgresException>(() => fakeUpload.ExecuteNonQueryAsync(ct))).SqlState);

            var measure = await FixtureProcess.Run(FixtureProcess.Migration(db.ConnectionString, "backup", "measure"), ct);
            Assert.True(measure.Code == 0, measure.Error);
            using (var receipt = JsonDocument.Parse(measure.Output))
            {
                var measured = Assert.Single(receipt.RootElement.GetProperty("media").EnumerateArray());
                Assert.Equal(asset.ToString("N"), measured.GetProperty("id").GetString());
                Assert.Equal(Convert.ToHexStringLower(normalized.Hash), measured.GetProperty("sha256").GetString());
                var relations = receipt.RootElement.GetProperty("relations").EnumerateArray().ToArray();
                Assert.Contains(relations, relation => relation.GetProperty("name").GetString() == "private_media_import" &&
                    relation.GetProperty("rows").GetInt64() == 1);
                Assert.Contains(relations, relation => relation.GetProperty("name").GetString() == "article_revision_media_import" &&
                    relation.GetProperty("rows").GetInt64() == 1);
            }

            var address = NativeCaddyProxy.NewAddress();
            await using var server = await ServerProcess.Start(db.ConnectionString, ct,
                new Dictionary<string, string>
                {
                    ["FSUSBLOG_PUBLIC_ORIGIN"] = address.GetLeftPart(UriPartial.Authority),
                    ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true",
                    [MediaEndpoints.StorageSetting] = media,
                }, request => PublicationFixture.Forward(request, address.Authority));
            await using var proxy = await NativeCaddyProxy.Start(server.Client.BaseAddress!, root, ct, address);
            var client = proxy.Client;
            var path = PathFor(WireRoutes.PrivateMediaRead, asset);
            using var list = await Send(client, HttpMethod.Get, WireRoutes.PrivateMediaList, owner, ct);
            Assert.Equal(HttpStatusCode.OK, list.StatusCode);
            Assert.Equal(asset, First(await list.Content.ReadAsByteArrayAsync(ct), 1));
            await AssertHidden(client, HttpMethod.Get, path, outsider, ct);
            await AssertHidden(client, HttpMethod.Get, path, null, ct);
            using var contentRequest = Request(HttpMethod.Get, path, owner);
            contentRequest.Version = HttpVersion.Version20;
            contentRequest.VersionPolicy = HttpVersionPolicy.RequestVersionExact;
            using var content = await client.SendAsync(contentRequest, ct);
            Assert.Equal(HttpStatusCode.OK, content.StatusCode);
            Assert.Equal(HttpVersion.Version20, content.Version);
            Assert.Equal(normalized.Bytes, await content.Content.ReadAsByteArrayAsync(ct));
            var references = WireRoutes.ArticleMedia.Replace("{id:int}", article.ToString(CultureInfo.InvariantCulture),
                StringComparison.Ordinal) + $"?revision={revision}";
            using var attachments = await Send(client, HttpMethod.Get, references, owner, ct);
            Assert.Equal(HttpStatusCode.OK, attachments.StatusCode);
            var listing = await attachments.Content.ReadAsByteArrayAsync(ct);
            var payload = Aeds.Decode(listing, FrameType.ArticleMedia);
            Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(payload[12..]));
            Assert.Equal(asset, new Guid(payload[16..32], bigEndian: true));
            var ticket = Encoding.UTF8.GetString(payload[36..]);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, outsider, ct, ticket);
            using var preview = await Send(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket);
            Assert.Equal(HttpStatusCode.OK, preview.StatusCode);
            Assert.Equal(normalized.Bytes, await preview.Content.ReadAsByteArrayAsync(ct));
            using var pinned = await Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaRemove, asset), owner, ct);
            Assert.Equal(HttpStatusCode.Conflict, pinned.StatusCode);
            using var upload = await Upload(client, owner, asset, "new-upload.png", "image/png", raw, ct);
            Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
            var uploadedId = First(await upload.Content.ReadAsByteArrayAsync(ct), 1);
            Assert.NotEqual(asset, uploadedId);
            using var retry = await Upload(client, owner, asset, "new-upload.png", "image/png", raw, ct);
            Assert.Equal(uploadedId, First(await retry.Content.ReadAsByteArrayAsync(ct), 1));
            succeeded = true;
        }
        finally
        {
            if (succeeded) directory.Delete(recursive: true);
            else
            {
                File.Delete(Path.Combine(root, "leaf.key"));
                Console.WriteLine($"Preserved the failed private media fixture at {root}.");
            }
        }
    }
}
