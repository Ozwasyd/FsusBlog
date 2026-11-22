using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed record PublicationHeadAnchor(long Sequence, byte[] Hash)
{
    internal static PublicationHeadAnchor? Parse(string? value)
    {
        if (value is null) return null;
        if (value == "genesis") return new(0, new byte[32]);
        var separator = value.IndexOf(':');
        if (separator is > 0 and <= 19 && value.Length == separator + 65 &&
            long.TryParse(value.AsSpan(0, separator), NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) &&
            sequence > 0 && sequence.ToString(CultureInfo.InvariantCulture).AsSpan().SequenceEqual(value.AsSpan(0, separator)) &&
            value[(separator + 1)..].All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'))
            return new(sequence, Convert.FromHexString(value.AsSpan(separator + 1)));
        throw new InvalidOperationException("Public publication head anchor must be genesis or a positive sequence and lowercase SHA-256.");
    }
}

internal sealed class PublicationHead(PublicationProofKeys keys, PublicationHeadAnchor anchor)
{
    internal sealed record Snapshot(PublicationTransparency Tail, byte[] Signature, byte[]? Json)
    {
        internal bool Matches(PublicationTransparency other) =>
            Tail.Sequence == other.Sequence && Tail.Hash.AsSpan().SequenceEqual(other.Hash);
    }

    private Snapshot? _current;
    private (Snapshot Previous, Snapshot Candidate)? _pending;

    internal Snapshot? Current => Volatile.Read(ref _current);
    internal bool HasPendingCommit => _pending.HasValue;

    internal async Task<Snapshot?> Load(NpgsqlConnection db, NpgsqlTransaction tx, bool transparencyActive, CancellationToken ct)
    {
        if (!transparencyActive || !await CurrentSchema.HasPublicationHeadAsync(db, tx, ct)) return null;
        var tail = await PublicationTransparency.ReadHead(db, tx, ct);
        if (anchor.Sequence == 0)
        {
            if (tail.Sequence != 0) return null;
        }
        var attestation = await ReadAttestation(db, tx, tail, ct);
        if (attestation is null || (anchor.Sequence != 0 && !await VerifyPrefix(db, tx, tail, ct))) return null;
        return attestation;
    }

    internal void Publish(Snapshot? value) => Volatile.Write(ref _current, value);

    internal void Observe(PublicationTransparency tail)
    {
        if (Current is { } before && !before.Matches(tail)) Publish(null);
    }

    internal async Task<Snapshot?> Prepare(NpgsqlConnection db, NpgsqlTransaction tx, PublicationTransparency tail,
        DateTimeOffset issueTime, CancellationToken ct)
    {
        if (Current is not { } previous) return null;
        var key = keys.Current;
        if (!key.Allows(issueTime) || tail.Sequence <= previous.Tail.Sequence)
            throw new InvalidOperationException("Native head cannot attest a non-advancing publication ledger.");
        var claim = new PublicationTransparencyHeadV2(keys.Origin, tail.Sequence, tail.Hash, key.Id, key.Version, key.Fingerprint, issueTime);
        var signature = keys.Sign(claim.Payload());
        if (await SqlCommands.Execute(db, tx, ct, """
            insert into public.publication_transparency_head(singleton,seq,entry_sha256,origin,key_id,key_version,key_sha256,attested_at,signature)
            values(true,$1,$2,$3,$4,$5,$6,$7,$8)
            on conflict(singleton) do update set seq=excluded.seq,entry_sha256=excluded.entry_sha256,
              origin=excluded.origin,key_id=excluded.key_id,key_version=excluded.key_version,key_sha256=excluded.key_sha256,
              attested_at=excluded.attested_at,signature=excluded.signature
            where (publication_transparency_head.seq,publication_transparency_head.entry_sha256,publication_transparency_head.signature)=($9,$10,$11)
            """, tail.Sequence, tail.Hash, keys.Origin, key.Id, key.Version, key.Fingerprint, issueTime, signature,
            previous.Tail.Sequence, previous.Tail.Hash, previous.Signature) != 1)
            throw new InvalidOperationException("The durable publication head changed outside the configured writer.");
        return Encode(claim, signature);
    }

    internal void BeginCommit(Snapshot candidate)
    {
        _pending = (Current ?? throw new InvalidOperationException("The current publication head is unavailable."), candidate);
        Publish(null);
    }

    internal void CompleteCommit(Snapshot? value)
    {
        _pending = null;
        Publish(value);
    }

    internal async Task<Snapshot?> Recover(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        var pending = _pending ?? throw new InvalidOperationException("No publication head commit is pending.");
        var tail = await PublicationTransparency.ReadHead(db, tx, ct);
        var stored = await ReadAttestation(db, tx, tail, ct);
        if (stored is null) return null;
        return IsSame(stored, pending.Previous) || IsSame(stored, pending.Candidate) ? stored : null;
    }

    private static bool IsSame(Snapshot observed, Snapshot expected) =>
        observed.Matches(expected.Tail) && observed.Signature.AsSpan().SequenceEqual(expected.Signature);

    private async Task<bool> VerifyPrefix(NpgsqlConnection db, NpgsqlTransaction tx, PublicationTransparency tail, CancellationToken ct)
    {
        if (anchor.Sequence > tail.Sequence) return false;
        await using var read = Store.Sql(db, tx, """
            select seq,prev_sha256,receipt_sha256,entry_sha256 from public.article_publication_transparency
            where seq between $1 and $2 order by seq
            """, anchor.Sequence, tail.Sequence);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || row.GetInt64(0) != anchor.Sequence ||
            !anchor.Hash.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(3))) return false;
        var sequence = anchor.Sequence;
        var hash = anchor.Hash;
        while (await row.ReadAsync(ct))
        {
            ++sequence;
            if (row.GetInt64(0) != sequence || !hash.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(1))) return false;
            hash = PublicationTransparencyV2.EntryDigest(sequence, hash, row.GetFieldValue<byte[]>(2));
            if (!hash.AsSpan().SequenceEqual(row.GetFieldValue<byte[]>(3))) return false;
        }
        return sequence == tail.Sequence && hash.AsSpan().SequenceEqual(tail.Hash);
    }

    private async Task<Snapshot?> ReadAttestation(NpgsqlConnection db, NpgsqlTransaction tx, PublicationTransparency tail, CancellationToken ct)
    {
        await using var read = Store.Sql(db, tx, """
            select h.seq,h.entry_sha256,h.origin,h.key_id,h.key_version,h.key_sha256,h.attested_at,h.signature,k.revoked_at,k.compromised_at
            from public.publication_transparency_head h join public.publication_proof_key k on k.key_id=h.key_id
            where h.singleton
            """);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return tail.Sequence == 0 ? new(tail, [], null) : null;
        var claim = new PublicationTransparencyHeadV2(row.GetString(2), row.GetInt64(0), row.GetFieldValue<byte[]>(1),
            row.GetString(3), row.GetInt32(4), row.GetFieldValue<byte[]>(5), row.GetDateTime(6));
        if (claim.Sequence != tail.Sequence || !claim.EntrySha256.AsSpan().SequenceEqual(tail.Hash) || claim.Origin != keys.Origin ||
            !keys.Keys.TryGetValue(claim.KeyId, out var key) || key.Version != claim.KeyVersion ||
            !claim.KeySha256.AsSpan().SequenceEqual(key.Fingerprint) || !row.IsDBNull(9) ||
            (!row.IsDBNull(8) && claim.AttestedAt >= row.GetDateTime(8)))
            return null;
        try
        {
            var signature = row.GetFieldValue<byte[]>(7);
            return key.VerifySignature(claim.Payload(), claim.AttestedAt, signature) ? Encode(claim, signature) : null;
        }
        catch (Exception error) when (error is ArgumentException or CryptographicException)
        {
            return null;
        }
    }

    private static Snapshot Encode(PublicationTransparencyHeadV2 claim, byte[] signature) =>
        new(new(claim.Sequence, claim.EntrySha256), signature, JsonSerializer.SerializeToUtf8Bytes(PublicationHeadJson.Project(claim, signature)));
}
