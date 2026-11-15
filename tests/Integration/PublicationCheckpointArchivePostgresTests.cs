using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FsusBlog.V2.Contracts;
using Microsoft.AspNetCore.WebUtilities;
using Xunit.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationCheckpointArchivePostgresTests(ITestOutputHelper evidence)
{
    private const string Host = "checkpoints.example.test";
    private const string Prefix = "/integrity/v2/checkpoints";
    private const string Latest = Prefix + "/latest.json";
    private const string Settings = "IntegrityProof__CheckpointArchive__";
    private const string Keys = "IntegrityProof__Signing__Keys__";

    [PostgresFact]
    public Task ServesOnlyPinnedClosedDayWithSeparateKeyRegistryAndCurrentArchiveAncestor() => VerifyArchive(viaCaddy: false);

    [CaddyPostgresFact]
    public Task ServesOriginalSignedDayAndHeadAnonymouslyThroughTrustedCaddyTls() => VerifyArchive(viaCaddy: true);

    private async Task VerifyArchive(bool viaCaddy)
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var scratch = Directory.CreateDirectory(Path.Combine(OperatingSystem.IsMacOS() ? "/private/tmp" : "/tmp", $"fsus-checkpoints-{Guid.NewGuid():N}"));
        using var retired = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var current = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        try
        {
            var midnight = DateTimeOffset.UtcNow.Date.AddDays(-1);
            var headTime = new DateTimeOffset(midnight, TimeSpan.Zero).AddHours(1);
            var cutover = headTime.AddHours(1);
            var signedAt = cutover.AddHours(1);
            var day = midnight.AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var backfilledDay = midnight.AddDays(-2).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var tiedDay = midnight.AddDays(-3).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
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
            var before = headTime.AddDays(-30);
            var after = signedAt.AddDays(30);
            var oldKey = ProvideKey("old", 1, retired, before, after, cutover);
            var nextKey = ProvideKey("next", 2, current, before, after);
            var headDigest = SHA256.HashData("fixture source head"u8);
            var receipt = SHA256.HashData("fixture witnessed next receipt"u8);
            var head = new PublicationTransparencyHeadV2(origin, 3, headDigest, "old", 1,
                SHA256.HashData(retired.ExportSubjectPublicKeyInfo()), headTime);
            var dayReceipt = new PublicationCheckpointV2(origin, day, 0, 0, 0, PublicationCheckpointTreeV2.EmptyDailyRoot(), 3, headDigest,
                "next", 2, SHA256.HashData(current.ExportSubjectPublicKeyInfo()), signedAt, PublicationCheckpointKind.Daily);
            var signedHead = JsonSerializer.SerializeToNode(new
            {
                headVersion = 2, kind = "native-publication-log-head", algorithm = ArticlePublicationProofPayloadV2.Algorithm, origin,
                sequence = "3", entrySha256 = Hex(headDigest), keyId = "old", keyVersion = 1, keySha256 = Hex(head.KeySha256),
                attestedAtUtc = Time(headTime), signature = Sign(retired, head.Payload()),
            })!;
            var signedDay = SignedDay(dayReceipt);
            var backfilledAt = signedAt.AddMinutes(1);
            var backfilled = SignedDay(dayReceipt with { ScopeKey = backfilledDay, AttestedAt = backfilledAt });
            var tied = SignedDay(dayReceipt with { ScopeKey = tiedDay, AttestedAt = backfilledAt });
            var archived = new JsonObject
            {
                ["archiveVersion"] = 2, ["head"] = signedHead.DeepClone(),
                ["bridgeReceiptSha256"] = new JsonArray(JsonValue.Create(Hex(receipt))),
                ["checkpoints"] = new JsonArray(signedDay.DeepClone(), backfilled.DeepClone(), tied),
            };
            await Install(archived);
            var validPin = "4:" + Hex(PublicationTransparencyV2.EntryDigest(4, headDigest, receipt));
            config[Settings + "CurrentAnchor"] = validPin;
            var route = $"{Prefix}/daily/{day}.json";
            await WithServer(async client =>
            {
                await Read(client, route, HttpStatusCode.NotFound);
                await Read(client, Latest, HttpStatusCode.NotFound);
            });
            config[Settings + "Enabled"] = "true";
            await WithServer(async client =>
            {
                var servedDay = await Read(client, route, HttpStatusCode.OK);
                var servedHead = await Read(client, Prefix + "/head.json", HttpStatusCode.OK);
                var servedLatest = await Read(client, Latest, HttpStatusCode.OK);
                Assert.True(JsonNode.DeepEquals(signedHead, JsonNode.Parse(servedHead)));
                Assert.Equal(signedHead.ToJsonString(), servedHead);
                Assert.Equal("{\"checkpoint\":" + signedDay.ToJsonString() + ",\"inclusion\":null}", servedDay);
                var publicBundle = JsonNode.Parse(servedDay)!.AsObject();
                Assert.Equal(2, publicBundle.Count);
                Assert.Null(publicBundle["inclusion"]);
                Assert.True(JsonNode.DeepEquals(signedDay, publicBundle["checkpoint"]));
                Assert.DoesNotContain(Hex(receipt), servedDay);
                Assert.DoesNotContain(Hex(receipt), servedHead);
                Assert.Equal("{\"checkpoint\":" + backfilled.ToJsonString() + ",\"inclusion\":null}", servedLatest);
                Assert.Equal(await Read(client, $"{Prefix}/daily/{backfilledDay}.json", HttpStatusCode.OK), servedLatest);
                Assert.DoesNotContain(Hex(receipt), servedLatest);
                await Read(client, Prefix + "/daily/2020-01-01.json", HttpStatusCode.NotFound);
                await Read(client, Prefix + "/daily/2026-02-30.json", HttpStatusCode.BadRequest);
                if (!viaCaddy)
                {
                    await Read(client, route, HttpStatusCode.NotFound, "another.example.test");
                    await Read(client, route, HttpStatusCode.Forbidden, transport: "http");
                    await Read(client, Latest, HttpStatusCode.NotFound, "another.example.test");
                    await Read(client, Latest, HttpStatusCode.Forbidden, transport: "http");
                }
                await Read(client, "/integrity/v2/keys.json", HttpStatusCode.NotFound);
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
            await WithServer(client => Read(client, route, HttpStatusCode.OK));
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
            var augmented = archived.DeepClone();
            augmented["checkpoints"]![0]!["articleId"] = 123;
            await Install(augmented);
            await Withheld();
            var unsigned = archived.DeepClone();
            var originalSignature = signedDay["signature"]!.GetValue<string>();
            unsigned["checkpoints"]![0]!["signature"] = (originalSignature[0] == 'A' ? "B" : "A") + originalSignature[1..];
            await Install(unsigned);
            await Withheld();
            var future = archived.DeepClone();
            var futureDate = signedAt.AddDays(7);
            future["checkpoints"]![0]!["attestedAtUtc"] = Time(futureDate);
            future["checkpoints"]![0]!["signature"] = Sign(current, (dayReceipt with { AttestedAt = futureDate }).Payload());
            await Install(future);
            await Withheld();
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

            async Task WithServer(Func<HttpClient, Task> check)
            {
                await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, config,
                    request => PublicationFixture.Forward(request, address.Authority));
                if (!viaCaddy)
                {
                    await check(server.Client);
                    return;
                }
                await using var proxy = await NativeCaddyProxy.Start(server.Client.BaseAddress!, scratch.FullName, ct, address);
                evidence.WriteLine($"Caddy SHA-256 leaf pin {proxy.Fingerprint}, HTTP/2 on {proxy.Client.BaseAddress}");
                await check(proxy.Client);
            }

            Task Withheld() => WithServer(async client =>
            {
                await Read(client, route, HttpStatusCode.ServiceUnavailable);
                await Read(client, Prefix + "/head.json", HttpStatusCode.ServiceUnavailable);
                await Read(client, Latest, HttpStatusCode.ServiceUnavailable);
                if (viaCaddy)
                {
                    using var ready = await client.GetAsync("/health/ready", ct);
                    Assert.Equal(HttpStatusCode.NoContent, ready.StatusCode);
                }
            });

            async Task Install(JsonNode archive)
            {
                var content = JsonSerializer.SerializeToUtf8Bytes(archive);
                var pending = path + ".prepared";
                await File.WriteAllBytesAsync(pending, content, ct);
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(pending, UnixFileMode.UserRead);
                File.Move(pending, path, overwrite: true);
                config[Settings + "Sha256"] = Hex(SHA256.HashData(content));
            }

            object ProvideKey(string id, int version, ECDsa key, DateTimeOffset from, DateTimeOffset until, DateTimeOffset? revoked = null)
            {
                var prefix = Keys + id + "__";
                var spki = key.ExportSubjectPublicKeyInfo();
                var material = WebEncoders.Base64UrlEncode(spki);
                PublicationFixture.ConfigureKey(config, id, version.ToString(CultureInfo.InvariantCulture), spki, Time(from), Time(until));
                if (revoked is { } at) config[prefix + "RevokedAtUtc"] = Time(at);
                return new { keyId = id, keyVersion = version, keySha256 = Hex(SHA256.HashData(spki)), publicKey = material,
                    notBeforeUtc = Time(from), notAfterUtc = Time(until), revokedAtUtc = revoked is { } mark ? Time(mark) : null,
                    compromisedAtUtc = (string?)null };
            }

            async Task IndependentlyVerify(string bundle, string witness, string date, params object[] keys)
            {
                var keyPath = Path.Combine(scratch.FullName, "keys.json");
                var headPath = Path.Combine(scratch.FullName, "head.json");
                var bundlePath = Path.Combine(scratch.FullName, "public-day.json");
                await File.WriteAllTextAsync(keyPath, JsonSerializer.Serialize(new { manifestVersion = 2, kind = "native-publication-proof-keys",
                    algorithm = ArticlePublicationProofPayloadV2.Algorithm, keys }), ct);
                await File.WriteAllTextAsync(headPath, witness, ct);
                await File.WriteAllTextAsync(bundlePath, bundle, ct);
                var tool = PublicationFixture.Tool("verify-publication-checkpoint.mjs");
                var result = await FixtureProcess.Run(
                    FixtureProcess.Command("node", tool, origin, keyPath, headPath, bundlePath, "--daily", date), ct);
                Assert.True(result.Code == 0, result.Error);
                Assert.Equal(date, JsonNode.Parse(result.Output)!["scopeKey"]!.GetValue<string>());
            }

            async Task<string> Read(HttpClient client, string target, HttpStatusCode expected,
                string? host = null, string transport = "https")
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, target);
                if (!viaCaddy) PublicationFixture.Forward(request, host ?? address.Authority, transport);
                else
                {
                    request.Version = HttpVersion.Version20;
                    request.VersionPolicy = HttpVersionPolicy.RequestVersionExact;
                }
                using var response = await client.SendAsync(request, ct);
                Assert.Equal(expected, response.StatusCode);
                if (viaCaddy)
                {
                    Assert.Equal(HttpVersion.Version20, response.Version);
                    Assert.False(response.Headers.Contains("Set-Cookie"));
                    if (expected == HttpStatusCode.OK)
                        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
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
    private static string Sign(ECDsa key, byte[] bytes) => WebEncoders.Base64UrlEncode(
        key.SignData(bytes, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
}
