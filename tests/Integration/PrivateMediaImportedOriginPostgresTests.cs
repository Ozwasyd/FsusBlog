namespace FsusBlog.V2.Integration.Tests;

public sealed partial class PrivateMediaPostgresTests
{
    [CaddyPostgresFact(requiresMigrate: true)]
    public async Task ImportedOriginKeepsTheLegacyAssetAndRevisionPrivateAcrossNativeTlsAndBackup()
    {
        if (OperatingSystem.IsWindows()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
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
            var schemaFile = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
                "../../../../../src/Cli/OptionalSchema/private-media-import-origin.sql"));
            await db.Exec(await File.ReadAllTextAsync(schemaFile, ct));
            await db.WithConnection(connection => CurrentSchema.VerifyAsync(connection, ct), ct);
            var (article, revision) = await db.InTx(async (connection, tx) =>
            {
                var actor = new Identity(owner.Id, "imported-asset-owner", 1, true, DateTimeOffset.UtcNow.AddMinutes(5));
                var (draft, _) = await Store.Execute(connection, tx, actor, ArticleAction.Save,
                    new Edit(0, 0, Guid.NewGuid(), "Verified import fixture", "Private content."), ct);
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
                await FixtureSql.ExecuteAsync(connection, tx, ct,
                    "insert into public.article_revision_media(article_id,revision,asset_id) values($1,$2,$3)", draft.Id, draft.Revision, asset);
                await FixtureSql.ExecuteAsync(connection, tx, ct, """
                    insert into public.article_revision_media_import
                      (article_id,revision,asset_id,source_revision_id,reference_count,alt_text)
                    values($1,$2,$3,5000000003,2,'Original private alternative');
                    """, draft.Id, draft.Revision, asset);
                return (draft.Id, draft.Revision);
            }, ct);
            var importedRow = Assert.Single(await db.QueryRows("""
                select r.source_revision_id,r.reference_count,r.alt_text,m.command_id,m.request_hash
                from public.article_revision_media_import r join public.private_media m on m.id=r.asset_id where r.asset_id=$1
                """, row => (row.GetInt64(0), row.GetInt32(1), row.GetString(2), row.IsDBNull(3), row.IsDBNull(4)), asset));
            Assert.Equal((5_000_000_003L, 2, "Original private alternative", true, true), importedRow);
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, (await Assert.ThrowsAsync<PostgresException>(() =>
                db.Exec("update public.private_media_import set owner_id=$1 where asset_id=$2", outsider.Id, asset))).SqlState);
            Assert.Equal(PostgresErrorCodes.CheckViolation, (await Assert.ThrowsAsync<PostgresException>(() =>
                db.Exec("update public.private_media set command_id=$1,request_hash=$2 where id=$3", Guid.NewGuid(), rawDigest, asset))).SqlState);

            var measure = await FixtureProcess.Run(FixtureProcess.Migration(db.ConnectionString, "backup", "measure"), ct);
            Assert.True(measure.Code == 0, measure.Error);
            using (var receipt = JsonDocument.Parse(measure.Output))
            {
                var measured = Assert.Single(receipt.RootElement.GetProperty("media").EnumerateArray());
                Assert.Equal((asset.ToString("N"), Convert.ToHexStringLower(normalized.Hash)),
                    (measured.GetProperty("id").GetString(), measured.GetProperty("sha256").GetString()));
                var relations = receipt.RootElement.GetProperty("relations").EnumerateArray().ToArray();
                foreach (var table in new[] { "private_media_import", "article_revision_media_import" })
                    Assert.Contains(relations, relation => relation.GetProperty("name").GetString() == table &&
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
            Assert.Equal(asset, First(await OkBytes(Send(client, HttpMethod.Get, WireRoutes.PrivateMediaList, owner, ct), ct), 1));
            await AssertHidden(client, HttpMethod.Get, path, outsider, ct);
            await AssertHidden(client, HttpMethod.Get, path, null, ct);
            using var contentRequest = Request(HttpMethod.Get, path, owner, SiteAedsFixture.IsHttps(client));
            contentRequest.Version = HttpVersion.Version20;
            contentRequest.VersionPolicy = HttpVersionPolicy.RequestVersionExact;
            using (var content = Ok(await client.SendAsync(contentRequest, ct)))
            {
                Assert.Equal(HttpVersion.Version20, content.Version);
                Assert.Equal(normalized.Bytes, await content.Content.ReadAsByteArrayAsync(ct));
            }
            var references = WireRoutes.ArticleMedia.Replace("{id:int}", article.ToString(CultureInfo.InvariantCulture),
                StringComparison.Ordinal) + $"?revision={revision}";
            var payload = Aeds.Decode(await OkBytes(Send(client, HttpMethod.Get, references, owner, ct), ct), FrameType.ArticleMedia);
            Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(payload[12..]));
            Assert.Equal(asset, new Guid(payload[16..32], bigEndian: true));
            var ticket = Encoding.UTF8.GetString(payload[36..]);
            await AssertHidden(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, outsider, ct, ticket);
            Assert.Equal(normalized.Bytes, await OkBytes(Send(client, HttpMethod.Get, WireRoutes.ArticleMediaPreview, owner, ct, ticket), ct));
            await CheckStatusAsync(Conflict, Send(client, HttpMethod.Post, PathFor(WireRoutes.PrivateMediaRemove, asset), owner, ct));
            var uploadedId = await UploadAsset(client, owner, asset, "new-upload.png", "image/png", raw, ct);
            Assert.NotEqual(asset, uploadedId);
            Assert.Equal(uploadedId, await UploadAsset(client, owner, asset, "new-upload.png", "image/png", raw, ct));
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
