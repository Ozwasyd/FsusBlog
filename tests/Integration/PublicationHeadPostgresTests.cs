using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationHeadPostgresTests
{
    private const string Host = "head.example.test";
    private const string Origin = "https://" + Host;
    private const string Head = "/integrity/v2/log/head.json";
    private const string Registry = "/integrity/v2/keys.json";
    private const string Settings = "IntegrityProof__Signing__";
    private const string Anchor = Settings + "NativeV2PublicHeadAnchor";

    [PublicationTransparencyFact]
    public async Task ServesOnlyOriginalOpaqueHeadForTheAnchoredExactCommittedTail()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await Scalar("drop table public.publication_transparency_head");
        await Scalar("alter table public.article_publication_transparency drop constraint publication_transparency_exact_head");
        await Migrate("head-schema");
        await Migrate("head-schema");
        await Migrate("enable");

        var owner = Guid.NewGuid();
        var ticket = RandomNumberGenerator.GetBytes(32);
        await Scalar("insert into public.blog_user values($1,'Public head fixture',true,true,1)", owner);
        await Scalar("insert into public.login_ticket values($1,$2,now()+interval '5 minutes')", SHA256.HashData(ticket), owner);
        var (session, _) = await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(ticket), ct);
        var parent = OperatingSystem.IsMacOS() ? "/private/tmp" : "/tmp";
        var scratch = Directory.CreateDirectory(Path.Combine(parent, $"fsus-head-{Guid.NewGuid():N}"));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(scratch.FullName,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        using var currentKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var nextKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        try
        {
            var currentPath = PrivateFile("current.pkcs8", currentKey);
            var nextPath = PrivateFile("next.pkcs8", nextKey);
            var config = new Dictionary<string, string>
            {
                ["FSUSBLOG_PUBLIC_ORIGIN"] = Origin,
                ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true",
                [Settings + "NativeV2Enabled"] = "true",
                [Settings + "CurrentKeyId"] = "first",
                [Settings + "NativeV2PrivateKeyFile"] = currentPath,
            };
            SetKey("first", 1, currentKey);
            SetKey("next", 2, nextKey);
            await using (var server = await Start()) await Status(server, HttpStatusCode.NotFound);

            config[Anchor] = "genesis";
            string firstPin;
            string retained;
            DateTime attestedAt;
            await using (var server = await Start())
            {
                await Status(server, HttpStatusCode.NotFound);
                var release = await Publish(server, "First retained content");
                var first = await WaitForHead(server, "1");
                firstPin = "1:" + JsonNode.Parse(first)!["entrySha256"]!.GetValue<string>();
                first = await VerifyIndependently(server, first);
                await Scalar("create temporary table first_head as table public.publication_transparency_head");
                var proofUrl = await ProofPath(release.Id);
                using (var proof = await Send(server, HttpMethod.Get, proofUrl))
                {
                    proof.EnsureSuccessStatusCode();
                    Assert.NotEqual(JsonNode.Parse(first)!["signature"]!.GetValue<string>(),
                        JsonNode.Parse(await proof.Content.ReadAsStringAsync(ct))!["signature"]!.GetValue<string>());
                }
                await Edit(server, WireRoutes.Retract, release.Id, release.Revision);
                using (var privateProof = await Send(server, HttpMethod.Get, proofUrl))
                    Assert.Equal(HttpStatusCode.NotFound, privateProof.StatusCode);
                Assert.Equal(first, await WaitForHead(server, "1"));
                await Status(server, HttpStatusCode.NotFound, "wrong.example.test");
                await Status(server, HttpStatusCode.Forbidden, Host, "http");

                // The sequence witnesses a real head INSERT that fails after the proof and ledger inserts.
                await Scalar("create sequence public.head_fixture_attempt");
                await Scalar("""
                    alter table public.publication_transparency_head add constraint head_fixture_fail
                    check (nextval('public.head_fixture_attempt')=0) not valid
                    """);
                await Publish(server, "Second retained content");
                for (var attempt = 0; await Scalar("select is_called from public.head_fixture_attempt") is not true; attempt++)
                {
                    Assert.InRange(attempt, 0, 100);
                    await Task.Delay(100, ct);
                }
                Assert.Equal(1L, await Scalar("select count(*) from public.article_publication_proof"));
                Assert.Equal(1L, await Scalar("select count(*) from public.article_publication_transparency"));
                Assert.Equal(first, await WaitForHead(server, "1"));
                await Scalar("alter table public.publication_transparency_head drop constraint head_fixture_fail");
                await Scalar("drop sequence public.head_fixture_attempt");
                retained = await VerifyIndependently(server, await WaitForHead(server, "2"));
                attestedAt = (DateTime)(await Scalar("select attested_at from public.publication_transparency_head"))!;
            }

            await Scalar("create temporary table latest_head as table public.publication_transparency_head");
            await using (var server = await Start()) await Status(server, HttpStatusCode.ServiceUnavailable);

            config[Anchor] = firstPin;
            await Scalar("delete from public.publication_transparency_head");
            await Scalar("insert into public.publication_transparency_head select * from pg_temp.first_head");
            await using (var server = await Start()) await Status(server, HttpStatusCode.ServiceUnavailable);
            await Scalar("delete from public.publication_transparency_head");
            await Scalar("insert into public.publication_transparency_head select * from pg_temp.latest_head");
            await Scalar("update public.article_publication_transparency set prev_sha256=decode(repeat('00',32),'hex') where seq=2");
            await using (var server = await Start()) await Status(server, HttpStatusCode.ServiceUnavailable);
            await Scalar("""
                update public.article_publication_transparency b set prev_sha256=a.entry_sha256
                from public.article_publication_transparency a where a.seq=1 and b.seq=2
                """);
            File.Delete(currentPath);
            config[Settings + "CurrentKeyId"] = "next";
            config[Settings + "NativeV2PrivateKeyFile"] = nextPath;
            config[Settings + "Keys__first__RevokedAtUtc"] = ArticlePublicationProofPayloadV2.Time(attestedAt.AddTicks(10));
            await using (var server = await Start())
            {
                Assert.Equal(retained, await VerifyIndependently(server, await WaitForHead(server, "2")));
                await Scalar("""
                    select pg_terminate_backend(l.pid) from pg_locks l
                    where l.database=(select oid from pg_database where datname=current_database())
                      and l.locktype='advisory' and l.mode='ExclusiveLock' and l.granted and l.objsubid=1
                      and ((l.classid::bigint << 32) | l.objid::bigint)=$1
                    """, FsusBlogV2.Storage.PublicationLocks.Ownership);
                for (var attempt = 0; ; attempt++)
                {
                    using var denied = await Send(server, HttpMethod.Get, Head);
                    if (denied.StatusCode == HttpStatusCode.ServiceUnavailable) break;
                    Assert.InRange(attempt, 0, 40);
                    await Task.Delay(50, ct);
                }
            }
            config[Settings + "Keys__first__CompromisedAtUtc"] = ArticlePublicationProofPayloadV2.Time(attestedAt);
            await using (var server = await Start())
            {
                await Status(server, HttpStatusCode.ServiceUnavailable);
                var next = await Publish(server, "Native proof survives optional head refusal");
                var proofUrl = await ProofPath(next.Id);
                for (var attempt = 0; ; attempt++)
                {
                    using var proof = await Send(server, HttpMethod.Get, proofUrl);
                    if (proof.IsSuccessStatusCode) break;
                    Assert.InRange(attempt, 0, 100);
                    await Task.Delay(100, ct);
                }
                Assert.Equal(3L, await Scalar("select max(seq) from public.article_publication_transparency"));
                Assert.Equal(2L, await Scalar("select seq from public.publication_transparency_head"));
                await Status(server, HttpStatusCode.ServiceUnavailable);
            }

            Task<ServerProcess> Start() => ServerProcess.Start(fixture.ConnectionString, ct, config, Forward);

            void SetKey(string id, int version, ECDsa value)
            {
                var prefix = Settings + "Keys__" + id + "__";
                config[prefix + "Version"] = version.ToString(System.Globalization.CultureInfo.InvariantCulture);
                config[prefix + "Algorithm"] = "ECDSA_P256_SHA256";
                config[prefix + "PublicKey"] = WebEncoders.Base64UrlEncode(value.ExportSubjectPublicKeyInfo());
                config[prefix + "NotBeforeUtc"] = "2020-01-01T00:00:00.000000Z";
                config[prefix + "NotAfterUtc"] = "2099-01-01T00:00:00.000000Z";
            }

            async Task<HttpResponseMessage> Send(ServerProcess server, HttpMethod method, string url, byte[]? body = null,
                string host = Host, string scheme = "https")
            {
                using var request = new HttpRequestMessage(method, url);
                request.Headers.Host = host;
                request.Headers.Add("X-Forwarded-For", "127.0.0.1");
                request.Headers.Add("X-Forwarded-Proto", scheme);
                if (body is not null)
                {
                    request.Headers.Add("Cookie", "fsus-v2-session=" + session);
                    request.Content = new ByteArrayContent(body);
                    request.Content.Headers.ContentType = new(Aeds.ContentType);
                }
                var response = await server.Client.SendAsync(request, ct);
                if (url == Head && config.ContainsKey(Anchor)) Assert.True(response.Headers.CacheControl?.NoStore);
                return response;
            }

            async Task Status(ServerProcess server, HttpStatusCode code, string host = Host, string scheme = "https")
            {
                using var response = await Send(server, HttpMethod.Get, Head, host: host, scheme: scheme);
                Assert.Equal(code, response.StatusCode);
            }

            async Task<string> WaitForHead(ServerProcess server, string sequence)
            {
                for (var attempt = 0; ; attempt++)
                {
                    using var response = await Send(server, HttpMethod.Get, Head);
                    if (response.IsSuccessStatusCode)
                    {
                        var body = await response.Content.ReadAsStringAsync(ct);
                        if (JsonNode.Parse(body)!["sequence"]!.GetValue<string>() == sequence) return body;
                    }
                    Assert.InRange(attempt, 0, 100);
                    await Task.Delay(100, ct);
                }
            }

            async Task<string> VerifyIndependently(ServerProcess server, string head)
            {
                using var registry = await Send(server, HttpMethod.Get, Registry);
                registry.EnsureSuccessStatusCode();
                var keyFile = Path.Combine(scratch.FullName, "keys.json");
                var headFile = Path.Combine(scratch.FullName, "head.json");
                await File.WriteAllTextAsync(keyFile, await registry.Content.ReadAsStringAsync(ct), ct);
                await File.WriteAllTextAsync(headFile, head, ct);
                for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
                {
                    var tool = Path.Combine(dir.FullName, "tools", "verify-publication-head.mjs");
                    if (!File.Exists(tool)) continue;
                    await Run(new("node") { ArgumentList = { tool, Origin, keyFile, headFile } });
                    return head;
                }
                throw new FileNotFoundException("Native publication head verifier was not found.");
            }

            async Task<Draft> Publish(ServerProcess server, string body)
            {
                var draft = await Edit(server, WireRoutes.Save, 0, 0, "Public anchor fixture", body);
                return await Edit(server, WireRoutes.Publish, draft.Id, draft.Revision);
            }

            async Task<Draft> Edit(ServerProcess server, string action, int article, long revision, string title = "", string body = "")
            {
                using var response = await Send(server, HttpMethod.Post, action,
                    Wire.EncodeArticleCommand(new(article, revision, Guid.NewGuid(), title, body)));
                response.EnsureSuccessStatusCode();
                return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
            }
        }
        finally { scratch.Delete(recursive: true); }

        string PrivateFile(string name, ECDsa key)
        {
            var path = Path.Combine(scratch.FullName, name);
            var bytes = key.ExportPkcs8PrivateKey();
            try { File.WriteAllBytes(path, bytes); }
            finally { CryptographicOperations.ZeroMemory(bytes); }
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead);
            return path;
        }

        async Task<string> ProofPath(int article) => $"/integrity/v2/article/{article}/{await Scalar(
            "select publication_id from public.article_publication where article_id=$1", article)}/rights.json";
        async Task<object?> Scalar(string sql, params object[] args)
        {
            await using var command = Store.Sql(db, null, sql, args);
            return await command.ExecuteScalarAsync(ct);
        }

        Task Migrate(string operation)
        {
            var options = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_BIN") ?? "dotnet")
            {
                ArgumentList = { Environment.GetEnvironmentVariable(PublicationTransparencyFact.MigrationPath)!, "publication-transparency", operation },
            };
            options.Environment["FSUSBLOG_DB"] = fixture.ConnectionString;
            return Run(options);
        }

        async Task Run(ProcessStartInfo options)
        {
            options.UseShellExecute = false;
            options.RedirectStandardOutput = true;
            options.RedirectStandardError = true;
            using var process = Process.Start(options)!;
            var output = process.StandardOutput.ReadToEndAsync(ct);
            var error = process.StandardError.ReadToEndAsync(ct);
            await process.WaitForExitAsync(ct);
            Assert.True(process.ExitCode == 0, (await error) + (await output));
        }
    }

    private static void Forward(HttpRequestMessage request)
    {
        request.Headers.Host = Host;
        request.Headers.Add("X-Forwarded-For", "127.0.0.1");
        request.Headers.Add("X-Forwarded-Proto", "https");
    }
}
