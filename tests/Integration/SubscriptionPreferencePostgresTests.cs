using CurrentSchema = FsusBlogV2.Storage.CurrentSchema;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SubscriptionPreferencePostgresTests
{
    private const string Origin = "https://preferences.example.test";
    private const string FixtureEmail = "Preferences+consent@example.test";

    [PostgresFact]
    public async Task FeatureRequiresConfiguredOriginAndExactStorage()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var key = RandomToken();
        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { [SubscriptionIdentity.KeySetting] = "" }))
        {
            await CheckStatusAsync(NotFound, disabled.Client.GetAsync("/subscribe", ct));
            using var enrollment = new ByteArrayContent(Encode(FixtureEmail, SubscriptionIdentity.EmailChannel));
            enrollment.Headers.ContentType = new(Aeds.ContentType);
            await CheckStatusAsync(NotFound, disabled.Client.PostAsync(WireRoutes.SubscriptionEnroll, enrollment, ct));
        }
        var noOrigin = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var unexpected = await ServerProcess.Start(fixture.ConnectionString, ct,
                new Dictionary<string, string> { [SubscriptionIdentity.KeySetting] = key, ["FSUSBLOG_PUBLIC_ORIGIN"] = "" });
        });
        Assert.Contains("explicit public HTTPS origin", noOrigin.Message);
        await fixture.Exec("drop table public.site_subscription");
        await fixture.WithConnection(db => CurrentSchema.VerifyAsync(db, ct), ct);
        var noSchema = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var unexpected = await ServerProcess.Start(fixture.ConnectionString, ct, Settings(key), Forwarded);
        });
        Assert.Contains("site_subscription", noSchema.Message);
    }

    [PostgresFact]
    public async Task ProofIsBoundSingleUseAndCommitsWithSuppressionUnderRetries()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var key = RandomToken();
        var lookup = SubscriptionIdentity.Read(key)!.EmailKey(FixtureEmail)!;
        var (secret, wrong) = (RandomToken(), RandomToken());
        var digest = SubscriptionIdentity.ProofDigest(secret)!;
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings(key), Forwarded);

        using (var shell = new HttpRequestMessage(HttpMethod.Get, "/subscribe"))
        {
            Forwarded(shell);
            shell.Headers.Host = "preferences.example.test:443";
            using var response = Ok(await server.Client.SendAsync(shell, ct));
            Assert.Equal(("noindex, nofollow", "no-referrer", true),
                (Assert.Single(response.Headers.GetValues("X-Robots-Tag")),
                    Assert.Single(response.Headers.GetValues("Referrer-Policy")), response.Headers.CacheControl?.NoStore == true));
        }
        foreach (var (email, channel, proof, status, host, origin) in new[]
        {
            (FixtureEmail, 2, (string?)null, NotFound, "different.example.test", "https://different.example.test"),
            (FixtureEmail, 2, null, Forbidden, "preferences.example.test", "https://different.example.test"),
            ("display<alice@example.test>", 2, null, BadRequest, "preferences.example.test", Origin),
            (FixtureEmail, 3, null, BadRequest, "preferences.example.test", Origin),
            (FixtureEmail, 2, secret, BadRequest, "preferences.example.test", Origin),
        })
            await Post(WireRoutes.SubscriptionEnroll, email, channel, proof, status, host, origin);
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.site_subscription"));

        var enrolled = await Post(WireRoutes.SubscriptionEnroll, FixtureEmail, 2);
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionEnroll, FixtureEmail.ToUpperInvariant(), 1));
        Assert.Equal(((short)2, 1L), (await fixture.Scalar<short>("select channel from public.site_subscription where email_key=$1", lookup),
            await fixture.Scalar<long>("select count(*) from public.site_subscription")));
        await fixture.Exec("update public.site_subscription set proof_digest=$2,proof_expires_at=clock_timestamp()-interval '1 second' where email_key=$1", lookup, digest);
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret));
        Assert.True(await fixture.Scalar<bool>("select enabled from public.site_subscription where email_key=$1", lookup));
        await fixture.Exec("update public.site_subscription set proof_expires_at=clock_timestamp()+interval '15 minutes' where email_key=$1", lookup);
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 1, secret));
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, "unregistered@example.test", 2, secret, source: "192.0.2.26"));
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, wrong, source: "192.0.2.27"));
        await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, null, BadRequest, source: "192.0.2.28");
        await Post(WireRoutes.SubscriptionCancel + "?proof=no", FixtureEmail, 2, secret, BadRequest, source: "192.0.2.29");
        Assert.True(await fixture.Scalar<bool>("select enabled from public.site_subscription where email_key=$1", lookup));

        await fixture.Exec("alter table public.site_subscription add constraint subscription_failure_test check (enabled)");
        await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, ServiceUnavailable, source: "192.0.2.30");
        Assert.Equal(digest, await fixture.Scalar<byte[]>("select proof_digest from public.site_subscription where email_key=$1", lookup));
        await fixture.Exec("alter table public.site_subscription drop constraint subscription_failure_test");
        var waiting = await fixture.InTx(async (db, barrier) =>
        {
            await FixtureSql.ExecuteAsync(db, barrier, ct,
                "update public.site_subscription set proof_expires_at=clock_timestamp()+interval '350 milliseconds' where email_key=$1", lookup);
            var task = Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, source: "192.0.2.35");
            await Task.Delay(TimeSpan.FromMilliseconds(800), ct);
            return task;
        }, ct);
        Assert.Equal(enrolled, await waiting);
        Assert.True(await fixture.Scalar<bool>("select enabled from public.site_subscription where email_key=$1", lookup));
        await fixture.Exec("update public.site_subscription set proof_expires_at=clock_timestamp()+interval '15 minutes' where email_key=$1", lookup);
        var races = await Task.WhenAll(Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, source: "192.0.2.31"),
            Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, source: "192.0.2.32"));
        Assert.All(races, receipt => Assert.Equal(enrolled, receipt));
        var cutoff = await fixture.Scalar("select unsubscribed_at from public.site_subscription where email_key=$1", lookup);
        Assert.NotNull(cutoff);
        Assert.False(await fixture.Scalar<bool>("select enabled from public.site_subscription where email_key=$1", lookup));
        Assert.Equal(DBNull.Value, await fixture.Scalar("select proof_digest from public.site_subscription where email_key=$1", lookup));
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionEnroll, FixtureEmail, 1, source: "192.0.2.33"));
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, source: "192.0.2.34"));
        Assert.Equal(cutoff, await fixture.Scalar("select unsubscribed_at from public.site_subscription where email_key=$1", lookup));
        Assert.Equal((short)2, await fixture.Scalar<short>("select channel from public.site_subscription where email_key=$1", lookup));
        var persisted = await fixture.Scalar<string>("select row_to_json(s)::text from public.site_subscription s");
        Assert.DoesNotContain(FixtureEmail, persisted);
        Assert.DoesNotContain(secret, persisted);

        async Task<byte[]> Post(string path, string email, int channel, string? proof = null, HttpStatusCode expected = OK,
            string host = "preferences.example.test", string origin = Origin, string? source = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(Encode(email, channel)) };
            Forwarded(request);
            request.Headers.Host = host;
            request.Headers.TryAddWithoutValidation("Origin", origin);
            if (source is not null) { request.Headers.Remove("X-Forwarded-For"); request.Headers.TryAddWithoutValidation("X-Forwarded-For", source); }
            if (proof is not null) request.Headers.TryAddWithoutValidation(WireHeaders.SubscriptionProof, proof);
            request.Content.Headers.ContentType = new(Aeds.ContentType);
            using var response = Expect(expected, await server.Client.SendAsync(request, ct));
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.False(response.Headers.Contains("Set-Cookie"));
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            var diagnostic = Encoding.UTF8.GetString(bytes);
            Assert.DoesNotContain(email, diagnostic);
            if (proof is not null) Assert.DoesNotContain(proof, diagnostic);
            if (response.IsSuccessStatusCode) Assert.True(Aeds.Decode(bytes, FrameType.EmptySuccess).SequenceEqual("\u0001\0\0\0"u8));
            return bytes;
        }
    }

    private static byte[] Encode(string email, int channel)
    {
        var bytes = Encoding.UTF8.GetBytes(email);
        var payload = new byte[bytes.Length + 8];
        BinaryPrimitives.WriteInt32LittleEndian(payload, bytes.Length);
        bytes.CopyTo(payload.AsSpan(4));
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(bytes.Length + 4), channel);
        return Aeds.Encode(FrameType.SubscriptionPreferenceRequest, payload);
    }

    private static string RandomToken() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private static Dictionary<string, string> Settings(string key) => new()
    {
        [SubscriptionIdentity.KeySetting] = key, ["FSUSBLOG_PUBLIC_ORIGIN"] = Origin, ["FSUSBLOG_TRUST_LOOPBACK_PROXY"] = "true"
    };

    private static void Forwarded(HttpRequestMessage request)
    {
        request.Headers.Host = "preferences.example.test";
        request.Headers.TryAddWithoutValidation("X-Forwarded-For", "192.0.2.20");
        request.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");
    }
}
