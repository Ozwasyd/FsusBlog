using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using CurrentSchema = FsusBlogV2.Storage.CurrentSchema;

namespace FsusBlog.V2.Integration.Tests;

public sealed class SubscriptionPreferencePostgresTests
{
    private const string Origin = "https://preferences.example.test";
    private const string FixtureEmail = "Preferences+consent@example.test";

    [PostgresFact]
    public async Task FeatureRequiresConfiguredOriginAndExactStorage()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var key = RandomToken();
        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct,
            new Dictionary<string, string> { [SubscriptionIdentity.KeySetting] = "" }))
        {
            using var shell = await disabled.Client.GetAsync("/subscribe", ct);
            Assert.Equal(HttpStatusCode.NotFound, shell.StatusCode);
            using var enrollment = new ByteArrayContent(Encode(FixtureEmail, SubscriptionIdentity.EmailChannel));
            enrollment.Headers.ContentType = new(Aeds.ContentType);
            using var write = await disabled.Client.PostAsync(WireRoutes.SubscriptionEnroll, enrollment, ct);
            Assert.Equal(HttpStatusCode.NotFound, write.StatusCode);
        }
        var unsafeConfig = new Dictionary<string, string> { [SubscriptionIdentity.KeySetting] = key, ["FSUSBLOG_PUBLIC_ORIGIN"] = "" };
        var noOrigin = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var unexpected = await ServerProcess.Start(fixture.ConnectionString, ct, unsafeConfig);
        });
        Assert.Contains("explicit public HTTPS origin", noOrigin.Message);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        await FixtureSql.ExecuteAsync(db, null, ct, "drop table public.site_subscription");
        await CurrentSchema.VerifyAsync(db, ct);
        var noSchema = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var unexpected = await ServerProcess.Start(fixture.ConnectionString, ct, Settings(key), Forwarded);
        });
        Assert.Contains("site_subscription", noSchema.Message);
    }

    [PostgresFact]
    public async Task ProofIsBoundSingleUseAndCommitsWithSuppressionUnderRetries()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var key = RandomToken();
        var identity = SubscriptionIdentity.Read(key)!;
        var lookup = identity.EmailKey(FixtureEmail)!;
        var secret = RandomToken();
        var wrong = RandomToken();
        var digest = SubscriptionIdentity.ProofDigest(secret)!;
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings(key), Forwarded);

        using (var shell = new HttpRequestMessage(HttpMethod.Get, "/subscribe"))
        {
            Forwarded(shell);
            shell.Headers.Host = "preferences.example.test:443";
            using var response = await server.Client.SendAsync(shell, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal("noindex, nofollow", Assert.Single(response.Headers.GetValues("X-Robots-Tag")));
            Assert.Equal("no-referrer", Assert.Single(response.Headers.GetValues("Referrer-Policy")));
            Assert.True(response.Headers.CacheControl?.NoStore);
        }
        await Post(WireRoutes.SubscriptionEnroll, FixtureEmail, 2, null, HttpStatusCode.NotFound, host: "different.example.test",
            origin: "https://different.example.test");
        await Post(WireRoutes.SubscriptionEnroll, FixtureEmail, 2, null, HttpStatusCode.Forbidden, origin: "https://different.example.test");
        await Post(WireRoutes.SubscriptionEnroll, "display<alice@example.test>", 2, null, HttpStatusCode.BadRequest);
        await Post(WireRoutes.SubscriptionEnroll, FixtureEmail, 3, null, HttpStatusCode.BadRequest);
        await Post(WireRoutes.SubscriptionEnroll, FixtureEmail, 2, secret, HttpStatusCode.BadRequest);
        Assert.Equal(0L, await Scalar("select count(*) from public.site_subscription"));

        var enrolled = await Post(WireRoutes.SubscriptionEnroll, FixtureEmail, 2);
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionEnroll, FixtureEmail.ToUpperInvariant(), 1));
        Assert.Equal((short)2, await Scalar("select channel from public.site_subscription where email_key=$1", lookup));
        Assert.Equal(1L, await Scalar("select count(*) from public.site_subscription"));
        await Sql("update public.site_subscription set proof_digest=$2,proof_expires_at=clock_timestamp()-interval '1 second' where email_key=$1", lookup, digest);
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret));
        Assert.Equal(true, await Scalar("select enabled from public.site_subscription where email_key=$1", lookup));
        await Sql("update public.site_subscription set proof_expires_at=clock_timestamp()+interval '15 minutes' where email_key=$1", lookup);
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 1, secret));
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, "unregistered@example.test", 2, secret, source: "192.0.2.26"));
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, wrong, source: "192.0.2.27"));
        await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, null, HttpStatusCode.BadRequest, source: "192.0.2.28");
        await Post(WireRoutes.SubscriptionCancel + "?proof=no", FixtureEmail, 2, secret, HttpStatusCode.BadRequest, source: "192.0.2.29");
        Assert.Equal(true, await Scalar("select enabled from public.site_subscription where email_key=$1", lookup));

        await Sql("alter table public.site_subscription add constraint subscription_failure_test check (enabled)");
        await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, HttpStatusCode.ServiceUnavailable, source: "192.0.2.30");
        Assert.Equal(digest, (byte[])(await Scalar("select proof_digest from public.site_subscription where email_key=$1", lookup))!);
        await Sql("alter table public.site_subscription drop constraint subscription_failure_test");
        await using (var barrier = await db.BeginTransactionAsync(ct))
        {
            await FixtureSql.ExecuteAsync(db, barrier, ct, """
                update public.site_subscription set proof_expires_at=clock_timestamp()+interval '350 milliseconds' where email_key=$1
                """, lookup);
            var waiting = Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, source: "192.0.2.35");
            await Task.Delay(TimeSpan.FromMilliseconds(800), ct);
            await barrier.CommitAsync(ct);
            Assert.Equal(enrolled, await waiting);
        }
        Assert.Equal(true, await Scalar("select enabled from public.site_subscription where email_key=$1", lookup));
        await Sql("update public.site_subscription set proof_expires_at=clock_timestamp()+interval '15 minutes' where email_key=$1", lookup);
        var races = await Task.WhenAll(Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, source: "192.0.2.31"),
            Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, source: "192.0.2.32"));
        Assert.All(races, receipt => Assert.Equal(enrolled, receipt));
        var cutoff = await Scalar("select unsubscribed_at from public.site_subscription where email_key=$1", lookup);
        Assert.NotNull(cutoff);
        Assert.Equal(false, await Scalar("select enabled from public.site_subscription where email_key=$1", lookup));
        Assert.Equal(DBNull.Value, await Scalar("select proof_digest from public.site_subscription where email_key=$1", lookup));
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionEnroll, FixtureEmail, 1, source: "192.0.2.33"));
        Assert.Equal(enrolled, await Post(WireRoutes.SubscriptionCancel, FixtureEmail, 2, secret, source: "192.0.2.34"));
        Assert.Equal(cutoff, await Scalar("select unsubscribed_at from public.site_subscription where email_key=$1", lookup));
        Assert.Equal((short)2, await Scalar("select channel from public.site_subscription where email_key=$1", lookup));
        var persisted = (string)(await Scalar("select row_to_json(s)::text from public.site_subscription s"))!;
        Assert.DoesNotContain(FixtureEmail, persisted);
        Assert.DoesNotContain(secret, persisted);

        async Task<byte[]> Post(string path, string email, int channel, string? proof = null, HttpStatusCode expected = HttpStatusCode.OK,
            string host = "preferences.example.test", string origin = Origin, string? source = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(Encode(email, channel)) };
            Forwarded(request);
            request.Headers.Host = host;
            request.Headers.TryAddWithoutValidation("Origin", origin);
            if (source is not null)
            {
                request.Headers.Remove("X-Forwarded-For");
                request.Headers.TryAddWithoutValidation("X-Forwarded-For", source);
            }
            if (proof is not null) request.Headers.TryAddWithoutValidation(WireHeaders.SubscriptionProof, proof);
            request.Content.Headers.ContentType = new(Aeds.ContentType);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.False(response.Headers.Contains("Set-Cookie"));
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            var diagnostic = Encoding.UTF8.GetString(bytes);
            Assert.DoesNotContain(email, diagnostic);
            if (proof is not null) Assert.DoesNotContain(proof, diagnostic);
            if (response.IsSuccessStatusCode) Assert.True(Aeds.Decode(bytes, FrameType.EmptySuccess).SequenceEqual("\u0001\0\0\0"u8));
            return bytes;
        }

        Task<object?> Scalar(string sql, params object[] args) =>
            FixtureSql.ScalarAsync(db, null, ct, sql, args);

        Task Sql(string sql, params object[] args) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, args);

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
