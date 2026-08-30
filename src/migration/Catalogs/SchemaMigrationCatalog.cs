using System.Globalization;

using FsusBlog.Migration;

namespace FsusBlog.Migration.Catalogs;

internal enum SchemaMigrationGapPolicy
{
    ContiguousVersions = 0,
    AllowSparseVersions = 1
}

internal sealed record SchemaMigrationCatalogDependency(
    string MigrationId,
    SchemaMigrationPhase Phase);

internal sealed record SchemaMigrationVersionGap(
    DateOnly StartInclusive,
    DateOnly EndInclusive);

internal sealed record SchemaMigrationCatalog(
    string CatalogId,
    DateOnly StartVersion,
    DateOnly EndVersion,
    SchemaMigrationGapPolicy GapPolicy,
    IReadOnlyList<SchemaMigrationCatalogDependency> Dependencies,
    IReadOnlyList<ISchemaMigrationDescriptor> Descriptors);

internal static class SchemaMigrationIdentity
{
    internal static DateOnly ParseVersion(ISchemaMigrationDescriptor descriptor)
    {
        ArgumentNullException.ThrowIfNull(descriptor);

        string migrationId = descriptor.MigrationId;
        if (migrationId.Length < 14 || migrationId[8] != '-')
        {
            throw new InvalidOperationException(
                $"Schema migration id {migrationId} must use yyyyMMdd-pre|post-name format.");
        }

        if (!DateOnly.TryParseExact(
                migrationId.AsSpan(0, 8),
                "yyyyMMdd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out DateOnly version))
        {
            throw new InvalidOperationException(
                $"Schema migration id {migrationId} has an invalid yyyyMMdd version.");
        }

        ReadOnlySpan<char> phaseAndName = migrationId.AsSpan(9);
        SchemaMigrationPhase declaredPhase = phaseAndName.StartsWith("pre-", StringComparison.Ordinal)
            ? SchemaMigrationPhase.PreCodeFirst
            : phaseAndName.StartsWith("post-", StringComparison.Ordinal)
                ? SchemaMigrationPhase.PostCodeFirst
                : throw new InvalidOperationException(
                    $"Schema migration id {migrationId} must declare pre or post phase.");

        int expectedSeparatorIndex = declaredPhase == SchemaMigrationPhase.PreCodeFirst ? 12 : 13;
        if (migrationId.Length <= expectedSeparatorIndex + 1
            || migrationId[expectedSeparatorIndex] != '-')
        {
            throw new InvalidOperationException(
                $"Schema migration id {migrationId} must include a non-empty name after its phase.");
        }

        if (declaredPhase != descriptor.Phase)
        {
            throw new InvalidOperationException(
                $"Schema migration {migrationId} declares {declaredPhase} but descriptor phase is {descriptor.Phase}.");
        }

        return version;
    }
}

internal sealed class SchemaMigrationExecutionOrder : IComparer<ISchemaMigrationDescriptor>
{
    internal static SchemaMigrationExecutionOrder Instance
    {
        get;
    } = new();

    public int Compare(ISchemaMigrationDescriptor? left, ISchemaMigrationDescriptor? right)
    {
        if (ReferenceEquals(left, right))
        {
            return 0;
        }

        if (left is null)
        {
            return -1;
        }

        if (right is null)
        {
            return 1;
        }

        int phaseComparison = left.Phase.CompareTo(right.Phase);
        return phaseComparison != 0
            ? phaseComparison
            : StringComparer.Ordinal.Compare(left.MigrationId, right.MigrationId);
    }
}
