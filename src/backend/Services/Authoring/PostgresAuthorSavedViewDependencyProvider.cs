using System.Globalization;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Resolves only the dependency kinds whose owning production authority exists today.
/// Taxonomy identities are the database primary keys. Property, author-search, relation,
/// and content-check providers remain absent until their owning contracts are available.
/// </summary>
public sealed class PostgresAuthorSavedViewDependencyProvider(ISqlSugarClient db)
    : IAuthorSavedViewDependencyProvider
{
    private const string AuthorityRevision = "taxonomy-primary-key-v1";

    public async ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewCondition condition,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        string? table = TaxonomyTable(condition.Field.Kind);
        if (table is null)
        {
            return null;
        }

        int[]? identities = ParseIdentities(condition.Field.Kind, [condition.Field.Identity, .. condition.Values]);
        if (identities is null)
        {
            return Fact(condition.Field, condition.OperatorId, AuthorSavedViewDependencyStatus.Unknown, []);
        }

        cancellationToken.ThrowIfCancellationRequested();
        int existing = await CountExistingAsync(table, identities).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return Fact(
            condition.Field,
            condition.OperatorId,
            existing == identities.Length
                ? AuthorSavedViewDependencyStatus.Current
                : AuthorSavedViewDependencyStatus.Deleted,
            [.. condition.Values]);
    }

    public ValueTask<AuthorSavedViewDependencyFact?> ResolveSortAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewSort sort,
        CancellationToken cancellationToken = default)
        => ResolveFieldAsync(owner, sort.Field, "sort", cancellationToken);

    public ValueTask<AuthorSavedViewDependencyFact?> ResolveProjectionAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewFieldReference field,
        CancellationToken cancellationToken = default)
        => ResolveFieldAsync(owner, field, "projection", cancellationToken);

    private async ValueTask<AuthorSavedViewDependencyFact?> ResolveFieldAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewFieldReference field,
        string operation,
        CancellationToken cancellationToken)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        string? table = TaxonomyTable(field.Kind);
        if (table is null)
        {
            return null;
        }

        int[]? identities = ParseIdentities(field.Kind, [field.Identity]);
        if (identities is null)
        {
            return Fact(field, operation, AuthorSavedViewDependencyStatus.Unknown, []);
        }

        cancellationToken.ThrowIfCancellationRequested();
        int existing = await CountExistingAsync(table, identities).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return Fact(
            field,
            operation,
            existing == 1
                ? AuthorSavedViewDependencyStatus.Current
                : AuthorSavedViewDependencyStatus.Deleted,
            []);
    }

    private async Task<int> CountExistingAsync(string table, IReadOnlyList<int> identities)
    {
        var parameters = new SugarParameter[identities.Count];
        var placeholders = new string[identities.Count];
        for (int index = 0; index < identities.Count; index++)
        {
            placeholders[index] = $"@Identity{index}";
            parameters[index] = new SugarParameter(placeholders[index], identities[index]);
        }

        return await db.Ado.GetIntAsync(
            $"SELECT COUNT(1) FROM {table} WHERE id IN ({string.Join(',', placeholders)});",
            parameters).ConfigureAwait(false);
    }

    private static string? TaxonomyTable(AuthorSavedViewFieldKind kind)
        => kind switch
        {
            AuthorSavedViewFieldKind.Category => "category",
            AuthorSavedViewFieldKind.Tag => "tag",
            _ => null
        };

    private static int[]? ParseIdentities(
        AuthorSavedViewFieldKind kind,
        IReadOnlyList<string> identities)
    {
        string prefix = kind == AuthorSavedViewFieldKind.Category ? "category:" : "tag:";
        var parsed = new HashSet<int>();
        foreach (string identity in identities)
        {
            if (!identity.StartsWith(prefix, StringComparison.Ordinal)
                || !int.TryParse(
                    identity.AsSpan(prefix.Length),
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out int id)
                || id <= 0)
            {
                return null;
            }
            parsed.Add(id);
        }
        return [.. parsed.Order()];
    }

    private static AuthorSavedViewDependencyFact Fact(
        AuthorSavedViewFieldReference field,
        string operation,
        AuthorSavedViewDependencyStatus status,
        IReadOnlyList<string> canonicalValues)
        => new(field, operation, status, AuthorityRevision, canonicalValues);
}
