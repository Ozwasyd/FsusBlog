namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationTransparencyPostgresTests
{
    private const string Host = "proof.example.test", Origin = "https://" + Host, Settings = "IntegrityProof__Signing__";

    [PublicationTransparencyFact]
    public async Task IssuesAndVerifiesAnAtomicDenseLedgerWithIndependentPrefixAndKeyState()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
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
                var firstUrl = await PublicationFixture.ProofPath(fixture, first.Id, ct);
                await Wait("select count(*)=1 from public.article_publication_transparency");
                await CheckStatusAsync(OK, Send(server, HttpMethod.Get, firstUrl));
                var anchor = Succeeded(await Audit());
                firstPin = anchor["entrySha256"]!.GetValue<string>();
                Assert.Equal(1, anchor["trustedSignatures"]!.GetValue<int>());

                // The sequence witnesses a real attempted write even when the signer transaction is rolled back.
                await fixture.Exec("""
                    create sequence public.transparency_fixture_attempt;
                    alter table public.article_publication_transparency add constraint transparency_fixture_fail
                        check (nextval('public.transparency_fixture_attempt')=0) not valid;
                    """);
                var successor = await Publish(server, first);
                var successorUrl = await PublicationFixture.ProofPath(fixture, successor.Id, ct);
                await Wait("select is_called from public.transparency_fixture_attempt");
                Assert.Equal((1L, 1L), (await fixture.Scalar<long>("select count(*) from public.article_publication_proof"),
                    await fixture.Scalar<long>("select count(*) from public.article_publication_transparency")));
                var oldWriter = await Assert.ThrowsAsync<PostgresException>(() => fixture.Exec("""
                    insert into public.article_publication_proof(publication_id,origin,key_id,key_version,key_sha256,issued_at,signature)
                    select (select max(publication_id) from public.article_publication_canonical),
                           origin,key_id,key_version,key_sha256,issued_at,signature from public.article_publication_proof
                    """));
                Assert.Equal(PostgresErrorCodes.NotNullViolation, oldWriter.SqlState);
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, successorUrl));
                await fixture.Exec("alter table public.article_publication_transparency drop constraint transparency_fixture_fail; drop sequence public.transparency_fixture_attempt;");
                await Wait("select count(*)=2 from public.article_publication_transparency");
                lastOld = await fixture.Scalar<DateTime>("select max(issued_at) from public.article_publication_proof");
                await PublicationFixture.Edit(server, Host, session, WireRoutes.Retract,
                    new(successor.Id, successor.Revision, Guid.NewGuid(), "", ""), ct);
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, successorUrl));
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, "/integrity/v2/log/head"));
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
                await CheckStatusAsync(OK, Send(server, HttpMethod.Get, await PublicationFixture.ProofPath(fixture, second.Id, ct)));
                var rotated = Succeeded(await Audit("1", firstPin));
                Assert.Equal((3, 2), (rotated["trustedSignatures"]!.GetValue<int>(), rotated["retiredEligibleSignatures"]!.GetValue<int>()));
            }
            config[Settings + "Keys__old__CompromisedAtUtc"] = ArticlePublicationProofPayloadV2.Time(lastOld);
            string finalPin;
            await using (var server = await Start())
            {
                // An older saved manifest cannot override the later durable compromise state.
                var compromised = Succeeded(await Audit("1", firstPin));
                Assert.Equal((2, 1, true, "withheld"), (compromised["compromisedSignatures"]!.GetValue<int>(),
                    compromised["trustedSignatures"]!.GetValue<int>(), compromised["chainVerified"]!.GetValue<bool>(),
                    compromised["trustStatus"]!.GetValue<string>()));
                finalPin = compromised["entrySha256"]!.GetValue<string>();
                await Registry(server);
            }

            Denied(await Audit("1", new string('f', 64)), "prefix was not found or changed");
            await fixture.Exec("update public.article_publication_transparency set prev_sha256=decode(repeat('00',32),'hex') where seq=2");
            Denied(await Audit(), "chain failed at sequence 2");
            await fixture.Exec("""
                update public.article_publication_transparency b set prev_sha256=a.entry_sha256
                from public.article_publication_transparency a where a.seq=1 and b.seq=2
                """);
            var tail = await fixture.Scalar<long>("select publication_id from public.article_publication_transparency where seq=3");
            Assert.Equal(PostgresErrorCodes.ForeignKeyViolation,
                (await Assert.ThrowsAsync<PostgresException>(() => fixture.Exec("delete from public.article_publication_transparency where seq=3"))).SqlState);
            await fixture.InTx(async (db, tx) =>
            {
                await FixtureSql.ExecuteAsync(db, tx, ct, "delete from public.article_publication_transparency where seq=3");
                await FixtureSql.ExecuteAsync(db, tx, ct, "delete from public.article_publication_proof where publication_id=$1", tail);
            }, ct);
            Denied(await Audit("3", finalPin), "prefix was not found or changed");

            // An inactive ledger store with issued receipts cannot be relabeled as an empty genesis.
            await fixture.Exec("""
                alter table public.article_publication_proof alter column transparency_seq drop not null;
                update public.article_publication_proof set transparency_seq=null;
                delete from public.publication_transparency_head;
                delete from public.article_publication_transparency;
                """);
            Denied(await Migrate("enable"), "before any native proof has been issued");
            Assert.Equal((2L, 0L), (await fixture.Scalar<long>("select count(*) from public.article_publication_proof"),
                await fixture.Scalar<long>("select count(*) from public.article_publication_transparency")));

            Task<ServerProcess> Start() => ServerProcess.Start(fixture.ConnectionString, ct, config, request => PublicationFixture.Forward(request, Host));
            async Task Registry(ServerProcess server) => await File.WriteAllBytesAsync(path, await OkBytes(Send(server, HttpMethod.Get, "/integrity/v2/keys.json"), ct), ct);
            Task<Draft> Publish(ServerProcess server, Draft? previous = null) => PublicationFixture.Publish(server, Host, session, "Public ledger", "原始 source\n", ct, previous);
            Task<HttpResponseMessage> Send(ServerProcess server, HttpMethod method, string url) =>
                PublicationFixture.SendForwarded(server, method, url, Host, session, frame: null, ct);
        }
        finally { scratch.Delete(recursive: true); }

        async Task Wait(string sql)
        {
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (await fixture.Scalar(sql) is true) return;
                await Task.Delay(100, ct);
            }
            throw new InvalidOperationException("The native ledger fixture did not reach the expected state.");
        }

        Task<FixtureProcess.Result> Audit(params string[] prefix) => Migrate(["verify", Origin, path, .. prefix]);
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
