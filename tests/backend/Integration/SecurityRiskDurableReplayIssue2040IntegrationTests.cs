using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

using Microsoft.Extensions.DependencyInjection;

using Npgsql;

using SqlSugar;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>No container producer: the coordinator must supply an explicitly task-owned loopback PostgreSQL database.</summary>
[Trait("Category", "Integration")]
public sealed class SecurityRiskDurableReplayIssue2040IntegrationTests(ITestOutputHelper output) : IAsyncLifetime
{
    internal const string DatabaseVariable = "FSUSBLOG_SECURITY_RISK_ISSUE2040_DATABASE";
    private string? _adminConnection;
    private string? _connection;
    private string? _database;

    public async Task InitializeAsync()
    {
        string configured = Environment.GetEnvironmentVariable(DatabaseVariable)
            ?? throw new InvalidOperationException("Task-owned security-risk PostgreSQL prerequisite is missing; no runtime qualification.");
        var builder = new NpgsqlConnectionStringBuilder(configured);
        if (!IPAddress.TryParse(builder.Host, out IPAddress? address) || !IPAddress.IsLoopback(address)
            || builder.Database is not { } sourceDatabase || !sourceDatabase.StartsWith("fsus_", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Task-owned loopback database admission rejected.");
        }
        builder.Pooling = false;
        _adminConnection = builder.ConnectionString;
        string database = "fsus_security_risk_2040_" + Guid.NewGuid().ToString("N");
        await using (var connection = new NpgsqlConnection(_adminConnection))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand($"CREATE DATABASE \"{database}\";", connection);
            await command.ExecuteNonQueryAsync();
        }
        _database = database; // Only this exact, newly created test database is cleanup-owned.
        builder.Database = database;
        builder.ApplicationName = "security-risk-2040";
        _connection = builder.ConnectionString;
        using SqlSugarClient db = Client();
        PostgresSqlSugarTestClient.InitTables(db, typeof(SecurityRiskEvent));
        await AssertTimestampSchemaAsync();
    }

    public async Task DisposeAsync()
    {
        if (_database is not null)
        {
            await using var connection = new NpgsqlConnection(_adminConnection);
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand($"DROP DATABASE \"{_database}\" WITH (FORCE);", connection);
            await command.ExecuteNonQueryAsync();
        }
    }

    [Fact]
    public async Task RealCommitBeforeAckLoss_ColdReplayKeepsOneFullNormalizedRow()
    {
        using SqlSugarClient db = Client();
        using var owner = new SecurityRiskIssue2040Owner(store: new SecurityRiskEventStore(db));
        SecurityRiskEventWrite expected = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(expected));
        ProtectedDeliveryWitness witness = await CaptureProtectedDeliveryAsync(owner, expected);
        Assert.True(owner.Queue.TryRead(out SecurityRiskEventWrite delivery));
        await AssertProtectedDeliveryAsync(owner, witness, leased: true);
        await new SecurityRiskEventStore(db).AppendAsync(delivery);
        AssertFullRow(expected, Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync()));
        await AssertRawTimestampsAsync(expected);
        await AssertProtectedDeliveryAsync(owner, witness, leased: true);
        owner.Queue.Dispose(); // Cold owner cannot borrow the original in-flight reservation.
        await AssertProtectedDeliveryAsync(owner, witness);
        using var cold = new SecurityRiskIssue2040Owner(owner.Root, deleteRoot: false, store: new SecurityRiskEventStore(db));
        Assert.Equal(1, await cold.Worker.FlushOnceAsync(CancellationToken.None));
        AssertFullRow(expected, Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync()));
        await AssertRawTimestampsAsync(expected);
        Assert.Equal(0, cold.Queue.Snapshot().OutstandingCount);
        await AssertDeliveryDeletedAsync(cold, witness);
    }

    [Fact]
    public async Task RealSqlAck_DeletesOnlyItsExactCiphertextAndPerEventKeyWhilePeerRemainsProtected()
    {
        using SqlSugarClient db = Client();
        var store = new SecurityRiskEventStore(db);
        using var owner = new SecurityRiskIssue2040Owner(store: store);
        SecurityRiskEventWrite first = SecurityRiskIssue2040Owner.Write();
        SecurityRiskEventWrite peer = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(first));
        ProtectedDeliveryWitness firstWitness = await CaptureProtectedDeliveryAsync(owner, first);
        Assert.True(await owner.Queue.EnqueueAsync(peer));
        ProtectedDeliveryWitness peerWitness = await CaptureProtectedDeliveryAsync(owner, peer);
        Assert.NotEqual(firstWitness.Reference, peerWitness.Reference);
        Assert.True(firstWitness.KeyPath != peerWitness.KeyPath, "security-risk-witness:per-event-key-not-independent");
        Assert.NotEqual(firstWitness.KeyDigest, peerWitness.KeyDigest);
        Assert.Empty(await db.Queryable<SecurityRiskEvent>().ToListAsync());

        Assert.True(owner.Queue.TryRead(out SecurityRiskEventWrite firstDelivery));
        Assert.Equal(first.Id, firstDelivery.Id);
        await AssertProtectedDeliveryAsync(owner, firstWitness, leased: true);
        await AssertProtectedDeliveryAsync(owner, peerWitness);
        await store.AppendAsync(firstDelivery); // Real SQL COMMIT; journal ACK is deliberately still outstanding.
        AssertFullRow(first, Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync()));
        await AssertRawTimestampsAsync(first);
        await AssertProtectedDeliveryAsync(owner, firstWitness, leased: true);
        await AssertProtectedDeliveryAsync(owner, peerWitness);
        await owner.Worker.PersistSafelyAsync([firstDelivery], CancellationToken.None);
        await AssertDeliveryDeletedAsync(owner, firstWitness);
        await AssertProtectedDeliveryAsync(owner, peerWitness);
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        AssertFullRow(first, Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync()));
        await AssertRawTimestampsAsync(first);

        Assert.True(owner.Queue.TryRead(out SecurityRiskEventWrite peerDelivery));
        Assert.Equal(peer.Id, peerDelivery.Id);
        await AssertProtectedDeliveryAsync(owner, peerWitness, leased: true);
        await owner.Worker.PersistSafelyAsync([peerDelivery], CancellationToken.None);
        await AssertDeliveryDeletedAsync(owner, firstWitness);
        await AssertDeliveryDeletedAsync(owner, peerWitness);
        SecurityRiskEvent[] rows = (await db.Queryable<SecurityRiskEvent>().ToListAsync()).ToArray();
        Assert.Equal(2, rows.Length);
        AssertFullRow(first, Assert.Single(rows, row => row.Id == first.Id));
        AssertFullRow(peer, Assert.Single(rows, row => row.Id == peer.Id));
        await AssertRawTimestampsAsync(first);
        await AssertRawTimestampsAsync(peer);
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
    }

    [Theory]
    [InlineData("occurred_at_utc")]
    [InlineData("source")]
    [InlineData("reason")]
    [InlineData("action")]
    [InlineData("score_delta")]
    [InlineData("total_score")]
    [InlineData("ttl_seconds")]
    [InlineData("expires_at_utc")]
    [InlineData("subject_hash")]
    [InlineData("route_key")]
    [InlineData("client_ip_hash")]
    [InlineData("device_fp_hash")]
    [InlineData("path")]
    [InlineData("method")]
    [InlineData("user_agent")]
    [InlineData("detail")]
    [InlineData("trace_id")]
    [InlineData("pseudonym_epoch")]
    public async Task EveryNormalizedStoredField_IsAnExactCommitPostcondition(string column)
    {
        using SqlSugarClient db = Client();
        var store = new SecurityRiskEventStore(db);
        using var owner = new SecurityRiskIssue2040Owner(store: store);
        SecurityRiskEventWrite expected = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(expected));
        ProtectedDeliveryWitness witness = await CaptureProtectedDeliveryAsync(owner, expected);
        Assert.True(owner.Queue.TryRead(out SecurityRiskEventWrite delivery));
        await AssertProtectedDeliveryAsync(owner, witness, leased: true);
        await store.AppendAsync(delivery);
        await AssertProtectedDeliveryAsync(owner, witness, leased: true);
        await AssertRawTimestampsAsync(expected);
        string value = column switch
        {
            "occurred_at_utc" or "expires_at_utc" => $"{column} + interval '1 second'",
            "score_delta" or "total_score" or "ttl_seconds" or "pseudonym_epoch" => $"{column} + 1",
            _ => "'altered'"
        };
        // Identifiers and value expressions come only from the closed InlineData list.
        await db.Ado.ExecuteCommandAsync($"UPDATE security_risk_event SET {column} = {value};");
        await Assert.ThrowsAsync<InvalidDataException>(() => store.AppendAsync(delivery));
        await owner.Worker.PersistSafelyAsync([delivery], CancellationToken.None);
        Assert.Equal(1, await db.Queryable<SecurityRiskEvent>().CountAsync());
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        await AssertProtectedDeliveryAsync(owner, witness);
    }

    [Fact]
    public async Task RealBlockedInsertCancellation_RollsBackThenReplaysOriginalTimeTtlEpoch()
    {
        using SqlSugarClient db = Client();
        using var owner = new SecurityRiskIssue2040Owner(store: new SecurityRiskEventStore(db));
        SecurityRiskEventWrite expected = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(expected));
        ProtectedDeliveryWitness witness = await CaptureProtectedDeliveryAsync(owner, expected);
        await using var blocker = new NpgsqlConnection(_connection);
        await blocker.OpenAsync();
        await using var transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("LOCK TABLE security_risk_event IN ACCESS EXCLUSIVE MODE;", blocker, transaction))
        {
            await command.ExecuteNonQueryAsync();
        }
        using var cancellation = new CancellationTokenSource();
        Task flush = owner.Worker.FlushOnceAsync(cancellation.Token);
        Assert.True(await WaitForRealInsertLockAsync(flush));
        Assert.Equal(1, owner.Queue.Snapshot().InFlightCount);
        await AssertProtectedDeliveryAsync(owner, witness, leased: true);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => flush);
        Assert.Equal(0, owner.Queue.Snapshot().InFlightCount);
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        await AssertProtectedDeliveryAsync(owner, witness);
        await transaction.RollbackAsync();
        Assert.Equal(0, await db.Queryable<SecurityRiskEvent>().CountAsync());
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        AssertFullRow(expected, Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync()));
        await AssertRawTimestampsAsync(expected);
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        await AssertDeliveryDeletedAsync(owner, witness);
    }

    [Fact]
    public async Task RealStoreFailure_RetainsCiphertextThenRepairsOnlyThroughExactCommit()
    {
        using SqlSugarClient db = Client();
        using var owner = new SecurityRiskIssue2040Owner(store: new SecurityRiskEventStore(db));
        SecurityRiskEventWrite expected = SecurityRiskIssue2040Owner.Write();
        Assert.True(await owner.Queue.EnqueueAsync(expected));
        ProtectedDeliveryWitness witness = await CaptureProtectedDeliveryAsync(owner, expected);
        await db.Ado.ExecuteCommandAsync("ALTER TABLE security_risk_event RENAME COLUMN detail TO unavailable_detail;");
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        Assert.Equal(1, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(1, owner.Queue.Snapshot().OutstandingCount);
        await AssertProtectedDeliveryAsync(owner, witness);
        await db.Ado.ExecuteCommandAsync("ALTER TABLE security_risk_event RENAME COLUMN unavailable_detail TO detail;");
        Assert.Equal(1, await owner.Worker.FlushOnceAsync(CancellationToken.None));
        AssertFullRow(expected, Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync()));
        await AssertRawTimestampsAsync(expected);
        Assert.Equal(0, owner.Queue.Snapshot().TerminalFailureCount);
        Assert.Equal(0, owner.Queue.Snapshot().OutstandingCount);
        await AssertDeliveryDeletedAsync(owner, witness);
    }

    [Fact]
    [Trait("Category", "Process")]
    public async Task RealSqlCommitThenKillBeforeJournalAck_ColdOwnerVerifiesExactExistingRow()
    {
        using var owner = new SecurityRiskIssue2040Owner();
        string invocation = Guid.NewGuid().ToString("N");
        string assembly = typeof(SecurityRiskDurableReplayIssue2040IntegrationTests).Assembly.Location;
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(assembly)));
        string rootDigest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(owner.Root)));
        var start = new ProcessStartInfo(PublicAotCrashWorkerProgram.ResolveDotNetHostPath())
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (string argument in new[] { assembly, SecurityRiskAdmissionProcessIssue2040Worker.Command, owner.Root,
            invocation, Environment.ProcessId.ToString(CultureInfo.InvariantCulture), "committed" })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment[DatabaseVariable] = _connection;
        using var process = new Process { StartInfo = start };
        Assert.True(process.Start());
        Task<string> errors = process.StandardError.ReadToEndAsync();
        try
        {
            string? marker = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal($"security-risk-durable {invocation} {process.Id} {Environment.ProcessId} {digest} {rootDigest} committed", marker);
            output.WriteLine(marker);
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            Assert.NotEqual(0, process.ExitCode);
            Assert.Equal(string.Empty, await errors);
            output.WriteLine($"security-risk-killed pid={process.Id} exit={process.ExitCode} assembly={digest}");
            using SqlSugarClient db = Client();
            SecurityRiskEventWrite expected = SecurityRiskIssue2040Owner.Write() with
            {
                Id = invocation
            };
            ProtectedDeliveryWitness witness = await CaptureProtectedDeliveryAsync(owner, expected);
            AssertFullRow(expected, Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync()));
            await AssertRawTimestampsAsync(expected);
            using var cold = new SecurityRiskIssue2040Owner(owner.Root, deleteRoot: false, store: new SecurityRiskEventStore(db));
            Assert.Equal(1, await cold.Worker.FlushOnceAsync(CancellationToken.None));
            AssertFullRow(expected, Assert.Single(await db.Queryable<SecurityRiskEvent>().ToListAsync()));
            await AssertRawTimestampsAsync(expected);
            Assert.Equal(0, cold.Queue.Snapshot().OutstandingCount);
            await AssertDeliveryDeletedAsync(cold, witness);
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
    }

    private SqlSugarClient Client() => PostgresSqlSugarTestClient.Create(_connection
        ?? throw new InvalidOperationException("Task-owned database has not been initialized."));

    private async Task AssertTimestampSchemaAsync()
    {
        using SqlSugarClient db = Client();
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT column_name, data_type, datetime_precision, is_nullable, current_setting('TimeZone')
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'security_risk_event'
                AND column_name IN ('occurred_at_utc', 'expires_at_utc')
            ORDER BY column_name;
            """, connection);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        foreach (string column in new[] { "expires_at_utc", "occurred_at_utc" })
        {
            Assert.True(await reader.ReadAsync());
            Assert.Equal(column, reader.GetString(0));
            Assert.Equal("timestamp without time zone", reader.GetString(1));
            Assert.Equal(6, reader.GetInt32(2));
            Assert.Equal("NO", reader.GetString(3));
            Assert.Equal("UTC", reader.GetString(4));
        }
        Assert.False(await reader.ReadAsync());
    }

    private async Task AssertRawTimestampsAsync(SecurityRiskEventWrite expected)
    {
        SecurityRiskEvent prepared = SecurityRiskEventStore.ToEntity(expected);
        Assert.Equal(DateTimeKind.Utc, prepared.OccurredAtUtc.Kind);
        Assert.Equal(DateTimeKind.Utc, prepared.ExpiresAtUtc.Kind);
        Assert.Equal(expected.OccurredAtUtc.UtcTicks, prepared.OccurredAtUtc.Ticks);
        Assert.Equal(expected.ExpiresAtUtc.UtcTicks, prepared.ExpiresAtUtc.Ticks);
        using SqlSugarClient db = Client();
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT occurred_at_utc, expires_at_utc, current_setting('TimeZone')
            FROM security_risk_event WHERE id = @Id;
            """, connection);
        command.Parameters.AddWithValue("Id", expected.Id);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal("UTC", reader.GetString(2));
        AssertRawTimestamp(expected.OccurredAtUtc, reader.GetDateTime(0));
        AssertRawTimestamp(expected.ExpiresAtUtc, reader.GetDateTime(1));
        Assert.False(await reader.ReadAsync());
    }

    private static void AssertRawTimestamp(DateTimeOffset expected, DateTime actual)
    {
        Assert.Equal(TimeSpan.Zero, expected.Offset);
        Assert.Equal(DateTimeKind.Unspecified, actual.Kind);
        Assert.Equal(0L, actual.Ticks % 10);
        Assert.Equal(expected.UtcTicks - expected.UtcTicks % 10, actual.Ticks);
    }

    private sealed record ProtectedDeliveryWitness(string Reference, string SourcePath, string KeyPath,
        string SourceDigest, string KeyDigest);

    private static async Task<ProtectedDeliveryWitness> CaptureProtectedDeliveryAsync(
        SecurityRiskIssue2040Owner owner, SecurityRiskEventWrite expected)
    {
        string reference = SecurityRiskDurableDelivery.Reference(expected.Id);
        string[] sources = Directory.GetFiles(Path.Combine(owner.Root, "security-risk-fallback"),
            $"security-risk-*-{reference}.json");
        Assert.True(sources.Length == 1, "security-risk-witness:exact-pending-source-required");
        AssertPrivateWitnessFile(sources[0]);
        byte[] source = await File.ReadAllBytesAsync(sources[0]);
        Assert.True(source.Length is > 0 and <= 65_536, "security-risk-witness:source-size-invalid");
        SecurityRiskJournalEnvelope envelope = JsonSerializer.Deserialize<SecurityRiskJournalEnvelope>(source)
            ?? throw new InvalidDataException("security-risk-witness:envelope-missing");
        Assert.Equal(1, envelope.Version);
        Assert.Equal(reference, envelope.Reference);
        Assert.True(envelope.Sequence > 0, "security-risk-witness:sequence-invalid");
        Assert.Equal($"security-risk-{envelope.Sequence:D19}-{reference}.json", Path.GetFileName(sources[0]));
        Assert.Equal(12, envelope.Nonce.Length);
        Assert.Equal(16, envelope.Tag.Length);
        byte[] key = await owner.Provider.GetRequiredService<IAuditRetentionEpochKeyStore>()
            .TryReadAsync(SecurityRiskFallbackWriter.KeyDomain, reference, CancellationToken.None)
            ?? throw new InvalidDataException("security-risk-witness:per-event-key-missing");
        byte[] plaintext = new byte[envelope.Ciphertext.Length];
        try
        {
            string? keyPath = null;
            // Match real file bytes against the production key capability; do not duplicate its filename protocol.
            foreach (string path in Directory.EnumerateFiles(Path.Combine(owner.Root, "audit-retention", "epoch-keys"), "dek-*.bin"))
            {
                AssertPrivateWitnessFile(path);
                byte[] candidate = await File.ReadAllBytesAsync(path);
                try
                {
                    if (CryptographicOperations.FixedTimeEquals(candidate, key))
                    {
                        Assert.True(keyPath is null, "security-risk-witness:ambiguous-per-event-key");
                        keyPath = path;
                    }
                }
                finally
                {
                    CryptographicOperations.ZeroMemory(candidate);
                }
            }
            Assert.True(keyPath is not null, "security-risk-witness:physical-key-missing");
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(envelope.Nonce, envelope.Ciphertext, envelope.Tag, plaintext,
                SecurityRiskDurableDelivery.AssociatedData(reference, envelope.Sequence));
            SecurityRiskDurableEntry delivery = JsonSerializer.Deserialize<SecurityRiskDurableEntry>(plaintext)
                ?? throw new InvalidDataException("security-risk-witness:payload-missing");
            Assert.Equal(reference, delivery.Reference);
            Assert.Equal(envelope.Sequence, delivery.Sequence);
            Assert.True(SecurityRiskDurableDelivery.SamePayload(SecurityRiskDurableDelivery.Normalize(expected), delivery.Payload),
                "security-risk-witness:normalized-payload-mismatch");
            return new(reference, sources[0], keyPath ?? throw new InvalidDataException("security-risk-witness:physical-key-missing"),
                Convert.ToHexStringLower(SHA256.HashData(source)), Convert.ToHexStringLower(SHA256.HashData(key)));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            CryptographicOperations.ZeroMemory(plaintext);
        }
    }

    private static async Task AssertProtectedDeliveryAsync(SecurityRiskIssue2040Owner owner,
        ProtectedDeliveryWitness witness, bool leased = false)
    {
        AssertPrivateWitnessFile(witness.SourcePath);
        AssertPrivateWitnessFile(witness.KeyPath);
        if (!leased)
        {
            Assert.Equal(witness.SourceDigest, Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(witness.SourcePath))));
        }
        // The source lease is FileShare.None; do not weaken or bypass it to reopen in-flight ciphertext.
        byte[] key = await owner.Provider.GetRequiredService<IAuditRetentionEpochKeyStore>()
            .TryReadAsync(SecurityRiskFallbackWriter.KeyDomain, witness.Reference, CancellationToken.None)
            ?? throw new InvalidDataException("security-risk-witness:protected-key-disappeared");
        byte[]? physical = null;
        try
        {
            physical = await File.ReadAllBytesAsync(witness.KeyPath);
            Assert.Equal(witness.KeyDigest, Convert.ToHexStringLower(SHA256.HashData(key)));
            Assert.True(CryptographicOperations.FixedTimeEquals(physical, key), "security-risk-witness:key-file-changed");
        }
        finally
        {
            CryptographicOperations.ZeroMemory(key);
            if (physical is not null)
            {
                CryptographicOperations.ZeroMemory(physical);
            }
        }
    }

    private static async Task AssertDeliveryDeletedAsync(SecurityRiskIssue2040Owner owner, ProtectedDeliveryWitness witness)
    {
        Assert.True(!File.Exists(witness.SourcePath) && !Directory.Exists(witness.SourcePath), "security-risk-witness:source-not-deleted");
        Assert.True(!Directory.EnumerateFileSystemEntries(Path.Combine(owner.Root, "security-risk-fallback"),
            $"security-risk-*-{witness.Reference}.json*").Any(), "security-risk-witness:delivery-marker-not-deleted");
        Assert.True(!File.Exists(witness.KeyPath) && !Directory.Exists(witness.KeyPath), "security-risk-witness:key-not-deleted");
        byte[]? key = await owner.Provider.GetRequiredService<IAuditRetentionEpochKeyStore>()
            .TryReadAsync(SecurityRiskFallbackWriter.KeyDomain, witness.Reference, CancellationToken.None);
        try
        {
            Assert.True(key is null, "security-risk-witness:key-capability-survived-ack");
        }
        finally
        {
            if (key is not null)
            {
                CryptographicOperations.ZeroMemory(key);
            }
        }
    }

    private static void AssertPrivateWitnessFile(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("security-risk-witness:unix-permission-evidence-required");
        }
        var info = new FileInfo(path);
        Assert.True(info.Exists && !info.Attributes.HasFlag(FileAttributes.Directory)
            && !info.Attributes.HasFlag(FileAttributes.ReparsePoint), "security-risk-witness:private-regular-file-required");
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
    }

    private async Task<bool> WaitForRealInsertLockAsync(Task writer)
    {
        await using var connection = new NpgsqlConnection(_connection);
        await connection.OpenAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!writer.IsCompleted)
        {
            await using var command = new NpgsqlCommand(
                "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%INSERT%security_risk_event%';",
                connection);
            if (Convert.ToInt64(await command.ExecuteScalarAsync(deadline.Token), CultureInfo.InvariantCulture) > 0)
            {
                return true;
            }
            await Task.Delay(25, deadline.Token);
        }
        return false;
    }

    private static void AssertFullRow(SecurityRiskEventWrite expected, SecurityRiskEvent actual)
    {
        Assert.Equal(expected.Id, actual.Id);
        AssertRawTimestamp(expected.OccurredAtUtc, actual.OccurredAtUtc);
        AssertRawTimestamp(expected.ExpiresAtUtc, actual.ExpiresAtUtc);
        Assert.Equal(expected.OccurredAtUtc.UtcTicks / 10, actual.OccurredAtUtc.Ticks / 10);
        Assert.Equal(expected.Source, actual.Source);
        Assert.Equal(expected.Reason, actual.Reason);
        Assert.Equal(expected.Action, actual.Action);
        Assert.Equal(expected.ScoreDelta, actual.ScoreDelta);
        Assert.Equal(expected.TotalScore, actual.TotalScore);
        Assert.Equal(expected.TtlSeconds, actual.TtlSeconds);
        Assert.Equal(expected.ExpiresAtUtc.UtcTicks / 10, actual.ExpiresAtUtc.Ticks / 10);
        Assert.Equal(expected.SubjectHash, actual.SubjectHash);
        Assert.Equal(expected.RouteKey, actual.RouteKey);
        Assert.Equal(expected.ClientIpHash, actual.ClientIpHash);
        Assert.Equal(expected.DeviceFpHash, actual.DeviceFpHash);
        Assert.Null(actual.Path);
        Assert.Equal(expected.Method, actual.Method);
        Assert.Null(actual.UserAgent);
        Assert.Equal(expected.Detail, actual.Detail);
        Assert.Equal(expected.TraceId, actual.TraceId);
        Assert.Equal(expected.PseudonymEpoch, actual.PseudonymEpoch);
    }
}
