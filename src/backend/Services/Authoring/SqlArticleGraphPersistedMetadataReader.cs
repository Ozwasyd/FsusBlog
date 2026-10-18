using System.Data;
using System.Diagnostics;
using System.Globalization;

using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.ArticleEmbeds;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

internal enum ArticleGraphMetadataSelection
{
    Current,
    Publication
}

internal sealed record ArticleGraphPersistedMetadataRequest(
    AuthorArticlePinOwner Owner,
    Guid RequestId,
    IReadOnlyList<ArticleRelationArticleCoordinate> Candidates,
    ArticleGraphMetadataSelection Selection,
    int RemainingReadOperations,
    int RemainingMilliseconds);

internal sealed record ArticleGraphPersistedMetadataFact(
    int ArticleId,
    long CurrentRevisionId,
    long? CurrentPublicationId,
    int? PublicationNo,
    long? PublicationRevisionId,
    int? PublicationRevisionNo,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    ArticleRelationRevisionCoordinate Source,
    string Title,
    ArticleStatus Status);

internal sealed record ArticleGraphPersistedMetadataResult(
    IReadOnlyList<ArticleGraphPersistedMetadataFact> Facts,
    int ReadOperations,
    int RemainingMilliseconds,
    AuthorArticlePinPermissionSnapshot Permission);

/// <summary>
/// Reads authorized persisted numeric memberships and exact source coordinates on the injected
/// caller client. It grants no relation/publication admission and interprets no graph filters.
/// Missing facts, drift, snapshots and exhausted allocations return no partial metadata.
/// </summary>
/// <remarks>
/// The native adapter consumes the canonical exact batch API on the same caller session,
/// without a per-article coordinate loop or parallel coordinate store. The caller retains
/// transaction, connection and commit ownership. Awaiting command/reader disposal establishes
/// completion before return; cancellation response and cleanup can still exceed the allocation.
/// The permission supplier links request and prior ADO cancellation and awaits reader completion.
/// The allocation limits fact acceptance and requests cancellation; mandatory command/reader
/// completion is awaited before relinquishing the borrowed client, even after that deadline.
/// Cleanup is not promised to finish within the allocation. Only the concrete, same-client
/// permission supplier can bind native allocated reads. A closed/auto-closing session or another
/// supplier remains unavailable. This does not grant full Graph privacy or host admission;
/// the original Graph orchestration stays fail closed. No pending work is abandoned.
/// </remarks>
public sealed class SqlArticleGraphPersistedMetadataReader
{
    internal const int MaxCandidates = ArticleRelationSourceCoordinateAuthority.MaxRevisionReadBatchSize;
    internal const int MaxTags = 256;
    private readonly IAuthorArticlePinPermissionProjectionProvider _permissions;
    private readonly Func<CancellationToken, Task<SessionStamp>> _probe;
    private readonly Func<int[], ArticleGraphMetadataSelection, CancellationToken, Task<Row[]>> _readRows;
    private readonly Func<Row[], CancellationToken, Task<ArticleRelationRevisionCoordinate[]>> _readCoordinates;
    private readonly int _maximumCandidates;
    private readonly Func<SqlArticleGraphPersistedMetadataReader>? _newRead;
    private readonly bool _boundedPermissionReadsAvailable = true;
    private readonly GraphNativePermissionRead? _nativeRead;

    /// <summary>Uses the existing permission and canonical coordinate authorities without writing or registering them.</summary>
    public SqlArticleGraphPersistedMetadataReader(ISqlSugarClient db,
        ArticleRelationSourceCoordinateAuthority coordinates,
        IAuthorArticlePinPermissionProjectionProvider permissions)
        : this(permissions, null!, null!, null!)
    {
        _boundedPermissionReadsAvailable = permissions is SqlAuthorArticlePinPermissionAuthority native && native.IsBoundTo(db);
        _newRead = () =>
        {
            var binding = new GraphNativePermissionRead(db, (SqlAuthorArticlePinPermissionAuthority)permissions);
            var session = new CallerSession(db, binding);
            return new(permissions, session.ProbeAsync, session.ReadRowsAsync, async (rows, token) =>
            {
                var pairs = Array.AsReadOnly(rows.Select(static row =>
                    (ArticleId: row.ArticleId, RevisionId: row.SelectedRevisionId)).ToArray());
                binding.Validate(token);
                IReadOnlyList<ArticleRelationRevisionCoordinate> saved = await coordinates.ReadRevisionsAsync(
                    db, pairs, token).ConfigureAwait(false);
                binding.Validate(token);
                return Copy(saved, rows.Length, token);
            }, nativeRead: binding);
        };
    }

    // Controlled ordinary tests exercise the algorithm without supplying a second production authority.
    internal SqlArticleGraphPersistedMetadataReader(IAuthorArticlePinPermissionProjectionProvider permissions,
        Func<CancellationToken, Task<SessionStamp>> probe,
        Func<int[], ArticleGraphMetadataSelection, CancellationToken, Task<Row[]>> readRows,
        Func<Row[], CancellationToken, Task<ArticleRelationRevisionCoordinate[]>> readCoordinates,
        int maximumCandidates = MaxCandidates,
        GraphNativePermissionRead? nativeRead = null)
    {
        _permissions = permissions;
        _probe = probe;
        _readRows = readRows;
        _readCoordinates = readCoordinates;
        _maximumCandidates = maximumCandidates;
        _nativeRead = nativeRead;
    }

    internal SqlArticleGraphPersistedMetadataReader BeginRead()
        => _boundedPermissionReadsAvailable && _newRead is not null ? _newRead() : this;

    internal async Task<ArticleGraphPersistedMetadataResult?> ReadAsync(
        ArticleGraphPersistedMetadataRequest request, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_boundedPermissionReadsAvailable)
        {
            return null;
        }
        if (_newRead is not null)
        {
            return await _newRead().ReadAsync(request, cancellationToken).ConfigureAwait(false);
        }
        // Only this invocation's acquired/captured prior token may explain its refusal.
        CancellationToken priorCancellation = default;
        try
        {
            AuthorArticlePinContract.ValidateOwner(request.Owner);
            AuthorArticlePinContract.ValidateRequestId(request.RequestId);
            ArticleRelationArticleCoordinate[] candidates = Copy(request.Candidates, _maximumCandidates, cancellationToken);
            Require(Enum.IsDefined(request.Selection)
                && request.RemainingReadOperations is >= 1 and <= 4096
                && request.RemainingMilliseconds is >= 1 and <= 250
                && candidates.All(static candidate => candidate.ArticleId > 0
                    && ArticleEmbedTargetCodec.IsPortableArticleIdentity(candidate.ArticleIdentity))
                && candidates.Select(static candidate => candidate.ArticleId).Distinct().Count() == candidates.Length
                && candidates.Select(static candidate => candidate.ArticleIdentity).Distinct(StringComparer.Ordinal).Count() == candidates.Length);
            Array.Sort(candidates, static (first, second) => first.ArticleId.CompareTo(second.ArticleId));
            var budget = new ReadBudget(request.RemainingReadOperations, request.RemainingMilliseconds);
            // Reserve the complete two-pass allocation before touching the server or permission source.
            budget.RequireCapacity(26);
            using IDisposable? custody = _nativeRead?.Enter(cancellationToken, out priorCancellation);
            using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(
                cancellationToken, priorCancellation);
            deadline.CancelAfter(budget.RemainingTime());
            CancellationToken token = deadline.Token;
            SessionStamp initial = await ProbeAsync(budget, null, token).ConfigureAwait(false);
            SessionStamp previous = await ProbeAsync(budget, initial, token).ConfigureAwait(false);
            AuthorArticlePinPermissionSnapshot context = await PermissionAsync(request, [], budget, token).ConfigureAwait(false);
            int[] ids = candidates.Select(static candidate => candidate.ArticleId).ToArray();
            AuthorArticlePinPermissionSnapshot permission = await PermissionAsync(request, ids, budget, token).ConfigureAwait(false);
            Require(SameContext(context, permission));
            int[] authorized = permission.Decisions.Where(static decision => decision.CanProject && decision.CanOpen)
                .Select(static decision => decision.ArticleId).Order().ToArray();
            Row[]? firstRows = null;
            ArticleRelationRevisionCoordinate[]? firstSources = null;
            for (int pass = 0; pass < 2; pass++)
            {
                previous = await ProbeAsync(budget, previous, token).ConfigureAwait(false);
                Row[] rows = [];
                ArticleRelationRevisionCoordinate[] sources = [];
                if (authorized.Length != 0)
                {
                    budget.Take();
                    rows = Copy(await _readRows(authorized, request.Selection, token).ConfigureAwait(false), authorized.Length, token);
                    Array.Sort(rows, static (first, second) => first.ArticleId.CompareTo(second.ArticleId));
                    ValidateRows(rows, authorized, request.Selection);
                    previous = await ProbeAsync(budget, previous, token).ConfigureAwait(false);
                    budget.Take();
                    sources = Copy(await _readCoordinates(rows, token).ConfigureAwait(false), rows.Length, token);
                    Array.Sort(sources, static (first, second) => first.ArticleId.CompareTo(second.ArticleId));
                    ValidateSources(rows, sources, candidates);
                    previous = await ProbeAsync(budget, previous, token).ConfigureAwait(false);
                }
                AuthorArticlePinPermissionSnapshot fresh = await PermissionAsync(request, ids, budget, token).ConfigureAwait(false);
                Require(SamePermission(permission, fresh));
                previous = await ProbeAsync(budget, previous, token).ConfigureAwait(false);
                if (pass == 0)
                {
                    firstRows = rows;
                    firstSources = sources;
                }
                else
                {
                    Require(firstRows!.SequenceEqual(rows) && firstSources!.SequenceEqual(sources));
                }
            }
            var facts = Array.AsReadOnly(firstRows!.Select((row, index) => new ArticleGraphPersistedMetadataFact(
                row.ArticleId, row.CurrentRevisionId, row.CurrentPublicationId,
                row.PublicationNo, row.PublicationRevisionId, row.PublicationRevisionNo, row.SelectedCategoryId,
                Array.AsReadOnly(ParseTags(row.SelectedTags)), firstSources![index], row.Title, row.Status)).ToArray());
            token.ThrowIfCancellationRequested();
            int remainingMilliseconds = (int)budget.RemainingTime().TotalMilliseconds;
            Require(remainingMilliseconds > 0);
            return new(facts, budget.Operations, remainingMilliseconds, permission);
        }
        catch (Exception)
        {
            cancellationToken.ThrowIfCancellationRequested();
            priorCancellation.ThrowIfCancellationRequested();
            return null;
        }
    }

    private async Task<SessionStamp> ProbeAsync(ReadBudget budget, SessionStamp? previous, CancellationToken token)
    {
        budget.Take();
        SessionStamp stamp = await _probe(token).ConfigureAwait(false);
        Require(stamp.BackendId > 0 && !string.IsNullOrEmpty(stamp.TransactionId)
            && stamp.Isolation == IsolationLevel.ReadCommitted && !stamp.HasAmbientTransaction);
        if (previous is not null)
        {
            Require(previous.BackendId == stamp.BackendId && previous.CallerTransaction == stamp.CallerTransaction
                && (stamp.CallerTransaction
                    ? previous.TransactionId == stamp.TransactionId
                    : previous.TransactionId != stamp.TransactionId));
        }
        token.ThrowIfCancellationRequested();
        return stamp;
    }

    private async Task<AuthorArticlePinPermissionSnapshot> PermissionAsync(ArticleGraphPersistedMetadataRequest request,
        int[] ids, ReadBudget budget, CancellationToken token)
    {
        // The original permission adapter reads at most session/principal plus article state.
        // Reserve both SQL operations, including the empty-context call's conservative allowance.
        var permissionRequest = new AuthorArticlePinPermissionBatchRequest(
            request.Owner, request.RequestId, Array.AsReadOnly(ids.ToArray()));
        AuthorArticlePinPermissionSnapshot value;
        if (_nativeRead is null)
        {
            budget.Take(2);
            value = await _permissions.ResolveAsync(permissionRequest, token).ConfigureAwait(false);
        }
        else
        {
            value = await _nativeRead.ResolveAsync(permissionRequest, () => budget.Take(), token).ConfigureAwait(false);
        }
        token.ThrowIfCancellationRequested();
        value = value with
        {
            Decisions = Array.AsReadOnly(Copy(value.Decisions, ids.Length, token)
            .OrderBy(static decision => decision.ArticleId).ToArray())
        };
        Require(value.Status == AuthorArticlePinPermissionSnapshotStatus.Current && value.Owner == request.Owner
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.PermissionRevision)
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.SiteRevision)
            && AuthorArticlePinProjectionContract.IsRequiredRevisionReference(value.SessionRevision)
            && value.Decisions.Select(static decision => decision.ArticleId).SequenceEqual(ids)
            && value.Decisions.All(static decision => !(decision.CanProject && decision.CanOpen)
                || AuthorArticlePinProjectionContract.IsRequiredRevisionReference(decision.PermissionReference))
            && value.ContentDigest == AuthorArticlePinProjectionContract.ComputePermissionDigest(value));
        token.ThrowIfCancellationRequested();
        return value;
    }

    private static bool SameContext(AuthorArticlePinPermissionSnapshot first, AuthorArticlePinPermissionSnapshot second)
        => first.Owner == second.Owner && first.PermissionRevision == second.PermissionRevision
            && first.SiteRevision == second.SiteRevision && first.SessionRevision == second.SessionRevision;

    private static bool SamePermission(AuthorArticlePinPermissionSnapshot first, AuthorArticlePinPermissionSnapshot second)
        => SameContext(first, second) && first.Status == second.Status && first.ReasonCode == second.ReasonCode
            && first.ContentDigest == second.ContentDigest && first.Decisions.SequenceEqual(second.Decisions);

    private static void ValidateRows(Row[] rows, int[] ids, ArticleGraphMetadataSelection selection)
    {
        Require(rows.Select(static row => row.ArticleId).SequenceEqual(ids));
        foreach (Row row in rows)
        {
            Require(row.Title is { Length: <= 256 } && !row.IsDeleted && Enum.IsDefined(row.Status) && row.Status != ArticleStatus.Deleted
                && row.CurrentRevisionId > 0 && row.CurrentRevisionNo > 0
                && row.SelectedRevisionId > 0 && row.SelectedRevisionNo > 0 && row.SelectedCategoryId > 0
                && (row.CurrentPublicationId is null
                    ? row.PublicationNo is null && row.PublicationRevisionId is null
                        && row.PublicationRevisionNo is null && row.PublicationRecordRevisionNo is null
                    : row.CurrentPublicationId > 0 && row.PublicationNo > 0
                        && row.PublicationRevisionId > 0 && row.PublicationRevisionNo > 0
                        && row.PublicationRecordRevisionNo == row.PublicationRevisionNo)
                && (selection == ArticleGraphMetadataSelection.Current
                    ? row.SelectedRevisionId == row.CurrentRevisionId && row.SelectedRevisionNo == row.CurrentRevisionNo
                    : row.CurrentPublicationId > 0 && row.SelectedRevisionId == row.PublicationRevisionId
                        && row.SelectedRevisionNo == row.PublicationRevisionNo));
            _ = ParseTags(row.SelectedTags);
        }
    }

    private static void ValidateSources(Row[] rows, ArticleRelationRevisionCoordinate[] sources,
        ArticleRelationArticleCoordinate[] candidates)
    {
        Require(sources.Length == rows.Length);
        Dictionary<int, string> identities = candidates.ToDictionary(static candidate => candidate.ArticleId,
            static candidate => candidate.ArticleIdentity);
        for (int index = 0; index < rows.Length; index++)
        {
            Row row = rows[index];
            ArticleRelationRevisionCoordinate source = sources[index];
            Require(source.ArticleId == row.ArticleId && source.RevisionId == row.SelectedRevisionId
                && source.RevisionNo == row.SelectedRevisionNo && source.SourceEpoch != Guid.Empty
                && source.ArticleIdentity == identities[row.ArticleId]
                && source.RevisionIdentity is { Length: 45 }
                && source.RevisionIdentity.StartsWith("revision:", StringComparison.Ordinal)
                && Guid.TryParseExact(source.RevisionIdentity[9..], "D", out Guid identity)
                && identity != Guid.Empty && source.RevisionIdentity == $"revision:{identity:D}");
        }
    }

    internal static int[] ParseTags(string text)
    {
        Require(text is { Length: <= MaxTags * 11 });
        if (text.Length == 0)
        {
            return [];
        }
        string[] parts = text.Split(',');
        Require(parts.Length <= MaxTags);
        var tags = new int[parts.Length];
        for (int index = 0; index < parts.Length; index++)
        {
            Require(int.TryParse(parts[index], NumberStyles.None, CultureInfo.InvariantCulture, out int tag) && tag > 0
                && parts[index] == tag.ToString(CultureInfo.InvariantCulture));
            tags[index] = tag;
        }
        Require(tags.Distinct().Count() == tags.Length);
        Array.Sort(tags);
        return tags;
    }

    private static T[] Copy<T>(IReadOnlyList<T> values, int maximum, CancellationToken token = default)
    {
        token.ThrowIfCancellationRequested();
        int count = values.Count;
        token.ThrowIfCancellationRequested();
        Require(count >= 0 && count <= maximum);
        var copy = new T[count];
        for (int index = 0; index < count; index++)
        {
            copy[index] = values[index];
            token.ThrowIfCancellationRequested();
        }
        int capturedCount = values.Count;
        token.ThrowIfCancellationRequested();
        Require(capturedCount == count);
        for (int index = 0; index < count; index++)
        {
            T value = values[index];
            token.ThrowIfCancellationRequested();
            Require(EqualityComparer<T>.Default.Equals(copy[index], value));
        }
        int verifiedCount = values.Count;
        token.ThrowIfCancellationRequested();
        Require(verifiedCount == count);
        return copy;
    }

    private static void Require(bool condition)
    {
        if (!condition)
        {
            throw new InvalidOperationException("graph_metadata_unavailable");
        }
    }

    internal sealed record Row(int ArticleId, ArticleStatus Status, bool IsDeleted,
        long CurrentRevisionId, int CurrentRevisionNo, long? CurrentPublicationId, int? PublicationNo,
        long? PublicationRevisionId, int? PublicationRevisionNo, int? PublicationRecordRevisionNo,
        long SelectedRevisionId, int SelectedRevisionNo,
        int SelectedCategoryId, string SelectedTags, string Title);

    internal sealed record SessionStamp(int BackendId, string TransactionId, IsolationLevel Isolation,
        bool CallerTransaction, bool HasAmbientTransaction);

    private sealed class ReadBudget(int maximumOperations, int milliseconds)
    {
        private readonly long _started = Stopwatch.GetTimestamp();
        internal int Operations
        {
            get; private set;
        }
        internal TimeSpan RemainingTime()
        {
            TimeSpan remaining = TimeSpan.FromMilliseconds(milliseconds) - Stopwatch.GetElapsedTime(_started);
            Require(remaining > TimeSpan.Zero);
            return remaining;
        }
        internal void RequireCapacity(int count)
        {
            _ = RemainingTime();
            Require(count <= maximumOperations - Operations);
        }
        internal void Take(int count = 1)
        {
            RequireCapacity(count);
            Operations += count;
        }
    }

    private sealed class CallerSession(ISqlSugarClient db, GraphNativePermissionRead binding)
    {
        private NpgsqlConnection? _connection;
        private NpgsqlTransaction? _transaction;

        private NpgsqlCommand Command(string sql, CancellationToken token)
        {
            binding.Validate(token);
            Require(System.Transactions.Transaction.Current is null
                && db.CurrentConnectionConfig.DbType == SqlSugar.DbType.PostgreSQL
                && db.Ado.Connection is NpgsqlConnection
                && (db.Ado.Transaction is null || db.Ado.Transaction is NpgsqlTransaction));
            var connection = (NpgsqlConnection)db.Ado.Connection;
            var transaction = db.Ado.Transaction as NpgsqlTransaction;
            if (_connection is null)
            {
                _connection = connection;
                _transaction = transaction;
            }
            Require(ReferenceEquals(connection, _connection) && ReferenceEquals(transaction, _transaction)
                && (transaction is null || (transaction.IsolationLevel == IsolationLevel.ReadCommitted
                    && ReferenceEquals(transaction.Connection, connection))));
            return new(sql, connection, transaction)
            {
                CommandTimeout = 1
            };
        }

        internal async Task<SessionStamp> ProbeAsync(CancellationToken token)
        {
            await using NpgsqlCommand command = Command(
                """
                SELECT pg_backend_pid(), virtualxid, current_setting('transaction_isolation')
                FROM pg_locks
                WHERE pid = pg_backend_pid() AND locktype = 'virtualxid'
                  AND granted AND mode = 'ExclusiveLock'
                LIMIT 2;
                """, token);
            if (command.Connection!.State != ConnectionState.Open)
            {
                Require(command.Transaction is null);
                await command.Connection.OpenAsync(token).ConfigureAwait(false);
            }
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            Require(await reader.ReadAsync(token).ConfigureAwait(false));
            var stamp = new SessionStamp(reader.GetInt32(0), reader.GetString(1),
                reader.GetString(2) == "read committed" ? IsolationLevel.ReadCommitted : IsolationLevel.Unspecified,
                _transaction is not null, System.Transactions.Transaction.Current is not null);
            Require(!await reader.ReadAsync(token).ConfigureAwait(false));
            binding.ObserveSession(stamp);
            return stamp;
        }

        internal async Task<Row[]> ReadRowsAsync(int[] ids, ArticleGraphMetadataSelection selection, CancellationToken token)
        {
            string revision = selection == ArticleGraphMetadataSelection.Current ? "current_revision" : "publication_revision";
            string category = selection == ArticleGraphMetadataSelection.Current ? "a.categoryid" : "publication_revision.categoryid";
            string tags = selection == ArticleGraphMetadataSelection.Current
                ? "(SELECT string_agg(bounded.tagid::text, ',' ORDER BY bounded.tagid) FROM (SELECT tagid FROM article_tag WHERE articleid = a.id ORDER BY tagid LIMIT 257) bounded)"
                : "CASE WHEN octet_length(publication_revision.tag_ids) <= 2816 THEN publication_revision.tag_ids ELSE NULL END";
            await using NpgsqlCommand command = Command($$"""
                SELECT a.id, a.status, a.isdeleted, a.current_revision_id, current_revision.revision_no,
                       a.current_publication_id, publication.publication_no,
                       publication_revision.id, publication_revision.revision_no, publication.revision_no,
                       {{revision}}.id, {{revision}}.revision_no,
                       {{category}}, {{tags}},
                       CASE WHEN octet_length(a.title) <= 1024 AND char_length(a.title) <= 256 THEN a.title ELSE NULL END
                FROM article a
                LEFT JOIN article_revision current_revision ON current_revision.id = a.current_revision_id AND current_revision.article_id = a.id
                LEFT JOIN article_publication publication ON publication.id = a.current_publication_id AND publication.article_id = a.id
                LEFT JOIN article_revision publication_revision ON publication_revision.id = publication.article_revision_id AND publication_revision.article_id = a.id
                WHERE a.id = ANY(@ids)
                ORDER BY a.id
                LIMIT 65;
                """, token);
            command.Parameters.AddWithValue("ids", ids);
            var rows = new List<Row>(ids.Length);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            while (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                Require(rows.Count < ids.Length);
                Require(!reader.IsDBNull(3) && !reader.IsDBNull(4) && !reader.IsDBNull(10)
                    && !reader.IsDBNull(11) && !reader.IsDBNull(12) && !reader.IsDBNull(14));
                Require(!reader.IsDBNull(13) || selection == ArticleGraphMetadataSelection.Current);
                rows.Add(new(reader.GetInt32(0), (ArticleStatus)reader.GetInt32(1), reader.GetBoolean(2),
                    reader.GetInt64(3), reader.GetInt32(4), reader.IsDBNull(5) ? null : reader.GetInt64(5),
                    reader.IsDBNull(6) ? null : reader.GetInt32(6),
                    reader.IsDBNull(7) ? null : reader.GetInt64(7),
                    reader.IsDBNull(8) ? null : reader.GetInt32(8),
                    reader.IsDBNull(9) ? null : reader.GetInt32(9), reader.GetInt64(10), reader.GetInt32(11),
                    reader.GetInt32(12), reader.IsDBNull(13) ? string.Empty : reader.GetString(13), reader.GetString(14)));
            }
            return rows.ToArray();
        }
    }
}
