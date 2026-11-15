using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationProofPostgresTests
{
    private const string Origin = "https://proof.example.test";
    private const string Registry = "/integrity/v2/keys.json";
    private const string Settings = "IntegrityProof__Signing__";

    [PostgresFact]
    public async Task OnlyLivePublicationsAreSignedAndOldSignaturesSurviveRotationButNotCompromise()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var actor = Guid.NewGuid();
        var ticket = RandomNumberGenerator.GetBytes(32);
        await using (var owner = Store.Sql(db, null, "insert into public.blog_user values($1,'Proof author',true,true,1)", actor))
            await owner.ExecuteNonQueryAsync(ct);
        await using (var auth = Store.Sql(db, null, "insert into public.login_ticket values($1,$2,now()+interval '5 minutes')", SHA256.HashData(ticket), actor))
            await auth.ExecuteNonQueryAsync(ct);
        var (session, _) = await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(ticket), ct);
        using var previous = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var next = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var parent = OperatingSystem.IsMacOS() ? "/private/tmp" : "/tmp";
        var scratch = Directory.CreateDirectory(Path.Combine(parent, "fsus-proof-" + Guid.NewGuid().ToString("N")));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(scratch.FullName,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        try
        {
            var aPath = KeyFile("a.pkcs8", previous);
            var bPath = KeyFile("b.pkcs8", next);
            var settings = new Dictionary<string, string>
            {
                ["FSUSBLOG_PUBLIC_ORIGIN"] = Origin, ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true",
                [Settings + "NativeV2Enabled"] = "true", [Settings + "CurrentKeyId"] = "a",
                [Settings + "NativeV2PrivateKeyFile"] = aPath,
            };
            AddKey("a", 1, previous);
            settings[Settings + "NativeV2PrivateKeyFile"] = bPath;
            var wrongKey = await Assert.ThrowsAsync<InvalidOperationException>(async () => { await using var _ = await Start(); });
            Assert.Contains("Invalid native publication signing configuration or private key.", wrongKey.Message);
            Assert.DoesNotContain(bPath, wrongKey.Message);
            settings[Settings + "NativeV2PrivateKeyFile"] = aPath;
            Draft first;
            string firstUrl;
            string firstProof;
            await using (var server = await Start())
            {
                var draft = await Edit(server, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Évidence", "Frozen body 🐈\n"));
                Assert.Equal("0", (await Scalar("select count(*) from public.article_publication_proof"))?.ToString());
                first = await Edit(server, WireRoutes.Publish, new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""));
                firstUrl = await PathOf(first);
                firstProof = await WaitProof(server, firstUrl);
                await VerifyIndependently(server, firstProof);
                var originalSignature = (byte[])(await Scalar("select signature from public.article_publication_proof"))!;
                await Scalar("update public.article_publication_proof set signature=$1", new byte[64]);
                using (var tampered = await Send(server, HttpMethod.Get, firstUrl))
                    Assert.Equal(HttpStatusCode.NotFound, tampered.StatusCode);
                await Scalar("update public.article_publication_proof set signature=$1", originalSignature);
                using var wrongHost = await Send(server, HttpMethod.Get, firstUrl, "other.example.test");
                Assert.Equal(HttpStatusCode.NotFound, wrongHost.StatusCode);
                using var nonexistent = await Send(server, HttpMethod.Get, firstUrl.Replace("/rights.json", "000/rights.json", StringComparison.Ordinal));
                Assert.Equal(HttpStatusCode.NotFound, nonexistent.StatusCode);
                await Edit(server, WireRoutes.Save, new(first.Id, first.Revision, Guid.NewGuid(), "Private revision", "New unpublished body"));
                Assert.Equal(firstProof, await WaitProof(server, firstUrl));
            }

            File.Delete(aPath);
            var oldIssued = DateTimeOffset.Parse(JsonNode.Parse(firstProof)!["issuedAtUtc"]!.GetValue<string>(),
                System.Globalization.CultureInfo.InvariantCulture);
            settings[Settings + "Keys__a__RevokedAtUtc"] = ArticlePublicationProofPayloadV2.Time(oldIssued.AddSeconds(1));
            settings[Settings + "CurrentKeyId"] = "b";
            settings[Settings + "NativeV2PrivateKeyFile"] = bPath;
            AddKey("b", 2, next);
            Draft second;
            string secondUrl;
            await using (var server = await Start())
            {
                Assert.Equal(firstProof, await WaitProof(server, firstUrl));
                await VerifyIndependently(server, firstProof);
                var draft = await Edit(server, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Second", "New signing key"));
                second = await Edit(server, WireRoutes.Publish, new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""));
                secondUrl = await PathOf(second);
                var signed = await WaitProof(server, secondUrl);
                Assert.Equal("b", JsonNode.Parse(signed)!["keyId"]!.GetValue<string>());
                await VerifyIndependently(server, signed);
                var previousUrl = secondUrl;
                var successor = await Edit(server, WireRoutes.Save, new(second.Id, second.Revision, Guid.NewGuid(), "Replacement", "New release"));
                second = await Edit(server, WireRoutes.Publish, new(second.Id, successor.Revision, Guid.NewGuid(), "", ""));
                secondUrl = await PathOf(second);
                using (var replaced = await Send(server, HttpMethod.Get, previousUrl))
                    Assert.Equal(HttpStatusCode.NotFound, replaced.StatusCode);
                await VerifyIndependently(server, await WaitProof(server, secondUrl));
                var denied = await Edit(server, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Do not sign", "Visible without proof"));
                var policy = new ArticleRightsCommand(denied.Id, denied.Revision, Guid.NewGuid(), true, "CC0-1.0", "", 0, "", "", "disabled", 0, false, false, false);
                using var updated = await Send(server, HttpMethod.Post, WireRoutes.DraftRightsCommand, body: Wire.EncodeArticleRightsCommand(policy));
                Assert.Equal(HttpStatusCode.OK, updated.StatusCode);
                var revision = Wire.DecodeArticleRightsPolicy(await updated.Content.ReadAsByteArrayAsync(ct)).Revision;
                var visible = await Edit(server, WireRoutes.Publish, new(denied.Id, revision, Guid.NewGuid(), "", ""));
                using var notSigned = await Send(server, HttpMethod.Get, await PathOf(visible));
                Assert.Equal(HttpStatusCode.NotFound, notSigned.StatusCode);
            }

            var compromise = Settings + "Keys__a__CompromisedAtUtc";
            settings[compromise] = "2026-11-15T00:00:00.000000Z";
            await using (var server = await Start())
            {
                using var old = await Send(server, HttpMethod.Get, firstUrl);
                Assert.Equal(HttpStatusCode.NotFound, old.StatusCode);
                await VerifyIndependently(server, firstProof, success: false);
                await VerifyIndependently(server, await WaitProof(server, secondUrl));
                await Edit(server, WireRoutes.Retract, new(second.Id, second.Revision, Guid.NewGuid(), "", ""));
                using var withdrawn = await Send(server, HttpMethod.Get, secondUrl);
                Assert.Equal(HttpStatusCode.NotFound, withdrawn.StatusCode);
                Assert.Equal("3", (await Scalar("select count(*) from public.article_publication_proof"))?.ToString());
                Assert.True((bool)(await Scalar("""
                    select pg_terminate_backend(l.pid, 5000) from pg_locks l
                    where l.database=(select oid from pg_database where datname=current_database())
                      and l.locktype='advisory' and l.mode='ExclusiveLock' and l.granted and l.objsubid=1
                      and ((l.classid::bigint << 32) | l.objid::bigint)=$1
                    """, FsusBlogV2.Storage.PublicationLocks.Ownership))!);
                for (var attempt = 0; ; attempt++)
                {
                    using var unavailable = await Send(server, HttpMethod.Get, Registry);
                    if (unavailable.StatusCode == HttpStatusCode.ServiceUnavailable) break;
                    Assert.InRange(attempt, 0, 30);
                    await Task.Delay(50, ct);
                }
            }
            settings.Remove(compromise);
            var rejected = await Assert.ThrowsAsync<InvalidOperationException>(async () => { await using var _ = await Start(); });
            Assert.Contains("cannot be rebound or unrevoked", rejected.Message);

            void AddKey(string id, int version, ECDsa key)
            {
                var prefix = Settings + "Keys__" + id + "__";
                settings[prefix + "Algorithm"] = "ECDSA_P256_SHA256";
                settings[prefix + "Version"] = version.ToString(System.Globalization.CultureInfo.InvariantCulture);
                settings[prefix + "PublicKey"] = WebEncoders.Base64UrlEncode(key.ExportSubjectPublicKeyInfo());
                settings[prefix + "NotBeforeUtc"] = "2020-01-01T00:00:00.000000Z";
                settings[prefix + "NotAfterUtc"] = "2099-01-01T00:00:00.000000Z";
            }

            Task<ServerProcess> Start() => ServerProcess.Start(fixture.ConnectionString, ct, settings, Forward);
            async Task<string> PathOf(Draft draft) => $"/integrity/v2/article/{draft.Id}/{await Scalar("select publication_id from public.article_publication where article_id=$1", draft.Id)}/rights.json";

            async Task<Draft> Edit(ServerProcess server, string route, ArticleCommand input)
            {
                using var response = await Send(server, HttpMethod.Post, route, body: Wire.EncodeArticleCommand(input));
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
            }

            async Task<HttpResponseMessage> Send(ServerProcess server, HttpMethod method, string url,
                string host = "proof.example.test", byte[]? body = null)
            {
                using var request = new HttpRequestMessage(method, url);
                Forward(request);
                request.Headers.Host = host;
                if (body is not null)
                {
                    request.Headers.Add("Cookie", "fsus-v2-session=" + session);
                    request.Content = new ByteArrayContent(body);
                    request.Content.Headers.ContentType = new(Aeds.ContentType);
                }
                var response = await server.Client.SendAsync(request, ct);
                if (url.StartsWith("/integrity/v2", StringComparison.Ordinal))
                    Assert.True(response.Headers.CacheControl?.NoStore);
                return response;
            }

            async Task<string> WaitProof(ServerProcess server, string path)
            {
                for (var attempt = 0; attempt < 80; attempt++)
                {
                    using var response = await Send(server, HttpMethod.Get, path);
                    if (response.StatusCode == HttpStatusCode.OK) return await response.Content.ReadAsStringAsync(ct);
                    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
                    await Task.Delay(100, ct);
                }
                throw new InvalidOperationException("The committed public proof did not become available.");
            }

            async Task VerifyIndependently(ServerProcess server, string proof, bool success = true)
            {
                using var response = await Send(server, HttpMethod.Get, Registry);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                var proofPath = Path.Combine(scratch.FullName, "proof.json");
                var keysPath = Path.Combine(scratch.FullName, "keys.json");
                await File.WriteAllTextAsync(proofPath, proof, ct);
                await File.WriteAllTextAsync(keysPath, await response.Content.ReadAsStringAsync(ct), ct);
                await VerifyTool(proofPath, keysPath, success);
                if (!success) return;
                var changed = JsonNode.Parse(proof)!;
                changed["publicationOutboxId"] = "9876543210";
                await File.WriteAllTextAsync(proofPath, changed.ToJsonString(), ct);
                await VerifyTool(proofPath, keysPath, false);
            }

            async Task VerifyTool(string proof, string keys, bool success)
            {
                var tool = FindVerifier();
                using var process = Process.Start(new ProcessStartInfo("node")
                {
                    ArgumentList = { tool, Origin, keys, proof }, RedirectStandardOutput = true, RedirectStandardError = true,
                    UseShellExecute = false,
                })!;
                await process.WaitForExitAsync(ct);
                var reason = await process.StandardError.ReadToEndAsync(ct);
                Assert.True((process.ExitCode == 0) == success, reason);
            }
        }
        finally { scratch.Delete(recursive: true); }

        string KeyFile(string basename, ECDsa key)
        {
            var path = Path.Combine(scratch.FullName, basename);
            var der = key.ExportPkcs8PrivateKey();
            try { File.WriteAllBytes(path, der); }
            finally { CryptographicOperations.ZeroMemory(der); }
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead);
            return path;
        }
        async Task<object?> Scalar(string sql, params object[] args)
        {
            await using var command = Store.Sql(db, null, sql, args);
            return await command.ExecuteScalarAsync(ct);
        }
    }

    private static void Forward(HttpRequestMessage request)
    {
        request.Headers.Host = "proof.example.test";
        request.Headers.Add("X-Forwarded-For", "127.0.0.1");
        request.Headers.Add("X-Forwarded-Proto", "https");
    }

    private static string FindVerifier()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var path = Path.Combine(dir.FullName, "tools", "verify-publication-proof.mjs");
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException("Native publication proof verifier was not found.");
    }
}
