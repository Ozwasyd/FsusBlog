using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Security.Cryptography;

namespace FsusBlog.Migration;

/// <summary>Closed observation categories, including the extractor vocabulary identity.</summary>
public enum OfflineMigrationFingerprintCategory
{
    /// <summary>Extractor ID or version changed.</summary>
    Extractor,
    /// <summary>Physical schema observations differ.</summary>
    Schema,
    /// <summary>Observed migration history differs.</summary>
    History,
    /// <summary>Business-shape preconditions differ.</summary>
    Business
}

/// <summary>Exact set/value differences; no nearest-baseline selection is implied.</summary>
public enum OfflineMigrationFingerprintDifferenceKind
{
    /// <summary>An expected fact is absent.</summary>
    Missing,
    /// <summary>An observed fact is not expected.</summary>
    Extra,
    /// <summary>The same fact name has a different value.</summary>
    Changed
}

/// <summary>
/// Redacted exact difference: names, baseline IDs and values are hashes of their original
/// UTF-16 code units, never raw catalog expressions, data, SQL or credentials. Null value
/// hashes mean absence, not the hash of an empty string. Counts cover the complete category.
/// </summary>
public sealed record OfflineMigrationFingerprintDifference(
    string BaselineIdSha256,
    OfflineMigrationFingerprintCategory Category,
    OfflineMigrationFingerprintDifferenceKind Kind,
    string FactNameSha256,
    string? ExpectedValueSha256,
    string? ActualValueSha256,
    int ExpectedFactCount,
    int ActualFactCount);

/// <summary>
/// Migration-only safe failure transport, constructed from actual observation sets rather
/// than parsing arbitrary exception messages. It confers no source, backup or write grant.
/// Native owners may propagate it only after awaited owned cleanup has returned; cleanup
/// uncertainty remains a separate higher-priority failure without this payload.
/// </summary>
public sealed class OfflineMigrationSourceFingerprintException : InvalidOperationException
{
    private OfflineMigrationSourceFingerprintException(string code,
        ImmutableArray<OfflineMigrationFingerprintDifference> differences,
        ImmutableArray<string> ambiguousBaselineIdSha256s) : base(code)
    {
        Code = code;
        Differences = differences;
        AmbiguousBaselineIdSha256s = ambiguousBaselineIdSha256s;
    }

    /// <summary>Only source_fingerprint_unknown or source_fingerprint_ambiguous.</summary>
    public string Code
    {
        get;
    }

    /// <summary>Immutable exact differences against every registered candidate.</summary>
    public ImmutableArray<OfflineMigrationFingerprintDifference> Differences
    {
        get;
    }

    /// <summary>Every matching baseline ID, hashed and sorted; ambiguity is never selection.</summary>
    public ImmutableArray<string> AmbiguousBaselineIdSha256s
    {
        get;
    }

    internal static OfflineMigrationSourceFingerprintException Unknown(
        IEnumerable<(string BaselineId, OfflineMigrationSourceShape Expected)> expected,
        OfflineMigrationSourceShape actual)
    {
        ArgumentNullException.ThrowIfNull(expected);
        OfflineMigrationPlanValidation.ValidateShape(actual);
        var differences = ImmutableArray.CreateBuilder<OfflineMigrationFingerprintDifference>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach ((string baselineId, OfflineMigrationSourceShape shape) in expected.OrderBy(value => value.BaselineId, StringComparer.Ordinal))
        {
            OfflineMigrationPlanValidation.RequireText(baselineId, "source_fingerprint_id_missing");
            OfflineMigrationPlanValidation.ValidateShape(shape);
            if (!ids.Add(baselineId) || shape.Provider != actual.Provider)
            {
                throw new InvalidOperationException("source_fingerprint_difference_context_invalid");
            }
            int before = differences.Count;
            string baselineHash = HashText(baselineId);
            Compare(OfflineMigrationFingerprintCategory.Extractor,
                [new("id", shape.ExtractorId), new("version", shape.ExtractorVersion)],
                [new("id", actual.ExtractorId), new("version", actual.ExtractorVersion)]);
            Compare(OfflineMigrationFingerprintCategory.Schema, shape.Schema, actual.Schema);
            Compare(OfflineMigrationFingerprintCategory.History, shape.History, actual.History);
            Compare(OfflineMigrationFingerprintCategory.Business, shape.BusinessShape, actual.BusinessShape);
            if (differences.Count == before)
            {
                // A matched baseline cannot be relabeled unknown by this transport helper.
                throw new InvalidOperationException("source_fingerprint_difference_context_invalid");
            }

            void Compare(OfflineMigrationFingerprintCategory category,
                ImmutableArray<OfflineMigrationFact> expectedFacts, ImmutableArray<OfflineMigrationFact> actualFacts)
            {
                var expectedValues = OfflineMigrationPlanValidation.NormalizeFacts(expectedFacts)
                    .ToDictionary(fact => fact.Name, fact => fact.Value, StringComparer.Ordinal);
                var actualValues = OfflineMigrationPlanValidation.NormalizeFacts(actualFacts)
                    .ToDictionary(fact => fact.Name, fact => fact.Value, StringComparer.Ordinal);
                foreach (string name in expectedValues.Keys.Union(actualValues.Keys, StringComparer.Ordinal)
                             .OrderBy(value => value, StringComparer.Ordinal))
                {
                    bool hasExpected = expectedValues.TryGetValue(name, out string? expectedValue);
                    bool hasActual = actualValues.TryGetValue(name, out string? actualValue);
                    if (hasExpected && hasActual && expectedValue == actualValue)
                    {
                        continue;
                    }
                    OfflineMigrationFingerprintDifferenceKind kind = !hasExpected
                        ? OfflineMigrationFingerprintDifferenceKind.Extra
                        : !hasActual ? OfflineMigrationFingerprintDifferenceKind.Missing
                        : OfflineMigrationFingerprintDifferenceKind.Changed;
                    differences.Add(new(baselineHash, category, kind, HashText(name),
                        hasExpected ? HashText(expectedValue!) : null,
                        hasActual ? HashText(actualValue!) : null, expectedValues.Count, actualValues.Count));
                }
            }
        }
        if (ids.Count == 0)
        {
            throw new InvalidOperationException("source_fingerprint_difference_context_invalid");
        }
        return new("source_fingerprint_unknown", differences.ToImmutable(), []);
    }

    internal static OfflineMigrationSourceFingerprintException Ambiguous(IEnumerable<string> baselineIds)
    {
        ArgumentNullException.ThrowIfNull(baselineIds);
        string[] ids = baselineIds.ToArray();
        foreach (string id in ids)
        {
            OfflineMigrationPlanValidation.RequireText(id, "source_fingerprint_id_missing");
        }
        if (ids.Length < 2 || ids.Distinct(StringComparer.Ordinal).Count() != ids.Length)
        {
            throw new InvalidOperationException("source_fingerprint_difference_context_invalid");
        }
        return new("source_fingerprint_ambiguous", [], ids.Select(HashText)
            .OrderBy(value => value, StringComparer.Ordinal).ToImmutableArray());
    }

    internal static string HashText(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("fsusblog.migration-fingerprint-difference-text.v1\0"u8);
        Span<byte> bytes = stackalloc byte[512];
        BinaryPrimitives.WriteInt32LittleEndian(bytes, value.Length);
        hash.AppendData(bytes[..4]);
        // Hash original code units, including unpaired surrogates. A replacement encoder
        // would collapse distinct unknown inputs and cease to represent an exact difference.
        for (int offset = 0; offset < value.Length; offset += bytes.Length / 2)
        {
            int count = Math.Min(bytes.Length / 2, value.Length - offset);
            for (int index = 0; index < count; index++)
            {
                BinaryPrimitives.WriteUInt16LittleEndian(bytes.Slice(index * 2, 2), value[offset + index]);
            }
            hash.AppendData(bytes[..(count * 2)]);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
}
