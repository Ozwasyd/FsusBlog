using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationTransparencyPostgresTests
{
    private const string Host = "proof.example.test";
    private const string Origin = "https://" + Host;
    private const string Settings = "IntegrityProof__Signing__";

    [PublicationTransparencyFact]
    public async Task IssuesAndVerifiesAnAtomicDenseLedgerWithIndependentPrefixAndKeyState()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await RemoveLedgerSchema();
        Succeeded(await Migrate("enable"));
        Succeeded(await Migrate("enable"));
        var owner = Guid.NewGuid();
        var ticket = RandomNumberGenerator.GetBytes(32);
        await Scalar("insert into public.blog_user values($1,'Ledger author',true,true,1)", owner);
        await Scalar("insert into public.login_ticket values($1,$2,now()+interval '5 minutes')", SHA256.HashData(ticket), owner);
        var (session, _) = await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(ticket), ct);
        var parent = OperatingSystem.IsMacOS() ? "/private/tmp" : "/tmp";
        var scratch = Directory.CreateDirectory(Path.Combine(parent, $"fsus-transparency-{Guid.NewGuid():N}"));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(scratch.FullName,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        using var old = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var next = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var path = Path.Combine(scratch.FullName, "registry.json");
        try
        {
            var oldPath = KeyFile("old.pkcs8", old);
            var nextPath = KeyFile("next.pkcs8", next);
            var config = new Dictionary<string, string>
            {
                ["FSUSBLOG_PUBLIC_ORIGIN"] = Origin, ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true",
                [Settings + "NativeV2Enabled"] = "true", [Settings + "CurrentKeyId"] = "old",
                [Settings + "NativeV2PrivateKeyFile"] = oldPath,
            };
            AddKey("old", "1", old);
            AddKey("next", "2", next);
            string firstPin;
            DateTime lastOld;
            await using (var server = await Start())
            {
                Denied(await Migrate("enable"), "Stop the serving process");
                await Registry(server);
                Assert.Equal("0", Succeeded(await Audit())["sequence"]!.GetValue<string>());
                Denied(await Audit("0", new string('0', 64)), "positive prefix sequence");
                var first = await Publish(server);
                var firstUrl = await ProofPath(first.Id);
                await Wait("select count(*)=1 from public.article_publication_transparency");
                using (var current = await Send(server, HttpMethod.Get, firstUrl)) Assert.Equal(HttpStatusCode.OK, current.StatusCode);
                var anchor = Succeeded(await Audit());
                firstPin = anchor["entrySha256"]!.GetValue<string>();
                Assert.Equal(1, anchor["trustedSignatures"]!.GetValue<int>());

                // The sequence witnesses a real attempted write even when the signer transaction is rolled back.
                await Scalar("create sequence public.transparency_fixture_attempt");
                await Scalar("""
                    alter table public.article_publication_transparency add constraint transparency_fixture_fail
                    check (nextval('public.transparency_fixture_attempt')=0) not valid
                    """);
                var successor = await Publish(server, first);
                var successorUrl = await ProofPath(successor.Id);
                await Wait("select is_called from public.transparency_fixture_attempt");
                Assert.Equal(1L, await Scalar("select count(*) from public.article_publication_proof"));
                Assert.Equal(1L, await Scalar("select count(*) from public.article_publication_transparency"));
                var oldWriter = await Assert.ThrowsAsync<PostgresException>(() => Scalar("""
                    insert into public.article_publication_proof(publication_id,origin,key_id,key_version,key_sha256,issued_at,signature)
                    select (select max(publication_id) from public.article_publication_canonical),
                           origin,key_id,key_version,key_sha256,issued_at,signature
                    from public.article_publication_proof
                    """));
                Assert.Equal(PostgresErrorCodes.NotNullViolation, oldWriter.SqlState);
                using (var unsigned = await Send(server, HttpMethod.Get, successorUrl)) Assert.Equal(HttpStatusCode.NotFound, unsigned.StatusCode);
                await Scalar("alter table public.article_publication_transparency drop constraint transparency_fixture_fail");
                await Scalar("drop sequence public.transparency_fixture_attempt");
                await Wait("select count(*)=2 from public.article_publication_transparency");
                lastOld = (DateTime)(await Scalar("select max(issued_at) from public.article_publication_proof"))!;
                await Edit(server, WireRoutes.Retract, successor.Id, successor.Revision);
                using (var retired = await Send(server, HttpMethod.Get, successorUrl)) Assert.Equal(HttpStatusCode.NotFound, retired.StatusCode);
                using (var exposed = await Send(server, HttpMethod.Get, "/integrity/v2/log/head"))
                    Assert.Equal(HttpStatusCode.NotFound, exposed.StatusCode);
                Assert.True(Succeeded(await Audit("1", firstPin))["prefixVerified"]!.GetValue<bool>());
            }

            File.Delete(oldPath);
            config[Settings + "CurrentKeyId"] = "next";
            config[Settings + "NativeV2PrivateKeyFile"] = nextPath;
            config[Settings + "Keys__old__RevokedAtUtc"] = ArticlePublicationProofPayloadV2.Time(lastOld.AddTicks(10));
            await using (var server = await Start())
            {
                var second = await Publish(server);
                await Wait("select count(*)=3 from public.article_publication_transparency");
                using (var current = await Send(server, HttpMethod.Get, await ProofPath(second.Id))) Assert.Equal(HttpStatusCode.OK, current.StatusCode);
                var rotated = Succeeded(await Audit("1", firstPin));
                Assert.Equal(3, rotated["trustedSignatures"]!.GetValue<int>());
                Assert.Equal(2, rotated["retiredEligibleSignatures"]!.GetValue<int>());
            }
            config[Settings + "Keys__old__CompromisedAtUtc"] = ArticlePublicationProofPayloadV2.Time(lastOld);
            string finalPin;
            await using (var server = await Start())
            {
                // An older saved manifest cannot override the later durable compromise state.
                var compromised = Succeeded(await Audit("1", firstPin));
                Assert.Equal(2, compromised["compromisedSignatures"]!.GetValue<int>());
                Assert.Equal(1, compromised["trustedSignatures"]!.GetValue<int>());
                Assert.True(compromised["chainVerified"]!.GetValue<bool>());
                Assert.Equal("withheld", compromised["trustStatus"]!.GetValue<string>());
                finalPin = compromised["entrySha256"]!.GetValue<string>();
                await Registry(server);
            }

            Denied(await Audit("1", new string('f', 64)), "prefix was not found or changed");
            await Scalar("update public.article_publication_transparency set prev_sha256=decode(repeat('00',32),'hex') where seq=2");
            Denied(await Audit(), "chain failed at sequence 2");
            await Scalar("""
                update public.article_publication_transparency b set prev_sha256=a.entry_sha256
                from public.article_publication_transparency a where a.seq=1 and b.seq=2
                """);
            var tail = (long)(await Scalar("select publication_id from public.article_publication_transparency where seq=3"))!;
            var orphan = await Assert.ThrowsAsync<PostgresException>(() =>
                Scalar("delete from public.article_publication_transparency where seq=3"));
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, orphan.SqlState);
            await using (var tx = await db.BeginTransactionAsync(ct))
            {
                await using var deleteLeaf = Store.Sql(db, tx, "delete from public.article_publication_transparency where seq=3");
                await deleteLeaf.ExecuteNonQueryAsync(ct);
                await using var deleteProof = Store.Sql(db, tx, "delete from public.article_publication_proof where publication_id=$1", tail);
                await deleteProof.ExecuteNonQueryAsync(ct);
                await tx.CommitAsync(ct);
            }
            Denied(await Audit("3", finalPin), "prefix was not found or changed");

            // A pre-ledger store with issued receipts cannot be relabeled as an empty genesis.
            await RemoveLedgerSchema();
            Denied(await Migrate("enable"), "before any native proof has been issued");
            Assert.Equal(2L, await Scalar("select count(*) from public.article_publication_proof"));
            Assert.False((bool)(await Scalar("select to_regclass('public.article_publication_transparency') is not null"))!);

            Task<ServerProcess> Start() => ServerProcess.Start(fixture.ConnectionString, ct, config, Forward);

            void AddKey(string key, string version, ECDsa value)
            {
                var prefix = Settings + "Keys__" + key + "__";
                config[prefix + "Algorithm"] = "ECDSA_P256_SHA256";
                config[prefix + "Version"] = version;
                config[prefix + "PublicKey"] = WebEncoders.Base64UrlEncode(value.ExportSubjectPublicKeyInfo());
                config[prefix + "NotBeforeUtc"] = "2020-01-01T00:00:00.000000Z";
                config[prefix + "NotAfterUtc"] = "2099-01-01T00:00:00.000000Z";
            }

            async Task Registry(ServerProcess server)
            {
                using var response = await Send(server, HttpMethod.Get, "/integrity/v2/keys.json");
                response.EnsureSuccessStatusCode();
                await File.WriteAllBytesAsync(path, await response.Content.ReadAsByteArrayAsync(ct), ct);
            }

            async Task<Draft> Publish(ServerProcess server, Draft? previous = null)
            {
                var ready = await Edit(server, WireRoutes.Save, previous?.Id ?? 0, previous?.Revision ?? 0, "Public ledger", "原始 source\n");
                return await Edit(server, WireRoutes.Publish, ready.Id, ready.Revision);
            }

            async Task<Draft> Edit(ServerProcess server, string route, int article, long revision, string title = "", string body = "")
            {
                using var response = await Send(server, HttpMethod.Post, route,
                    Wire.EncodeArticleCommand(new(article, revision, Guid.NewGuid(), title, body)));
                response.EnsureSuccessStatusCode();
                return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
            }

            async Task<HttpResponseMessage> Send(ServerProcess server, HttpMethod method, string url, byte[]? payload = null)
            {
                using var request = new HttpRequestMessage(method, url);
                Forward(request);
                if (payload is not null)
                {
                    request.Headers.Add("Cookie", "fsus-v2-session=" + session);
                    request.Content = new ByteArrayContent(payload);
                    request.Content.Headers.ContentType = new(Aeds.ContentType);
                }
                return await server.Client.SendAsync(request, ct);
            }
        }
        finally { scratch.Delete(recursive: true); }

        string KeyFile(string name, ECDsa key)
        {
            var file = Path.Combine(scratch.FullName, name);
            var privateBytes = key.ExportPkcs8PrivateKey();
            try { File.WriteAllBytes(file, privateBytes); }
            finally { CryptographicOperations.ZeroMemory(privateBytes); }
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(file, UnixFileMode.UserRead);
            return file;
        }

        async Task<string> ProofPath(int article) => $"/integrity/v2/article/{article}/{await Scalar(
            "select publication_id from public.article_publication where article_id=$1", article)}/rights.json";

        async Task Wait(string sql)
        {
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (await Scalar(sql) is true) return;
                await Task.Delay(100, ct);
            }
            throw new InvalidOperationException("The native ledger fixture did not reach the expected state.");
        }

        async Task<object?> Scalar(string sql, params object[] args)
        {
            await using var command = Store.Sql(db, null, sql, args);
            return await command.ExecuteScalarAsync(ct);
        }

        async Task RemoveLedgerSchema()
        {
            await Scalar("alter table public.article_publication_proof drop column transparency_seq");
            await Scalar("drop table if exists public.publication_transparency_head,public.article_publication_transparency");
        }

        Task<(int Code, string Output, string Error)> Audit(params string[] prefix) =>
            Migrate(["verify", Origin, path, .. prefix]);

        async Task<(int Code, string Output, string Error)> Migrate(params string[] arguments)
        {
            var options = new ProcessStartInfo(Environment.GetEnvironmentVariable("DOTNET_BIN") ?? "dotnet")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true,
            };
            options.ArgumentList.Add(Environment.GetEnvironmentVariable(PublicationTransparencyFact.MigrationPath)!);
            options.ArgumentList.Add("publication-transparency");
            foreach (var argument in arguments) options.ArgumentList.Add(argument);
            options.Environment["FSUSBLOG_DB"] = fixture.ConnectionString;
            using var process = Process.Start(options)!;
            var stdout = process.StandardOutput.ReadToEndAsync(ct);
            var stderr = process.StandardError.ReadToEndAsync(ct);
            await process.WaitForExitAsync(ct);
            return (process.ExitCode, await stdout, await stderr);
        }
    }

    private static JsonNode Succeeded((int Code, string Output, string Error) result)
    {
        Assert.True(result.Code == 0, result.Error);
        return result.Output.StartsWith('{') ? JsonNode.Parse(result.Output)! : new JsonObject();
    }

    private static void Denied((int Code, string Output, string Error) result, string diagnosis)
    {
        Assert.NotEqual(0, result.Code);
        Assert.Contains(diagnosis, result.Error);
    }

    private static void Forward(HttpRequestMessage request)
    {
        request.Headers.Host = Host;
        request.Headers.Add("X-Forwarded-For", "127.0.0.1");
        request.Headers.Add("X-Forwarded-Proto", "https");
    }
}

internal sealed class PublicationTransparencyFact : FactAttribute
{
    internal const string MigrationPath = "FSUSBLOG_TEST_MIGRATE_DLL";

    public PublicationTransparencyFact()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)) ||
            !File.Exists(Environment.GetEnvironmentVariable(MigrationPath)))
            Skip = $"Set {ScratchDatabase.Variable} and {MigrationPath} to test the native issuance ledger.";
    }
}
