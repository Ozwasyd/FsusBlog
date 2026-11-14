using System.Buffers.Text;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using Npgsql;

namespace FsusBlog.V2.Server.Security;

/// <summary>Only explicitly mapped, independently authorized operations may request a proof.</summary>
internal enum PowScope { PublicCommentSubmit, InboxCreate, InboxReply, SiteRecoveryKey, AdminInboxReply, AdminSitePagePublish }

internal sealed class ScopedPow(TimeProvider time)
{
    private readonly byte[] signingKey = RandomNumberGenerator.GetBytes(32);
    private readonly object issuing = new();
    private readonly Dictionary<string, int> counters = new(StringComparer.Ordinal);
    private long windowEnds;

    internal PowChallenge Issue(PowScope scope, string context, string session, IPAddress source, string clientNonce, byte[] frame)
    {
        if (!Hex(clientNonce, 32)) throw Invalid();
        Rate(session, source);
        var salt = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var timestamp = time.GetUtcNow().ToUnixTimeSeconds();
        return new(salt, WireLimits.PowChallengeDifficulty, timestamp,
            Base64Url.EncodeToString(Signature(scope, context, session, source, clientNonce, frame, salt, timestamp)));
    }

    internal async Task Consume(NpgsqlConnection db, NpgsqlTransaction tx, PowScope scope, string context,
        string session, IPAddress source,
        byte[] frame, PowProof proof, CancellationToken ct)
    {
        var now = time.GetUtcNow().ToUnixTimeSeconds();
        if (!Hex(proof.Salt, 32) || !Hex(proof.ClientNonce, 32) ||
            proof.Nonce.Length is < 1 or > 10 || !proof.Nonce.All(char.IsAsciiDigit) ||
            proof.Difficulty != WireLimits.PowChallengeDifficulty || proof.Timestamp <= now - WireLimits.PowChallengeSeconds ||
            proof.Timestamp > now + 2 || !TrySignature(proof.Signature, out var observed))
            throw Refused();

        var expected = Signature(scope, context, session, source, proof.ClientNonce, frame, proof.Salt, proof.Timestamp);
        if (!CryptographicOperations.FixedTimeEquals(expected, observed) ||
            !HasWork(proof.Salt, proof.Nonce, proof.ClientNonce, proof.Difficulty))
            throw Refused();

        await using var insert = Store.Sql(db, tx, """
            with expired_rows as (
                select digest from public.scoped_pow_consumed where expires_at<=clock_timestamp()
                order by expires_at limit 32 for update skip locked
            ), clean as (
                delete from public.scoped_pow_consumed using expired_rows
                where scoped_pow_consumed.digest=expired_rows.digest
            )
            insert into public.scoped_pow_consumed(digest,expires_at)
            select $1,$2 where $2 > clock_timestamp()
                and to_timestamp($3) <= clock_timestamp()+interval '2 seconds'
            on conflict do nothing
            """, expected, DateTimeOffset.FromUnixTimeSeconds(proof.Timestamp + WireLimits.PowChallengeSeconds),
                (double)proof.Timestamp);
        if (await insert.ExecuteNonQueryAsync(ct) != 1) throw Refused();

        // A simultaneous request may block on the digest's unique index. Recheck the database
        // clock after that wait, before returning authority to execute the protected mutation.
        await using var expiry = Store.Sql(db, tx, "select $1>clock_timestamp()",
            DateTimeOffset.FromUnixTimeSeconds(proof.Timestamp + WireLimits.PowChallengeSeconds));
        if (await expiry.ExecuteScalarAsync(ct) is not true) throw Refused();
    }

    internal static bool HasWork(string salt, string nonce, string clientNonce, int bits)
    {
        if (bits is < 1 or > 256) return false;
        var digest = SHA256.HashData(Encoding.UTF8.GetBytes($"{salt}:{nonce}:{clientNonce}"));
        var count = bits / 8;
        return !digest.AsSpan(0, count).ContainsAnyExcept((byte)0) &&
            (bits % 8 == 0 || digest[count] >> (8 - bits % 8) == 0);
    }

    private void Rate(string session, IPAddress source)
    {
        var sessionKey = "session:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(session)));
        var sourceKey = "source:" + Convert.ToHexString(HMACSHA256.HashData(signingKey, source.GetAddressBytes()));
        lock (issuing)
        {
            var now = time.GetUtcNow().ToUnixTimeSeconds();
            if (now >= windowEnds)
            {
                counters.Clear();
                windowEnds = now + 60;
            }
            var sessionCount = counters.GetValueOrDefault(sessionKey);
            var sourceCount = counters.GetValueOrDefault(sourceKey);
            if (sessionCount >= 8 || sourceCount >= 24 || counters.Count >= 2048)
                throw new ScopedPowFailure(429, "Too many security challenges. Try again later.", "pow_rate_limited");
            counters[sessionKey] = sessionCount + 1;
            counters[sourceKey] = sourceCount + 1;
        }
    }

    internal static IPAddress Source(HttpContext ctx)
    {
        var address = ctx.Connection.RemoteIpAddress ?? throw Refused();
        return address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;
    }

    private byte[] Signature(PowScope scope, string context, string session, IPAddress source, string clientNonce,
        byte[] frame, string salt, long timestamp)
    {
        var action = scope switch
        {
            PowScope.PublicCommentSubmit => "comment-submit",
            PowScope.InboxCreate => "inbox-create",
            PowScope.InboxReply => "inbox-reply",
            PowScope.AdminInboxReply => "admin-inbox-reply",
            PowScope.SiteRecoveryKey => "site-recovery-key",
            PowScope.AdminSitePagePublish => "admin-site-page-publish",
            _ => throw Refused()
        };
        if (context.Length > 160) throw Refused();
        var contextDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(context)));
        var sessionDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(session)));
        var frameDigest = Convert.ToHexString(SHA256.HashData(frame));
        var ip = Convert.ToHexString(source.GetAddressBytes());
        var binding = string.Create(CultureInfo.InvariantCulture,
            $"fsus-classic-pow-v1:{action}:{contextDigest}:{sessionDigest}:{ip}:{clientNonce}:{frameDigest}:{salt}:{timestamp}:{WireLimits.PowChallengeDifficulty}");
        return HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes(binding));
    }

    internal static string ReadClientNonce(HttpContext ctx)
    {
        if (!ctx.Request.Headers.TryGetValue(WireHeaders.PowClientNonce, out var nonce) ||
            nonce.Count != 1 || nonce[0] is not { } value || !Hex(value, 32)) throw Invalid();
        return value;
    }

    internal static PowProof ReadProof(HttpContext ctx)
    {
        if (!ctx.Request.Headers.TryGetValue(WireHeaders.PowProof, out var header) || header.Count != 1)
            throw Missing();
        try { return PowWire.ReadProof(header[0]); }
        catch (ProtocolException) { throw Invalid(); }
    }

    internal static async Task<IResult> Protect(HttpContext ctx, Func<Task<byte[]>> run,
        PowScope scope = PowScope.PublicCommentSubmit)
    {
        try { return Results.Bytes(await run(), Aeds.ContentType); }
        catch (ScopedPowFailure rejection)
        {
            var details = scope == PowScope.PublicCommentSubmit ? "comment_" + rejection.Details : rejection.Details;
            return new AedsError(rejection.Status, Wire.EncodeError(rejection.Status, rejection.Message, details, ctx.TraceIdentifier));
        }
    }

    private static bool TrySignature(string encoded, out byte[] digest)
    {
        digest = new byte[32];
        return encoded.Length == 43 && Base64Url.TryDecodeFromChars(encoded, digest, out var written) &&
            written == 32 && Base64Url.EncodeToString(digest) == encoded;
    }

    private static bool Hex(string value, int length) =>
        value.Length == length && value.All(char.IsAsciiHexDigit);

    private static ScopedPowFailure Missing() => new(401, "A security proof is required.", "pow_required");
    private static ScopedPowFailure Invalid() => new(400, "The security proof format is invalid.", "pow_invalid");
    private static ScopedPowFailure Refused() => new(401, "The security proof expired or was rejected.", "pow_rejected");
}

internal sealed class ScopedPowFailure(int status, string message, string details) : Exception(message)
{
    internal int Status { get; } = status;
    internal string Details { get; } = details;
}
