namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationCheckpointInclusionPostgresTests(ITestOutputHelper evidence)
{
    private const string Signing = "IntegrityProof__Signing__", CheckpointSigning = "IntegrityProof__CheckpointSigning__";
    private const string Archive = "IntegrityProof__CheckpointArchive__", Key = "fixture", Checkpoints = "/integrity/v2/checkpoints";

    [CaddyPostgresFact(requiresMigrate: true)]
    public Task ServesOnlyTheStillPublicSignedLedgerMemberThroughCaddyTls() => Verify(automatic: false);

    [CaddyPostgresFact(requiresMigrate: true)]
    public Task SignsClosedDaysFromTheLiveExactLedgerWithAnIndependentKeyWithoutChangingTheOnlineHead() => Verify(automatic: true);

    private async Task Verify(bool automatic)
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var directory = PublicationFixture.PrivateScratch("fsus-daily-inclusion");
        var succeeded = false;
        try
        {
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var spki = key.ExportSubjectPublicKeyInfo();
            var fingerprint = SHA256.HashData(spki);
            var address = NativeCaddyProxy.NewAddress();
            var origin = address.GetLeftPart(UriPartial.Authority);
            var headAt = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(-1).AddHours(1));
            var (publishedAt, issuedAt) = (headAt.AddDays(-1), headAt.AddDays(-1).AddHours(1));
            var (before, after) = (publishedAt.AddDays(-1), headAt.AddDays(30));
            var day = publishedAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var privateFile = PublicationFixture.PrivateKey(directory, "key.pkcs8", key);
            var settings = PublicationFixture.NativeSettings(origin, Key, privateFile);
            PublicationFixture.ConfigureKey(settings, Key, "1", spki, Time(before), Time(after));
            settings[Archive + "Enabled"] = "true";
            settings[Archive + "Path"] = Path.Combine(directory.FullName, "archive.json");
            var migration = Environment.GetEnvironmentVariable(PublicationTransparencyFact.MigrationPath)!;
            var runner = Environment.GetEnvironmentVariable("DOTNET_BIN") ?? "dotnet";
            await Run(runner, [migration, "publication-transparency", "enable"], migrationEnvironment: true);

            var authorSession = await MediaFixture.CreateSession(fixture.DataSource, "Daily member fixture", ct, canAuthor: true);
            var session = authorSession.Token;
            var author = new Identity(authorSession.Id, "Daily member fixture", 1, true, DateTimeOffset.UtcNow.AddMinutes(5));
            Member covered = null!, omitted = null!, oddLeaf = null!;
            var tail = new PublicationTransparency(0, new byte[32]);
            await fixture.InTx(async (connection, tx) =>
            {
                // Issuance is normally driven by the database clock. Use a closed UTC day for the fixture's receipts.
                await FixtureSql.ExecuteAsync(connection, tx, ct, """
                    insert into public.publication_proof_key(key_id,version,spki_sha256,not_before,not_after) values($1,1,$2,$3,$4)
                    """, Key, fingerprint, before, after);
                covered = await Publish(connection, tx, "Covered current release");
                omitted = await Publish(connection, tx, "Current release without archived witness");
                oddLeaf = await Publish(connection, tx, "Covered last release on the selected day");
                await FixtureSql.ExecuteAsync(connection, tx, ct, "update public.blog_outbox set processed_at=now() where processed_at is null");
            }, ct);

            var head = new PublicationTransparencyHeadV2(origin, tail.Sequence, tail.Hash, Key, 1, fingerprint, headAt);
            var headPath = Path.Combine(directory.FullName, "head.json");
            var headSignature = PublicationFixture.SignP256(key, head.Payload());
            await File.WriteAllTextAsync(headPath, JsonSerializer.Serialize(new
            {
                headVersion = 2, kind = "native-publication-log-head", algorithm = ArticlePublicationProofPayloadV2.Algorithm, origin,
                sequence = Coordinate(head.Sequence), entrySha256 = Hex(head.EntrySha256), keyId = Key, keyVersion = 1,
                keySha256 = Hex(fingerprint), attestedAtUtc = Time(headAt), signature = WebEncoders.Base64UrlEncode(headSignature),
            }), ct);
            var manifest = Path.Combine(directory.FullName, "keys.json");
            using var checkpointKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var checkpointSpki = checkpointKey.ExportSubjectPublicKeyInfo();
            var manifestKeys = new List<object> { RegistryKey(Key, spki) };
            if (automatic) manifestKeys.Add(RegistryKey("checkpoint", checkpointSpki));
            await File.WriteAllTextAsync(manifest, JsonSerializer.Serialize(new
            {
                manifestVersion = 2, kind = "native-publication-proof-keys", currentKeyId = Key,
                algorithm = ArticlePublicationProofPayloadV2.Algorithm, keys = manifestKeys,
            }), ct);
            if (automatic) { await CheckAutomatic(); succeeded = true; return; }
            var first = JsonNode.Parse(await Checkpoint(covered.Sequence))!;
            var last = JsonNode.Parse(await Checkpoint(oddLeaf.Sequence))!;
            var checkpoint = first["checkpoint"]!;
            Assert.Equal(checkpoint["rootSha256"]!.GetValue<string>(), last["checkpoint"]!["rootSha256"]!.GetValue<string>());
            var archive = new JsonObject
            {
                ["archiveVersion"] = 3, ["head"] = JsonNode.Parse(await File.ReadAllTextAsync(headPath, ct)),
                ["bridgeReceiptSha256"] = new JsonArray(), ["checkpoints"] = new JsonArray(checkpoint.DeepClone()),
                ["inclusions"] = new JsonArray(ForDay(first), ForDay(last)),
            };
            settings[Archive + "CurrentAnchor"] = Coordinate(tail.Sequence) + ":" + Hex(tail.Hash);
            await Install(archive);
            await WithTls(async (client, server) =>
            {
                Assert.Equal(await File.ReadAllTextAsync(headPath, ct), await Get(client, Checkpoints + "/head.json", OK));
                var dayRoute = $"{Checkpoints}/daily/{day}.json";
                var aggregate = await Get(client, dayRoute, OK);
                Assert.Equal("{\"checkpoint\":" + checkpoint.ToJsonString() + ",\"inclusion\":null}", aggregate);
                Assert.Equal(aggregate, await Get(client, Checkpoints + "/latest.json", OK));
                foreach (var (member, expected) in new[] { (covered, first), (oddLeaf, last) })
                {
                    var bundle = await Get(client, member.Path, OK);
                    var parsed = JsonNode.Parse(bundle)!;
                    Assert.True(JsonNode.DeepEquals(expected["inclusion"], parsed["inclusion"]));
                    Assert.Equal(checkpoint.ToJsonString(), parsed["checkpoint"]!.ToJsonString());
                    var bundlePath = Path.Combine(directory.FullName, $"member-{member.Sequence}.json");
                    await File.WriteAllTextAsync(bundlePath, bundle, ct);
                    var result = JsonNode.Parse(await Run("node", [PublicationFixture.Tool("verify-publication-checkpoint.mjs"),
                        origin, manifest, headPath, bundlePath, "--daily", day, Coordinate(member.Sequence), Hex(member.Entry)]))!;
                    Assert.Equal(Coordinate(member.Sequence), result["inclusionSequence"]!.GetValue<string>());
                    evidence.WriteLine($"Node independently verified day {day}, ledger sequence {member.Sequence} and entry {Hex(member.Entry)}.");
                }
                foreach (var missing in new[] { omitted.Path, $"{Checkpoints}/daily/{day}/{covered.Sequence}.json",
                    $"/integrity/v2/article/{omitted.Article.Id}/{covered.Publication}/daily-proof.json" })
                    await Get(client, missing, NotFound);

                await PublicationFixture.Edit(server, address.Authority, session, WireRoutes.Retract,
                    new(oddLeaf.Article.Id, oddLeaf.Article.Revision, Guid.NewGuid(), "", ""), ct);
                await Get(client, oddLeaf.Path, NotFound);
                Assert.Equal(aggregate, await Get(client, dayRoute, OK));
            });

            var tampered = archive.DeepClone();
            tampered["inclusions"]![0]!["inclusion"]!["siblings"]![0] = new string('0', 64);
            await Install(tampered);
            await WithTls(async (client, _) =>
            {
                await Get(client, covered.Path, ServiceUnavailable);
                await Get(client, oddLeaf.Path, NotFound);
                await Get(client, covered.Path.Replace("daily-proof.json", "rights.json", StringComparison.Ordinal), OK);
            });
            succeeded = true;

            object RegistryKey(string id, byte[] publicKey) => new { keyId = id, keyVersion = 1, publicKey = WebEncoders.Base64UrlEncode(publicKey),
                keySha256 = Hex(SHA256.HashData(publicKey)), notBeforeUtc = Time(before), notAfterUtc = Time(after),
                revokedAtUtc = (string?)null, compromisedAtUtc = (string?)null };

            async Task CheckAutomatic()
            {
                var checkpointFile = PublicationFixture.PrivateKey(directory, "checkpoint.pkcs8", checkpointKey);
                PublicationFixture.ConfigureKey(settings, "checkpoint", "1", checkpointSpki, Time(before), Time(after));
                settings[Signing + "NativeV2PublicHeadAnchor"] = Coordinate(covered.Sequence) + ":" + Hex(covered.Entry);
                settings.Remove(Archive + "Enabled");
                await fixture.Exec("""
                    insert into public.publication_transparency_head(singleton,seq,entry_sha256,origin,key_id,key_version,key_sha256,attested_at,signature)
                    values(true,$1,$2,$3,$4,1,$5,$6,$7)
                    """, tail.Sequence, tail.Hash, origin, Key, fingerprint, headAt, headSignature);

                var signer = new Dictionary<string, string> { [CheckpointSigning + "KeyId"] = "checkpoint", [CheckpointSigning + "PrivateKeyFile"] = checkpointFile };
                var args = new[] { migration, "publication-transparency", "checkpoint-daily-auto", origin, manifest,
                    Coordinate(covered.Sequence), Hex(covered.Entry), directory.FullName };
                const string headRoute = "/integrity/v2/log/head.json";
                string sealedPath = "", sealedHash = "";
                await WithTls(async (client, _) =>
                {
                    var initial = await Get(client, headRoute, OK);
                    Assert.Equal(await File.ReadAllTextAsync(headPath, ct), initial);
                    var quietDay = headAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    var firstRun = JsonNode.Parse(await Run(runner, args, migrationEnvironment: true, overrides: signer))!;
                    Assert.Equal(quietDay, firstRun["scopeKey"]!.GetValue<string>());
                    await VerifyAutomaticArchive(firstRun, quietDay, 0);
                    var explicitDay = args.Append(day).ToArray();
                    var result = JsonNode.Parse(await Run(runner, explicitDay, migrationEnvironment: true, overrides: signer))!;
                    await VerifyAutomaticArchive(result, day, 3);
                    (sealedPath, sealedHash) = (result["path"]!.GetValue<string>(), result["sha256"]!.GetValue<string>());
                    var original = await File.ReadAllBytesAsync(sealedPath, ct);
                    Assert.True(JsonNode.DeepEquals(result, JsonNode.Parse(await Run(runner, explicitDay, migrationEnvironment: true, overrides: signer))));
                    Assert.Equal(original, await File.ReadAllBytesAsync(sealedPath, ct));

                    var changed = JsonNode.Parse(original)!;
                    changed["checkpoints"]![0]!["entryCount"] = 2;
                    var changedBytes = JsonSerializer.SerializeToUtf8Bytes(changed);
                    await ReplaceSealedArchive(changedBytes);
                    await Run(runner, explicitDay, migrationEnvironment: true, overrides: signer, failure: "bytes were changed");
                    Assert.Equal(changedBytes, await File.ReadAllBytesAsync(sealedPath, ct));
                    await ReplaceSealedArchive(original);

                    var openDay = await fixture.Scalar<string>("select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD')");
                    await Run(runner, [.. args, openDay], migrationEnvironment: true, overrides: signer, failure: "still open");
                    var wrong = args.ToArray();
                    wrong[6] = new string('0', 64);
                    await Run(runner, wrong, migrationEnvironment: true, overrides: signer, failure: "independently retained native head");
                    signer[CheckpointSigning + "KeyId"] = Key;
                    await Run(runner, args, migrationEnvironment: true, overrides: signer, failure: "separately registered");
                    Assert.Equal(initial, await Get(client, headRoute, OK));
                    Assert.Equal(tail.Sequence, await fixture.Scalar<long>("select count(*) from public.article_publication_transparency"));
                });

                settings[Archive + "Enabled"] = "true";
                settings[Archive + "Path"] = sealedPath;
                settings[Archive + "Sha256"] = sealedHash;
                settings[Archive + "CurrentAnchor"] = Coordinate(tail.Sequence) + ":" + Hex(tail.Hash);
                await WithTls(async (client, _) =>
                {
                    await Get(client, Checkpoints + "/head.json", OK);
                    Assert.Equal(3, JsonNode.Parse(await Get(client, $"{Checkpoints}/daily/{day}.json", OK))!["checkpoint"]!["entryCount"]!.GetValue<int>());
                });

                async Task VerifyAutomaticArchive(JsonNode result, string scope, int count)
                {
                    var bytes = await File.ReadAllBytesAsync(result["path"]!.GetValue<string>(), ct);
                    Assert.Equal(Hex(SHA256.HashData(bytes)), result["sha256"]!.GetValue<string>());
                    var signed = JsonNode.Parse(bytes)!;
                    var cp = signed["checkpoints"]![0]!;
                    Assert.Equal(("checkpoint", count), (signed["head"]!["keyId"]!.GetValue<string>(), cp["entryCount"]!.GetValue<int>()));
                    var date = DateTime.ParseExact(scope, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
                    Assert.True(DateTimeOffset.Parse(signed["head"]!["attestedAtUtc"]!.GetValue<string>(), CultureInfo.InvariantCulture) >= date.ToUniversalTime().AddDays(1));
                    var (signedHeadPath, bundlePath) = (Path.Combine(directory.FullName, "automatic-head.json"), Path.Combine(directory.FullName, "automatic-day.json"));
                    await File.WriteAllTextAsync(signedHeadPath, signed["head"]!.ToJsonString(), ct);
                    await File.WriteAllTextAsync(bundlePath, "{\"checkpoint\":" + cp.ToJsonString() + ",\"inclusion\":null}", ct);
                    var verified = JsonNode.Parse(await Run("node",
                        [PublicationFixture.Tool("verify-publication-checkpoint.mjs"), origin, manifest, signedHeadPath, bundlePath, "--daily", scope]))!;
                    Assert.Equal((scope, count == 0 ? "0" : Coordinate(tail.Sequence)),
                        (verified["scopeKey"]!.GetValue<string>(), verified["toSequence"]!.GetValue<string>()));
                    evidence.WriteLine($"Node verified automatic date {scope}, {count} entries, archive SHA-256 {Hex(SHA256.HashData(bytes))}.");
                }

                async Task ReplaceSealedArchive(byte[] bytes)
                {
                    var replacement = sealedPath + ".fixture";
                    await MediaFixture.WriteReadOnlyFile(replacement, bytes, ct);
                    File.Move(replacement, sealedPath, overwrite: true);
                }
            }

            async Task<Member> Publish(NpgsqlConnection connection, NpgsqlTransaction tx, string title)
            {
                var (draft, _) = await Store.Execute(connection, tx, author, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, "Fixture body"), ct);
                var (published, _) = await Store.Execute(connection, tx, author, ArticleAction.Publish, new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""), ct);
                var publication = (long)(await FixtureSql.ScalarAsync(connection, tx, ct,
                    "select publication_id from public.article_publication where article_id=$1", published.Id))!;
                var outbox = (long)(await FixtureSql.ScalarAsync(connection, tx, ct,
                    "delete from public.article_publication_canonical where publication_id=$1 returning outbox_id", publication))!;
                await FixtureSql.ExecuteAsync(connection, tx, ct, "update public.article_publication_history set happened_at=$2 where publication_id=$1", publication, publishedAt);
                await FixtureSql.ExecuteAsync(connection, tx, ct, "update public.article_publication set published_at=$2 where publication_id=$1", publication, publishedAt);
                await PublicationCanonicalStore.Record(connection, tx, published.Id, published.Revision, outbox, ct);
                ArticlePublicationProofV2 claim;
                await using (var select = Store.Sql(connection, tx,
                    "select publication_no,rights_snapshot_id,content_sha256,policy_sha256 from public.article_publication_canonical where publication_id=$1", publication))
                await using (var row = await select.ExecuteReaderAsync(ct))
                {
                    Assert.True(await row.ReadAsync(ct));
                    claim = new(origin, published.Id, published.Revision, publication, row.GetInt32(0), publishedAt, row.GetInt64(1),
                        outbox, row.GetFieldValue<byte[]>(2), row.GetFieldValue<byte[]>(3), Key, 1, fingerprint, issuedAt);
                }
                var transcript = ArticlePublicationProofPayloadV2.Build(claim);
                var signature = PublicationFixture.SignP256(key, transcript);
                await FixtureSql.ExecuteAsync(connection, tx, ct, """
                    insert into public.article_publication_proof(publication_id,origin,key_id,key_version,key_sha256,issued_at,signature,transparency_seq)
                    values($1,$2,$3,1,$4,$5,$6,$7)
                    """, publication, origin, Key, fingerprint, issuedAt, signature, tail.Sequence + 1);
                tail = await tail.Append(connection, tx, tail.Sequence + 1, publication, transcript, signature, ct);
                return new(published, publication, tail.Sequence, tail.Hash);
            }

            JsonObject ForDay(JsonNode bundle) => new() { ["scopeKey"] = day, ["inclusion"] = bundle["inclusion"]!.DeepClone() };
            Task<string> Checkpoint(long sequence) => Run(runner,
                [migration, "publication-transparency", "checkpoint-daily", origin, manifest, headPath, day, Coordinate(sequence)], migrationEnvironment: true);

            async Task<string> Run(string executable, string[] arguments, bool migrationEnvironment = false,
                IReadOnlyDictionary<string, string>? overrides = null, string? failure = null)
            {
                var start = FixtureProcess.Command(executable, arguments);
                if (migrationEnvironment)
                {
                    start.Environment["FSUSBLOG_DB"] = fixture.ConnectionString;
                    start.Environment[Signing + "CurrentKeyId"] = Key;
                    start.Environment[Signing + "NativeV2PrivateKeyFile"] = privateFile;
                }
                if (overrides is not null) foreach (var (name, value) in overrides) start.Environment[name] = value;
                var result = await FixtureProcess.Run(start, ct);
                if (failure is null) Assert.True(result.Code == 0, result.Error);
                else
                {
                    Assert.NotEqual(0, result.Code);
                    Assert.Contains(failure, result.Error);
                    Assert.Equal("", result.Output);
                    evidence.WriteLine($"Signer refused {failure}.");
                }
                return result.Output;
            }

            async Task Install(JsonNode contents) =>
                settings[Archive + "Sha256"] = await PublicationFixture.InstallReadOnlyJson(settings[Archive + "Path"], contents, ct);

            async Task WithTls(Func<HttpClient, ServerProcess, Task> verify)
            {
                await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings,
                    request => PublicationFixture.Forward(request, address.Authority));
                await using var proxy = await NativeCaddyProxy.Start(server.Client.BaseAddress!, directory.FullName, ct, address);
                evidence.WriteLine($"Caddy endpoint {address.Authority}, leaf SHA-256 {proxy.Fingerprint}.");
                await verify(proxy.Client, server);
            }

            async Task<string> Get(HttpClient client, string path, HttpStatusCode code)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, path) { Version = HttpVersion.Version20, VersionPolicy = HttpVersionPolicy.RequestVersionExact };
                using var response = Expect(code, await client.SendAsync(request, ct));
                evidence.WriteLine($"GET {path} -> {(int)response.StatusCode}, Cache-Control {response.Headers.CacheControl}.");
                Assert.Equal((HttpVersion.Version20, false, true), (response.Version, response.Headers.Contains("Set-Cookie"), response.Headers.CacheControl?.NoStore == true));
                return await response.Content.ReadAsStringAsync(ct);
            }
        }
        finally
        {
            if (succeeded) directory.Delete(recursive: true);
            else
            {
                File.Delete(Path.Combine(directory.FullName, "key.pkcs8"));
                File.Delete(Path.Combine(directory.FullName, "checkpoint.pkcs8"));
                evidence.WriteLine($"Preserved failed witness fixture at {directory.FullName}.");
            }
        }
    }

    private static string Coordinate(long sequence) => sequence.ToString(CultureInfo.InvariantCulture);
    private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);
    private static string Time(DateTimeOffset value) => ArticlePublicationProofPayloadV2.Time(value);

    private sealed record Member(ArticleState Article, long Publication, long Sequence, byte[] Entry)
    {
        internal string Path => $"/integrity/v2/article/{Article.Id}/{Publication}/daily-proof.json";
    }
}
