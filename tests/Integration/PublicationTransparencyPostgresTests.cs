using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using FsusBlog.V2.Contracts;
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
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        Succeeded(await Migrate("enable"));
        Succeeded(await Migrate("enable"));
        var (_, session, _) = await fixture.SignIn("Ledger author", ct, minutes: 5);
        var scratch = PublicationFixture.PrivateScratch("fsus-transparency");
        using var old = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var next = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var path = Path.Combine(scratch.FullName, "registry.json");
        try
        {
            var oldPath = PublicationFixture.PrivateKey(scratch, "old.pkcs8", old);
            var nextPath = PublicationFixture.PrivateKey(scratch, "next.pkcs8", next);
            var config = PublicationFixture.NativeSettings(Origin, "old", oldPath);
            PublicationFixture.ConfigureKey(config, "old", "1", old.ExportSubjectPublicKeyInfo());
            PublicationFixture.ConfigureKey(config, "next", "2", next.ExportSubjectPublicKeyInfo());
            string firstPin;
            DateTime lastOld;
            await using (var server = await Start())
            {
                Denied(await Migrate("enable"), "Stop the serving process");
                await Registry(server);
                Assert.Equal("0", Succeeded(await Audit())["sequence"]!.GetValue<string>());
                Denied(await Audit("0", new string('0', 64)), "positive prefix sequence");
                var first = await Publish(server);
                var firstUrl = await PublicationFixture.ProofPath(db, first.Id, ct);
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
                var successorUrl = await PublicationFixture.ProofPath(db, successor.Id, ct);
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
                using (var current = await Send(server, HttpMethod.Get, await PublicationFixture.ProofPath(db, second.Id, ct))) Assert.Equal(HttpStatusCode.OK, current.StatusCode);
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
                await FixtureSql.ExecuteAsync(db, tx, ct, "delete from public.article_publication_transparency where seq=3");
                await FixtureSql.ExecuteAsync(db, tx, ct, "delete from public.article_publication_proof where publication_id=$1", tail);
                await tx.CommitAsync(ct);
            }
            Denied(await Audit("3", finalPin), "prefix was not found or changed");

            // An inactive ledger store with issued receipts cannot be relabeled as an empty genesis.
            await ResetLedgerInactive();
            Denied(await Migrate("enable"), "before any native proof has been issued");
            Assert.Equal(2L, await Scalar("select count(*) from public.article_publication_proof"));
            Assert.Equal(0L, await Scalar("select count(*) from public.article_publication_transparency"));

            Task<ServerProcess> Start() => ServerProcess.Start(fixture.ConnectionString, ct, config, request => PublicationFixture.Forward(request, Host));

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

            Task<Draft> Edit(ServerProcess server, string route, int article, long revision, string title = "", string body = "") =>
                PublicationFixture.Edit(server, Host, session, route, new(article, revision, Guid.NewGuid(), title, body), ct);

            Task<HttpResponseMessage> Send(ServerProcess server, HttpMethod method, string url) =>
                PublicationFixture.SendForwarded(server, method, url, Host, session, frame: null, ct);
        }
        finally { scratch.Delete(recursive: true); }


        async Task Wait(string sql)
        {
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (await Scalar(sql) is true) return;
                await Task.Delay(100, ct);
            }
            throw new InvalidOperationException("The native ledger fixture did not reach the expected state.");
        }

        Task<object?> Scalar(string sql, params object[] args) =>
            FixtureSql.ScalarAsync(db, null, ct, sql, args);

        async Task ResetLedgerInactive()
        {
            await Scalar("alter table public.article_publication_proof alter column transparency_seq drop not null");
            await Scalar("update public.article_publication_proof set transparency_seq=null");
            await Scalar("delete from public.publication_transparency_head");
            await Scalar("delete from public.article_publication_transparency");
        }

        Task<FixtureProcess.Result> Audit(params string[] prefix) =>
            Migrate(["verify", Origin, path, .. prefix]);

        Task<FixtureProcess.Result> Migrate(params string[] arguments) =>
            FixtureProcess.Run(FixtureProcess.Migration(fixture.ConnectionString, ["publication-transparency", .. arguments]), ct);
    }

    private static JsonNode Succeeded(FixtureProcess.Result result)
    {
        Assert.True(result.Code == 0, result.Error);
        return result.Output.StartsWith('{') ? JsonNode.Parse(result.Output)! : new JsonObject();
    }

    private static void Denied(FixtureProcess.Result result, string diagnosis)
    {
        Assert.NotEqual(0, result.Code);
        Assert.Contains(diagnosis, result.Error);
    }
}

internal sealed class PublicationTransparencyFact : FactAttribute
{
    internal const string MigrationPath = "FSUSBLOG_TEST_CLI_DLL";

    public PublicationTransparencyFact()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)) ||
            !File.Exists(Environment.GetEnvironmentVariable(MigrationPath)))
            Skip = $"Set {ScratchDatabase.Variable} and {MigrationPath} to test the native issuance ledger.";
    }
}
