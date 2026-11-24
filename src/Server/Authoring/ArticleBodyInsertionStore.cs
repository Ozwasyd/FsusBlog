namespace FsusBlog.V2.Server.Authoring;

internal sealed record ArticleBodyInsertionWitness(int Offset, int Length, byte[] SourceDigest, byte[] BodyDigest,
    IReadOnlyList<BodyInsertion>? Insertions = null, IReadOnlyList<BodyEdit>? Edits = null);

internal static class ArticleBodyInsertionStore
{
    internal static ArticleBodyInsertionWitness? Prepare(string source, string body, int offset, int length)
    {
        if (!Applies(source, body, offset, length))
            throw new BusinessException(Rejection.Invalid, "The saved body is not the supplied source insertion.");
        return Unique(source, body, offset, length) ? new(offset, length, Digest(source), Digest(body)) : null;
    }

    internal static ArticleBodyInsertionWitness? PrepareSequence(string source, string body, IReadOnlyList<BodyInsertion> insertions)
    {
        if (!TryReplay(source, body, insertions, out var unique))
            throw new BusinessException(Rejection.Invalid, "The saved body is not the supplied source insertion sequence.");
        return unique ? new(insertions[0].Offset, insertions[0].Length, Digest(source), Digest(body), insertions) : null;
    }

    internal static ArticleBodyInsertionWitness? PrepareEdits(string source, string body, IReadOnlyList<BodyEdit> edits)
    {
        if (!TryReplayEdits(source, body, edits, out var unique))
            throw new BusinessException(Rejection.Invalid, "The saved body is not the supplied source edit sequence.");
        // An ambiguous edit returning to the same text must block the identity fallback.
        return unique || source == body ? new(0, 0, Digest(source), Digest(body), Edits: edits) : null;
    }

    internal static async Task Record(NpgsqlConnection db, NpgsqlTransaction tx, int id, long revision, long source,
        ArticleBodyInsertionWitness witness, CancellationToken ct)
    {
        if (witness.Edits is { } edits)
        {
            // Older admitted physical schemas still save the valid draft.
            if (!await CurrentSchema.HasArticleBodyEditsAsync(db, tx, ct)) return;
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.article_body_insertion
                    (article_id,revision,source_revision,source_digest,body_digest,operations,edit_texts)
                values ($1,$2,$3,$4,$5,$6,$7)
                """, id, revision, source, witness.SourceDigest, witness.BodyDigest,
                edits.SelectMany(edit => new[] { edit.Offset, edit.RemovedLength }).ToArray(),
                edits.Select(edit => edit.Insert).ToArray());
            return;
        }
        if (witness.Insertions is { } operations)
        {
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.article_body_insertion
                    (article_id,revision,source_revision,offset_utf16,length_utf16,source_digest,body_digest,operations)
                values ($1,$2,$3,$4,$5,$6,$7,$8)
                """, id, revision, source, witness.Offset, witness.Length, witness.SourceDigest, witness.BodyDigest,
                operations.SelectMany(operation => new[] { operation.Offset, operation.Length }).ToArray());
            return;
        }
        if (!await CurrentSchema.HasArticleBodyInsertionAsync(db, tx, ct)) return;
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_body_insertion
                (article_id,revision,source_revision,offset_utf16,length_utf16,source_digest,body_digest)
            values ($1,$2,$3,$4,$5,$6,$7)
            """, id, revision, source, witness.Offset, witness.Length, witness.SourceDigest, witness.BodyDigest);
    }

    internal static async Task<DraftRevisionBodyInsertion> Read(NpgsqlConnection db, NpgsqlTransaction tx, int id,
        long revision, long sourceRevision, CancellationToken ct)
    {
        var absent = new DraftRevisionBodyInsertion(id, revision, sourceRevision, false, 0, 0, "", "", "", "");
        if (sourceRevision != revision - 1 || !await CurrentSchema.HasArticleBodyInsertionAsync(db, tx, ct)) return absent;
        var legacyOnly = await CurrentSchema.HasArticleBodyEditsAsync(db, tx, ct) ? "and e.edit_texts is null" : "";

        await using var read = SqlCommands.Create(db, tx, $"""
            select e.offset_utf16,e.length_utf16,e.source_digest,e.body_digest,prior.body,head.body
            from public.article_body_insertion e
            join public.article_revision prior on prior.article_id=e.article_id and prior.revision=e.source_revision
            join public.article_revision head on head.article_id=e.article_id and head.revision=e.revision
            where e.article_id=$1 and e.revision=$2 and e.source_revision=$3
                and e.offset_utf16 is not null and e.length_utf16 is not null {legacyOnly}
            """, id, revision, sourceRevision);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) return absent;
        var offset = row.GetInt32(0);
        var length = row.GetInt32(1);
        var sourceDigest = row.GetFieldValue<byte[]>(2);
        var bodyDigest = row.GetFieldValue<byte[]>(3);
        var source = row.GetString(4);
        var body = row.GetString(5);
        if (!Applies(source, body, offset, length) || !Unique(source, body, offset, length) ||
            !CryptographicOperations.FixedTimeEquals(sourceDigest, Digest(source)) ||
            !CryptographicOperations.FixedTimeEquals(bodyDigest, Digest(body)))
            return absent;
        return new(id, revision, sourceRevision, true, offset, length, Convert.ToHexStringLower(sourceDigest),
            Convert.ToHexStringLower(bodyDigest), source, body);
    }

    internal static async Task<DraftRevisionBodyInsertionChain> ReadChain(NpgsqlConnection db, NpgsqlTransaction tx, int id,
        long revision, long sourceRevision, CancellationToken ct)
    {
        var chain = await ReadVerifiedChain(db, tx, id, revision, sourceRevision, includeEdits: false, ct);
        return chain is null ? new(id, revision, sourceRevision, false, "", "", []) :
            new(id, revision, sourceRevision, true, chain.Source, chain.Body,
                chain.Edges.Select(edge => new DraftRevisionBodyInsertionEdge(edge.SourceDigest, edge.Digest, edge.Insertions)).ToArray());
    }

    internal static async Task<DraftRevisionBodyEditChain> ReadEditChain(NpgsqlConnection db, NpgsqlTransaction tx, int id,
        long revision, long sourceRevision, CancellationToken ct)
    {
        var chain = await ReadVerifiedChain(db, tx, id, revision, sourceRevision, includeEdits: true, ct);
        return chain is null ? new(id, revision, sourceRevision, false, "", "", []) :
            new(id, revision, sourceRevision, true, chain.Source, chain.Body,
                chain.Edges.Select(edge => new DraftRevisionBodyEditEdge(edge.SourceDigest, edge.Digest, edge.Edits)).ToArray());
    }

    private static async Task<SavedBodyChain?> ReadVerifiedChain(NpgsqlConnection db, NpgsqlTransaction tx, int id,
        long revision, long sourceRevision, bool includeEdits, CancellationToken ct)
    {
        if (revision - sourceRevision > WireLimits.ArticleBodyInsertionChainEdges) return null;
        var hasWitness = await CurrentSchema.HasArticleBodyInsertionAsync(db, tx, ct);
        var hasOperations = hasWitness && await CurrentSchema.HasArticleBodyInsertionOperationsAsync(db, tx, ct);
        var hasEdits = hasOperations && await CurrentSchema.HasArticleBodyEditsAsync(db, tx, ct);
        var coordinates = hasWitness
            ? "e.source_revision,e.offset_utf16,e.length_utf16,e.source_digest,e.body_digest"
            : "null::bigint,null::int,null::int,null::bytea,null::bytea";
        var operationsColumn = hasOperations ? "e.operations" : "null::integer[]";
        var editText = hasEdits && includeEdits
            ? $"case when octet_length(array_to_string(e.edit_texts,'')) <= {WireLimits.BodyBytes} then e.edit_texts end"
            : "null::text[]";
        var hasEdit = hasEdits ? "e.edit_texts is not null" : "false";
        var join = hasWitness ? "left join public.article_body_insertion e on e.article_id=r.article_id and e.revision=r.revision" : "";
        await using var read = SqlCommands.Create(db, tx, $"""
            select r.revision,r.body,{coordinates},{operationsColumn},{editText},{hasEdit}
            from public.article_revision r {join}
            where r.article_id=$1 and r.revision between $2 and $3
            order by r.revision
            """, id, sourceRevision, revision);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct) || row.GetInt64(0) != sourceRevision) return null;
        var source = row.GetString(1);
        if (Encoding.UTF8.GetByteCount(source) > WireLimits.BodyBytes) return null;
        var previousBody = source;
        var previousDigest = Digest(source);
        var previousRevision = sourceRevision;
        var edges = new List<SavedBodyEdge>((int)(revision - sourceRevision));
        var bytesRemaining = WireLimits.BodyBytes;

        while (await row.ReadAsync(ct))
        {
            var headRevision = row.GetInt64(0);
            var headBody = row.GetString(1);
            if (headRevision != previousRevision + 1 || Encoding.UTF8.GetByteCount(headBody) > WireLimits.BodyBytes)
                return null;
            var equal = string.Equals(previousBody, headBody, StringComparison.Ordinal);
            var headDigest = equal ? previousDigest : Digest(headBody);
            var recordedEdit = row.GetBoolean(9);
            if (!recordedEdit && !row.IsDBNull(2) && (row.IsDBNull(3) || row.IsDBNull(4))) return null;
            IReadOnlyList<BodyInsertion> insertions = [];
            IReadOnlyList<BodyEdit> edits = [];
            if (!equal || recordedEdit)
            {
                if (row.IsDBNull(2) || row.GetInt64(2) != previousRevision ||
                    !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(5), previousDigest) ||
                    !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(6), headDigest))
                    return null;
                if (recordedEdit)
                {
                    if (!includeEdits || !row.IsDBNull(3) || !row.IsDBNull(4) || row.IsDBNull(7) || row.IsDBNull(8))
                        return null;
                    var recorded = ReadEdits(row.GetFieldValue<int[]>(7), row.GetFieldValue<string[]>(8));
                    if (recorded is null || !TryReplayEdits(previousBody, headBody, recorded, out var unique) || !unique)
                        return null;
                    edits = recorded;
                }
                else
                {
                    var recorded = ReadInsertions(row);
                    if (recorded is null) return null;
                    var converted = includeEdits ? new BodyEdit[recorded.Length] : null;
                    if (!TryReplay(previousBody, headBody, recorded, out var unique, converted) || !unique) return null;
                    insertions = recorded;
                    if (converted is not null) edits = converted;
                }
            }
            bytesRemaining -= edits.Sum(edit => Encoding.UTF8.GetByteCount(edit.Insert));
            if (bytesRemaining < 0) return null;
            edges.Add(new(Convert.ToHexStringLower(previousDigest), Convert.ToHexStringLower(headDigest), insertions, edits));
            previousBody = headBody;
            previousDigest = headDigest;
            previousRevision = headRevision;
        }
        return previousRevision == revision ? new(source, previousBody, edges) : null;
    }

    private static BodyInsertion[]? ReadInsertions(NpgsqlDataReader row)
    {
        if (row.IsDBNull(3) || row.IsDBNull(4)) return null;
        var offset = row.GetInt32(3);
        var length = row.GetInt32(4);
        if (row.IsDBNull(7)) return [new(offset, length)];
        var encoded = row.GetFieldValue<int[]>(7);
        if (encoded.Length is < 2 or > 2 * WireLimits.ArticleBodyInsertionOperations ||
            encoded.Length % 2 != 0 || encoded[0] != offset || encoded[1] != length)
            return null;
        var result = new BodyInsertion[encoded.Length / 2];
        for (var index = 0; index < result.Length; index++)
            result[index] = new(encoded[2 * index], encoded[2 * index + 1]);
        return result;
    }

    private static BodyEdit[]? ReadEdits(int[] coordinates, string[] insertedTexts)
    {
        if (insertedTexts.Length is < 1 or > WireLimits.ArticleBodyInsertionOperations ||
            coordinates.Length != 2 * insertedTexts.Length) return null;
        var result = new BodyEdit[insertedTexts.Length];
        for (var index = 0; index < result.Length; index++)
            result[index] = new(coordinates[2 * index], coordinates[2 * index + 1], insertedTexts[index]);
        return result;
    }

    private static bool TryReplayEdits(string source, string body, IReadOnlyList<BodyEdit> edits, out bool unique)
    {
        unique = true;
        if (edits.Count is < 1 or > WireLimits.ArticleBodyInsertionOperations) return false;
        var maximumLength = source.Length;
        var length = source.Length;
        var insertedBytes = 0;
        foreach (var edit in edits)
        {
            if (edit.Offset < 0 || edit.Offset > length || edit.RemovedLength < 0 || edit.RemovedLength > length - edit.Offset ||
                (edit.RemovedLength == 0 && edit.Insert.Length == 0) || edit.Insert.Contains('\0'))
                return false;
            length += edit.Insert.Length - edit.RemovedLength;
            insertedBytes += Encoding.UTF8.GetByteCount(edit.Insert);
            if (length > WireLimits.BodyBytes || insertedBytes > WireLimits.BodyBytes) return false;
            maximumLength = Math.Max(maximumLength, length);
        }
        if (length != body.Length || maximumLength > WireLimits.BodyBytes) return false;

        var scratch = new char[maximumLength];
        source.AsSpan().CopyTo(scratch);
        length = source.Length;
        foreach (var (offset, removedLength, insert) in edits)
        {
            var current = scratch.AsSpan(0, length);
            var end = offset + removedLength;
            if (!ValidBoundary(current, offset) || !ValidBoundary(current, end)) return false;

            // More than one offset can explain the same splice only when an adjacent
            // offset can replay it. Decline evidence instead of guessing provenance.
            if (offset > 0 && current[end - 1] == (insert.Length == 0 ? current[offset - 1] : insert[^1]) ||
                end < length && current[offset] == (insert.Length == 0 ? current[end] : insert[0]) ||
                current[offset..end].SequenceEqual(insert))
                unique = false;

            current[end..].CopyTo(scratch.AsSpan(offset + insert.Length));
            insert.AsSpan().CopyTo(scratch.AsSpan(offset));
            length += insert.Length - removedLength;
            var next = scratch.AsSpan(0, length);
            if (!ValidBoundary(next, offset) || !ValidBoundary(next, offset + insert.Length)) return false;
        }
        return scratch.AsSpan(0, length).SequenceEqual(body);
    }

    private sealed record SavedBodyChain(string Source, string Body, IReadOnlyList<SavedBodyEdge> Edges);
    private sealed record SavedBodyEdge(string SourceDigest, string Digest, IReadOnlyList<BodyInsertion> Insertions,
        IReadOnlyList<BodyEdit> Edits);

    private static bool TryReplay(string source, string body, IReadOnlyList<BodyInsertion> insertions, out bool unique,
        BodyEdit[]? converted = null)
    {
        unique = true;
        if (insertions.Count is < 1 or > WireLimits.ArticleBodyInsertionOperations) return false;
        if (insertions.Count == 1)
        {
            var (offset, length) = insertions[0];
            if (!Applies(source, body, offset, length)) return false;
            unique = Unique(source, body, offset, length);
            if (converted is not null) converted[0] = new(offset, 0, body.Substring(offset, length));
            return true;
        }

        // Reverse explicit operations in a single scratch buffer. Removing an inserted
        // slice recovers the exact intermediate source for the next boundary/ambiguity check.
        var scratch = body.ToCharArray();
        var current = scratch.AsSpan();
        for (var index = insertions.Count - 1; index >= 0; index--)
        {
            var (offset, length) = insertions[index];
            if (offset < 0 || length <= 0 || offset > current.Length || length > current.Length - offset) return false;
            var end = offset + length;
            if (!ValidBoundary(current, offset) || !ValidBoundary(current, end)) return false;
            if ((offset > 0 && current[offset - 1] == current[end - 1]) ||
                (end < current.Length && current[end] == current[offset]))
                unique = false;
            if (converted is not null) converted[index] = new(offset, 0, new string(current[offset..end]));
            current[end..].CopyTo(current[offset..]);
            current = current[..(current.Length - length)];
            if (!ValidBoundary(current, offset)) return false;
        }
        return source.AsSpan().SequenceEqual(current);
    }

    private static bool Applies(string source, string body, int offset, int length) =>
        length > 0 && length == body.Length - source.Length && ValidBoundary(source, offset) &&
        ValidBoundary(body, offset) && ValidBoundary(body, offset + length) &&
        source.AsSpan(0, offset).SequenceEqual(body.AsSpan(0, offset)) &&
        source.AsSpan(offset).SequenceEqual(body.AsSpan(offset + length));

    // After exact replay, another possible insertion coordinate exists only if the insertion can shift
    // one code unit in either direction. Decline even when that shift crosses an invalid boundary.
    private static bool Unique(string source, string body, int offset, int length) =>
        (offset == 0 || source[offset - 1] != body[offset + length - 1]) &&
        (offset == source.Length || source[offset] != body[offset]);

    private static bool ValidBoundary(ReadOnlySpan<char> value, int offset) =>
        offset >= 0 && offset <= value.Length && (offset == 0 || offset == value.Length ||
            !(char.IsHighSurrogate(value[offset - 1]) && char.IsLowSurrogate(value[offset])) &&
            !(value[offset - 1] == '\r' && value[offset] == '\n'));

    private static byte[] Digest(string text) => SHA256.HashData(Encoding.UTF8.GetBytes(text));
}
