using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

// These are source/profile and streaming-codec controls, not actual database qualification.
public sealed class OfflineMigrationSourceObserverValue5263Tests
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
        AssertUnknown(accepted with
        {
            Schema = accepted.Schema.SetItem(column, accepted.Schema[column] with
            {
                Value = "changed"
            })
        });
        AssertUnknown(accepted with
        {
            Schema = accepted.Schema.RemoveAt(column)
        });
        AssertUnknown(accepted with
        {
            Schema = accepted.Schema.Add(new("column/article/unknown", "present"))
        });
        foreach (OfflineMigrationFact fact in accepted.BusinessShape.Where(fact => fact.Name != "business.profile"))
        {
            AssertUnknown(accepted with
            {
                BusinessShape = accepted.BusinessShape.Select(value => value.Name == fact.Name ? value with { Value = "1" } : value).ToImmutableArray()
            });
        }
        Assert.Equal(OfflineMigrationSourceFingerprints.LegacyId, registry.Match(accepted).Id);

        void AssertUnknown(OfflineMigrationSourceObservation changed)
        {
            OfflineMigrationSourceFingerprintException refusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() => registry.Match(changed));
            Assert.Equal("source_fingerprint_unknown", refusal.Code);
            Assert.NotEmpty(refusal.Differences);
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
        Assert.Throws<OfflineMigrationSourceFingerprintException>(() => registry.Match(empty with { Schema = empty.Schema.Add(new("table/unknown", "base")) }));
        Assert.Throws<OfflineMigrationSourceFingerprintException>(() => registry.Match(old with { History = [new("history.state", "partial")] }));
        Assert.Throws<OfflineMigrationSourceFingerprintException>(() => OfflineMigrationSourceFingerprints.RequireKnownSchema(provider,
            old.Schema.Add(new("table/schema_migration", "base"))));
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
                string type = column.Groups[2].Value switch
                {
                    "integer" => "int",
                    "boolean" => "bool",
                    var value => value
                };
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
        InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            new OfflineMigrationSourceObserver().ObserveAsync(provider, "not-a-database-connection", cancellation.Token));
        Assert.Equal(Enum.IsDefined(provider) ? "offline_source_provider_full_content_capability_unavailable" : "offline_source_provider_unknown", refusal.Message);
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
