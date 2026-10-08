using System.Collections.Concurrent;
using System.Data;
using System.Data.Common;
using System.Diagnostics;
using System.Security.Cryptography;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Testing;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public enum PublicArticleProjectionReadStatus
{
    NotFound,
    Found,
    Invalid,
    Unavailable
}

public readonly record struct PublicArticleProjectionReadResult(
    PublicArticleProjectionReadStatus Status,
    long Version,
    ReadOnlyMemory<byte> Frame,
    string? ETag,
    DateTimeOffset? UpdatedAtUtc,
    string? Error = null)
{
    public bool Found => Status == PublicArticleProjectionReadStatus.Found && !Frame.IsEmpty;
}

public readonly record struct PublicArticleProjectionWrite(
    int ArticleId,
    ReadOnlyMemory<byte> Frame,
    string ETag,
    string ContentHash,
    DateTimeOffset UpdatedAtUtc);

public interface IPublicArticleProjectionStore
{
    Task<PublicArticleProjectionReadResult> TryReadAsync(int articleId, CancellationToken cancellationToken = default);
    Task UpsertAsync(PublicArticleProjectionWrite projection, CancellationToken cancellationToken = default);
    Task MarkUnavailableAsync(int articleId, string reason, CancellationToken cancellationToken = default);
    Task<bool> VerifyShadowParityAsync(
        int articleId,
        ReadOnlyMemory<byte> expectedFrame,
        CancellationToken cancellationToken = default);
}

internal static class PublicArticleProjectionReadContract
{
    internal const string EnabledConfigurationKey = "Database:PublicArticleProjection:Enabled";
    internal const CommandBehavior Behavior = CommandBehavior.SequentialAccess | CommandBehavior.SingleRow;
    internal const int VersionOrdinal = 0;
    internal const int FrameOrdinal = 1;
    internal const int ETagOrdinal = 2;
    internal const int UpdatedAtOrdinal = 3;
}

public sealed record PublicArticleProjectionRuntimeSnapshot(
    int MaxPoolSize,
    int Active,
    int Waiting,
    long Reads,
    long Hits,
    long Misses,
    long Invalid,
    long Timeouts,
    long BrokenConnections,
    double P99PoolWaitMs,
    double P99QueryMs,
    string QueryShape,
    string ReadMode);

public sealed class PublicArticleProjectionRuntimeState
{
    private const int SampleCapacity = 256;
    private readonly long[] _poolWaitSamples = new long[SampleCapacity];
    private readonly long[] _querySamples = new long[SampleCapacity];
    private int _poolWaitIndex;
    private int _queryIndex;
    private int _active;
    private int _waiting;
    private long _reads;
    private long _hits;
    private long _misses;
    private long _invalid;
    private long _timeouts;
    private long _brokenConnections;
    private int _maxPoolSize;

    public void ConfigurePool(int maxPoolSize) => Volatile.Write(ref _maxPoolSize, maxPoolSize);
    public void EnterWait() => Interlocked.Increment(ref _waiting);

    public void EnterActive(TimeSpan poolWait)
    {
        Interlocked.Decrement(ref _waiting);
        Interlocked.Increment(ref _active);
        Record(_poolWaitSamples, ref _poolWaitIndex, poolWait);
    }

    public void CancelWait(TimeSpan poolWait)
    {
        Interlocked.Decrement(ref _waiting);
        Record(_poolWaitSamples, ref _poolWaitIndex, poolWait);
    }

    public void Complete(PublicArticleProjectionReadStatus status, TimeSpan queryElapsed)
    {
        Interlocked.Decrement(ref _active);
        Interlocked.Increment(ref _reads);
        Record(_querySamples, ref _queryIndex, queryElapsed);
        switch (status)
        {
            case PublicArticleProjectionReadStatus.Found:
                Interlocked.Increment(ref _hits);
                break;
            case PublicArticleProjectionReadStatus.NotFound:
                Interlocked.Increment(ref _misses);
                break;
            case PublicArticleProjectionReadStatus.Invalid:
                Interlocked.Increment(ref _invalid);
                break;
        }
    }

    public void RecordTimeout() => Interlocked.Increment(ref _timeouts);
    public void RecordBrokenConnection() => Interlocked.Increment(ref _brokenConnections);

    public PublicArticleProjectionRuntimeSnapshot Snapshot()
        => new(
            Volatile.Read(ref _maxPoolSize),
            Volatile.Read(ref _active),
            Volatile.Read(ref _waiting),
            Interlocked.Read(ref _reads),
            Interlocked.Read(ref _hits),
            Interlocked.Read(ref _misses),
            Interlocked.Read(ref _invalid),
            Interlocked.Read(ref _timeouts),
            Interlocked.Read(ref _brokenConnections),
            ReadP99(_poolWaitSamples),
            ReadP99(_querySamples),
            "single-prepared-primary-key-visible-v1",
            "SequentialAccess|SingleRow|fixed-ordinals");

    private static void Record(long[] samples, ref int index, TimeSpan elapsed)
    {
        int slot = (Interlocked.Increment(ref index) - 1) & (SampleCapacity - 1);
        Volatile.Write(ref samples[slot], elapsed.Ticks);
    }

    private static double ReadP99(long[] samples)
    {
        long[] populated = new long[samples.Length];
        int count = 0;
        for (int i = 0; i < samples.Length; i++)
        {
            long value = Volatile.Read(ref samples[i]);
            if (value > 0)
            {
                populated[count++] = value;
            }
        }

        if (count == 0)
        {
            return 0;
        }

        Array.Sort(populated, 0, count);
        int percentile = Math.Clamp((int)Math.Ceiling(count * 0.99) - 1, 0, count - 1);
        return TimeSpan.FromTicks(populated[percentile]).TotalMilliseconds;
    }
}

public sealed class PublicArticleProjectionNegativeCache(TimeProvider timeProvider)
{
    private static readonly TimeSpan s_ttl = TimeSpan.FromSeconds(30);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _missing = new(StringComparer.Ordinal);

    public bool IsMissing(string? scope, int articleId)
    {
        string key = BuildKey(scope, articleId);
        if (!_missing.TryGetValue(key, out DateTimeOffset expiresAt))
        {
            return false;
        }

        if (expiresAt > timeProvider.GetUtcNow())
        {
            return true;
        }

        _missing.TryRemove(key, out _);
        return false;
    }

    public void MarkMissing(string? scope, int articleId)
        => _missing[BuildKey(scope, articleId)] = timeProvider.GetUtcNow().Add(s_ttl);

    public void Invalidate(string? scope, int articleId)
        => _missing.TryRemove(BuildKey(scope, articleId), out _);

    private static string BuildKey(string? scope, int articleId)
        => string.Concat(scope ?? "public", ":", articleId.ToString(System.Globalization.CultureInfo.InvariantCulture));
}

public sealed class PublicArticleProjectionDataSourceProvider : IAsyncDisposable
{
    private readonly string _connectionString;
    private readonly int _maxPoolSize;
    private readonly int _minPoolSize;
    private readonly int _commandTimeoutSeconds;
    private readonly ConcurrentDictionary<string, Lazy<NpgsqlDataSource>> _sources = new(StringComparer.Ordinal);

    public PublicArticleProjectionDataSourceProvider(
        IConfiguration configuration,
        PublicArticleProjectionRuntimeState runtimeState)
    {
        string configured = configuration.GetConnectionString("DefaultConnection")
            ?? throw new InvalidOperationException("致命错误：未配置数据库连接字符串 DefaultConnection。");
        _connectionString = SqlSugarInitializer.NormalizeConnectionString(configured);
        var main = new NpgsqlConnectionStringBuilder(_connectionString);
        _maxPoolSize = Math.Clamp(
            configuration.GetValue<int?>("Database:PublicArticleProjection:MaxPoolSize")
                ?? Math.Max(2, main.MaxPoolSize / 4),
            1,
            main.MaxPoolSize);
        _minPoolSize = Math.Clamp(
            configuration.GetValue<int?>("Database:PublicArticleProjection:MinPoolSize") ?? 0,
            0,
            _maxPoolSize);
        _commandTimeoutSeconds = Math.Clamp(
            configuration.GetValue<int?>("Database:PublicArticleProjection:CommandTimeoutSeconds") ?? 5,
            1,
            30);
        runtimeState.ConfigurePool(_maxPoolSize);
    }

    public int MaxPoolSize => _maxPoolSize;
    public int CommandTimeoutSeconds => _commandTimeoutSeconds;

    public NpgsqlDataSource GetDataSource(string? schemaName)
    {
        string key = string.IsNullOrWhiteSpace(schemaName) ? "public" : schemaName;
        return _sources.GetOrAdd(
            key,
            _ => new Lazy<NpgsqlDataSource>(
                () => BuildDataSource(schemaName),
                LazyThreadSafetyMode.ExecutionAndPublication)).Value;
    }

    public async ValueTask DisposeAsync()
    {
        foreach (Lazy<NpgsqlDataSource> source in _sources.Values)
        {
            if (source.IsValueCreated)
            {
                await source.Value.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    private NpgsqlDataSource BuildDataSource(string? schemaName)
    {
        string scoped = string.IsNullOrWhiteSpace(schemaName)
            ? _connectionString
            : SqlSugarInitializer.ApplySearchPath(_connectionString, schemaName);
        var connection = new NpgsqlConnectionStringBuilder(scoped)
        {
            ApplicationName = "FsusBlog.PublicArticleProjection",
            MaxPoolSize = _maxPoolSize,
            MinPoolSize = _minPoolSize,
            CommandTimeout = _commandTimeoutSeconds,
            MaxAutoPrepare = 32,
            AutoPrepareMinUsages = 2
        };
        var builder = new NpgsqlDataSourceBuilder(connection.ConnectionString);
        return builder.Build();
    }
}

public sealed class PublicArticleProjectionStore(
    PublicArticleProjectionDataSourceProvider dataSources,
    PublicArticleProjectionRuntimeState runtimeState,
    PublicArticleProjectionNegativeCache negativeCache,
    ISqlSugarClient db,
    ITestSessionContext testSession,
    IDbConcurrencyGate dbGate,
    IAedsEncoder aeds,
    IConfiguration configuration,
    ILogger<PublicArticleProjectionStore> logger) : IPublicArticleProjectionStore
{
    internal const string ReadSql = """
        SELECT version, aeds_payload, etag, updated_at_utc
        FROM public_article_projection
        WHERE article_id = $1
          AND visible = true
        LIMIT 1;
        """;

    internal const string UpsertSql = """
        INSERT INTO public_article_projection (
            article_id,
            version,
            visible,
            aeds_payload,
            etag,
            content_hash,
            unavailable_reason,
            updated_at_utc,
            projection_schema_version)
        VALUES (@ArticleId, nextval('public_article_projection_version_seq'), true, @Frame, @ETag, @ContentHash, NULL, @UpdatedAtUtc, 1)
        ON CONFLICT (article_id) DO UPDATE SET
            version = CASE
                WHEN public_article_projection.content_hash = EXCLUDED.content_hash
                 AND public_article_projection.visible = true
                THEN public_article_projection.version
                ELSE nextval('public_article_projection_version_seq')
            END,
            visible = true,
            aeds_payload = EXCLUDED.aeds_payload,
            etag = EXCLUDED.etag,
            content_hash = EXCLUDED.content_hash,
            unavailable_reason = NULL,
            updated_at_utc = EXCLUDED.updated_at_utc,
            projection_schema_version = EXCLUDED.projection_schema_version;
        """;

    internal const string MarkUnavailableSql = """
        INSERT INTO public_article_projection (
            article_id,
            version,
            visible,
            aeds_payload,
            etag,
            content_hash,
            unavailable_reason,
            updated_at_utc,
            projection_schema_version)
        VALUES (@ArticleId, nextval('public_article_projection_version_seq'), false, NULL, NULL, NULL, @Reason, now(), 1)
        ON CONFLICT (article_id) DO UPDATE SET
            version = CASE
                WHEN public_article_projection.visible = false
                 AND public_article_projection.unavailable_reason = EXCLUDED.unavailable_reason
                THEN public_article_projection.version
                ELSE nextval('public_article_projection_version_seq')
            END,
            visible = false,
            aeds_payload = NULL,
            etag = NULL,
            content_hash = NULL,
            unavailable_reason = EXCLUDED.unavailable_reason,
            updated_at_utc = EXCLUDED.updated_at_utc,
            projection_schema_version = EXCLUDED.projection_schema_version;
        """;

    internal const string RecordShadowMismatchSql = """
        INSERT INTO public_article_projection_shadow_mismatch (
            article_id,
            expected_hash,
            actual_hash,
            projection_version,
            reason,
            observed_at_utc)
        VALUES (@ArticleId, @ExpectedHash, @ActualHash, @ProjectionVersion, @Reason, now() AT TIME ZONE 'utc');
        """;

    internal const string ShadowReadSql = """
        SELECT version, aeds_payload
        FROM public_article_projection
        WHERE article_id = @ArticleId
          AND visible = true
        LIMIT 1;
        """;

    public Task<PublicArticleProjectionReadResult> TryReadAsync(
        int articleId,
        CancellationToken cancellationToken = default)
    {
        if (articleId <= 0)
        {
            return Task.FromResult(new PublicArticleProjectionReadResult(PublicArticleProjectionReadStatus.NotFound, 0, default, null, null));
        }

        if (!configuration.GetValue(PublicArticleProjectionReadContract.EnabledConfigurationKey, true))
        {
            return Task.FromResult(new PublicArticleProjectionReadResult(
                PublicArticleProjectionReadStatus.Unavailable,
                0,
                default,
                null,
                null,
                "cutover-disabled"));
        }

        if (negativeCache.IsMissing(testSession.SchemaName, articleId))
        {
            return Task.FromResult(new PublicArticleProjectionReadResult(
                PublicArticleProjectionReadStatus.NotFound,
                0,
                default,
                null,
                null,
                "negative-cache"));
        }

        return ReadWithNegativeCacheAsync(articleId, cancellationToken);
    }

    private async Task<PublicArticleProjectionReadResult> ReadWithNegativeCacheAsync(
        int articleId,
        CancellationToken cancellationToken)
    {
        PublicArticleProjectionReadResult result = await dbGate.ExecuteClassifiedAsync(
            DbWorkloadClass.PublicShortRead,
            "public-article-projection-read",
            ct => ReadCoreAsync(articleId, ct),
            _ => Task.FromResult(new PublicArticleProjectionReadResult(
                PublicArticleProjectionReadStatus.Unavailable,
                0,
                default,
                null,
                null,
                "db-gate-timeout")),
            cancellationToken).ConfigureAwait(false);
        if (result.Status == PublicArticleProjectionReadStatus.NotFound)
        {
            negativeCache.MarkMissing(testSession.SchemaName, articleId);
        }

        return result;
    }

    public Task UpsertAsync(PublicArticleProjectionWrite projection, CancellationToken cancellationToken = default)
        => dbGate.ExecuteClassifiedAsync(
            DbWorkloadClass.BackgroundProjection,
            "public-article-projection-write",
            async ct =>
            {
                negativeCache.Invalidate(testSession.SchemaName, projection.ArticleId);
                await ExecuteWriteAsync(UpsertSql, projection, reason: null, ct).ConfigureAwait(false);
                return true;
            },
            _ => Task.FromException<bool>(new TimeoutException($"db-gate-timeout:public-article-projection-write:{projection.ArticleId}")),
            cancellationToken);

    public Task MarkUnavailableAsync(int articleId, string reason, CancellationToken cancellationToken = default)
        => dbGate.ExecuteClassifiedAsync(
            DbWorkloadClass.BackgroundProjection,
            "public-article-projection-unavailable",
            async ct =>
            {
                negativeCache.Invalidate(testSession.SchemaName, articleId);
                var projection = new PublicArticleProjectionWrite(articleId, default, string.Empty, string.Empty, DateTimeOffset.UtcNow);
                await ExecuteWriteAsync(MarkUnavailableSql, projection, NormalizeReason(reason), ct).ConfigureAwait(false);
                negativeCache.MarkMissing(testSession.SchemaName, articleId);
                return true;
            },
            _ => Task.FromException<bool>(new TimeoutException($"db-gate-timeout:public-article-projection-unavailable:{articleId}")),
            cancellationToken);

    public Task<bool> VerifyShadowParityAsync(
        int articleId,
        ReadOnlyMemory<byte> expectedFrame,
        CancellationToken cancellationToken = default)
        => dbGate.ExecuteClassifiedAsync(
            DbWorkloadClass.BackgroundProjection,
            "public-article-projection-shadow-compare",
            async ct =>
            {
                PublicArticleProjectionReadResult actual = await ReadShadowCoreAsync(articleId, ct).ConfigureAwait(false);
                if (actual.Found && actual.Frame.Span.SequenceEqual(expectedFrame.Span))
                {
                    return true;
                }

                string expectedHash = CreateContentHash(expectedFrame.Span);
                string? actualHash = actual.Found ? CreateContentHash(actual.Frame.Span) : null;
                string reason = actual.Status switch
                {
                    PublicArticleProjectionReadStatus.NotFound => "projection-missing",
                    PublicArticleProjectionReadStatus.Invalid => "projection-invalid",
                    PublicArticleProjectionReadStatus.Unavailable => "projection-unavailable",
                    _ => "semantic-frame-mismatch"
                };
                await RecordShadowMismatchAsync(
                    articleId,
                    expectedHash,
                    actualHash,
                    actual.Version > 0 ? actual.Version : null,
                    reason,
                    ct).ConfigureAwait(false);
                logger.LogError(
                    "public-article-projection-shadow-mismatch {ArticleId} {Version} {Reason}",
                    articleId,
                    actual.Version,
                    reason);
                return false;
            },
            _ => Task.FromException<bool>(new TimeoutException($"db-gate-timeout:public-article-projection-shadow-compare:{articleId}")),
            cancellationToken);

    private async Task<PublicArticleProjectionReadResult> ReadCoreAsync(int articleId, CancellationToken cancellationToken)
    {
        NpgsqlDataSource dataSource = dataSources.GetDataSource(testSession.SchemaName);
        runtimeState.EnterWait();
        long poolWaitStarted = Stopwatch.GetTimestamp();
        NpgsqlConnection? connection = null;
        try
        {
            connection = await dataSource.OpenConnectionAsync(cancellationToken).ConfigureAwait(false);
            runtimeState.EnterActive(Stopwatch.GetElapsedTime(poolWaitStarted));
        }
        catch (Exception ex)
        {
            runtimeState.CancelWait(Stopwatch.GetElapsedTime(poolWaitStarted));
            RecordConnectionFailure(ex);
            throw;
        }

        await using (connection.ConfigureAwait(false))
        {
            long queryStarted = Stopwatch.GetTimestamp();
            PublicArticleProjectionReadStatus status = PublicArticleProjectionReadStatus.Unavailable;
            try
            {
                await using var command = new NpgsqlCommand(ReadSql, connection)
                {
                    CommandTimeout = dataSources.CommandTimeoutSeconds
                };
                command.Parameters.Add(new NpgsqlParameter<int> { TypedValue = articleId });
                RuntimeCacheEvidenceObservation.Current?.QueryPlanCapture?.Record(command);
                await command.PrepareAsync(cancellationToken).ConfigureAwait(false);
                await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(
                    PublicArticleProjectionReadContract.Behavior,
                    cancellationToken).ConfigureAwait(false);
                if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    status = PublicArticleProjectionReadStatus.NotFound;
                    return new PublicArticleProjectionReadResult(status, 0, default, null, null);
                }

                long version = reader.GetInt64(PublicArticleProjectionReadContract.VersionOrdinal);
                byte[] frame = await reader.GetFieldValueAsync<byte[]>(
                    PublicArticleProjectionReadContract.FrameOrdinal,
                    cancellationToken).ConfigureAwait(false);
                string etag = reader.GetString(PublicArticleProjectionReadContract.ETagOrdinal);
                DateTime updatedAt = reader.GetDateTime(PublicArticleProjectionReadContract.UpdatedAtOrdinal);
                if (!TryValidateFrame(frame, etag, out string? validationError))
                {
                    status = PublicArticleProjectionReadStatus.Invalid;
                    logger.LogError(
                        "public-article-projection-invalid {ArticleId} {Version} {Error}",
                        articleId,
                        version,
                        validationError);
                    return new PublicArticleProjectionReadResult(
                        status,
                        version,
                        default,
                        etag,
                        new DateTimeOffset(DateTime.SpecifyKind(updatedAt, DateTimeKind.Utc)),
                        validationError);
                }

                status = PublicArticleProjectionReadStatus.Found;
                return new PublicArticleProjectionReadResult(
                    status,
                    version,
                    frame,
                    etag,
                    new DateTimeOffset(DateTime.SpecifyKind(updatedAt, DateTimeKind.Utc)));
            }
            catch (TimeoutException)
            {
                runtimeState.RecordTimeout();
                throw;
            }
            catch (NpgsqlException ex)
            {
                RecordConnectionFailure(ex);
                throw;
            }
            finally
            {
                runtimeState.Complete(status, Stopwatch.GetElapsedTime(queryStarted));
            }
        }
    }

    private async Task ExecuteWriteAsync(
        string sql,
        PublicArticleProjectionWrite projection,
        string? reason,
        CancellationToken cancellationToken)
    {
        var parameters = new List<SugarParameter>
        {
            new("@ArticleId", projection.ArticleId)
        };
        if (reason is null)
        {
            parameters.Add(new SugarParameter("@Frame", projection.Frame.ToArray()));
            parameters.Add(new SugarParameter("@ETag", projection.ETag));
            parameters.Add(new SugarParameter("@ContentHash", projection.ContentHash));
            parameters.Add(new SugarParameter("@UpdatedAtUtc", projection.UpdatedAtUtc.UtcDateTime));
        }
        else
        {
            parameters.Add(new SugarParameter("@Reason", reason));
        }

        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(sql, parameters).ConfigureAwait(false);
    }

    private async Task<PublicArticleProjectionReadResult> ReadShadowCoreAsync(
        int articleId,
        CancellationToken cancellationToken)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            ShadowReadSql,
            new SugarParameter("@ArticleId", articleId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return new PublicArticleProjectionReadResult(PublicArticleProjectionReadStatus.NotFound, 0, default, null, null);
        }

        long version = reader.GetInt64(0);
        byte[] frame = reader.GetFieldValue<byte[]>(1);
        return new PublicArticleProjectionReadResult(
            PublicArticleProjectionReadStatus.Found,
            version,
            frame,
            null,
            null);
    }

    private async Task RecordShadowMismatchAsync(
        int articleId,
        string expectedHash,
        string? actualHash,
        long? projectionVersion,
        string reason,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            RecordShadowMismatchSql,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@ExpectedHash", expectedHash),
            new SugarParameter("@ActualHash", (object?)actualHash ?? DBNull.Value),
            new SugarParameter("@ProjectionVersion", (object?)projectionVersion ?? DBNull.Value),
            new SugarParameter("@Reason", reason)).ConfigureAwait(false);
    }

    private bool TryValidateFrame(byte[] frame, string etag, out string? error)
    {
        var decoded = aeds.TryDecode(frame);
        if (!decoded.IsSuccess || decoded.Value.FrameType != AedsFrameType.ArticleDetail)
        {
            error = decoded.IsSuccess ? "unexpected-frame-type" : "aeds-validation-failed";
            return false;
        }

        if (!ArticleDetailAedsFileArtifactStore.LooksLikeAedsArticleDetailFrame(frame))
        {
            error = "article-detail-v3-validation-failed";
            return false;
        }

        string expected = CreateETag(frame);
        if (!string.Equals(expected, etag, StringComparison.Ordinal))
        {
            error = "etag-mismatch";
            return false;
        }

        error = null;
        return true;
    }

    private void RecordConnectionFailure(Exception exception)
    {
        if (exception is TimeoutException || exception is NpgsqlException { IsTransient: true })
        {
            runtimeState.RecordTimeout();
        }

        if (exception is NpgsqlException || exception is InvalidOperationException)
        {
            runtimeState.RecordBrokenConnection();
        }
    }

    public static string CreateContentHash(ReadOnlySpan<byte> frame)
        => Convert.ToHexString(SHA256.HashData(frame)).ToLowerInvariant();

    public static string CreateETag(ReadOnlySpan<byte> frame)
        => string.Concat('"', CreateContentHash(frame), '"');

    private static string NormalizeReason(string reason)
    {
        string normalized = string.IsNullOrWhiteSpace(reason) ? "not-public" : reason.Trim().ToLowerInvariant();
        return normalized.Length <= 96 ? normalized : normalized[..96];
    }
}
