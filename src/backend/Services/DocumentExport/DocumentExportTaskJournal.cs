using System.Collections.Immutable;

using Microsoft.AspNetCore.DataProtection;

using Npgsql;

using NpgsqlTypes;

namespace FsusBlog.Server.Services.DocumentExport;

internal sealed record DocumentExportPersistedAttempt(
    DocumentExportTask Task,
    DocumentExportAttemptSnapshot Snapshot,
    bool ExecutionOutstanding);

// Internal persistence projection of the existing task authority, never a
// provider/public wire schema or a second scheduler.
internal sealed record DocumentExportPersistedEntry(
    DocumentExportTask Task,
    string Identity,
    long RetainedBytes,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset ExpiresAtUtc,
    ImmutableArray<DocumentExportPersistedAttempt> Attempts);

internal sealed record DocumentExportJournalEntry(
    DocumentExportPersistedEntry State, DocumentExportFrozenInput Input, long Revision);

internal interface IDocumentExportTaskJournal : IDisposable
{
    void VerifyOwner();
    IReadOnlyList<DocumentExportJournalEntry> Read();
    long Write(DocumentExportPersistedEntry state, DocumentExportFrozenInput input, long expectedRevision);
    void Delete(string taskId, long expectedRevision);
}

/// <summary>
/// Private encrypted persistence for the existing bounded queue. A dedicated
/// non-pooled PostgreSQL session owns its database-wide advisory lock. Missing
/// schema, lost connection, stale revision and another owner all fail closed.
/// Provisioning belongs to an explicit Expand; this adapter never runs DDL.
/// </summary>
internal sealed class PostgresDocumentExportTaskJournal : IDocumentExportTaskJournal
{
    private const int MaxStateBytes = 131072;
    private readonly NpgsqlConnection _connection;
    private readonly IDataProtector _protector;
    private readonly DocumentExportQueueLimits _limits;
    private bool _disposed;

    internal PostgresDocumentExportTaskJournal(
        string connectionString, IDataProtectionProvider protection, DocumentExportQueueLimits limits)
    {
        _limits = limits;
        _protector = protection.CreateProtector("FsusBlog.DocumentExport.TaskJournal.v1");
        var builder = new NpgsqlConnectionStringBuilder(connectionString)
        {
            Pooling = false,
            IncludeErrorDetail = false,
            CommandTimeout = 5
        };
        _connection = new NpgsqlConnection(builder.ConnectionString);
        try
        {
            _connection.Open();
            using NpgsqlCommand command = Command("SELECT pg_try_advisory_lock(hashtextextended('document-export-task-queue', 0));");
            if (command.ExecuteScalar() is not true)
            {
                throw new InvalidOperationException("Export task journal already has an owner.");
            }
        }
        catch
        {
            _connection.Dispose();
            throw;
        }
    }

    public void VerifyOwner()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        using NpgsqlCommand command = Command("SELECT 1;");
        _ = command.ExecuteScalar();
    }

    public IReadOnlyList<DocumentExportJournalEntry> Read()
    {
        VerifyOwner();
        using (NpgsqlCommand budget = Command(
            "SELECT count(*), COALESCE(sum(retained_bytes), 0)::bigint FROM document_export_task;"))
        using (NpgsqlDataReader reader = budget.ExecuteReader())
        {
            _ = reader.Read();
            if (reader.GetInt64(0) > _limits.MaxTasks || reader.GetInt64(1) > _limits.MaxFrozenBytes)
            {
                throw new InvalidDataException("Export task journal exceeds its recovery budget.");
            }
        }
        var entries = new List<DocumentExportJournalEntry>();
        using NpgsqlCommand command = Command(
            """
            SELECT task_id, user_id, site_id, idempotency_key, created_at_utc_ticks, expires_at_utc_ticks,
                retained_bytes, revision, octet_length(frozen_input), octet_length(state), frozen_input, state,
                identity_digest, input_digest
            FROM document_export_task ORDER BY created_at_utc_ticks, task_id;
            """);
        using NpgsqlDataReader rows = command.ExecuteReader(System.Data.CommandBehavior.SequentialAccess);
        while (rows.Read())
        {
            string taskId = rows.GetString(0);
            long userId = rows.GetInt64(1);
            long siteId = rows.GetInt64(2);
            string key = rows.GetString(3);
            var created = new DateTimeOffset(rows.GetInt64(4), TimeSpan.Zero);
            var expires = new DateTimeOffset(rows.GetInt64(5), TimeSpan.Zero);
            long retainedBytes = rows.GetInt64(6);
            long revision = rows.GetInt64(7);
            if (rows.GetInt32(8) > _limits.MaxFrozenBytes + 4096 || rows.GetInt32(9) > MaxStateBytes + 4096)
            {
                throw new InvalidDataException("Export task journal payload exceeds its recovery budget.");
            }
            DocumentExportFrozenInput input = Unprotect<DocumentExportFrozenInput>(taskId, "input", rows.GetFieldValue<byte[]>(10));
            DocumentExportPersistedEntry state = Unprotect<DocumentExportPersistedEntry>(taskId, "state", rows.GetFieldValue<byte[]>(11));
            Validate(state, input);
            if (revision <= 0 || state.Task.TaskId != taskId || state.Task.UserId != userId
                || state.Task.SiteId != siteId || state.Task.IdempotencyKey != key
                || state.CreatedAtUtc != created || state.ExpiresAtUtc != expires || state.RetainedBytes != retainedBytes
                || state.Identity != rows.GetString(12) || input.ContentDigest != rows.GetString(13))
            {
                throw new InvalidDataException("Export task journal row binding is invalid.");
            }
            entries.Add(new DocumentExportJournalEntry(state, input, revision));
        }
        if (entries.Sum(entry => entry.State.Attempts.Count(attempt => attempt.ExecutionOutstanding)) > _limits.MaxConcurrency)
        {
            throw new InvalidDataException("Export task journal execution budget is invalid.");
        }
        return entries.AsReadOnly();
    }

    public long Write(DocumentExportPersistedEntry state, DocumentExportFrozenInput input, long expectedRevision)
    {
        VerifyOwner();
        Validate(state, input);
        byte[] stateBytes = DocumentExportDigest.Serialize(state);
        if (stateBytes.Length > MaxStateBytes || expectedRevision < 0)
        {
            throw new InvalidDataException("Export task journal write budget is invalid.");
        }
        byte[] protectedState = _protector.CreateProtector(state.Task.TaskId, "state").Protect(stateBytes);
        using NpgsqlCommand command = Command(expectedRevision == 0
            ? """
              INSERT INTO document_export_task(task_id, user_id, site_id, idempotency_key,
                  created_at_utc_ticks, expires_at_utc_ticks, retained_bytes, revision, frozen_input, state,
                  identity_digest, input_digest)
              VALUES(@task, @user, @site, @key, @created, @expires, @bytes, 1, @input, @state, @identity, @inputDigest)
              ON CONFLICT DO NOTHING;
              """
            : """
              UPDATE document_export_task SET state = @state, revision = revision + 1
              WHERE task_id = @task AND revision = @revision AND user_id = @user AND site_id = @site
                  AND idempotency_key = @key AND created_at_utc_ticks = @created AND expires_at_utc_ticks = @expires
                  AND retained_bytes = @bytes AND identity_digest = @identity AND input_digest = @inputDigest;
              """);
        command.Parameters.AddWithValue("task", state.Task.TaskId);
        command.Parameters.AddWithValue("state", NpgsqlDbType.Bytea, protectedState);
        command.Parameters.AddWithValue("user", state.Task.UserId);
        command.Parameters.AddWithValue("site", state.Task.SiteId);
        command.Parameters.AddWithValue("key", state.Task.IdempotencyKey);
        command.Parameters.AddWithValue("created", state.CreatedAtUtc.UtcTicks);
        command.Parameters.AddWithValue("expires", state.ExpiresAtUtc.UtcTicks);
        command.Parameters.AddWithValue("bytes", state.RetainedBytes);
        command.Parameters.AddWithValue("identity", state.Identity);
        command.Parameters.AddWithValue("inputDigest", input.ContentDigest);
        if (expectedRevision == 0)
        {
            command.Parameters.AddWithValue("input", NpgsqlDbType.Bytea,
                _protector.CreateProtector(state.Task.TaskId, "input").Protect(DocumentExportDigest.Serialize(input)));
        }
        else
        {
            command.Parameters.AddWithValue("revision", expectedRevision);
        }
        if (command.ExecuteNonQuery() != 1)
        {
            throw new InvalidOperationException("Export task journal revision conflict.");
        }
        return checked(expectedRevision + 1);
    }

    public void Delete(string taskId, long expectedRevision)
    {
        VerifyOwner();
        using NpgsqlCommand command = Command("DELETE FROM document_export_task WHERE task_id = @task AND revision = @revision;");
        command.Parameters.AddWithValue("task", taskId);
        command.Parameters.AddWithValue("revision", expectedRevision);
        if (command.ExecuteNonQuery() != 1)
        {
            throw new InvalidOperationException("Export task journal retention revision conflict.");
        }
    }

    public void Dispose()
    {
        _disposed = true;
        _connection.Dispose();
    }

    private NpgsqlCommand Command(string sql) => new(sql, _connection);

    private T Unprotect<T>(string taskId, string kind, byte[] bytes)
        => DocumentExportDigest.Deserialize<T>(_protector.CreateProtector(taskId, kind).Unprotect(bytes));

    private void Validate(DocumentExportPersistedEntry state, DocumentExportFrozenInput input)
    {
        DocumentExportContractValidator.Validate(state.Task, input);
        string identity = DocumentExportDigest.Compute(state.Task with
        {
            TaskId = string.Empty,
            RequestId = string.Empty,
            Status = DocumentExportTaskStatus.Queued,
            ContentDigest = string.Empty
        });
        if (state.Identity != identity || state.RetainedBytes != DocumentExportDigest.Serialize(input).LongLength
            || state.RetainedBytes > _limits.MaxFrozenBytes || state.CreatedAtUtc.Offset != TimeSpan.Zero
            || state.ExpiresAtUtc.Offset != TimeSpan.Zero || state.ExpiresAtUtc <= state.CreatedAtUtc
            || state.ExpiresAtUtc - state.CreatedAtUtc > _limits.RetentionTtl
            || state.Attempts.IsDefaultOrEmpty || state.Attempts.Length > _limits.MaxAttempts
            || state.Task != state.Attempts[0].Task
            || state.Attempts.Select(attempt => attempt.Snapshot.AttemptId).Distinct().Count() != state.Attempts.Length
            || state.Attempts.Select(attempt => attempt.Task.RequestId).Distinct(StringComparer.Ordinal).Count() != state.Attempts.Length)
        {
            throw new InvalidDataException("Export task journal identity or budget is invalid.");
        }
        for (int index = 0; index < state.Attempts.Length; index++)
        {
            DocumentExportPersistedAttempt attempt = state.Attempts[index];
            DocumentExportAttemptSnapshot snapshot = attempt.Snapshot;
            DocumentExportContractValidator.Validate(attempt.Task, input);
            string attemptIdentity = DocumentExportDigest.Compute(attempt.Task with
            {
                TaskId = string.Empty,
                RequestId = string.Empty,
                Status = DocumentExportTaskStatus.Queued,
                ContentDigest = string.Empty
            });
            if (attemptIdentity != identity || attempt.Task.TaskId != state.Task.TaskId
                || snapshot.AttemptId == Guid.Empty || snapshot.Number != index + 1
                || snapshot.RequestId != attempt.Task.RequestId || snapshot.TaskDigest != attempt.Task.ContentDigest
                || snapshot.Status != attempt.Task.Status || snapshot.CreatedAtUtc < state.CreatedAtUtc
                || snapshot.CreatedAtUtc >= state.ExpiresAtUtc
                || snapshot.StartedAtUtc < snapshot.CreatedAtUtc || snapshot.StoppedAtUtc < snapshot.CreatedAtUtc
                || snapshot.ContentDigest != DocumentExportDigest.Compute(snapshot with
                {
                    ContentDigest = string.Empty
                })
                || snapshot.StopOutcome is not (null or DocumentExportProviderResultStatus.Failed
                    or DocumentExportProviderResultStatus.Blocked or DocumentExportProviderResultStatus.Cancelled)
                || (attempt.ExecutionOutstanding && (index != state.Attempts.Length - 1 || snapshot.CleanupComplete
                    || snapshot.Status is not (DocumentExportTaskStatus.Preparing or DocumentExportTaskStatus.Running
                        or DocumentExportTaskStatus.Cancelling or DocumentExportTaskStatus.CleanupRequired or DocumentExportTaskStatus.Expired)))
                || (!attempt.ExecutionOutstanding && snapshot.Status is (DocumentExportTaskStatus.Preparing
                    or DocumentExportTaskStatus.Running or DocumentExportTaskStatus.Cancelling or DocumentExportTaskStatus.CleanupRequired))
                || (index < state.Attempts.Length - 1 && (!snapshot.CleanupComplete || attempt.ExecutionOutstanding
                    || snapshot.Status is not (DocumentExportTaskStatus.Failed or DocumentExportTaskStatus.Blocked))))
            {
                throw new InvalidDataException("Export task journal attempt binding is invalid.");
            }
        }
    }
}
