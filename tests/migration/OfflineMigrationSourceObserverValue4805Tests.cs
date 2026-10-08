using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Migration;

using Microsoft.Data.Sqlite;

using Npgsql;

using Xunit;

namespace FsusBlog.Migration.Tests;

// These are source/profile and streaming-codec controls, not actual database qualification.
public sealed class OfflineMigrationSourceObserverValue4805Tests
{
    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void RegistryContainsOnlyExplicitEmptyAndHistoricalProfiles(CurrentSchemaProviderKind provider)
    {
        OfflineMigrationSourceRegistry registry = OfflineMigrationSourceFingerprints.CreateRegistry();
        OfflineMigrationFingerprintDefinition empty = registry.Match(Observation(provider, false));
        OfflineMigrationFingerprintDefinition legacy = registry.Match(Observation(provider, true));
        Assert.Equal(OfflineMigrationSourceFingerprints.EmptyId, empty.Id);
        Assert.Equal("bootstrap-current-schema", empty.EntryStepId);
        Assert.Equal(OfflineMigrationSourceFingerprints.LegacyId, legacy.Id);
        Assert.Equal("legacy-20260517-to-current", legacy.EntryStepId);
        Assert.Equal(Enum.GetValues<CurrentSchemaProviderKind>(), empty.Providers.Select(shape => shape.Provider));
        Assert.Equal(Enum.GetValues<CurrentSchemaProviderKind>(), legacy.Providers.Select(shape => shape.Provider));
        Assert.All(legacy.Providers, shape => Assert.Equal(new OfflineMigrationFact("history.state", "absent"), Assert.Single(shape.History)));
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void OneColumnOrBusinessShapeDriftIsRefused(CurrentSchemaProviderKind provider)
    {
        OfflineMigrationSourceRegistry registry = OfflineMigrationSourceFingerprints.CreateRegistry();
        OfflineMigrationSourceObservation accepted = Observation(provider, true);
        int column = Array.FindIndex(accepted.Schema.ToArray(), fact => fact.Name == "column/article/title");
        Assert.True(column >= 0);
        AssertUnknown(accepted with { Schema = accepted.Schema.SetItem(column, accepted.Schema[column] with { Value = "changed" }) },
            OfflineMigrationFingerprintCategory.Schema, OfflineMigrationFingerprintDifferenceKind.Changed,
            accepted.Schema[column].Name, accepted.Schema[column].Value, "changed");
        AssertUnknown(accepted with { Schema = accepted.Schema.RemoveAt(column) },
            OfflineMigrationFingerprintCategory.Schema, OfflineMigrationFingerprintDifferenceKind.Missing,
            accepted.Schema[column].Name, accepted.Schema[column].Value, null);
        AssertUnknown(accepted with { Schema = accepted.Schema.Add(new("column/article/unknown", "present")) },
            OfflineMigrationFingerprintCategory.Schema, OfflineMigrationFingerprintDifferenceKind.Extra,
            "column/article/unknown", null, "present");
        foreach (OfflineMigrationFact fact in accepted.BusinessShape.Where(fact => fact.Name != "business.profile"))
        {
            AssertUnknown(accepted with
            {
                BusinessShape = accepted.BusinessShape.Select(value => value.Name == fact.Name ? value with { Value = "1" } : value).ToImmutableArray()
            }, OfflineMigrationFingerprintCategory.Business, OfflineMigrationFingerprintDifferenceKind.Changed,
                fact.Name, fact.Value, "1");
        }
        Assert.Equal(OfflineMigrationSourceFingerprints.LegacyId, registry.Match(accepted).Id);

        void AssertUnknown(OfflineMigrationSourceObservation changed,
            OfflineMigrationFingerprintCategory category, OfflineMigrationFingerprintDifferenceKind kind,
            string factName, string? expectedValue, string? actualValue)
        {
            OfflineMigrationSourceFingerprintException refusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() => registry.Match(changed));
            int expectedCount = category == OfflineMigrationFingerprintCategory.Schema ? accepted.Schema.Length : accepted.BusinessShape.Length;
            int actualCount = category == OfflineMigrationFingerprintCategory.Schema ? changed.Schema.Length : changed.BusinessShape.Length;
            OfflineMigrationSourceObserverValueAssertions.Unknown(refusal, OfflineMigrationSourceFingerprints.LegacyId,
                OfflineMigrationSourceObserverValueAssertions.Difference(OfflineMigrationSourceFingerprints.LegacyId,
                    category, kind, factName, expectedValue, actualValue, expectedCount, actualCount));
        }
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.PostgreSql)]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    public void UnknownMixedOrIntermediateHistoryDoesNotBecomeEmpty(CurrentSchemaProviderKind provider)
    {
        OfflineMigrationSourceRegistry registry = OfflineMigrationSourceFingerprints.CreateRegistry();
        OfflineMigrationSourceObservation empty = Observation(provider, false);
        OfflineMigrationSourceObservation old = Observation(provider, true);
        OfflineMigrationSourceFingerprintException emptyRefusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            registry.Match(empty with { Schema = empty.Schema.Add(new("table/unknown", "base")) }));
        OfflineMigrationSourceObserverValueAssertions.Unknown(emptyRefusal, OfflineMigrationSourceFingerprints.EmptyId,
            OfflineMigrationSourceObserverValueAssertions.Difference(OfflineMigrationSourceFingerprints.EmptyId,
                OfflineMigrationFingerprintCategory.Schema, OfflineMigrationFingerprintDifferenceKind.Extra,
                "table/unknown", null, "base", empty.Schema.Length, empty.Schema.Length + 1));
        OfflineMigrationSourceFingerprintException historyRefusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            registry.Match(old with { History = [new("history.state", "partial")] }));
        OfflineMigrationSourceObserverValueAssertions.Unknown(historyRefusal, OfflineMigrationSourceFingerprints.LegacyId,
            OfflineMigrationSourceObserverValueAssertions.Difference(OfflineMigrationSourceFingerprints.LegacyId,
                OfflineMigrationFingerprintCategory.History, OfflineMigrationFingerprintDifferenceKind.Changed,
                "history.state", "absent", "partial", old.History.Length, 1));
        OfflineMigrationSourceFingerprintException schemaRefusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSourceFingerprints.RequireKnownSchema(provider, old.Schema.Add(new("table/schema_migration", "base"))));
        OfflineMigrationSourceObserverValueAssertions.Unknown(schemaRefusal, OfflineMigrationSourceFingerprints.LegacyId,
            OfflineMigrationSourceObserverValueAssertions.Difference(OfflineMigrationSourceFingerprints.LegacyId,
                OfflineMigrationFingerprintCategory.Schema, OfflineMigrationFingerprintDifferenceKind.Extra,
                "table/schema_migration", null, "base", old.Schema.Length, old.Schema.Length + 1));
        Assert.False(OfflineMigrationSourceFingerprints.RequireKnownSchema(provider, empty.Schema));
        Assert.True(OfflineMigrationSourceFingerprints.RequireKnownSchema(provider, old.Schema));
    }

    [Fact]
    public void HistoricalProfileRecordsCheckedInFixtureInsteadOfCurrentEntities()
    {
        string fixture = File.ReadAllText(FindFixture());
        MatchCollection tables = Regex.Matches(fixture, @"CREATE TABLE ([a-z_]+) \(\r?\n([\s\S]*?)\r?\n\);", RegexOptions.CultureInvariant);
        Assert.Equal(10, tables.Count);
        Assert.Equal(49, OfflineMigrationSourceFingerprints.LegacyTables.Sum(table => table.Columns.Length));
        Assert.Equal(65, OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.PostgreSql, true).Length);
        foreach (Match match in tables)
        {
            OfflineMigrationSourceFingerprints.LegacyTable table = Assert.Single(
                OfflineMigrationSourceFingerprints.LegacyTables, table => table.Name == match.Groups[1].Value);
            var columns = new List<OfflineMigrationSourceFingerprints.LegacyColumn>();
            string[]? primaryKey = null;
            foreach (string source in match.Groups[2].Value.Split('\n'))
            {
                string line = source.Trim().TrimEnd(',');
                if (line.StartsWith("PRIMARY KEY (", StringComparison.Ordinal))
                {
                    primaryKey = line[13..^1].Split(',').Select(value => value.Trim()).ToArray();
                    continue;
                }
                Match column = Regex.Match(line, @"^([a-z_]+) (integer|bigint|varchar\([0-9]+\)|text|timestamp|boolean)(.*)$", RegexOptions.CultureInvariant);
                Assert.True(column.Success, line);
                string type = column.Groups[2].Value switch { "integer" => "int", "boolean" => "bool", var value => value };
                string remainder = column.Groups[3].Value;
                bool inlineKey = remainder.Contains("PRIMARY KEY", StringComparison.Ordinal);
                if (inlineKey)
                {
                    primaryKey = [column.Groups[1].Value];
                }
                string defaultValue = remainder.Contains("DEFAULT false", StringComparison.Ordinal) ? "false"
                    : remainder.Contains("DEFAULT 0", StringComparison.Ordinal) ? "0" : "none";
                columns.Add(new(column.Groups[1].Value, type,
                    !inlineKey && !remainder.Contains("NOT NULL", StringComparison.Ordinal),
                    remainder.Contains("GENERATED BY DEFAULT AS IDENTITY", StringComparison.Ordinal), defaultValue));
            }
            Assert.NotNull(primaryKey);
            Assert.Equal(primaryKey, table.PrimaryKey);
            Assert.Equal(columns, table.Columns);
        }
        Assert.Equal("character varying(200)", OfflineMigrationSourceFingerprints.PhysicalType(CurrentSchemaProviderKind.PostgreSql, "varchar(200)"));
    }

    [Theory]
    [InlineData(CurrentSchemaProviderKind.MySql)]
    [InlineData(CurrentSchemaProviderKind.Sqlite)]
    [InlineData((CurrentSchemaProviderKind)(-1))]
    public async Task MissingNativeFullContentCapabilityFailsBeforeConnection(CurrentSchemaProviderKind provider)
    {
        using var cancellation = new CancellationTokenSource();
        if (Enum.IsDefined(provider))
        {
            await using var unrelated = new NpgsqlConnection();
            InvalidOperationException wrongDriver = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                new OfflineMigrationSourceObserver().ObserveAsync(provider, unrelated, null!, cancellation.Token));
            Assert.Equal(provider == CurrentSchemaProviderKind.Sqlite
                ? "offline_sqlite_identity_held_native_transaction_required"
                : "offline_source_native_streaming_driver_required", wrongDriver.Message);
            return;
        }
        InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            new OfflineMigrationSourceObserver().ObserveAsync(provider, "not-a-database-connection", cancellation.Token));
        Assert.Equal("offline_source_provider_unknown", refusal.Message);
    }

    [Fact]
    public void MySqlRepresentativeDialectKeepsHistoricalFieldsAndExplicitTextEncoding()
    {
        foreach (OfflineMigrationSourceFingerprints.LegacyTable table in OfflineMigrationSourceFingerprints.LegacyTables)
        {
            string sql = OfflineMigrationSourceFingerprints.MySqlTableSql(table);
            Assert.StartsWith($"CREATE TABLE `{table.Name}` (", sql, StringComparison.Ordinal);
            Assert.EndsWith(" ENGINE=InnoDB", sql, StringComparison.Ordinal);
            Assert.Equal(table.Columns.Count(column => column.Identity), Regex.Matches(sql, " AUTO_INCREMENT").Count);
            foreach (OfflineMigrationSourceFingerprints.LegacyColumn column in table.Columns)
            {
                Assert.Contains($"`{column.Name}` {OfflineMigrationSourceFingerprints.PhysicalType(CurrentSchemaProviderKind.MySql, column.Type)}", sql, StringComparison.Ordinal);
                if (column.Type == "text" || column.Type.StartsWith("varchar", StringComparison.Ordinal))
                {
                    Assert.Contains($"text-encoding/{table.Name}/{column.Name}",
                        OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.MySql, true).Select(fact => fact.Name));
                }
            }
        }
        OfflineMigrationSourceObservation expected = Observation(CurrentSchemaProviderKind.MySql, true);
        int textFact = Array.FindIndex(expected.Schema.ToArray(), fact => fact.Name == "text-encoding/article/title");
        Assert.True(textFact >= 0);
        OfflineMigrationSourceFingerprintException refusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSourceFingerprints.CreateRegistry().Match(expected with
            {
                Schema = expected.Schema.SetItem(textFact, OfflineMigrationSourceFingerprints.MySqlTextFact("article", "title", "latin1", "latin1_swedish_ci"))
            }));
        OfflineMigrationSourceObserverValueAssertions.Unknown(refusal, OfflineMigrationSourceFingerprints.LegacyId,
            OfflineMigrationSourceObserverValueAssertions.Difference(OfflineMigrationSourceFingerprints.LegacyId,
                OfflineMigrationFingerprintCategory.Schema, OfflineMigrationFingerprintDifferenceKind.Changed,
                expected.Schema[textFact].Name, expected.Schema[textFact].Value,
                OfflineMigrationSourceFingerprints.MySqlTextFact("article", "title", "latin1", "latin1_swedish_ci").Value,
                expected.Schema.Length, expected.Schema.Length));
    }

    [Theory]
    [InlineData("text", true, "", "none")]
    [InlineData("int", false, "0", "0")]
    [InlineData("tinyint(1)", false, "0", "0")]
    [InlineData("text", false, "", "unsupported:")]
    [InlineData("text", false, "NULL", "unsupported:NULL")]
    [InlineData("varchar(50)", false, "0", "unsupported:0")]
    public void MySqlActualDefaultDoesNotCollapseLiteralDefaultsIntoAbsence(string type, bool isNull, string value, string expected)
        => Assert.Equal(expected, OfflineMigrationSourceObserver.MySqlDefault(type, isNull, value));

    [Theory]
    [InlineData(0L)]
    [InlineData(1L)]
    public void NativeBooleanIntegerPreservesBothLegalValues(long value)
        => Assert.Equal(value, OfflineMigrationSourceObserver.RequireBooleanInteger(value));

    [Theory]
    [InlineData(-1L)]
    [InlineData(2L)]
    [InlineData(long.MaxValue)]
    public void NativeBooleanIntegerDoesNotNormalizeInvalidValues(long value)
        => Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceObserver.RequireBooleanInteger(value));

    [Theory]
    [InlineData(0L)]
    [InlineData(1L)]
    [InlineData(-1L)]
    public void NativeCalendarTimestampPreservesMicrosecondsWithoutTimeZoneConversion(long delta)
        => Assert.Equal(delta, OfflineMigrationSourceObserver.TimestampMicroseconds(new DateTime(2000, 1, 1).AddTicks(delta * 10)));

    [Fact]
    public void NativeCalendarTimestampRejectsZoneAndSubMicrosecondRepresentations()
    {
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceObserver.TimestampMicroseconds(new DateTime(2000, 1, 1, 0, 0, 0, DateTimeKind.Utc)));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceObserver.TimestampMicroseconds(new DateTime(2000, 1, 1).AddTicks(1)));
    }

    [Theory]
    [InlineData("Page", false)]
    [InlineData("PageX", true)]
    [InlineData("Page_", true)]
    [InlineData("page_", false)]
    [InlineData("sys:page:home", true)]
    public void LegacyPageClassificationPreservesOriginalSqlWildcard(string key, bool expected)
        => Assert.Equal(expected, OfflineMigrationSourceObserver.IsLegacyPageKeyPrefix(key));

    [Theory]
    [InlineData("2026-05-17 10:00:00")]
    [InlineData("2026-05-17T10:00:00.000001")]
    public void SqliteTimestampKeepsValidLiteralWithoutLosingItsRawRepresentation(string value)
        => OfflineMigrationSourceObserver.RequireSqliteTimestampRepresentation(value, value.Length);

    [Theory]
    [InlineData("not-a-date")]
    [InlineData("2026-02-30 10:00:00")]
    [InlineData("2026-05-17T10:00:00Z")]
    [InlineData("2026-05-17 10:00:00.0000001")]
    public void SqliteTimestampRefusesInvalidOrLossyRepresentations(string value)
        => Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceObserver.RequireSqliteTimestampRepresentation(value, value.Length));

    [Fact]
    public async Task SqliteNativeReadCoversFullRepresentativeContentWithoutGrantingInstanceAdmission()
    {
        await WithSqliteFixtureAsync(async (path, cancellation) =>
        {
            await WriteSqliteAsync(path, "INSERT INTO article(id,title,content,summary,categoryid,views,createtime,isdeleted) VALUES(1,'title',@body,NULL,0,0,'2026-05-17 10:00:00.000001',0)",
                "body-A\0" + new string('x', 4095) + "\U0001F30D", cancellation);
            OfflineMigrationSourceObserver.SqliteSourceRead before = await ReadSqliteAsync(path, cancellation);
            Assert.Equal(Path.GetFullPath(path), before.NativeVfsName);
            Assert.Equal<OfflineMigrationFact>(OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.Sqlite, true), before.Schema);
            Assert.Equal<OfflineMigrationFact>(OfflineMigrationSourceFingerprints.Business(true, 0, 0, 0, 0), before.Business);
            Assert.Equal(before.ContentDigest, (await ReadSqliteAsync(path, cancellation)).ContentDigest);
            await WriteSqliteAsync(path, "UPDATE article SET content=@body WHERE id=1",
                "body-B\0" + new string('x', 4095) + "\U0001F30D", cancellation);
            string changedBody = (await ReadSqliteAsync(path, cancellation)).ContentDigest;
            Assert.NotEqual(before.ContentDigest, changedBody);
            await WriteSqliteAsync(path, "UPDATE sqlite_sequence SET seq=20 WHERE name='article'", null, cancellation);
            Assert.NotEqual(changedBody, (await ReadSqliteAsync(path, cancellation)).ContentDigest);
            OfflineMigrationSourceObservation admitted = await new OfflineMigrationSourceObserver().ObserveAsync(
                CurrentSchemaProviderKind.Sqlite, new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString(), cancellation);
            Assert.NotEqual(changedBody, admitted.ContentDigest);
            Assert.Equal(Path.GetFullPath(path), admitted.Database.DatabaseId);
            Assert.StartsWith("sqlite:", admitted.Database.InstanceId);
            Assert.Equal((await ReadSqliteAsync(path, cancellation)).ContentDigest, admitted.ContentDigest);
        });
    }

    [Theory]
    [InlineData("CREATE TABLE unknown_source(id INTEGER)", "source_fingerprint_unknown")]
    [InlineData("INSERT INTO article(id,title,categoryid,views,createtime,isdeleted) VALUES(1,'title',0,0,'2026-05-17 10:00:00',2)", "offline_source_boolean_value_invalid")]
    [InlineData("INSERT INTO article(id,title,categoryid,views,createtime,isdeleted) VALUES(1,'title',0,0,'not-a-date',0)", "offline_source_sqlite_timestamp_value_invalid")]
    [InlineData("INSERT INTO category(id,name) VALUES(1,zeroblob(1))", "offline_source_sqlite_storage_class_invalid")]
    public async Task SqliteNativeReadRejectsActualUnknownShapeOrInvalidValues(string sql, string refusal)
    {
        await WithSqliteFixtureAsync(async (path, cancellation) =>
        {
            await WriteSqliteAsync(path, sql, null, cancellation);
            if (refusal == "source_fingerprint_unknown")
            {
                OfflineMigrationSourceFingerprintException unknown = await Assert.ThrowsAsync<OfflineMigrationSourceFingerprintException>(
                    () => ReadSqliteAsync(path, cancellation));
                OfflineMigrationSourceObserverValueAssertions.UnknownSqliteTable(unknown, sql);
            }
            else
            {
                InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => ReadSqliteAsync(path, cancellation));
                Assert.StartsWith(refusal, error.Message, StringComparison.Ordinal);
            }
        });
    }

    [Fact]
    public async Task SqliteBusinessBoundsCountTextAfterNulInsteadOfSqlLengthPrefix()
    {
        await WithSqliteFixtureAsync(async (path, cancellation) =>
        {
            await WriteSqliteAsync(path, "INSERT INTO sys_systemconfig(\"key\",value) VALUES('ordinary',@body)", "a\0" + new string('x', 511), cancellation);
            OfflineMigrationSourceFingerprintException error = await Assert.ThrowsAsync<OfflineMigrationSourceFingerprintException>(() => ReadSqliteAsync(path, cancellation));
            const string baseline = OfflineMigrationSourceFingerprints.LegacyId;
            int count = OfflineMigrationSourceFingerprints.Business(true, 0, 0, 0, 0).Length;
            OfflineMigrationSourceObserverValueAssertions.Unknown(error, baseline,
                OfflineMigrationSourceObserverValueAssertions.Difference(baseline,
                    OfflineMigrationFingerprintCategory.Business, OfflineMigrationFingerprintDifferenceKind.Changed,
                    "legacy.config.nonpage.value.over512", "0", "1", count, count));
        });
    }

    [Fact]
    public async Task SqlitePublicNativeSessionRetainsActualBusinessFingerprintDifferences()
    {
        await WithSqliteFixtureAsync(async (path, cancellation) =>
        {
            string connectionString = new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString();
            var observer = new OfflineMigrationSourceObserver();
            // Actual identity/native capability must succeed before exercising
            // the refusal; unavailable FILESTAT cannot satisfy this control.
            OfflineMigrationSourceObservation before = await observer.ObserveAsync(
                CurrentSchemaProviderKind.Sqlite, connectionString, cancellation);
            Assert.Equal<OfflineMigrationFact>(OfflineMigrationSourceFingerprints.Business(true, 0, 0, 0, 0), before.BusinessShape);
            await WriteSqliteAsync(path, "INSERT INTO sys_systemconfig(\"key\",value) VALUES('ordinary',@body)",
                "a\0" + new string('x', 511), cancellation);
            OfflineMigrationSourceFingerprintException refusal = await Assert.ThrowsAsync<OfflineMigrationSourceFingerprintException>(
                () => observer.ObserveAsync(CurrentSchemaProviderKind.Sqlite, connectionString, cancellation));
            Assert.Equal("source_fingerprint_unknown", refusal.Code);
            Assert.Contains(refusal.Differences, difference => difference.Category == OfflineMigrationFingerprintCategory.Business);
            Assert.Null(refusal.InnerException);
        });
    }

    [Fact]
    public async Task SqliteEmptyNativeReadObservesActualAbsenceInsteadOfCallerLabels()
    {
        await WithSqliteFixtureAsync(async (path, cancellation) =>
        {
            OfflineMigrationSourceObserver.SqliteSourceRead empty = await ReadSqliteAsync(path, cancellation);
            Assert.Equal<OfflineMigrationFact>(OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.Sqlite, false), empty.Schema);
            Assert.Equal<OfflineMigrationFact>(OfflineMigrationSourceFingerprints.Business(false, 0, 0, 0, 0), empty.Business);
            Assert.Equal(empty.ContentDigest, (await ReadSqliteAsync(path, cancellation)).ContentDigest);
        }, legacy: false);
    }

    private static async Task WithSqliteFixtureAsync(Func<string, CancellationToken, Task> run, bool legacy = true)
    {
        string root = Path.Combine(Path.GetTempPath(), "fsusblog-source-observer-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string path = Path.Combine(root, "representative.db");
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try
        {
            // A real test-owned dialect realization, not a claimed historical production dump.
            await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = path, Mode = SqliteOpenMode.ReadWriteCreate, Pooling = false
            }.ToString()))
            {
                await connection.OpenAsync(cancellation.Token);
                foreach (OfflineMigrationSourceFingerprints.LegacyTable table in legacy ? OfflineMigrationSourceFingerprints.LegacyTables : [])
                {
                    await using SqliteCommand command = connection.CreateCommand();
                    command.CommandText = OfflineMigrationSourceFingerprints.SqliteTableSql(table);
                    await command.ExecuteNonQueryAsync(cancellation.Token);
                }
            }
            await run(path, cancellation.Token);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task SqliteSourceUsesActualIdentityAndContentFromTheSameHeldTransaction()
    {
        await WithSqliteFixtureAsync(async (path, cancellation) =>
        {
            await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false
            }.ToString());
            await connection.OpenAsync(cancellation);
            await using (SqliteCommand configure = connection.CreateCommand())
            {
                configure.CommandText = "PRAGMA query_only=1";
                await configure.ExecuteNonQueryAsync(cancellation);
            }
            await using SqliteTransaction transaction = connection.BeginTransaction(deferred: true);
            await using (SqliteCommand establish = connection.CreateCommand())
            {
                establish.Transaction = transaction;
                establish.CommandText = "SELECT COUNT(*) FROM main.sqlite_schema";
                _ = await establish.ExecuteScalarAsync(cancellation);
            }
            using var actualIdentity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(connection, transaction, cancellation);
            OfflineMigrationSourceObservation actual = await new OfflineMigrationSourceObserver().ObserveAsync(
                CurrentSchemaProviderKind.Sqlite, connection, transaction, cancellation);
            Assert.Equal(actualIdentity.Database, actual.Database);
            Assert.Equal((await OfflineMigrationSourceObserver.ReadSqliteSourceAsync(connection, transaction, cancellation)).ContentDigest,
                actual.ContentDigest);
            await actualIdentity.ValidateAsync(connection, transaction, cancellation);
            OfflineMigrationSourceObservation repeated = await new OfflineMigrationSourceObserver().ObserveAsync(
                CurrentSchemaProviderKind.Sqlite, connection, transaction, cancellation);
            Assert.Equal(actual.Database, repeated.Database);
            Assert.Equal(actual.ContentDigest, repeated.ContentDigest);
            Assert.True(OfflineMigrationPlanValidation.Equal(actual.Schema, repeated.Schema));
            Assert.True(OfflineMigrationPlanValidation.Equal(actual.History, repeated.History));
            Assert.True(OfflineMigrationPlanValidation.Equal(actual.BusinessShape, repeated.BusinessShape));
        }, legacy: false);
    }

    [Fact]
    public async Task SqliteSourceCannotSubstituteSameBytesAtTheUnchangedHeldFilename()
    {
        await WithSqliteFixtureAsync(async (path, cancellation) =>
        {
            byte[] original = File.ReadAllBytes(path);
            await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false
            }.ToString());
            await connection.OpenAsync(cancellation);
            await using (SqliteCommand configure = connection.CreateCommand())
            {
                configure.CommandText = "PRAGMA query_only=1";
                await configure.ExecuteNonQueryAsync(cancellation);
            }
            await using SqliteTransaction transaction = connection.BeginTransaction(deferred: true);
            await using (SqliteCommand establish = connection.CreateCommand())
            {
                establish.Transaction = transaction;
                establish.CommandText = "SELECT COUNT(*) FROM main.sqlite_schema";
                _ = await establish.ExecuteScalarAsync(cancellation);
            }
            // Capability must really succeed before this replacement is exercised.
            using var actualIdentity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(connection, transaction, cancellation);
            File.Move(path, path + ".original");
            File.WriteAllBytes(path, original);
            Assert.Equal(original, File.ReadAllBytes(path));
            await Assert.ThrowsAsync<InvalidOperationException>(() => new OfflineMigrationSourceObserver().ObserveAsync(
                CurrentSchemaProviderKind.Sqlite, connection, transaction, cancellation));
            await Assert.ThrowsAsync<InvalidOperationException>(() => actualIdentity.ValidateAsync(connection, transaction, cancellation));
        }, legacy: false);
    }

    private static async Task WriteSqliteAsync(string path, string sql, string? body, CancellationToken cancellationToken)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false
        }.ToString());
        await connection.OpenAsync(cancellationToken);
        await using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        byte[]? embeddedNulBytes = null;
        if (body is not null)
        {
            if (body.Contains('\0'))
            {
                // The native string binder terminates at NUL. Bind the complete
                // UTF-8 bytes and cast in SQL so the original TEXT negative input
                // actually reaches storage before testing the streaming reader.
                embeddedNulBytes = new UTF8Encoding(false, true).GetBytes(body);
                command.CommandText = sql.Replace("@body", "CAST(@body AS TEXT)", StringComparison.Ordinal);
                command.Parameters.AddWithValue("@body", embeddedNulBytes);
            }
            else
            {
                command.Parameters.AddWithValue("@body", body);
            }
        }
        await command.ExecuteNonQueryAsync(cancellationToken);
        if (embeddedNulBytes is not null)
        {
            await using SqliteCommand stored = connection.CreateCommand();
            if (sql.Contains("sys_systemconfig", StringComparison.Ordinal))
            {
                stored.CommandText = "SELECT typeof(value),CAST(value AS BLOB) FROM sys_systemconfig WHERE \"key\"='ordinary'";
            }
            else
            {
                Assert.Contains("article", sql, StringComparison.Ordinal);
                stored.CommandText = "SELECT typeof(content),CAST(content AS BLOB) FROM article WHERE id=1";
            }
            await using SqliteDataReader reader = await stored.ExecuteReaderAsync(cancellationToken);
            Assert.True(await reader.ReadAsync(cancellationToken));
            Assert.Equal("text", reader.GetString(0));
            Assert.Equal<byte>(embeddedNulBytes, (byte[])reader.GetValue(1));
            Assert.False(await reader.ReadAsync(cancellationToken));
        }
    }

    private static async Task<OfflineMigrationSourceObserver.SqliteSourceRead> ReadSqliteAsync(string path, CancellationToken cancellationToken)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path, Mode = SqliteOpenMode.ReadOnly, Cache = SqliteCacheMode.Private, Pooling = false
        }.ToString());
        await connection.OpenAsync(cancellationToken);
        await using (SqliteCommand readOnly = connection.CreateCommand())
        {
            readOnly.CommandText = "PRAGMA query_only=1";
            await readOnly.ExecuteNonQueryAsync(cancellationToken);
        }
        await using SqliteTransaction transaction = connection.BeginTransaction(deferred: true);
        return await OfflineMigrationSourceObserver.ReadSqliteSourceAsync(connection, transaction, cancellationToken);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(17)]
    [InlineData(4096)]
    public async Task ContentTextFramingIsIndependentOfNativeReadFragments(int fragment)
    {
        // The supplementary scalar straddles the fixed 4096-code-unit frame boundary.
        string content = new string('a', 4095) + "\U0001F30D" + new string('z', 5000) + "\0tail";
        using var cancellation = new CancellationTokenSource();
        using var complete = new StringReader(content);
        using var fragmented = new FragmentedReader(content, fragment);
        Assert.Equal(await TextDigestAsync(complete, cancellation.Token), await TextDigestAsync(fragmented, cancellation.Token));
    }

    [Fact]
    public async Task EqualLengthBusinessEditsChangeContentCommitment()
    {
        using var cancellation = new CancellationTokenSource();
        using var before = new StringReader("article-body-A");
        using var after = new StringReader("article-body-B");
        Assert.NotEqual(await TextDigestAsync(before, cancellation.Token), await TextDigestAsync(after, cancellation.Token));
    }

    [Fact]
    public async Task FramingDoesNotCollapseDistinctFieldsOrEmptyContent()
    {
        using var cancellation = new CancellationTokenSource();
        using IncrementalHash joined = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using IncrementalHash split = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        using var whole = new StringReader("ab");
        using var first = new StringReader("a");
        using var second = new StringReader("b");
        await OfflineMigrationSourceObserver.AppendTextAsync(joined, whole, cancellation.Token);
        await OfflineMigrationSourceObserver.AppendTextAsync(split, first, cancellation.Token);
        await OfflineMigrationSourceObserver.AppendTextAsync(split, second, cancellation.Token);
        Assert.NotEqual(Convert.ToHexString(joined.GetHashAndReset()), Convert.ToHexString(split.GetHashAndReset()));
        using var empty = new StringReader(string.Empty);
        Assert.Equal(Convert.ToHexString(SHA256.HashData(new byte[16])), await TextDigestAsync(empty, cancellation.Token));
    }

    [Fact]
    public async Task ContentStreamingHonorsOwnedCancellation()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        using var content = new FragmentedReader("content", 1);
        await Assert.ThrowsAsync<OperationCanceledException>(() => TextDigestAsync(content, cancellation.Token));
    }

    private static OfflineMigrationSourceObservation Observation(CurrentSchemaProviderKind provider, bool legacy)
    {
        OfflineMigrationSourceShape shape = OfflineMigrationSourceFingerprints.Shape(provider, legacy);
        // Unit input only; this identity/digest is not approved database observation evidence.
        return new(new(provider, "unit-instance", "unit-database"), shape.ExtractorId, shape.ExtractorVersion,
            shape.Schema, shape.History, shape.BusinessShape, new string('a', 64));
    }

    private static async Task<string> TextDigestAsync(TextReader reader, CancellationToken cancellationToken)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        await OfflineMigrationSourceObserver.AppendTextAsync(hash, reader, cancellationToken);
        return Convert.ToHexString(hash.GetHashAndReset());
    }

    private static string FindFixture()
    {
        foreach (string origin in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            DirectoryInfo? directory = new(origin);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string path = Path.Combine(directory.FullName, "tests", "backend", "Fixtures", "legacy-20260517-minimal.sql");
                if (File.Exists(path))
                {
                    return path;
                }
            }
        }
        throw new InvalidOperationException("historical_source_fixture_missing_from_complete_source_binding");
    }

    private sealed class FragmentedReader(string text, int maximumRead) : TextReader
    {
        private int _position;

        public override ValueTask<int> ReadAsync(Memory<char> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int length = Math.Min(Math.Min(buffer.Length, maximumRead), text.Length - _position);
            text.AsMemory(_position, length).CopyTo(buffer);
            _position += length;
            return ValueTask.FromResult(length);
        }
    }
}
