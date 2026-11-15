using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.V2.Server.Content;

internal sealed class PublicationCheckpointArchive(Uri? origin, TimeProvider clock, PublicationCheckpointArchive.Snapshot? snapshot)
{
    internal const string Prefix = "/integrity/v2/checkpoints";
    internal const string Limit = "publication-proof";
    private const string Json = "application/json; charset=utf-8";
    private const int MaxFileBytes = 1_048_576;
    private const int MaxDays = 366;
    private const int MaxBridge = 4096;

    internal sealed record Inclusion(string Day, byte[] EntrySha256, string Proof);
    internal sealed record Day(string Checkpoint, byte[] Response);
    internal sealed record Snapshot(byte[] Head, byte[] Latest, IReadOnlyDictionary<string, Day> Days,
        IReadOnlyDictionary<long, Inclusion> Inclusions, DateTimeOffset EarliestClock);

    internal static PublicationCheckpointArchive? Read(IConfiguration configuration, IntegrityKeys publicKeys, string? origin,
        string dist, TimeProvider clock)
    {
        var settings = configuration.GetSection("IntegrityProof:CheckpointArchive");
        var enabled = settings["Enabled"];
        if (enabled is null || (bool.TryParse(enabled, out var value) && !value)) return null;
        var site = origin is null ? null : new Uri(origin);
        try
        {
            if (!bool.TryParse(enabled, out var explicitOptIn) || !explicitOptIn || site is null) throw new FormatException();
            var anchor = PublicationHeadAnchor.Parse(settings["CurrentAnchor"]);
            if (anchor is null || anchor.Sequence <= 0) throw new FormatException();
            var pinnedHash = Digest(settings["Sha256"]);
            var bytes = ReadOnlyFile(settings["Path"], dist);
            if (!SHA256.HashData(bytes).AsSpan().SequenceEqual(pinnedHash)) throw new FormatException();
            var keys = PublicationProofKeys.ReadPublicKeys(configuration.GetSection("IntegrityProof:Signing"), publicKeys);
            return new(site, clock, Validate(bytes, anchor, keys, origin!, clock.GetUtcNow()));
        }
        catch (Exception error) when (error is FormatException or InvalidOperationException or IOException or UnauthorizedAccessException or
            ArgumentException or CryptographicException or JsonException or KeyNotFoundException or PlatformNotSupportedException)
        {
            return new(site, clock, null);
        }
    }

    internal void Map(WebApplication app)
    {
        if (snapshot is null) app.Logger.LogWarning("The opted-in daily publication checkpoint archive could not be verified.");
        app.MapGet(Prefix + "/head.json", (HttpContext ctx) => ReadResponse(ctx, null)).RequireRateLimiting(Limit);
        app.MapGet(Prefix + "/latest.json", (HttpContext ctx) => ReadResponse(ctx, null, latest: true)).RequireRateLimiting(Limit);
        app.MapGet(Prefix + "/daily/{day}.json", (HttpContext ctx, string day) => ReadResponse(ctx, day)).RequireRateLimiting(Limit);
    }

    internal byte[]? FindInclusion(DateTimeOffset issuedAt, long sequence, byte[] entrySha256)
    {
        if (snapshot is null || clock.GetUtcNow() < snapshot.EarliestClock) throw new PublicUnavailableException();
        return snapshot.Inclusions.TryGetValue(sequence, out var inclusion) &&
            issuedAt.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) == inclusion.Day &&
            entrySha256.AsSpan().SequenceEqual(inclusion.EntrySha256)
            ? Bundle(snapshot.Days[inclusion.Day].Checkpoint, inclusion.Proof) : null;
    }

    private Task ReadResponse(HttpContext ctx, string? day, bool latest = false)
    {
        if (origin is null || !ctx.Request.IsHttps || !string.Equals(ctx.Request.Host.Value, origin.Authority, StringComparison.OrdinalIgnoreCase))
            return Status(StatusCodes.Status404NotFound);
        if (day is not null && !PublicationCheckpointV2.TryDay(day, out _)) return Status(StatusCodes.Status400BadRequest);
        if (snapshot is null || clock.GetUtcNow() < snapshot.EarliestClock) return Status(StatusCodes.Status503ServiceUnavailable);
        var response = day is not null ? snapshot.Days.GetValueOrDefault(day)?.Response : latest ? snapshot.Latest : snapshot.Head;
        return response is null ? Status(StatusCodes.Status404NotFound) : PublicResponse.Write(ctx, response, Json);

        Task Status(int status)
        {
            ctx.Response.StatusCode = status;
            return Task.CompletedTask;
        }
    }

    private static byte[] ReadOnlyFile(string? path, string dist)
    {
        if (path is null || !Path.IsPathFullyQualified(path) || path != Path.GetFullPath(path) ||
            Path.GetRelativePath(dist, path).Split(Path.DirectorySeparatorChar)[0] != "..") throw new FormatException();
        using var directory = NativeUnixFile.OpenDirectory(Path.GetDirectoryName(path)!);
        using var handle = NativeUnixFile.OpenFile(directory, Path.GetFileName(path), NativeUnixFile.FileReadFlags, out _) ??
            throw new IOException("Could not open the daily checkpoint archive.");
        const UnixFileMode writable = UnixFileMode.UserWrite | UnixFileMode.GroupWrite | UnixFileMode.OtherWrite;
        if (NativeUnixFile.RegularMode(handle) is not { } mode || (mode & writable) != 0) throw new FormatException();
        using var stream = new FileStream(handle, FileAccess.Read);
        var length = stream.Length;
        if (length is < 1 or > MaxFileBytes) throw new FormatException();
        var bytes = new byte[(int)length];
        stream.ReadExactly(bytes);
        if (stream.ReadByte() != -1) throw new FormatException();
        return bytes;
    }

    private static Snapshot Validate(byte[] bytes, PublicationHeadAnchor anchor, IReadOnlyDictionary<string, ProofPublicKey> keys,
        string origin, DateTimeOffset now)
    {
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 6 });
        var archive = document.RootElement;
        var version = archive.GetProperty("archiveVersion").GetInt32();
        if (version == 2) RequireFields(archive, "archiveVersion", "head", "bridgeReceiptSha256", "checkpoints");
        else if (version == 3) RequireFields(archive, "archiveVersion", "head", "bridgeReceiptSha256", "checkpoints", "inclusions");
        else throw new FormatException();
        var signedHead = archive.GetProperty("head");
        RequireFields(signedHead, "headVersion", "kind", "algorithm", "origin", "sequence", "entrySha256", "keyId", "keyVersion",
            "keySha256", "attestedAtUtc", "signature");
        if (signedHead.GetProperty("headVersion").GetInt32() != 2 || Text(signedHead, "kind") != "native-publication-log-head" ||
            Text(signedHead, "algorithm") != ArticlePublicationProofPayloadV2.Algorithm || Text(signedHead, "origin") != origin)
            throw new FormatException();
        var head = new PublicationTransparencyHeadV2(origin, Coordinate(signedHead, "sequence"), Digest(Text(signedHead, "entrySha256")),
            Text(signedHead, "keyId"), signedHead.GetProperty("keyVersion").GetInt32(), Digest(Text(signedHead, "keySha256")), Time(signedHead));
        VerifySignature(keys, signedHead, head.KeyId, head.KeyVersion, head.KeySha256, head.AttestedAt, head.Payload());
        VerifyBridge(archive.GetProperty("bridgeReceiptSha256"), head, anchor);
        var checkpoints = archive.GetProperty("checkpoints");
        if (checkpoints.GetArrayLength() is < 1 or > MaxDays) throw new FormatException();
        var days = new Dictionary<string, Day>(StringComparer.Ordinal);
        var signedDays = new Dictionary<string, PublicationCheckpointV2>(StringComparer.Ordinal);
        foreach (var node in checkpoints.EnumerateArray())
        {
            var checkpoint = ValidateDay(node, head, keys);
            var raw = node.GetRawText();
            if (!signedDays.TryAdd(checkpoint.ScopeKey, checkpoint)) throw new FormatException();
            days.Add(checkpoint.ScopeKey, new(raw, Bundle(raw, "null")));
        }
        var latest = signedDays.Values.OrderByDescending(checkpoint => checkpoint.AttestedAt)
            .ThenByDescending(checkpoint => checkpoint.ScopeKey, StringComparer.Ordinal).First();
        if (now < latest.AttestedAt) throw new FormatException();
        var inclusions = version == 3 ? ValidateInclusions(archive.GetProperty("inclusions"), signedDays) : [];
        return new(Encoding.UTF8.GetBytes(signedHead.GetRawText()), days[latest.ScopeKey].Response, days, inclusions, latest.AttestedAt);
    }

    private static Dictionary<long, Inclusion> ValidateInclusions(JsonElement array, IReadOnlyDictionary<string, PublicationCheckpointV2> days)
    {
        if (array.GetArrayLength() > PublicationCheckpointV2.MaxPrefixEntries) throw new FormatException();
        var inclusions = new Dictionary<long, Inclusion>();
        foreach (var node in array.EnumerateArray())
        {
            RequireFields(node, "scopeKey", "inclusion");
            var day = Text(node, "scopeKey");
            if (!days.TryGetValue(day, out var checkpoint)) throw new FormatException();
            var proof = node.GetProperty("inclusion");
            RequireFields(proof, "sequence", "position", "entrySha256", "siblings");
            var entry = new PublicationCheckpointEntry(Coordinate(proof, "sequence"), Digest(Text(proof, "entrySha256")));
            var siblings = proof.GetProperty("siblings");
            if (siblings.GetArrayLength() > 12 || !PublicationCheckpointTreeV2.VerifyDailyInclusion(checkpoint, entry,
                proof.GetProperty("position").GetInt32(), siblings.EnumerateArray().Select(sibling => Digest(sibling.GetString())).ToArray()) ||
                !inclusions.TryAdd(entry.Sequence, new(day, entry.EntrySha256, proof.GetRawText())))
                throw new FormatException();
        }
        return inclusions;
    }

    private static byte[] Bundle(string checkpoint, string inclusion) =>
        Encoding.UTF8.GetBytes("{\"checkpoint\":" + checkpoint + ",\"inclusion\":" + inclusion + "}");

    private static void VerifyBridge(JsonElement receipts, PublicationTransparencyHeadV2 source, PublicationHeadAnchor anchor)
    {
        if (anchor.Sequence < source.Sequence || anchor.Sequence - source.Sequence > MaxBridge ||
            receipts.GetArrayLength() != anchor.Sequence - source.Sequence) throw new FormatException();
        var sequence = source.Sequence;
        var hash = source.EntrySha256;
        foreach (var receipt in receipts.EnumerateArray())
            hash = PublicationTransparencyV2.EntryDigest(++sequence, hash, Digest(receipt.GetString()));
        if (!hash.AsSpan().SequenceEqual(anchor.Hash)) throw new FormatException();
    }

    private static PublicationCheckpointV2 ValidateDay(JsonElement node, PublicationTransparencyHeadV2 head,
        IReadOnlyDictionary<string, ProofPublicKey> keys)
    {
        RequireFields(node, "checkpointVersion", "kind", "checkpointKind", "algorithm", "origin", "scopeKey", "fromSequence", "toSequence",
            "entryCount", "rootSha256", "headSequence", "headEntrySha256", "keyId", "keyVersion", "keySha256", "attestedAtUtc", "signature");
        if (node.GetProperty("checkpointVersion").GetInt32() != 2 || Text(node, "kind") != "native-publication-checkpoint" ||
            Text(node, "checkpointKind") != "daily" || Text(node, "algorithm") != ArticlePublicationProofPayloadV2.Algorithm ||
            Text(node, "origin") != head.Origin || !PublicationCheckpointV2.TryDay(Text(node, "scopeKey"), out var day) ||
            head.AttestedAt < day.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc).AddDays(1)) throw new FormatException();
        var claim = new PublicationCheckpointV2(head.Origin, Text(node, "scopeKey"), Coordinate(node, "fromSequence", allowZero: true),
            Coordinate(node, "toSequence", allowZero: true), node.GetProperty("entryCount").GetInt32(), Digest(Text(node, "rootSha256")),
            Coordinate(node, "headSequence"), Digest(Text(node, "headEntrySha256")), Text(node, "keyId"), node.GetProperty("keyVersion").GetInt32(),
            Digest(Text(node, "keySha256")), Time(node), PublicationCheckpointKind.Daily);
        if (claim.HeadSequence != head.Sequence || !claim.HeadEntrySha256.AsSpan().SequenceEqual(head.EntrySha256) || claim.AttestedAt < head.AttestedAt)
            throw new FormatException();
        VerifySignature(keys, node, claim.KeyId, claim.KeyVersion, claim.KeySha256, claim.AttestedAt, claim.Payload());
        return claim;
    }

    private static void VerifySignature(IReadOnlyDictionary<string, ProofPublicKey> keys, JsonElement node, string id, int version,
        byte[] fingerprint, DateTimeOffset at, byte[] payload)
    {
        var encoded = Text(node, "signature");
        if (encoded.Length != 86 || !keys.TryGetValue(id, out var key) || key.Version != version ||
            !key.Fingerprint.AsSpan().SequenceEqual(fingerprint)) throw new FormatException();
        var signature = WebEncoders.Base64UrlDecode(encoded);
        if (WebEncoders.Base64UrlEncode(signature) != encoded || !key.VerifySignature(payload, at, signature)) throw new FormatException();
    }

    private static void RequireFields(JsonElement node, params string[] fields)
    {
        if (node.ValueKind != JsonValueKind.Object || node.EnumerateObject().Count() != fields.Length ||
            fields.Any(field => !node.TryGetProperty(field, out _))) throw new FormatException();
    }

    private static string Text(JsonElement node, string field) => node.GetProperty(field).GetString() ?? throw new FormatException();

    private static long Coordinate(JsonElement node, string field, bool allowZero = false)
    {
        var raw = Text(node, field);
        if (!long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out var value) || value < (allowZero ? 0 : 1) ||
            raw != value.ToString(CultureInfo.InvariantCulture)) throw new FormatException();
        return value;
    }

    private static DateTimeOffset Time(JsonElement node)
    {
        var raw = Text(node, "attestedAtUtc");
        if (!DateTimeOffset.TryParseExact(raw, "yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var value) ||
            raw != ArticlePublicationProofPayloadV2.Time(value)) throw new FormatException();
        return value;
    }

    private static byte[] Digest(string? raw)
    {
        if (raw is null || raw.Length != 64 || raw.Any(value => value is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            throw new FormatException();
        return Convert.FromHexString(raw);
    }
}
