namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationCheckpointArchivePostgresTests(ITestOutputHelper evidence)
{
    private const string Host = "checkpoints.example.test", Prefix = "/integrity/v2/checkpoints", Latest = Prefix + "/latest.json";
    private const string Settings = "IntegrityProof__CheckpointArchive__", Keys = "IntegrityProof__Signing__Keys__";

    [PostgresFact]
    public Task ServesOnlyPinnedClosedDayWithSeparateKeyRegistryAndCurrentArchiveAncestor() => VerifyArchive(viaCaddy: false);

    [CaddyPostgresFact]
    public Task ServesOriginalSignedDayAndHeadAnonymouslyThroughTrustedCaddyTls() => VerifyArchive(viaCaddy: true);

    private async Task VerifyArchive(bool viaCaddy)
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var scratch = PublicationFixture.PrivateScratch("fsus-checkpoints");
        using var retired = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var current = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        try
        {
            var midnight = DateTimeOffset.UtcNow.Date.AddDays(-1);
            var headTime = new DateTimeOffset(midnight, TimeSpan.Zero).AddHours(1);
            var cutover = headTime.AddHours(1);
            var signedAt = cutover.AddHours(1);
            var (day, backfilledDay, tiedDay) = (midnight.AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                midnight.AddDays(-2).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                midnight.AddDays(-3).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
            var address = viaCaddy ? NativeCaddyProxy.NewAddress() : new Uri("https://" + Host);
            var origin = address.GetLeftPart(UriPartial.Authority);
            var path = Path.Combine(scratch.FullName, "archive.json");
            var config = new Dictionary<string, string>
            {
                ["FSUSBLOG_PUBLIC_ORIGIN"] = origin,
                ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true",
                ["IntegrityProof__Signing__NativeV2Enabled"] = "false",
                ["IntegrityProof__Signing__NativeV2PrivateKeyFile"] = Path.Combine(scratch.FullName, "nonexistent.pkcs8"),
                [Settings + "Path"] = path,
            };
            var (before, after) = (headTime.AddDays(-30), signedAt.AddDays(30));
            var oldKey = ProvideKey("old", 1, retired, before, after, cutover);
            var nextKey = ProvideKey("next", 2, current, before, after);
            var headDigest = SHA256.HashData("fixture source head"u8);
            var receipt = SHA256.HashData("fixture witnessed next receipt"u8);
            var head = new PublicationTransparencyHeadV2(origin, 3, headDigest, "old", 1,
                SHA256.HashData(retired.ExportSubjectPublicKeyInfo()), headTime);
            var dayReceipt = new PublicationCheckpointV2(origin, day, 0, 0, 0, PublicationCheckpointTreeV2.EmptyDailyRoot(), 3, headDigest,
                "next", 2, SHA256.HashData(current.ExportSubjectPublicKeyInfo()), signedAt, PublicationCheckpointKind.Daily);
            var signedHead = PublicationFixture.SignedHead(head, PublicationFixture.SignP256(retired, head.Payload()));
            var signedDay = SignedDay(dayReceipt);
            var backfilledAt = signedAt.AddMinutes(1);
            var backfilled = SignedDay(dayReceipt with { ScopeKey = backfilledDay, AttestedAt = backfilledAt });
            var archived = new JsonObject
            {
                ["archiveVersion"] = 2, ["head"] = signedHead.DeepClone(),
                ["bridgeReceiptSha256"] = new JsonArray(JsonValue.Create(Hex(receipt))),
                ["checkpoints"] = new JsonArray(signedDay.DeepClone(), backfilled.DeepClone(),
                    SignedDay(dayReceipt with { ScopeKey = tiedDay, AttestedAt = backfilledAt })),
            };
            await Install(archived);
            var validPin = "4:" + Hex(PublicationTransparencyV2.EntryDigest(4, headDigest, receipt));
            config[Settings + "CurrentAnchor"] = validPin;
            var route = $"{Prefix}/daily/{day}.json";
            await WithServer(async client => { await Read(client, route, NotFound); await Read(client, Latest, NotFound); });
            config[Settings + "Enabled"] = "true";
            await WithServer(async client =>
            {
                var servedDay = await Read(client, route, OK);
                var servedHead = await Read(client, Prefix + "/head.json", OK);
                var servedLatest = await Read(client, Latest, OK);
                Assert.True(JsonNode.DeepEquals(signedHead, JsonNode.Parse(servedHead)));
                Assert.Equal(signedHead.ToJsonString(), servedHead);
                Assert.Equal("{\"checkpoint\":" + signedDay.ToJsonString() + ",\"inclusion\":null}", servedDay);
                var publicBundle = JsonNode.Parse(servedDay)!.AsObject();
                Assert.Equal(2, publicBundle.Count);
                Assert.Null(publicBundle["inclusion"]);
                Assert.True(JsonNode.DeepEquals(signedDay, publicBundle["checkpoint"]));
                Assert.Equal("{\"checkpoint\":" + backfilled.ToJsonString() + ",\"inclusion\":null}", servedLatest);
                Assert.Equal(await Read(client, $"{Prefix}/daily/{backfilledDay}.json", OK), servedLatest);
                foreach (var body in new[] { servedDay, servedHead, servedLatest }) Assert.DoesNotContain(Hex(receipt), body);
                await Read(client, Prefix + "/daily/2020-01-01.json", NotFound);
                await Read(client, Prefix + "/daily/2026-02-30.json", BadRequest);
                if (!viaCaddy)
                    foreach (var target in new[] { route, Latest })
                    {
                        await Read(client, target, NotFound, "another.example.test");
                        await Read(client, target, Forbidden, transport: "http");
                    }
                await Read(client, "/integrity/v2/keys.json", NotFound);
                await IndependentlyVerify(servedDay, servedHead, day, oldKey, nextKey);
                await IndependentlyVerify(servedLatest, servedHead, backfilledDay, oldKey, nextKey);
                if (viaCaddy)
                    evidence.WriteLine($"Node verified {day}, signed head SHA-256 {Hex(SHA256.HashData(Encoding.UTF8.GetBytes(servedHead)))}, "
                        + $"daily response SHA-256 {Hex(SHA256.HashData(Encoding.UTF8.GetBytes(servedDay)))}. "
                        + $"Node verified latest attestation for {backfilledDay}, response SHA-256 {Hex(SHA256.HashData(Encoding.UTF8.GetBytes(servedLatest)))}.");
            });

            if (viaCaddy)
            {
                config[Settings + "CurrentAnchor"] = "4:" + Hex(SHA256.HashData("unrelated retained head"u8));
                await Withheld();
                return;
            }

            var matchingHead = archived.DeepClone();
            matchingHead["bridgeReceiptSha256"] = new JsonArray();
            await Install(matchingHead);
            config[Settings + "CurrentAnchor"] = "3:" + Hex(headDigest);
            await WithServer(client => Read(client, route, OK));
            await Install(archived);
            config[Settings + "CurrentAnchor"] = "4:" + Hex(SHA256.HashData("unrelated retained head"u8));
            await Withheld();
            config[Settings + "CurrentAnchor"] = validPin;
            config[Settings + "Sha256"] = new string('0', 64);
            await Withheld();
            await Install(archived);
            config[Settings + "Path"] = Path.Combine(scratch.FullName, "absent.json");
            await Withheld();
            var unrelatedPath = Path.Combine(scratch.FullName, "link.json");
            File.CreateSymbolicLink(unrelatedPath, path);
            config[Settings + "Path"] = unrelatedPath;
            await Withheld();
            config[Settings + "Path"] = path;
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            await Withheld();
            var originalSignature = signedDay["signature"]!.GetValue<string>();
            var futureDate = signedAt.AddDays(7);
            foreach (var mutate in new Action<JsonNode>[]
            {
                node => node["checkpoints"]![0]!["articleId"] = 123,
                node => node["checkpoints"]![0]!["signature"] = (originalSignature[0] == 'A' ? "B" : "A") + originalSignature[1..],
                node => { node["checkpoints"]![0]!["attestedAtUtc"] = Time(futureDate); node["checkpoints"]![0]!["signature"] = Sign(current, (dayReceipt with { AttestedAt = futureDate }).Payload()); },
            })
            {
                var copy = archived.DeepClone();
                mutate(copy);
                await Install(copy);
                await Withheld();
            }
            await Install(archived);
            config[Keys + "old__CompromisedAtUtc"] = Time(cutover);
            await Withheld();

            JsonNode SignedDay(PublicationCheckpointV2 claim) => JsonSerializer.SerializeToNode(new
            {
                checkpointVersion = 2, kind = "native-publication-checkpoint", checkpointKind = "daily", algorithm = ArticlePublicationProofPayloadV2.Algorithm,
                origin, scopeKey = claim.ScopeKey, fromSequence = "0", toSequence = "0", entryCount = 0, rootSha256 = Hex(claim.RootSha256),
                headSequence = "3", headEntrySha256 = Hex(headDigest), keyId = "next", keyVersion = 2, keySha256 = Hex(claim.KeySha256),
                attestedAtUtc = Time(claim.AttestedAt), signature = Sign(current, claim.Payload()),
            })!;

            Task WithServer(Func<HttpClient, Task> check) => PublicationFixture.WithPublicServer(fixture, scratch.FullName,
                address, config, evidence, viaCaddy, (client, _) => check(client), ct);

            Task Withheld() => WithServer(async client =>
            {
                foreach (var target in new[] { route, Prefix + "/head.json", Latest }) await Read(client, target, ServiceUnavailable);
                if (viaCaddy) await CheckStatusAsync(NoContent, client.GetAsync("/health/ready", ct));
            });

            async Task Install(JsonNode archive) => config[Settings + "Sha256"] = await PublicationFixture.InstallReadOnlyJson(path, archive, ct);

            object ProvideKey(string id, int version, ECDsa key, DateTimeOffset from, DateTimeOffset until, DateTimeOffset? revoked = null)
            {
                var spki = key.ExportSubjectPublicKeyInfo();
                PublicationFixture.ConfigureKey(config, id, version.ToString(CultureInfo.InvariantCulture), spki, Time(from), Time(until));
                if (revoked is { } at) config[Keys + id + "__RevokedAtUtc"] = Time(at);
                return new { keyId = id, keyVersion = version, keySha256 = Hex(SHA256.HashData(spki)), publicKey = WebEncoders.Base64UrlEncode(spki),
                    notBeforeUtc = Time(from), notAfterUtc = Time(until), revokedAtUtc = revoked is { } mark ? Time(mark) : null,
                    compromisedAtUtc = (string?)null };
            }

            async Task IndependentlyVerify(string bundle, string witness, string date, params object[] keys)
            {
                var (keyPath, headPath, bundlePath) = (Path.Combine(scratch.FullName, "keys.json"), Path.Combine(scratch.FullName, "head.json"),
                    Path.Combine(scratch.FullName, "public-day.json"));
                await File.WriteAllTextAsync(keyPath, JsonSerializer.Serialize(new { manifestVersion = 2, kind = "native-publication-proof-keys",
                    algorithm = ArticlePublicationProofPayloadV2.Algorithm, keys }), ct);
                await File.WriteAllTextAsync(headPath, witness, ct);
                await File.WriteAllTextAsync(bundlePath, bundle, ct);
                var result = await FixtureProcess.Run(PublicationFixture.Verifier("checkpoint",
                    origin, keyPath, headPath, bundlePath, "--daily", date), ct);
                Assert.True(result.Code == 0, result.Error);
                Assert.Equal(date, JsonNode.Parse(result.Output)!["scopeKey"]!.GetValue<string>());
            }

            async Task<string> Read(HttpClient client, string target, HttpStatusCode expected, string? host = null, string transport = "https")
            {
                using var response = Expect(expected, viaCaddy ? await client.GetAsync(target, ct)
                    : await PublicationFixture.ForwardedGet(client, target, host ?? address.Authority, ct, transport));
                if (viaCaddy)
                {
                    Assert.Equal(HttpVersion.Version20, response.Version);
                    Assert.False(response.Headers.Contains("Set-Cookie"));
                    if (expected == OK) Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
                    evidence.WriteLine($"GET {target} -> {(int)response.StatusCode}, Cache-Control: {response.Headers.CacheControl}");
                }
                if (target.StartsWith(Prefix, StringComparison.Ordinal)) Assert.True(response.Headers.CacheControl?.NoStore);
                return new UTF8Encoding(false, true).GetString(await response.Content.ReadAsByteArrayAsync(ct));
            }
        }
        finally { scratch.Delete(recursive: true); }
    }

    private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);
    private static string Time(DateTimeOffset time) => ArticlePublicationProofPayloadV2.Time(time);
    private static string Sign(ECDsa key, byte[] bytes) => WebEncoders.Base64UrlEncode(PublicationFixture.SignP256(key, bytes));
}
