using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Content;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;
using Xunit.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationCheckpointInclusionPostgresTests(ITestOutputHelper evidence)
{
    private const string Signing = "IntegrityProof__Signing__";
    private const string CheckpointSigning = "IntegrityProof__CheckpointSigning__";
    private const string Archive = "IntegrityProof__CheckpointArchive__";
    private const string Key = "fixture";
    private const string Checkpoints = "/integrity/v2/checkpoints";

    [CaddyPostgresFact(requiresMigrate: true)]
    public Task ServesOnlyTheStillPublicSignedLedgerMemberThroughCaddyTls() => Verify(automatic: false);

    [CaddyPostgresFact(requiresMigrate: true)]
    public Task SignsClosedDaysFromTheLiveExactLedgerWithAnIndependentKeyWithoutChangingTheOnlineHead() => Verify(automatic: true);

    private async Task Verify(bool automatic)
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
        var directory = Directory.CreateDirectory(Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : "/tmp",
            $"fsus-daily-inclusion-{Guid.NewGuid():N}"));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(directory.FullName,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var succeeded = false;
        try
        {
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var spki = key.ExportSubjectPublicKeyInfo();
            var fingerprint = SHA256.HashData(spki);
            var address = NativeCaddyProxy.NewAddress();
            var origin = address.GetLeftPart(UriPartial.Authority);
            var headAt = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(-1).AddHours(1));
            var publishedAt = headAt.AddDays(-1);
            var issuedAt = publishedAt.AddHours(1);
            var before = publishedAt.AddDays(-1);
            var after = headAt.AddDays(30);
            var day = publishedAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var privateFile = Path.Combine(directory.FullName, "key.pkcs8");
            await WriteKey(privateFile, key);
            var settings = new Dictionary<string, string>
            {
                ["FSUSBLOG_PUBLIC_ORIGIN"] = origin,
                ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true",
                [Signing + "NativeV2Enabled"] = "true",
                [Signing + "CurrentKeyId"] = Key,
                [Signing + "NativeV2PrivateKeyFile"] = privateFile,
                [Signing + "Keys__fixture__Version"] = "1",
                [Signing + "Keys__fixture__Algorithm"] = ArticlePublicationProofPayloadV2.Algorithm,
                [Signing + "Keys__fixture__PublicKey"] = WebEncoders.Base64UrlEncode(spki),
                [Signing + "Keys__fixture__NotBeforeUtc"] = Time(before),
                [Signing + "Keys__fixture__NotAfterUtc"] = Time(after),
                [Archive + "Enabled"] = "true",
                [Archive + "Path"] = Path.Combine(directory.FullName, "archive.json"),
            };
            var migration = Environment.GetEnvironmentVariable(PublicationTransparencyFact.MigrationPath)!;
            var runner = Environment.GetEnvironmentVariable("DOTNET_BIN") ?? "dotnet";
            await Run(runner, [migration, "publication-transparency", "enable"], migrationEnvironment: true);

            var owner = Guid.NewGuid();
            var ticket = RandomNumberGenerator.GetBytes(32);
            await Scalar(null, "insert into public.blog_user values($1,'Daily member fixture',true,true,1)", owner);
            await Scalar(null, "insert into public.login_ticket values($1,$2,now()+interval '5 minutes')", SHA256.HashData(ticket), owner);
            var (session, author) = await new Store(fixture.DataSource).SignIn(Hex(ticket), ct);
            Member covered;
            Member omitted;
            Member oddLeaf;
            var tail = new PublicationTransparency(0, new byte[32]);
            await using (var tx = await connection.BeginTransactionAsync(ct))
            {
                // Issuance is normally driven by the database clock. Use a closed UTC day for the fixture's receipts.
                await Scalar(tx, """
                    insert into public.publication_proof_key(key_id,version,spki_sha256,not_before,not_after)
                    values($1,1,$2,$3,$4)
                    """, Key, fingerprint, before, after);
                covered = await Publish(tx, "Covered current release");
                omitted = await Publish(tx, "Current release without archived witness");
                oddLeaf = await Publish(tx, "Covered last release on the selected day");
                await Scalar(tx, "update public.blog_outbox set processed_at=now() where processed_at is null");
                await tx.CommitAsync(ct);
            }

            var head = new PublicationTransparencyHeadV2(origin, tail.Sequence, tail.Hash, Key, 1, fingerprint, headAt);
            var headPath = Path.Combine(directory.FullName, "head.json");
            var headSignature = Sign(head.Payload());
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
                algorithm = ArticlePublicationProofPayloadV2.Algorithm,
                keys = manifestKeys,
            }), ct);
            if (automatic)
            {
                await CheckAutomatic();
                succeeded = true;
                return;
            }
            var first = JsonNode.Parse(await Checkpoint(covered.Sequence))!;
            var last = JsonNode.Parse(await Checkpoint(oddLeaf.Sequence))!;
            var checkpoint = first["checkpoint"]!;
            Assert.Equal(checkpoint["rootSha256"]!.GetValue<string>(), last["checkpoint"]!["rootSha256"]!.GetValue<string>());
            var archive = new JsonObject
            {
                ["archiveVersion"] = 3,
                ["head"] = JsonNode.Parse(await File.ReadAllTextAsync(headPath, ct)),
                ["bridgeReceiptSha256"] = new JsonArray(),
                ["checkpoints"] = new JsonArray(checkpoint.DeepClone()),
                ["inclusions"] = new JsonArray(ForDay(first), ForDay(last)),
            };
            settings[Archive + "CurrentAnchor"] = Coordinate(tail.Sequence) + ":" + Hex(tail.Hash);
            await Install(archive);
            await WithTls(async client =>
            {
                var headBytes = await Get(client, Checkpoints + "/head.json", HttpStatusCode.OK);
                Assert.Equal(await File.ReadAllTextAsync(headPath, ct), headBytes);
                var dayRoute = $"{Checkpoints}/daily/{day}.json";
                var aggregate = await Get(client, dayRoute, HttpStatusCode.OK);
                Assert.Equal("{\"checkpoint\":" + checkpoint.ToJsonString() + ",\"inclusion\":null}", aggregate);
                Assert.Equal(aggregate, await Get(client, Checkpoints + "/latest.json", HttpStatusCode.OK));
                foreach (var (member, expected) in new[] { (covered, first), (oddLeaf, last) })
                {
                    var bundle = await Get(client, member.Path, HttpStatusCode.OK);
                    var parsed = JsonNode.Parse(bundle)!;
                    Assert.True(JsonNode.DeepEquals(expected["inclusion"], parsed["inclusion"]));
                    Assert.Equal(checkpoint.ToJsonString(), parsed["checkpoint"]!.ToJsonString());
                    var bundlePath = Path.Combine(directory.FullName, $"member-{member.Sequence}.json");
                    await File.WriteAllTextAsync(bundlePath, bundle, ct);
                    var result = JsonNode.Parse(await Run("node",
                        [RepositoryTool("verify-publication-checkpoint.mjs"), origin, manifest, headPath, bundlePath,
                            "--daily", day, Coordinate(member.Sequence), Hex(member.Entry)]))!;
                    Assert.Equal(Coordinate(member.Sequence), result["inclusionSequence"]!.GetValue<string>());
                    evidence.WriteLine($"Node independently verified day {day}, ledger sequence {member.Sequence} and entry {Hex(member.Entry)}.");
                }
                await Get(client, omitted.Path, HttpStatusCode.NotFound);
                await Get(client, $"{Checkpoints}/daily/{day}/{covered.Sequence}.json", HttpStatusCode.NotFound);
                await Get(client, $"/integrity/v2/article/{omitted.Article.Id}/{covered.Publication}/daily-proof.json", HttpStatusCode.NotFound);

                using var retract = SiteAedsFixture.Request(HttpMethod.Post, WireRoutes.Retract,
                    Wire.EncodeArticleCommand(new(oddLeaf.Article.Id, oddLeaf.Article.Revision, Guid.NewGuid(), "", "")),
                    session, handle: null);
                using var response = await client.SendAsync(retract, ct);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                await Get(client, oddLeaf.Path, HttpStatusCode.NotFound);
                Assert.Equal(aggregate, await Get(client, dayRoute, HttpStatusCode.OK));
            });

            var tampered = archive.DeepClone();
            tampered["inclusions"]![0]!["inclusion"]!["siblings"]![0] = new string('0', 64);
            await Install(tampered);
            await WithTls(async client =>
            {
                await Get(client, covered.Path, HttpStatusCode.ServiceUnavailable);
                await Get(client, oddLeaf.Path, HttpStatusCode.NotFound);
                await Get(client, covered.Path.Replace("daily-proof.json", "rights.json", StringComparison.Ordinal), HttpStatusCode.OK);
            });
            succeeded = true;

            byte[] Sign(byte[] bytes) => key.SignData(bytes, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

            object RegistryKey(string id, byte[] publicKey) => new { keyId = id, keyVersion = 1, publicKey = WebEncoders.Base64UrlEncode(publicKey),
                keySha256 = Hex(SHA256.HashData(publicKey)), notBeforeUtc = Time(before), notAfterUtc = Time(after),
                revokedAtUtc = (string?)null, compromisedAtUtc = (string?)null };

            async Task CheckAutomatic()
            {
                var checkpointFile = Path.Combine(directory.FullName, "checkpoint.pkcs8");
                await WriteKey(checkpointFile, checkpointKey);
                const string checkpointConfig = Signing + "Keys__checkpoint__";
                settings[checkpointConfig + "Version"] = "1";
                settings[checkpointConfig + "Algorithm"] = ArticlePublicationProofPayloadV2.Algorithm;
                settings[checkpointConfig + "PublicKey"] = WebEncoders.Base64UrlEncode(checkpointSpki);
                settings[checkpointConfig + "NotBeforeUtc"] = Time(before);
                settings[checkpointConfig + "NotAfterUtc"] = Time(after);
                settings[Signing + "NativeV2PublicHeadAnchor"] = Coordinate(covered.Sequence) + ":" + Hex(covered.Entry);
                settings.Remove(Archive + "Enabled");
                await Scalar(null, """
                    insert into public.publication_transparency_head(singleton,seq,entry_sha256,origin,key_id,key_version,key_sha256,attested_at,signature)
                    values(true,$1,$2,$3,$4,1,$5,$6,$7)
                    """, tail.Sequence, tail.Hash, origin, Key, fingerprint, headAt, headSignature);

                var signer = new Dictionary<string, string>
                {
                    [CheckpointSigning + "KeyId"] = "checkpoint",
                    [CheckpointSigning + "PrivateKeyFile"] = checkpointFile,
                };
                var args = new[] { migration, "publication-transparency", "checkpoint-daily-auto", origin, manifest,
                    Coordinate(covered.Sequence), Hex(covered.Entry), directory.FullName };
                const string headRoute = "/integrity/v2/log/head.json";
                string sealedPath = "";
                string sealedHash = "";
                await WithTls(async client =>
                {
                    var initial = await Get(client, headRoute, HttpStatusCode.OK);
                    Assert.Equal(await File.ReadAllTextAsync(headPath, ct), initial);
                    var quietDay = headAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    var firstRun = JsonNode.Parse(await Run(runner, args, migrationEnvironment: true, overrides: signer))!;
                    Assert.Equal(quietDay, firstRun["scopeKey"]!.GetValue<string>());
                    await VerifyAutomaticArchive(firstRun, quietDay, 0);
                    var explicitDay = args.Append(day).ToArray();
                    var result = JsonNode.Parse(await Run(runner, explicitDay, migrationEnvironment: true, overrides: signer))!;
                    await VerifyAutomaticArchive(result, day, 3);
                    sealedPath = result["path"]!.GetValue<string>();
                    sealedHash = result["sha256"]!.GetValue<string>();
                    var original = await File.ReadAllBytesAsync(sealedPath, ct);
                    var retry = await Run(runner, explicitDay, migrationEnvironment: true, overrides: signer);
                    Assert.True(JsonNode.DeepEquals(result, JsonNode.Parse(retry)));
                    Assert.Equal(original, await File.ReadAllBytesAsync(sealedPath, ct));

                    var changed = JsonNode.Parse(original)!;
                    changed["checkpoints"]![0]!["entryCount"] = 2;
                    var changedBytes = JsonSerializer.SerializeToUtf8Bytes(changed);
                    await ReplaceSealedArchive(changedBytes);
                    await Run(runner, explicitDay, migrationEnvironment: true, overrides: signer, failure: "bytes were changed");
                    Assert.Equal(changedBytes, await File.ReadAllBytesAsync(sealedPath, ct));
                    await ReplaceSealedArchive(original);

                    var openDay = await Scalar(null, "select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD')");
                    await Run(runner, args.Append((string)openDay!).ToArray(), migrationEnvironment: true, overrides: signer, failure: "still open");
                    var wrong = args.ToArray();
                    wrong[6] = new string('0', 64);
                    await Run(runner, wrong, migrationEnvironment: true, overrides: signer, failure: "independently retained native head");
                    signer[CheckpointSigning + "KeyId"] = Key;
                    await Run(runner, args, migrationEnvironment: true, overrides: signer, failure: "separately registered");
                    Assert.Equal(initial, await Get(client, headRoute, HttpStatusCode.OK));
                    Assert.Equal(tail.Sequence, await Scalar(null, "select count(*) from public.article_publication_transparency"));
                });

                settings[Archive + "Enabled"] = "true";
                settings[Archive + "Path"] = sealedPath;
                settings[Archive + "Sha256"] = sealedHash;
                settings[Archive + "CurrentAnchor"] = Coordinate(tail.Sequence) + ":" + Hex(tail.Hash);
                await WithTls(async client =>
                {
                    await Get(client, Checkpoints + "/head.json", HttpStatusCode.OK);
                    var served = await Get(client, $"{Checkpoints}/daily/{day}.json", HttpStatusCode.OK);
                    Assert.Equal(3, JsonNode.Parse(served)!["checkpoint"]!["entryCount"]!.GetValue<int>());
                });

                async Task VerifyAutomaticArchive(JsonNode result, string scope, int count)
                {
                    var path = result["path"]!.GetValue<string>();
                    var bytes = await File.ReadAllBytesAsync(path, ct);
                    Assert.Equal(Hex(SHA256.HashData(bytes)), result["sha256"]!.GetValue<string>());
                    var signed = JsonNode.Parse(bytes)!;
                    Assert.Equal("checkpoint", signed["head"]!["keyId"]!.GetValue<string>());
                    var checkpoint = signed["checkpoints"]![0]!;
                    Assert.Equal(count, checkpoint["entryCount"]!.GetValue<int>());
                    var date = DateTime.ParseExact(scope, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
                    Assert.True(DateTimeOffset.Parse(signed["head"]!["attestedAtUtc"]!.GetValue<string>(), CultureInfo.InvariantCulture) >=
                        date.ToUniversalTime().AddDays(1));
                    var signedHeadPath = Path.Combine(directory.FullName, "automatic-head.json");
                    var bundlePath = Path.Combine(directory.FullName, "automatic-day.json");
                    await File.WriteAllTextAsync(signedHeadPath, signed["head"]!.ToJsonString(), ct);
                    await File.WriteAllTextAsync(bundlePath, "{\"checkpoint\":" + checkpoint.ToJsonString() + ",\"inclusion\":null}", ct);
                    var verified = JsonNode.Parse(await Run("node",
                        [RepositoryTool("verify-publication-checkpoint.mjs"), origin, manifest, signedHeadPath, bundlePath, "--daily", scope]))!;
                    Assert.Equal(scope, verified["scopeKey"]!.GetValue<string>());
                    Assert.Equal(count == 0 ? "0" : Coordinate(tail.Sequence), verified["toSequence"]!.GetValue<string>());
                    evidence.WriteLine($"Node verified automatic date {scope}, {count} entries, archive SHA-256 {Hex(SHA256.HashData(bytes))}.");
                }

                async Task ReplaceSealedArchive(byte[] bytes)
                {
                    var replacement = sealedPath + ".fixture";
                    await File.WriteAllBytesAsync(replacement, bytes, ct);
                    if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(replacement, UnixFileMode.UserRead);
                    File.Move(replacement, sealedPath, overwrite: true);
                }
            }

            async Task WriteKey(string path, ECDsa signer)
            {
                var privateBytes = signer.ExportPkcs8PrivateKey();
                try { await File.WriteAllBytesAsync(path, privateBytes, ct); }
                finally { CryptographicOperations.ZeroMemory(privateBytes); }
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead);
            }

            async Task<Member> Publish(NpgsqlTransaction tx, string title)
            {
                var (draft, _) = await Store.Execute(connection, tx, author, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, "Fixture body"), ct);
                var (published, _) = await Store.Execute(connection, tx, author, ArticleAction.Publish,
                    new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""), ct);
                var publication = (long)(await Scalar(tx,
                    "select publication_id from public.article_publication where article_id=$1", published.Id))!;
                var outbox = (long)(await Scalar(tx, """
                    delete from public.article_publication_canonical where publication_id=$1 returning outbox_id
                    """, publication))!;
                await Scalar(tx, "update public.article_publication_history set happened_at=$2 where publication_id=$1", publication, publishedAt);
                await Scalar(tx, "update public.article_publication set published_at=$2 where publication_id=$1", publication, publishedAt);
                await PublicationCanonicalStore.Record(connection, tx, published.Id, published.Revision, outbox, ct);
                ArticlePublicationProofV2 claim;
                await using (var select = Store.Sql(connection, tx, """
                    select publication_no,rights_snapshot_id,content_sha256,policy_sha256
                    from public.article_publication_canonical where publication_id=$1
                    """, publication))
                await using (var row = await select.ExecuteReaderAsync(ct))
                {
                    Assert.True(await row.ReadAsync(ct));
                    claim = new(origin, published.Id, published.Revision, publication, row.GetInt32(0), publishedAt, row.GetInt64(1),
                        outbox, row.GetFieldValue<byte[]>(2), row.GetFieldValue<byte[]>(3), Key, 1, fingerprint, issuedAt);
                }
                var transcript = ArticlePublicationProofPayloadV2.Build(claim);
                var signature = Sign(transcript);
                await Scalar(tx, """
                    insert into public.article_publication_proof(publication_id,origin,key_id,key_version,key_sha256,issued_at,signature,transparency_seq)
                    values($1,$2,$3,1,$4,$5,$6,$7)
                    """, publication, origin, Key, fingerprint, issuedAt, signature, tail.Sequence + 1);
                tail = await tail.Append(connection, tx, tail.Sequence + 1, publication, transcript, signature, ct);
                return new(published, publication, tail.Sequence, tail.Hash);
            }

            JsonObject ForDay(JsonNode bundle) => new() { ["scopeKey"] = day, ["inclusion"] = bundle["inclusion"]!.DeepClone() };

            Task<string> Checkpoint(long sequence) => Run(runner,
                [migration, "publication-transparency", "checkpoint-daily", origin, manifest, headPath, day, Coordinate(sequence)],
                migrationEnvironment: true);

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
                if (overrides is not null)
                    foreach (var (name, value) in overrides) start.Environment[name] = value;
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

            async Task Install(JsonNode contents)
            {
                var bytes = JsonSerializer.SerializeToUtf8Bytes(contents);
                var path = settings[Archive + "Path"];
                await File.WriteAllBytesAsync(path + ".tmp", bytes, ct);
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path + ".tmp", UnixFileMode.UserRead);
                File.Move(path + ".tmp", path, overwrite: true);
                settings[Archive + "Sha256"] = Hex(SHA256.HashData(bytes));
            }

            async Task WithTls(Func<HttpClient, Task> verify)
            {
                await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings,
                    request => PublicationFixture.Forward(request, address.Authority));
                await using var proxy = await NativeCaddyProxy.Start(server.Client.BaseAddress!, directory.FullName, ct, address);
                evidence.WriteLine($"Caddy endpoint {address.Authority}, leaf SHA-256 {proxy.Fingerprint}.");
                await verify(proxy.Client);
            }

            async Task<string> Get(HttpClient client, string path, HttpStatusCode code)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, path)
                {
                    Version = HttpVersion.Version20, VersionPolicy = HttpVersionPolicy.RequestVersionExact,
                };
                using var response = await client.SendAsync(request, ct);
                evidence.WriteLine($"GET {path} -> {(int)response.StatusCode}, Cache-Control {response.Headers.CacheControl}.");
                Assert.Equal(code, response.StatusCode);
                Assert.Equal(HttpVersion.Version20, response.Version);
                Assert.False(response.Headers.Contains("Set-Cookie"));
                Assert.True(response.Headers.CacheControl?.NoStore);
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

        Task<object?> Scalar(NpgsqlTransaction? tx, string sql, params object[] values) =>
            FixtureSql.ScalarAsync(connection, tx, ct, sql, values);
    }

    private static string RepositoryTool(string name) => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../tools", name));
    private static string Coordinate(long sequence) => sequence.ToString(CultureInfo.InvariantCulture);
    private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);
    private static string Time(DateTimeOffset value) => ArticlePublicationProofPayloadV2.Time(value);

    private sealed record Member(ArticleState Article, long Publication, long Sequence, byte[] Entry)
    {
        internal string Path => $"/integrity/v2/article/{Article.Id}/{Publication}/daily-proof.json";
    }
}
