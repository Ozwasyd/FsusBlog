using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Cli
{
    private static async Task IssueSubscriptionCancelAsync(NpgsqlConnection connection, string channelName, CancellationToken ct)
    {
        var channel = channelName switch
        {
            "rss" => SubscriptionIdentity.RssChannel,
            "email" => SubscriptionIdentity.EmailChannel,
            _ => throw new ArgumentException("Use site-subscription issue-cancel rss|email and provide one email address on standard input.")
        };
        var identity = SubscriptionIdentity.Read(Environment.GetEnvironmentVariable(SubscriptionIdentity.KeySetting)) ??
            throw new InvalidOperationException("Subscription preferences are disabled.");
        if (!Console.IsInputRedirected) throw new ArgumentException("Provide one email address on redirected standard input.");
        var input = new byte[SubscriptionIdentity.EmailLimit + 3];
        byte[] emailKey;
        try
        {
            using var stdin = Console.OpenStandardInput();
            var used = await stdin.ReadAtLeastAsync(input, input.Length, false, ct);
            if (used == input.Length || input.AsSpan(0, used).ContainsAnyInRange((byte)128, byte.MaxValue)) throw InvalidEmail();
            var email = Encoding.ASCII.GetString(input, 0, used);
            if (email.EndsWith("\r\n", StringComparison.Ordinal)) email = email[..^2];
            else if (email.EndsWith('\n')) email = email[..^1];
            emailKey = identity.EmailKey(email) ?? throw InvalidEmail();
        }
        finally { CryptographicOperations.ZeroMemory(input); }

        await CurrentSchema.VerifyAsync(connection, ct, new(Subscription: true));
        var secret = RandomNumberGenerator.GetBytes(32);
        try
        {
            await using var tx = await connection.BeginTransactionAsync(ct);
            await using var handoff = new NpgsqlCommand("select pg_catalog.pg_advisory_xact_lock_shared($1,$2)", connection, tx)
            {
                CommandTimeout = 5
            };
            handoff.Parameters.AddWithValue(PublicationLocks.HandoffClass);
            handoff.Parameters.AddWithValue(PublicationLocks.HandoffObject);
            await handoff.ExecuteNonQueryAsync(ct);

            await using var target = new NpgsqlCommand("""
                select 1 from public.site_subscription where email_key=$1 and channel=$2 and enabled for update
                """, connection, tx);
            target.Parameters.AddWithValue(emailKey);
            target.Parameters.AddWithValue(channel);
            if (await target.ExecuteScalarAsync(ct) is not 1)
                throw new InvalidOperationException("A cancellation proof could not be issued for the provided preference.");

            await using var grant = new NpgsqlCommand("""
                update public.site_subscription set proof_digest=$3, proof_expires_at=clock_timestamp()+$4
                where email_key=$1 and channel=$2 and enabled
                """, connection, tx);
            grant.Parameters.AddWithValue(emailKey);
            grant.Parameters.AddWithValue(channel);
            grant.Parameters.AddWithValue(SHA256.HashData(secret));
            grant.Parameters.AddWithValue(SubscriptionIdentity.ProofLifetime);
            if (await grant.ExecuteNonQueryAsync(ct) != 1)
                throw new InvalidOperationException("A cancellation proof could not be issued for the provided preference.");
            await tx.CommitAsync(ct);
            Console.WriteLine(Convert.ToHexStringLower(secret));
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }

    private static ArgumentException InvalidEmail() => new("Provide one valid ASCII email address on standard input.");
}
