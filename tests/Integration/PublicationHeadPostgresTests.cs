namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationHeadPostgresTests
{
    private const string Host = "head.example.test", Origin = "https://" + Host;
    private const string Head = "/integrity/v2/log/head.json", Registry = "/integrity/v2/keys.json";
    private const string Settings = "IntegrityProof__Signing__", Anchor = Settings + "NativeV2PublicHeadAnchor";

    [PublicationTransparencyFact]
    public async Task ServesOnlyOriginalOpaqueHeadForTheAnchoredExactCommittedTail()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await Run(FixtureProcess.Migration(fixture.ConnectionString, "publication-transparency", "enable"));

        var (_, session, _) = await fixture.SignIn("Public head fixture", ct, minutes: 5);
        var scratch = PublicationFixture.PrivateScratch("fsus-head");
        using var currentKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var nextKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        try
        {
            var currentPath = PublicationFixture.PrivateKey(scratch, "current.pkcs8", currentKey);
            var nextPath = PublicationFixture.PrivateKey(scratch, "next.pkcs8", nextKey);
            var config = PublicationFixture.NativeSettings(Origin, "first", currentPath);
            PublicationFixture.ConfigureKey(config, "first", "1", currentKey.ExportSubjectPublicKeyInfo());
            PublicationFixture.ConfigureKey(config, "next", "2", nextKey.ExportSubjectPublicKeyInfo());
            await using (var server = await Start()) await Status(server, NotFound);

            config[Anchor] = "genesis";
            string firstPin, retained;
            DateTime attestedAt;
            await using (var server = await Start())
            {
                await Status(server, NotFound);
                var release = await Publish(server, "First retained content");
                var first = await WaitForHead(server, "1");
                firstPin = "1:" + JsonNode.Parse(first)!["entrySha256"]!.GetValue<string>();
                first = await VerifyIndependently(server, first);
                await fixture.Exec("create table public.first_head_fixture as table public.publication_transparency_head");
                var proofUrl = await PublicationFixture.ProofPath(fixture, release.Id, ct);
                Assert.NotEqual(JsonNode.Parse(first)!["signature"]!.GetValue<string>(),
                    JsonNode.Parse(await OkString(Send(server, HttpMethod.Get, proofUrl), ct))!["signature"]!.GetValue<string>());
                await PublicationFixture.Edit(server, Host, session, WireRoutes.Retract,
                    new(release.Id, release.Revision, Guid.NewGuid(), "", ""), ct);
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, proofUrl));
                Assert.Equal(first, await WaitForHead(server, "1"));
                await Status(server, NotFound, "wrong.example.test");
                await Status(server, Forbidden, Host, "http");

                // The sequence witnesses a real head INSERT that fails after the proof and ledger inserts.
                await fixture.Exec("""
                    create sequence public.head_fixture_attempt;
                    alter table public.publication_transparency_head add constraint head_fixture_fail
                        check (nextval('public.head_fixture_attempt')=0) not valid;
                    """);
                await Publish(server, "Second retained content");
                for (var attempt = 0; !await fixture.Scalar<bool>("select is_called from public.head_fixture_attempt"); attempt++)
                {
                    Assert.InRange(attempt, 0, 100);
                    await Task.Delay(100, ct);
                }
                Assert.Equal((1L, 1L, first), (await fixture.Scalar<long>("select count(*) from public.article_publication_proof"),
                    await fixture.Scalar<long>("select count(*) from public.article_publication_transparency"), await WaitForHead(server, "1")));
                await fixture.Exec("alter table public.publication_transparency_head drop constraint head_fixture_fail; drop sequence public.head_fixture_attempt;");
                retained = await VerifyIndependently(server, await WaitForHead(server, "2"));
                attestedAt = await fixture.Scalar<DateTime>("select attested_at from public.publication_transparency_head");
                AssertFailed(await Checkpoint(currentPath), "Stop the serving process", checkEmpty: false);
            }

            var signedCheckpoint = await Checkpoint(currentPath);
            Assert.True(signedCheckpoint.Code == 0, signedCheckpoint.Error);
            await VerifyCheckpoint(signedCheckpoint.Output, "first");
            var priorDay = (await fixture.Scalar<DateTime>("select min(issued_at) from public.article_publication_proof")).AddDays(-1)
                .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var dailyCheckpoint = await Checkpoint(currentPath, day: priorDay);
            Assert.True(dailyCheckpoint.Code == 0, dailyCheckpoint.Error);
            var dayBundle = JsonNode.Parse(dailyCheckpoint.Output)!;
            var cp = dayBundle["checkpoint"]!;
            Assert.Equal(("daily", 0, "0", "0"), (cp["checkpointKind"]!.GetValue<string>(), cp["entryCount"]!.GetValue<int>(),
                cp["fromSequence"]!.GetValue<string>(), cp["toSequence"]!.GetValue<string>()));
            Assert.Null(dayBundle["inclusion"]);
            var dayFile = Path.Combine(scratch.FullName, "daily-checkpoint.json");
            await File.WriteAllTextAsync(dayFile, dailyCheckpoint.Output, ct);
            await Run(FixtureProcess.Command("node", PublicationFixture.Tool("verify-publication-checkpoint.mjs"), Origin,
                Path.Combine(scratch.FullName, "keys.json"), Path.Combine(scratch.FullName, "head.json"), dayFile, "--daily", priorDay));
            AssertFailed(await Checkpoint(currentPath, day: attestedAt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)), "on or after the next UTC midnight");
            AssertFailed(await Checkpoint(currentPath, day: priorDay, include: "1"), "cannot include a ledger entry");
            var originalIssue = await fixture.Scalar<DateTime>("select issued_at from public.article_publication_proof where transparency_seq=2");
            await fixture.Exec("update public.article_publication_proof set issued_at=issued_at+interval '1 second' where transparency_seq=2");
            AssertFailed(await Checkpoint(currentPath, day: priorDay), "does not connect to the independently retained native head");
            await fixture.Exec("update public.article_publication_proof set issued_at=$1 where transparency_seq=2", originalIssue);
            AssertFailed(await Checkpoint(currentPath, "next"), "differs from the trusted registry's current key", checkEmpty: false);
            var wrongPrivateKey = await Checkpoint(nextPath);
            AssertFailed(wrongPrivateKey, "Invalid native publication signing configuration or private key", checkEmpty: false);
            Assert.DoesNotContain(nextPath, wrongPrivateKey.Error);

            await fixture.Exec("create table public.latest_head_fixture as table public.publication_transparency_head");
            await using (var server = await Start()) await Status(server, ServiceUnavailable);

            config[Anchor] = firstPin;
            await fixture.Exec("delete from public.publication_transparency_head; insert into public.publication_transparency_head select * from public.first_head_fixture;");
            await using (var server = await Start()) await Status(server, ServiceUnavailable);
            await fixture.Exec("""
                delete from public.publication_transparency_head;
                insert into public.publication_transparency_head select * from public.latest_head_fixture;
                drop table public.first_head_fixture, public.latest_head_fixture;
                update public.article_publication_transparency set prev_sha256=decode(repeat('00',32),'hex') where seq=2;
                """);
            AssertFailed(await Checkpoint(currentPath), "does not connect to the independently retained native head", checkEmpty: false);
            await using (var server = await Start()) await Status(server, ServiceUnavailable);
            await fixture.Exec("""
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
                Assert.True(await fixture.TerminateAdvisoryOwner(PublicationLocks.Ownership, 5000, ct));
                for (var attempt = 0; ; attempt++)
                {
                    using var denied = await Send(server, HttpMethod.Get, Head);
                    if (denied.StatusCode == ServiceUnavailable) break;
                    Assert.InRange(attempt, 0, 40);
                    await Task.Delay(50, ct);
                }
            }
            var rotatedCheckpoint = await Checkpoint(nextPath, "next");
            Assert.True(rotatedCheckpoint.Code == 0, rotatedCheckpoint.Error);
            await VerifyCheckpoint(rotatedCheckpoint.Output, "next");
            config[Settings + "Keys__first__CompromisedAtUtc"] = ArticlePublicationProofPayloadV2.Time(attestedAt);
            await using (var server = await Start())
            {
                await Status(server, ServiceUnavailable);
                var next = await Publish(server, "Native proof survives optional head refusal");
                var proofUrl = await PublicationFixture.ProofPath(fixture, next.Id, ct);
                for (var attempt = 0; ; attempt++)
                {
                    using var proof = await Send(server, HttpMethod.Get, proofUrl);
                    if (proof.IsSuccessStatusCode) break;
                    Assert.InRange(attempt, 0, 100);
                    await Task.Delay(100, ct);
                }
                Assert.Equal((3L, 2L), (await fixture.Scalar<long>("select max(seq) from public.article_publication_transparency"),
                    await fixture.Scalar<long>("select seq from public.publication_transparency_head")));
                await Status(server, ServiceUnavailable);
            }
            // The saved manifest predates the compromise. The persisted revocation state still denies the anchor.
            AssertFailed(await Checkpoint(nextPath, "next"), "ineligible at its attested time", checkEmpty: false);

            Task<ServerProcess> Start() => ServerProcess.Start(fixture.ConnectionString, ct, config, request => PublicationFixture.Forward(request, Host));

            async Task<HttpResponseMessage> Send(ServerProcess server, HttpMethod method, string url, byte[]? body = null,
                string host = Host, string scheme = "https")
            {
                var response = await PublicationFixture.SendForwarded(server, method, url, host, session, body, ct, scheme);
                if (url == Head && config.ContainsKey(Anchor)) Assert.True(response.Headers.CacheControl?.NoStore);
                return response;
            }

            Task Status(ServerProcess server, HttpStatusCode code, string host = Host, string scheme = "https") =>
                CheckStatusAsync(code, Send(server, HttpMethod.Get, Head, host: host, scheme: scheme));

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
                var keyFile = Path.Combine(scratch.FullName, "keys.json");
                var headFile = Path.Combine(scratch.FullName, "head.json");
                await File.WriteAllTextAsync(keyFile, await OkString(Send(server, HttpMethod.Get, Registry), ct), ct);
                await File.WriteAllTextAsync(headFile, head, ct);
                await Run(FixtureProcess.Command("node", PublicationFixture.Tool("verify-publication-head.mjs"), Origin, keyFile, headFile));
                return head;
            }

            Task<Draft> Publish(ServerProcess server, string body) =>
                PublicationFixture.Publish(server, Host, session, "Public anchor fixture", body, ct);
        }
        finally { scratch.Delete(recursive: true); }

        Task<FixtureProcess.Result> Checkpoint(string privateKey, string currentKeyId = "first", string? day = null, string? include = null)
        {
            var options = FixtureProcess.Migration(fixture.ConnectionString,
                "publication-transparency", day is null ? "checkpoint-release" : "checkpoint-daily", Origin,
                Path.Combine(scratch.FullName, "keys.json"), Path.Combine(scratch.FullName, "head.json"));
            foreach (var argument in day is null ? new[] { "release-fixture.1", "1", "2", "2" } : include is null ? [day] : [day, include])
                options.ArgumentList.Add(argument);
            options.Environment[Settings + "CurrentKeyId"] = currentKeyId;
            options.Environment[Settings + "NativeV2PrivateKeyFile"] = privateKey;
            return FixtureProcess.Run(options, ct);
        }

        async Task VerifyCheckpoint(string output, string keyId)
        {
            var checkpoint = JsonNode.Parse(output)!["checkpoint"]!;
            Assert.Equal((keyId, 2), (checkpoint["keyId"]!.GetValue<string>(), checkpoint["entryCount"]!.GetValue<int>()));
            var bundle = Path.Combine(scratch.FullName, "checkpoint.json");
            await File.WriteAllTextAsync(bundle, output, ct);
            var expected = await fixture.Scalar<string>("select encode(entry_sha256,'hex') from public.article_publication_transparency where seq=2");
            await Run(FixtureProcess.Command("node", PublicationFixture.Tool("verify-publication-checkpoint.mjs"), Origin,
                Path.Combine(scratch.FullName, "keys.json"), Path.Combine(scratch.FullName, "head.json"), bundle, "release-fixture.1", "2", expected));
        }

        async Task Run(ProcessStartInfo options)
        {
            var result = await FixtureProcess.Run(options, ct);
            Assert.True(result.Code == 0, result.Error + result.Output);
        }

        static void AssertFailed(FixtureProcess.Result result, string expectedError, bool checkEmpty = true)
        {
            Assert.NotEqual(0, result.Code);
            if (checkEmpty) Assert.Empty(result.Output);
            Assert.Contains(expectedError, result.Error);
        }
    }
}
