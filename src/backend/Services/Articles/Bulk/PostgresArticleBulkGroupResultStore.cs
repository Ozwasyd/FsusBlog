using System.Collections.Immutable;
using System.Data;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using Npgsql;

using NpgsqlTypes;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles.Bulk;

/// <summary>
/// Dedicated Bulk result storage. It neither starts/commits/rolls back transactions nor grants
/// admission. Writes require the caller's exact original ambient PostgreSQL transaction. Reads
/// return stored original reports and append-only observations, never commit/zero-write proof.
/// The original owner supplies an already-open independent read scope; this store never opens,
/// closes or disposes a borrowed connection, including after custody drift.
/// </summary>
internal sealed class PostgresArticleBulkGroupResultStore(ISqlSugarClient db)
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 64
    };

    internal async Task StageOriginalReportedResultAsync(
        NpgsqlTransaction originalTransaction, ArticleBulkOriginalGroupResult result,
        CancellationToken cancellationToken)
    {
        ArticleBulkGroupResultStorageContract.ValidateResult(result);
        NpgsqlConnection connection = RequireTransaction(originalTransaction);
        string json = Serialize(result);
        await VerifyCommandCoordinatesAsync(originalTransaction, result, cancellationToken).ConfigureAwait(false);
        RequireTransaction(originalTransaction);
        Dictionary<string, string> metadata = Metadata(result);
        string columns = string.Join(',', metadata.Keys);
        string parameters = string.Join(',', metadata.Keys.Select(static name => $"@{name}"));
        using var command = new NpgsqlCommand($"""
            INSERT INTO article_bulk_group_result ({columns},original_outcome,original_json,created_at_utc)
            VALUES ({parameters},@Outcome,@Json,@At)
            ON CONFLICT (group_idempotency_key) DO NOTHING;
            """, connection, originalTransaction);
        foreach ((string name, string value) in metadata)
            command.Parameters.AddWithValue(name, NpgsqlDbType.Text, value);
        command.Parameters.AddWithValue("Outcome", NpgsqlDbType.Integer, (int)result.OriginalOutcome);
        command.Parameters.AddWithValue("Json", NpgsqlDbType.Text, json);
        command.Parameters.AddWithValue("At", NpgsqlDbType.Timestamp, Timestamp(result.RecordedAtUtc));
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        RequireTransaction(originalTransaction);
        ArticleBulkOriginalGroupResult? persisted = await ReadOriginalCoreAsync(
            connection, originalTransaction, result.Binding, false, cancellationToken).ConfigureAwait(false);
        RequireTransaction(originalTransaction);
        if (persisted?.ContentDigest != result.ContentDigest)
            throw new ArticleBulkContractException("article-bulk.result-idempotency-conflict");
        // Successful staging is not a committed transaction, side-effect completion, or zero-write acknowledgement.
    }

    internal async Task StageRecoveryObservationAsync(
        NpgsqlTransaction originalTransaction, ArticleBulkGroupResultBinding binding,
        ArticleBulkStoredRecoveryObservation observation, CancellationToken cancellationToken)
    {
        ArticleBulkGroupResultStorageContract.ValidateBinding(binding);
        NpgsqlConnection connection = RequireTransaction(originalTransaction);
        ArticleBulkOriginalGroupResult? original = await ReadOriginalCoreAsync(
            connection, originalTransaction, binding, true, cancellationToken).ConfigureAwait(false);
        RequireTransaction(originalTransaction);
        if (original is null)
            throw new ArticleBulkContractException("article-bulk.result-observation-original-missing");
        ArticleBulkGroupResultStorageContract.ValidateObservation(original, observation);
        string json = Serialize(observation);
        using (var replay = new NpgsqlCommand("""
            SELECT observation_json,content_digest,ordinal,original_result_digest,
                   previous_observation_digest,observed_at_utc FROM article_bulk_group_recovery_observation
            WHERE group_idempotency_key=@GroupKey AND observation_id=@ObservationId;
            """, connection, originalTransaction))
        {
            replay.Parameters.AddWithValue("GroupKey", binding.GroupIdempotencyKey);
            replay.Parameters.AddWithValue("ObservationId", observation.ObservationId);
            using NpgsqlDataReader reader = await replay.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                RequireTransaction(originalTransaction);
                if (reader.GetString(0) != json || reader.GetString(1) != observation.ContentDigest
                    || reader.GetInt64(2) != observation.Ordinal || reader.GetString(3) != observation.OriginalResultDigest
                    || reader.GetString(4) != observation.PreviousObservationDigest
                    || reader.GetDateTime(5) != Timestamp(observation.ObservedAtUtc))
                    throw new ArticleBulkContractException("article-bulk.result-observation-replay-conflict");
                return;
            }
        }
        long previousOrdinal = 0;
        string previousDigest = original.ContentDigest;
        using (var tail = new NpgsqlCommand("""
            SELECT ordinal,content_digest,observation_json FROM article_bulk_group_recovery_observation
            WHERE group_idempotency_key=@GroupKey ORDER BY ordinal DESC LIMIT 1;
            """, connection, originalTransaction))
        {
            tail.Parameters.AddWithValue("GroupKey", binding.GroupIdempotencyKey);
            using NpgsqlDataReader reader = await tail.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                previousOrdinal = reader.GetInt64(0);
                previousDigest = reader.GetString(1);
                ArticleBulkStoredRecoveryObservation previous = Deserialize<ArticleBulkStoredRecoveryObservation>(reader.GetString(2));
                ArticleBulkGroupResultStorageContract.ValidateObservation(original, previous);
                if (previous.Ordinal != previousOrdinal || previous.ContentDigest != previousDigest)
                    throw new ArticleBulkContractException("article-bulk.result-observation-tail-tampered");
            }
        }
        RequireTransaction(originalTransaction);
        if (observation.Ordinal != previousOrdinal + 1 || observation.PreviousObservationDigest != previousDigest)
            throw new ArticleBulkContractException("article-bulk.result-observation-stale-head");
        using var append = new NpgsqlCommand("""
            INSERT INTO article_bulk_group_recovery_observation
                (group_idempotency_key,ordinal,observation_id,original_result_digest,
                 previous_observation_digest,content_digest,observation_json,observed_at_utc)
            VALUES (@GroupKey,@Ordinal,@Id,@Original,@Previous,@Digest,@Json,@At);
            """, connection, originalTransaction);
        append.Parameters.AddWithValue("GroupKey", binding.GroupIdempotencyKey);
        append.Parameters.AddWithValue("Ordinal", observation.Ordinal);
        append.Parameters.AddWithValue("Id", observation.ObservationId);
        append.Parameters.AddWithValue("Original", observation.OriginalResultDigest);
        append.Parameters.AddWithValue("Previous", observation.PreviousObservationDigest);
        append.Parameters.AddWithValue("Digest", observation.ContentDigest);
        append.Parameters.AddWithValue("Json", NpgsqlDbType.Text, json);
        append.Parameters.AddWithValue("At", NpgsqlDbType.Timestamp, Timestamp(observation.ObservedAtUtc));
        await append.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        RequireTransaction(originalTransaction);
        // Never update the original result, including an original UnknownRecovery outcome.
    }

    internal async Task<ArticleBulkGroupResultStorageObservation?> ReadOriginalAsync(
        ArticleBulkGroupResultBinding expected, CancellationToken cancellationToken)
    {
        ArticleBulkGroupResultStorageContract.ValidateBinding(expected);
        NpgsqlConnection connection = RequireReadConnection();
        ArticleBulkOriginalGroupResult? original = await ReadOriginalCoreAsync(
            connection, null, expected, false, cancellationToken).ConfigureAwait(false);
        RequireReadConnection(connection);
        // Missing is only missing storage data, never evidence that no business writes occurred.
        return original is null ? null : new(original);
    }

    internal async IAsyncEnumerable<ArticleBulkStoredRecoveryObservation> ReadRecoveryBatchAsync(
        ArticleBulkGroupResultBinding expected, long afterOrdinal,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArticleBulkGroupResultStorageContract.ValidateBinding(expected);
        if (afterOrdinal is < 0 or > ArticleBulkGroupResultStorageContract.MaxObservationOrdinal)
            throw new ArticleBulkContractException("article-bulk.result-observation-cursor-invalid");
        NpgsqlConnection connection = RequireReadConnection();
        {
            ArticleBulkOriginalGroupResult? original = await ReadOriginalCoreAsync(connection, null, expected, false, cancellationToken)
                .ConfigureAwait(false);
            if (original is null)
                throw new ArticleBulkContractException("article-bulk.result-observation-original-missing");
            string previousDigest = original.ContentDigest;
            if (afterOrdinal != 0)
            {
                using var anchor = new NpgsqlCommand("""
                    SELECT observation_json FROM article_bulk_group_recovery_observation
                    WHERE group_idempotency_key=@Key AND ordinal=@Ordinal;
                    """, connection);
                anchor.Parameters.AddWithValue("Key", expected.GroupIdempotencyKey);
                anchor.Parameters.AddWithValue("Ordinal", afterOrdinal);
                object? json = await anchor.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
                RequireReadConnection(connection);
                if (json is not string text)
                    throw new ArticleBulkContractException("article-bulk.result-observation-anchor-missing");
                ArticleBulkStoredRecoveryObservation value = Deserialize<ArticleBulkStoredRecoveryObservation>(text);
                ArticleBulkGroupResultStorageContract.ValidateObservation(original, value);
                if (value.Ordinal != afterOrdinal)
                    throw new ArticleBulkContractException("article-bulk.result-observation-anchor-tampered");
                previousDigest = value.ContentDigest;
            }
            using var command = new NpgsqlCommand("""
                SELECT ordinal,observation_id,original_result_digest,previous_observation_digest,
                       content_digest,observation_json,observed_at_utc
                FROM article_bulk_group_recovery_observation
                WHERE group_idempotency_key=@Key AND ordinal>@After ORDER BY ordinal LIMIT @Limit;
                """, connection);
            command.Parameters.AddWithValue("Key", expected.GroupIdempotencyKey);
            command.Parameters.AddWithValue("After", afterOrdinal);
            command.Parameters.AddWithValue("Limit", ArticleBulkGroupResultStorageContract.ObservationReadBatchSize);
            using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                RequireReadConnection(connection);
                ArticleBulkStoredRecoveryObservation value = Deserialize<ArticleBulkStoredRecoveryObservation>(reader.GetString(5));
                ArticleBulkGroupResultStorageContract.ValidateObservation(original, value);
                if (value.Ordinal != ++afterOrdinal || value.Ordinal != reader.GetInt64(0)
                    || value.ObservationId != reader.GetGuid(1) || value.OriginalResultDigest != reader.GetString(2)
                    || value.PreviousObservationDigest != previousDigest || value.PreviousObservationDigest != reader.GetString(3)
                    || value.ContentDigest != reader.GetString(4) || Timestamp(value.ObservedAtUtc) != reader.GetDateTime(6))
                    throw new ArticleBulkContractException("article-bulk.result-observation-chain-tampered");
                previousDigest = value.ContentDigest;
                yield return value;
            }
        }
    }

    private async Task<ArticleBulkOriginalGroupResult?> ReadOriginalCoreAsync(
        NpgsqlConnection connection, NpgsqlTransaction? transaction, ArticleBulkGroupResultBinding expected,
        bool lockRow, CancellationToken cancellationToken)
    {
        using var command = new NpgsqlCommand(
            "SELECT * FROM article_bulk_group_result WHERE group_idempotency_key=@Key" + (lockRow ? " FOR UPDATE;" : ";"),
            connection, transaction);
        command.Parameters.AddWithValue("Key", expected.GroupIdempotencyKey);
        using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            return null;
        ArticleBulkOriginalGroupResult result = Deserialize<ArticleBulkOriginalGroupResult>(reader.GetString(reader.GetOrdinal("original_json")));
        ArticleBulkGroupResultStorageContract.ValidateResult(result);
        if (result.Binding.ContentDigest != expected.ContentDigest
            || (int)result.OriginalOutcome != reader.GetInt32(reader.GetOrdinal("original_outcome"))
            || Timestamp(result.RecordedAtUtc) != reader.GetDateTime(reader.GetOrdinal("created_at_utc")))
            throw new ArticleBulkContractException("article-bulk.result-storage-binding-tampered");
        foreach ((string name, string value) in Metadata(result))
        {
            if (reader.GetString(reader.GetOrdinal(name)) != value)
                throw new ArticleBulkContractException("article-bulk.result-storage-metadata-tampered");
        }
        return result;
    }

    private async Task VerifyCommandCoordinatesAsync(
        NpgsqlTransaction transaction, ArticleBulkOriginalGroupResult result, CancellationToken cancellationToken)
    {
        if (result.Commands.Length == 0)
            return;
        NpgsqlConnection connection = RequireTransaction(transaction);
        int[] articleIds = [.. result.Commands.Select(command => int.Parse(command.ArticleId, NumberStyles.None, CultureInfo.InvariantCulture))];
        using var query = new NpgsqlCommand("""
            SELECT COUNT(*) FROM unnest(@Articles::integer[],@Events::text[],@Chains::text[],@Hashes::text[])
                AS refs(article_id,event_id,chain_id,record_hash)
            JOIN article_mutation_outbox o ON o.aggregate_type='article'
                AND o.aggregate_id=refs.article_id AND o.event_id=refs.event_id
            JOIN sys_audit_log a ON a.chain_id=refs.chain_id AND a.record_hash=refs.record_hash
                AND a.actor_type='admin' AND a.actor_id=@Actor
                AND a.target_type='article-canonical-lifecycle' AND a.target_id=refs.article_id::text;
            """, connection, transaction);
        query.Parameters.AddWithValue("Articles", NpgsqlDbType.Array | NpgsqlDbType.Integer, articleIds);
        query.Parameters.AddWithValue("Events", NpgsqlDbType.Array | NpgsqlDbType.Text, result.Commands.Select(static command => command.OutboxEventId).ToArray());
        query.Parameters.AddWithValue("Chains", NpgsqlDbType.Array | NpgsqlDbType.Text, result.Commands.Select(static command => command.AuditChainId).ToArray());
        query.Parameters.AddWithValue("Hashes", NpgsqlDbType.Array | NpgsqlDbType.Text, result.Commands.Select(static command => command.AuditRecordHash).ToArray());
        query.Parameters.AddWithValue("Actor", result.Binding.Request.Actor.UserId);
        object? count = await query.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        RequireTransaction(transaction);
        if (count is not long actual || actual != result.Commands.Length)
            throw new ArticleBulkContractException("article-bulk.result-original-command-coordinates-missing");
        // Row correlation does not verify audit signatures, owner admission, rollback, or postcommit completion.
    }

    private NpgsqlConnection RequireTransaction(NpgsqlTransaction original)
    {
        if (!ReferenceEquals(db.Ado.Transaction, original) || db.Ado.Connection is not NpgsqlConnection connection
            || !ReferenceEquals(original.Connection, connection) || connection.State != ConnectionState.Open)
            throw new ArticleBulkContractException("article-bulk.result-original-transaction-required");
        return connection;
    }

    private NpgsqlConnection RequireReadConnection(NpgsqlConnection? expected = null)
    {
        if (db.Ado.Transaction is not null || db.Ado.Connection is not NpgsqlConnection connection
            || connection.State != ConnectionState.Open || expected is not null && !ReferenceEquals(connection, expected))
            throw new ArticleBulkContractException("article-bulk.result-read-requires-independent-connection");
        return connection;
    }

    private static Dictionary<string, string> Metadata(ArticleBulkOriginalGroupResult result)
    {
        ArticleBulkExecutionRequest request = result.Binding.Request;
        return new(StringComparer.Ordinal)
        {
            ["group_idempotency_key"] = result.Binding.GroupIdempotencyKey,
            ["execution_identity_digest"] = request.ExecutionIdentityDigest,
            ["request_digest"] = request.ContentDigest,
            ["plan_digest"] = request.PlanDigest,
            ["frozen_set_digest"] = request.FrozenSetDigest,
            ["registry_digest"] = request.RegistryDigest,
            ["parameters_digest"] = request.ParametersDigest,
            ["binding_digest"] = result.Binding.ContentDigest,
            ["actor_authority_digest"] = request.Actor.AuthorityDigest,
            ["policy_digest"] = request.PolicyDigest,
            ["permission_policy_digest"] = request.PermissionPolicyDigest,
            ["source_build_digest"] = request.Source.BuildDigest,
            ["content_digest"] = result.ContentDigest,
            ["actor_user_id"] = request.Actor.UserId,
            ["site_id"] = request.Actor.SiteId,
            ["source_commit"] = request.Source.Commit,
            ["operation_id"] = request.OperationId
        };
    }

    private static DateTime Timestamp(DateTimeOffset value)
        => new(value.UtcTicks / 10 * 10, DateTimeKind.Utc); // PostgreSQL timestamp has microsecond precision; payload retains original ticks.

    private static string Serialize<T>(T value)
    {
        string json = JsonSerializer.Serialize(value, s_json);
        if (Encoding.UTF8.GetByteCount(json) is < 1 or > ArticleBulkGroupResultStorageContract.MaxPayloadBytes)
            throw new ArticleBulkContractException("article-bulk.result-storage-payload-budget");
        return json;
    }

    private static T Deserialize<T>(string json)
    {
        if (Encoding.UTF8.GetByteCount(json) is < 1 or > ArticleBulkGroupResultStorageContract.MaxPayloadBytes)
            throw new ArticleBulkContractException("article-bulk.result-storage-payload-budget");
        T? value = JsonSerializer.Deserialize<T>(json, s_json);
        if (value is null || Serialize(value) != json)
            throw new ArticleBulkContractException("article-bulk.result-storage-noncanonical-json");
        return value;
    }
}
