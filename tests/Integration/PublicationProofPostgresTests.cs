namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicationProofPostgresTests
{
    private const string Origin = "https://proof.example.test", Registry = "/integrity/v2/keys.json", Settings = "IntegrityProof__Signing__";

    [PostgresFact]
    public async Task OnlyLivePublicationsAreSignedAndOldSignaturesSurviveRotationButNotCompromise()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, session, handle) = await fixture.SignIn("Proof author", ct, minutes: 5);
        using var previous = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var next = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var scratch = PublicationFixture.PrivateScratch("fsus-proof");
        try
        {
            var aPath = PublicationFixture.PrivateKey(scratch, "a.pkcs8", previous);
            var bPath = PublicationFixture.PrivateKey(scratch, "b.pkcs8", next);
            var settings = PublicationFixture.NativeSettings(Origin, "a", aPath);
            settings["FSUSBLOG_ADMIN_ORIGIN"] = "https://admin-proof.example.test";
            var mediaAvailable = OperatingSystem.IsMacOS() || OperatingSystem.IsLinux();
            if (OperatingSystem.IsMacOS() || OperatingSystem.IsLinux())
                foreach (var (key, value) in MediaFixture.PublicSettings(
                    MediaFixture.CreateOwnedDirectory(scratch.FullName, "private"), MediaFixture.CreateOwnedDirectory(scratch.FullName, "public")))
                    settings.Add(key, value);
            PublicationFixture.ConfigureKey(settings, "a", "1", previous.ExportSubjectPublicKeyInfo());
            settings[Settings + "NativeV2PrivateKeyFile"] = bPath;
            var wrongKey = await Assert.ThrowsAsync<InvalidOperationException>(async () => { await using var _ = await Start(); });
            Assert.Contains("Invalid native publication signing configuration or private key.", wrongKey.Message);
            Assert.DoesNotContain(bPath, wrongKey.Message);
            settings[Settings + "NativeV2PrivateKeyFile"] = aPath;
            Draft first;
            string firstUrl, firstProof;
            await using (var server = await Start())
            {
                var draft = await Edit(server, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Évidence", "Frozen body 🐈\n"));
                Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_publication_proof"));
                first = await Edit(server, WireRoutes.Publish, new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""));
                firstUrl = await PublicationFixture.ProofPath(fixture, first.Id, ct);
                firstProof = await WaitProof(server, firstUrl);
                Assert.Equal(2, JsonNode.Parse(firstProof)!["canonicalVersion"]!.GetValue<int>());
                await VerifyIndependently(server, firstProof);
                var originalSignature = await fixture.Scalar<byte[]>("select signature from public.article_publication_proof");
                await fixture.Exec("update public.article_publication_proof set signature=$1", new byte[64]);
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, firstUrl));
                await fixture.Exec("update public.article_publication_proof set signature=$1", originalSignature);
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, firstUrl, "other.example.test"));
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, firstUrl.Replace("/rights.json", "000/rights.json", StringComparison.Ordinal)));
                await Edit(server, WireRoutes.Save, new(first.Id, first.Revision, Guid.NewGuid(), "Private revision", "New unpublished body"));
                Assert.Equal(firstProof, await WaitProof(server, firstUrl));
            }

            File.Delete(aPath);
            var oldIssued = DateTimeOffset.Parse(JsonNode.Parse(firstProof)!["issuedAtUtc"]!.GetValue<string>(), CultureInfo.InvariantCulture);
            settings[Settings + "Keys__a__RevokedAtUtc"] = ArticlePublicationProofPayloadV2.Time(oldIssued.AddSeconds(1));
            settings[Settings + "CurrentKeyId"] = "b";
            settings[Settings + "NativeV2PrivateKeyFile"] = bPath;
            PublicationFixture.ConfigureKey(settings, "b", "2", next.ExportSubjectPublicKeyInfo());
            Draft second;
            string secondUrl;
            await using (var server = await Start())
            {
                Assert.Equal(firstProof, await WaitProof(server, firstUrl));
                await VerifyIndependently(server, firstProof);
                var draft = await Edit(server, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Second", "New signing key"));
                second = await Edit(server, WireRoutes.Publish, new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""));
                secondUrl = await PublicationFixture.ProofPath(fixture, second.Id, ct);
                var signed = await WaitProof(server, secondUrl);
                Assert.Equal("b", JsonNode.Parse(signed)!["keyId"]!.GetValue<string>());
                await VerifyIndependently(server, signed);
                var previousUrl = secondUrl;
                var successor = await Edit(server, WireRoutes.Save, new(second.Id, second.Revision, Guid.NewGuid(), "Replacement", "New release"));
                string? coverDigest = null;
                if (mediaAvailable) (second, coverDigest) = await PublishCover(server, successor);
                else second = await Edit(server, WireRoutes.Publish, new(second.Id, successor.Revision, Guid.NewGuid(), "", ""));
                secondUrl = await PublicationFixture.ProofPath(fixture, second.Id, ct);
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, previousUrl));
                var replacementProof = await WaitProof(server, secondUrl);
                if (coverDigest is not null) await AssertCoverProof(server, second, replacementProof, coverDigest);
                await VerifyIndependently(server, replacementProof);
                var denied = await Edit(server, WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Do not sign", "Visible without proof"));
                var revision = Wire.DecodeArticleRightsPolicy(await OkBytes(Send(server, HttpMethod.Post, WireRoutes.DraftRightsCommand,
                    body: Wire.EncodeArticleRightsCommand(new(denied.Id, denied.Revision, Guid.NewGuid(), true, "CC0-1.0", "", 0, "", "", "disabled", 0, false, false, false))), ct)).Revision;
                var visible = await Edit(server, WireRoutes.Publish, new(denied.Id, revision, Guid.NewGuid(), "", ""));
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, await PublicationFixture.ProofPath(fixture, visible.Id, ct)));
            }

            var compromise = Settings + "Keys__a__CompromisedAtUtc";
            settings[compromise] = "2026-11-15T00:00:00.000000Z";
            await using (var server = await Start())
            {
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, firstUrl));
                await VerifyIndependently(server, firstProof, success: false);
                await VerifyIndependently(server, await WaitProof(server, secondUrl));
                await Edit(server, WireRoutes.Retract, new(second.Id, second.Revision, Guid.NewGuid(), "", ""));
                await CheckStatusAsync(NotFound, Send(server, HttpMethod.Get, secondUrl));
                Assert.Equal(3L, await fixture.Scalar<long>("select count(*) from public.article_publication_proof"));
                Assert.True(await fixture.TerminateAdvisoryOwner(PublicationLocks.Ownership, 5000, ct));
                for (var attempt = 0; ; attempt++)
                {
                    using var unavailable = await Send(server, HttpMethod.Get, Registry);
                    if (unavailable.StatusCode == ServiceUnavailable) break;
                    Assert.InRange(attempt, 0, 30);
                    await Task.Delay(50, ct);
                }
            }
            settings.Remove(compromise);
            var rejected = await Assert.ThrowsAsync<InvalidOperationException>(async () => { await using var _ = await Start(); });
            Assert.Contains("cannot be rebound or unrevoked", rejected.Message);

            Task<ServerProcess> Start() => ServerProcess.Start(fixture.ConnectionString, ct, settings, request => PublicationFixture.Forward(request, "proof.example.test"));

            async Task<Draft> Edit(ServerProcess server, string route, ArticleCommand input) =>
                Wire.DecodeDraft(await OkBytes(Send(server, HttpMethod.Post, route, body: Wire.EncodeArticleCommand(input)), ct));

            async Task<HttpResponseMessage> Send(ServerProcess server, HttpMethod method, string url,
                string host = "proof.example.test", byte[]? body = null, Guid? mutation = null)
            {
                var authoring = SiteAedsFixture.IsAuthoringRoute(url);
                using var request = SiteAedsFixture.Request(method, url, body, null, mutation.HasValue ? handle : null);
                if (authoring && body is not null) request.Headers.Add("Cookie", $"__Host-FsusAdminSession={session}");
                PublicationFixture.Forward(request, authoring ? "admin-proof.example.test" : host);
                if (mutation is { } key) request.Headers.Add(WireHeaders.ClientMutationId, key.ToString("D"));
                var response = await server.Client.SendAsync(request, ct);
                if (url.StartsWith("/integrity/v2", StringComparison.Ordinal)) Assert.True(response.Headers.CacheControl?.NoStore);
                return response;
            }

            async Task<(Draft Published, string Digest)> PublishCover(ServerProcess server, Draft draft)
            {
                using var upload = SiteAedsFixture.Request(HttpMethod.Post, WireRoutes.PrivateMediaUpload + "?name=signed-cover.png", frame: null, null, handle);
                upload.Headers.Add("Cookie", $"__Host-FsusAdminSession={session}");
                PublicationFixture.Forward(upload, "admin-proof.example.test");
                upload.Headers.Add(WireHeaders.ClientMutationId, Guid.NewGuid().ToString("D"));
                upload.Content = new ByteArrayContent(MediaFixture.SolidImage(SKEncodedImageFormat.Png, SKColors.SteelBlue));
                upload.Content.Headers.ContentType = new("image/png");
                var asset = MediaFixture.FirstListedAsset(await OkBytes(server.Client.SendAsync(upload, ct), ct), 1);
                var digest = await fixture.Scalar<string>("select encode(content_hash,'hex') from public.private_media where id=$1", asset);
                async Task<Draft> Step(string route, Func<Guid, byte[]> encode)
                {
                    var key = Guid.NewGuid();
                    return Wire.DecodeDraft(await OkBytes(Send(server, HttpMethod.Post, route, body: encode(key), mutation: key), ct));
                }
                draft = await Step(WireRoutes.ArticleMediaCommand, key => Wire.EncodeArticleMediaCommand(new(draft.Id, draft.Revision, key, asset, true)));
                draft = await Step(WireRoutes.ArticleCoverSave, key => Wire.EncodeArticleCoverCommand(new(draft.Id, draft.Revision, key, asset)));
                return (await Step(WireRoutes.ArticlePublishImages, key => Wire.EncodeArticlePublishImages(new(draft.Id, draft.Revision, key, [asset]))), digest);
            }

            async Task AssertCoverProof(ServerProcess server, Draft draft, string proof, string coverDigest)
            {
                var claim = JsonNode.Parse(proof)!;
                Assert.Equal(3, claim["canonicalVersion"]!.GetValue<int>());
                var publicationId = long.Parse(claim["publicationId"]!.GetValue<string>(), CultureInfo.InvariantCulture);
                var digest = Convert.ToHexStringLower(SHA256.HashData(await OkBytes(Send(server, HttpMethod.Get,
                    PublishedArticleImage.FilePath(draft.Id, publicationId, coverDigest)), ct)));
                Assert.Equal(coverDigest, digest);
                var payload = string.Create(CultureInfo.InvariantCulture, $"""
                    fsusblog.integrity.article-content.v3
                    version:i:3
                    articleId:i:{draft.Id}
                    revision:i:{draft.Revision}
                    title:s:UmVwbGFjZW1lbnQ=
                    markdown:s:TmV3IHJlbGVhc2U=
                    categoryId:n
                    tagIds:i:
                    coverMediaSha256:h:{digest}
                    """) + "\n";
                Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(payload))), claim["contentSha256"]!.GetValue<string>());
            }

            async Task<string> WaitProof(ServerProcess server, string path)
            {
                for (var attempt = 0; attempt < 80; attempt++)
                {
                    using var response = await Send(server, HttpMethod.Get, path);
                    if (response.StatusCode == OK) return await response.Content.ReadAsStringAsync(ct);
                    Assert.Equal(NotFound, response.StatusCode);
                    await Task.Delay(100, ct);
                }
                throw new InvalidOperationException("The committed public proof did not become available.");
            }

            async Task VerifyIndependently(ServerProcess server, string proof, bool success = true)
            {
                var (proofPath, keysPath) = (Path.Combine(scratch.FullName, "proof.json"), Path.Combine(scratch.FullName, "keys.json"));
                await File.WriteAllTextAsync(proofPath, proof, ct);
                await File.WriteAllTextAsync(keysPath, await OkString(Send(server, HttpMethod.Get, Registry), ct), ct);
                await VerifyTool(proofPath, keysPath, success);
                if (!success) return;
                var changed = JsonNode.Parse(proof)!;
                changed["publicationOutboxId"] = "9876543210";
                await File.WriteAllTextAsync(proofPath, changed.ToJsonString(), ct);
                await VerifyTool(proofPath, keysPath, false);
            }

            async Task VerifyTool(string proof, string keys, bool success)
            {
                var result = await FixtureProcess.Run(FixtureProcess.Command("node", PublicationFixture.Tool("verify-publication-proof.mjs"), Origin, keys, proof), ct);
                Assert.True((result.Code == 0) == success, result.Error);
            }
        }
        finally { scratch.Delete(recursive: true); }
    }
}
