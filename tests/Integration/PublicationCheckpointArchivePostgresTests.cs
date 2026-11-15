using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using FsusBlog.V2.Contracts;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationCheckpointArchivePostgresTests
{
    private const string Host = "checkpoints.example.test";
    private const string Origin = "https://" + Host;
    private const string Prefix = "/integrity/v2/checkpoints";
    private const string Settings = "IntegrityProof__CheckpointArchive__";
    private const string Keys = "IntegrityProof__Signing__Keys__";

    [PostgresFact]
    public async Task ServesOnlyPinnedClosedDayWithSeparateKeyRegistryAndCurrentArchiveAncestor()
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
            var path = Path.Combine(scratch.FullName, "archive.json");
            var config = new Dictionary<string, string>
            {
                ["FSUSBLOG_PUBLIC_ORIGIN"] = Origin,
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
            var head = new PublicationTransparencyHeadV2(Origin, 3, headDigest, "old", 1,
                SHA256.HashData(retired.ExportSubjectPublicKeyInfo()), headTime);
            var dayReceipt = new PublicationCheckpointV2(Origin, day, 0, 0, 0, PublicationCheckpointTreeV2.EmptyDailyRoot(), 3, headDigest,
                "next", 2, SHA256.HashData(current.ExportSubjectPublicKeyInfo()), signedAt, PublicationCheckpointKind.Daily);
            var signedHead = JsonSerializer.SerializeToNode(new
            {
                headVersion = 2, kind = "native-publication-log-head", algorithm = ArticlePublicationProofPayloadV2.Algorithm, origin = Origin,
                sequence = "3", entrySha256 = Hex(headDigest), keyId = "old", keyVersion = 1, keySha256 = Hex(head.KeySha256),
                attestedAtUtc = Time(headTime), signature = Sign(retired, head.Payload()),
            })!;
            var signedDay = JsonSerializer.SerializeToNode(new
            {
                checkpointVersion = 2, kind = "native-publication-checkpoint", checkpointKind = "daily", algorithm = ArticlePublicationProofPayloadV2.Algorithm,
                origin = Origin, scopeKey = day, fromSequence = "0", toSequence = "0", entryCount = 0, rootSha256 = Hex(dayReceipt.RootSha256),
                headSequence = "3", headEntrySha256 = Hex(headDigest), keyId = "next", keyVersion = 2, keySha256 = Hex(dayReceipt.KeySha256),
                attestedAtUtc = Time(signedAt), signature = Sign(current, dayReceipt.Payload()),
            })!;
            var archived = new JsonObject
            {
                ["archiveVersion"] = 2, ["head"] = signedHead.DeepClone(),
                ["bridgeReceiptSha256"] = new JsonArray(JsonValue.Create(Hex(receipt))),
                ["checkpoints"] = new JsonArray(signedDay.DeepClone()),
            };
            await Install(archived);
            var validPin = "4:" + Hex(PublicationTransparencyV2.EntryDigest(4, headDigest, receipt));
            config[Settings + "CurrentAnchor"] = validPin;
            var route = $"{Prefix}/daily/{day}.json";
            await using (var server = await Start()) await Read(server, route, HttpStatusCode.NotFound);
            config[Settings + "Enabled"] = "true";
            await using (var server = await Start())
            {
                var servedDay = await Read(server, route, HttpStatusCode.OK);
                var servedHead = await Read(server, Prefix + "/head.json", HttpStatusCode.OK);
                Assert.True(JsonNode.DeepEquals(signedHead, JsonNode.Parse(servedHead)));
                var publicBundle = JsonNode.Parse(servedDay)!.AsObject();
                Assert.Equal(2, publicBundle.Count);
                Assert.Null(publicBundle["inclusion"]);
                Assert.True(JsonNode.DeepEquals(signedDay, publicBundle["checkpoint"]));
                Assert.DoesNotContain(Hex(receipt), servedDay);
                Assert.DoesNotContain(Hex(receipt), servedHead);
                await Read(server, Prefix + "/daily/2020-01-01.json", HttpStatusCode.NotFound);
                await Read(server, Prefix + "/daily/2026-02-30.json", HttpStatusCode.BadRequest);
                await Read(server, route, HttpStatusCode.NotFound, "another.example.test");
                await Read(server, route, HttpStatusCode.Forbidden, transport: "http");
                await Read(server, "/integrity/v2/keys.json", HttpStatusCode.NotFound);
                await IndependentlyVerify(servedDay, servedHead, day, oldKey, nextKey);
            }

            var matchingHead = archived.DeepClone();
            matchingHead["bridgeReceiptSha256"] = new JsonArray();
            await Install(matchingHead);
            config[Settings + "CurrentAnchor"] = "3:" + Hex(headDigest);
            await using (var server = await Start()) await Read(server, route, HttpStatusCode.OK);
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

            Task<ServerProcess> Start() => ServerProcess.Start(fixture.ConnectionString, ct, config, request => Forward(request));

            async Task Withheld()
            {
                await using var server = await Start();
                await Read(server, route, HttpStatusCode.ServiceUnavailable);
                await Read(server, Prefix + "/head.json", HttpStatusCode.ServiceUnavailable);
            }

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
                config[prefix + "Version"] = version.ToString(CultureInfo.InvariantCulture);
                config[prefix + "Algorithm"] = ArticlePublicationProofPayloadV2.Algorithm;
                config[prefix + "PublicKey"] = material;
                config[prefix + "NotBeforeUtc"] = Time(from);
                config[prefix + "NotAfterUtc"] = Time(until);
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
                var tool = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../tools/verify-publication-checkpoint.mjs"));
                var start = new ProcessStartInfo("node")
                {
                    UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
                    ArgumentList = { tool, Origin, keyPath, headPath, bundlePath, "--daily", date },
                };
                using var process = Process.Start(start)!;
                var stderr = process.StandardError.ReadToEndAsync(ct);
                var stdout = process.StandardOutput.ReadToEndAsync(ct);
                await process.WaitForExitAsync(ct);
                Assert.True(process.ExitCode == 0, await stderr);
                Assert.Equal(date, JsonNode.Parse(await stdout)!["scopeKey"]!.GetValue<string>());
            }

            async Task<string> Read(ServerProcess server, string target, HttpStatusCode expected,
                string host = Host, string transport = "https")
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, target);
                Forward(request, host, transport);
                using var response = await server.Client.SendAsync(request, ct);
                Assert.Equal(expected, response.StatusCode);
                if (target.StartsWith(Prefix, StringComparison.Ordinal)) Assert.True(response.Headers.CacheControl?.NoStore);
                return await response.Content.ReadAsStringAsync(ct);
            }
        }
        finally { scratch.Delete(recursive: true); }
    }

    private static void Forward(HttpRequestMessage request, string host = Host, string transport = "https")
    {
        request.Headers.Host = host;
        request.Headers.Add("X-Forwarded-For", "127.0.0.1");
        request.Headers.Add("X-Forwarded-Proto", transport);
    }

    private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);
    private static string Time(DateTimeOffset time) => ArticlePublicationProofPayloadV2.Time(time);
    private static string Sign(ECDsa key, byte[] bytes) => WebEncoders.Base64UrlEncode(
        key.SignData(bytes, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
}
