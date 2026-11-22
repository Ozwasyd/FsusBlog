using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal readonly record struct CatalogColumnInfo(bool NotNull, string TypeName);

internal readonly record struct CatalogCheckInfo(
    string Name,
    bool IsValidated,
    bool IsLocal,
    bool IsStrictEnforced,
    string CompactExpression,
    string ConstraintDefinition);

internal sealed class CatalogPresenceScope
{
    private const string PublicPrefix = "public.";

    internal string[] RelationNames { get; }
    internal string[] ColumnRelationNames { get; }
    internal string[] CheckRelationNames { get; }

    private readonly HashSet<string> _relations;
    private readonly HashSet<string> _columnRelations;
    private readonly HashSet<string> _checkRelations;

    internal CatalogPresenceScope(
        IEnumerable<string> relations,
        IEnumerable<string> columnRelations,
        IEnumerable<string> checkRelations)
    {
        RelationNames = NormalizeDistinct(relations);
        ColumnRelationNames = NormalizeDistinct(columnRelations);
        CheckRelationNames = NormalizeDistinct(checkRelations);
        _relations = new HashSet<string>(RelationNames, StringComparer.Ordinal);
        _columnRelations = new HashSet<string>(ColumnRelationNames, StringComparer.Ordinal);
        _checkRelations = new HashSet<string>(CheckRelationNames, StringComparer.Ordinal);
    }

    internal static string NormalizePublicName(string qualifiedName)
    {
        if (!qualifiedName.StartsWith(PublicPrefix, StringComparison.Ordinal) || qualifiedName.Length <= PublicPrefix.Length)
            throw new InvalidOperationException($"Expected a public-qualified relation name, got '{qualifiedName}'.");
        var name = qualifiedName[PublicPrefix.Length..];
        if (name.Length > 63)
            throw new InvalidOperationException($"PostgreSQL relation name '{qualifiedName}' exceeds 63 bytes.");
        return name;
    }

    internal string RequireRelationInScope(string qualifiedName) =>
        RequireInScope(qualifiedName, _relations, "Relation");

    internal string RequireColumnRelationInScope(string qualifiedName) =>
        RequireInScope(qualifiedName, _columnRelations, "Column metadata for");

    internal string RequireCheckRelationInScope(string qualifiedName) =>
        RequireInScope(qualifiedName, _checkRelations, "CHECK metadata for");

    private static string RequireInScope(string qualifiedName, HashSet<string> names, string subject)
    {
        var name = NormalizePublicName(qualifiedName);
        if (!names.Contains(name))
            throw new InvalidOperationException($"{subject} '{qualifiedName}' is outside the catalog presence snapshot scope.");
        return name;
    }

    private static string[] NormalizeDistinct(IEnumerable<string> qualifiedNames) =>
        qualifiedNames.Select(NormalizePublicName).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
}

// Per-transaction, immutable catalog presence snapshot loaded in a single bounded pg_catalog query
// inside the caller's existing RepeatableRead / READ ONLY transaction. Never shared across transactions.
//
// Bounded scope:
//   - Relation existence & relkind: only the fixed allowlist of public.* probed relations (82 distinct names).
//   - Column metadata (attnotnull, type): only the fixed allowlist of 9 column-probed tables.
//   - CHECK constraint metadata: only the fixed allowlist of 5 CHECK-probed tables.
//
// Explicitly retained outside this generic snapshot as dedicated queries:
//   - HasArticleReadTotalSchemaAsync (pg_index + pg_am + pg_opclass + indkey/indoption DESC btree shape)
//   - VerifyRelationsAsync (full relation/column/modifier/identity/trigger/constraint shape verifier)
//   - Post-shape publication coordinates, data invariants and index checks in VerifyCatalogAsync.
internal sealed class CatalogPresenceSnapshot
{
    private const string BatchSql = """
        SELECT 'r', c.relname::text, c.relkind::text,
               false, false, false,
               NULL::text, NULL::text
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::pg_catalog.name[])
        UNION ALL
        SELECT 'c', c.relname::text, a.attname::text,
               a.attnotnull, false, false,
               tn.nspname::text || '.' || t.typname::text, NULL::text
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
        JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($2::pg_catalog.name[])
          AND a.attnum > 0 AND NOT a.attisdropped
        UNION ALL
        SELECT 'k', c.relname::text, k.conname::text,
               k.convalidated, k.conislocal,
               NOT k.condeferrable AND NOT k.connoinherit
                   AND coalesce(pg_catalog.to_jsonb(k)->>'conenforced', 'true') = 'true',
               pg_catalog.regexp_replace(pg_catalog.pg_get_expr(k.conbin, k.conrelid, true), '[[:space:]]', '', 'g'),
               pg_catalog.pg_get_constraintdef(k.oid, true)
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid
        WHERE n.nspname = 'public' AND c.relname = ANY($3::pg_catalog.name[])
          AND k.contype = 'c'
        """;

    private readonly CatalogPresenceScope _scope;
    private readonly Dictionary<string, char> _relations;
    private readonly Dictionary<string, Dictionary<string, CatalogColumnInfo>> _columns;
    private readonly Dictionary<string, List<CatalogCheckInfo>> _checks;

    private CatalogPresenceSnapshot(CatalogPresenceScope scope)
    {
        _scope = scope;
        _relations = new(scope.RelationNames.Length, StringComparer.Ordinal);
        _columns = new(scope.ColumnRelationNames.Length, StringComparer.Ordinal);
        _checks = new(scope.CheckRelationNames.Length, StringComparer.Ordinal);
    }

    internal int ScopedRelationCount => _scope.RelationNames.Length;
    internal int ScopedColumnRelationCount => _scope.ColumnRelationNames.Length;
    internal int ScopedCheckRelationCount => _scope.CheckRelationNames.Length;
    internal int ObservedRelationCount => _relations.Count;
    internal int ObservedColumnCount { get; private set; }
    internal int ObservedCheckCount { get; private set; }

    internal static async Task<CatalogPresenceSnapshot> LoadAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        CatalogPresenceScope scope,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(BatchSql, connection, transaction);
        command.Parameters.Add(new NpgsqlParameter<string[]> { TypedValue = scope.RelationNames });
        command.Parameters.Add(new NpgsqlParameter<string[]> { TypedValue = scope.ColumnRelationNames });
        command.Parameters.Add(new NpgsqlParameter<string[]> { TypedValue = scope.CheckRelationNames });

        var snapshot = new CatalogPresenceSnapshot(scope);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var kind = reader.GetString(0);
            var relation = reader.GetString(1);
            var itemName = reader.GetString(2);
            switch (kind)
            {
                case "r":
                    if (itemName.Length > 0)
                        snapshot._relations[relation] = itemName[0];
                    break;
                case "c":
                    if (!snapshot._columns.TryGetValue(relation, out var relationColumns))
                    {
                        relationColumns = new Dictionary<string, CatalogColumnInfo>(StringComparer.Ordinal);
                        snapshot._columns[relation] = relationColumns;
                    }
                    relationColumns[itemName] = new CatalogColumnInfo(
                        NotNull: reader.GetBoolean(3),
                        TypeName: reader.IsDBNull(6) ? "" : reader.GetString(6));
                    snapshot.ObservedColumnCount++;
                    break;
                case "k":
                    if (!snapshot._checks.TryGetValue(relation, out var relationChecks))
                    {
                        relationChecks = [];
                        snapshot._checks[relation] = relationChecks;
                    }
                    relationChecks.Add(new CatalogCheckInfo(
                        Name: itemName,
                        IsValidated: reader.GetBoolean(3),
                        IsLocal: reader.GetBoolean(4),
                        IsStrictEnforced: reader.GetBoolean(5),
                        CompactExpression: reader.IsDBNull(6) ? "" : reader.GetString(6),
                        ConstraintDefinition: reader.IsDBNull(7) ? "" : reader.GetString(7)));
                    snapshot.ObservedCheckCount++;
                    break;
                default:
                    throw new InvalidOperationException($"Unexpected catalog snapshot row kind '{kind}'.");
            }
        }

        return snapshot;
    }

    internal bool HasRelation(string qualifiedName) =>
        _relations.ContainsKey(_scope.RequireRelationInScope(qualifiedName));

    internal char? GetRelationKind(string qualifiedName) =>
        _relations.TryGetValue(_scope.RequireRelationInScope(qualifiedName), out var kind) ? kind : null;

    internal int CountRelations(params string[] qualifiedNames)
    {
        var count = 0;
        foreach (var qualifiedName in qualifiedNames)
        {
            if (HasRelation(qualifiedName)) count++;
        }
        return count;
    }

    internal bool HasCompleteRelations(string incomplete, params string[] qualifiedNames) =>
        CurrentSchema.Complete(CountRelations(qualifiedNames), qualifiedNames.Length, incomplete);

    internal bool HasTypedRelations((string Relation, char Kind)[] relations, string incomplete)
    {
        var present = 0;
        var matched = 0;
        foreach (var (relation, expectedKind) in relations)
        {
            if (GetRelationKind(relation) is not { } actualKind) continue;
            present++;
            if (actualKind == expectedKind) matched++;
        }
        if (present == 0) return false;
        if (matched != relations.Length) throw new InvalidOperationException(incomplete);
        return true;
    }

    internal bool HasColumn(string qualifiedRelation, string columnName) =>
        TryGetColumn(qualifiedRelation, columnName, out _);

    internal bool TryGetColumn(string qualifiedRelation, string columnName, out CatalogColumnInfo column)
    {
        var relation = _scope.RequireColumnRelationInScope(qualifiedRelation);
        if (_columns.TryGetValue(relation, out var relationColumns) &&
            relationColumns.TryGetValue(columnName, out column))
        {
            return true;
        }
        column = default;
        return false;
    }

    private List<CatalogCheckInfo>? ChecksFor(string qualifiedRelation) =>
        _checks.GetValueOrDefault(_scope.RequireCheckRelationInScope(qualifiedRelation));

    internal bool HasCheckConstraint(string qualifiedRelation, string constraintName, bool requireLocalValidated = false) =>
        ChecksFor(qualifiedRelation)?.Exists(check => check.Name == constraintName &&
            (!requireLocalValidated || (check.IsValidated && check.IsLocal))) == true;

    internal bool HasColumnAndCheck(string qualifiedRelation, string columnName, string constraintName,
        string incomplete, bool requireLocalValidated = false)
    {
        var found = (HasColumn(qualifiedRelation, columnName) ? 1 : 0) +
            (HasCheckConstraint(qualifiedRelation, constraintName, requireLocalValidated) ? 1 : 0);
        return CurrentSchema.Complete(found, 2, incomplete);
    }

    internal string? FindStrictLocalCheckExpression(string qualifiedRelation, string constraintName)
    {
        foreach (var check in ChecksFor(qualifiedRelation) ?? [])
        {
            if (check.Name == constraintName && check.IsValidated && check.IsLocal && check.IsStrictEnforced)
                return check.CompactExpression;
        }
        return null;
    }

    internal bool HasValidatedCheckDefinition(string qualifiedRelation, params string[] definitions) =>
        ChecksFor(qualifiedRelation)?.Exists(check => check.IsValidated &&
            definitions.Contains(check.ConstraintDefinition, StringComparer.Ordinal)) == true;

    internal bool HasValidatedCheckExpression(string qualifiedRelation, string compactExpression) =>
        ChecksFor(qualifiedRelation)?.Exists(check => check.IsValidated && check.CompactExpression == compactExpression) == true;
}

internal static partial class CurrentSchema
{
    private static readonly Lazy<CatalogPresenceScope> CatalogProbeScopeHolder = new(BuildCatalogProbeScope);

    internal static CatalogPresenceScope CatalogProbeScope => CatalogProbeScopeHolder.Value;

    private static CatalogPresenceScope BuildCatalogProbeScope() => new(
        relations:
        [
            ArticleMediaRelation,
            ArticleCoverRelation,
            ..PrivateMediaImportRelations.Names,
            LegacyReleaseOriginRelation,
            SiteSubscriptionRelation,
            ..SiteRecoveryKeyRelations.Names,
            AdminInboxReplyRelation,
            AdminInboxStatusRelation,
            AdminInboxNoticeRelation,
            AdminInboxReadRelation,
            AuthoringWorkspaceRelation,
            ..SiteRefreshRelations.Names,
            ..SitePageEditorRelations.Names,
            ..SiteConfigOverrideRelations.Names,
            ..AppearanceActivationRelations.Names,
            ..RootCommentPowPolicyRelations.Names,
            ..SavedViewRelations.Names,
            ..SavedViewPlacementRelations.Names,
            ..AdminTagMetadataRelations.Names,
            ..AdminCategoryMetadataRelations.Names,
            ..AdminArticleRollbackRelations,
            ..AdminArticleTrashRestoreRelations.Names,
            ..CommentAuthorDeleteRelations.Names,
            ..CommentAuthorEditRelations.Names,
            CommentReportRelation,
            ..CommentAppealRelations.Names,
            CommentReplyRelation,
            ..AdminCommentBatchRelations.Names,
            ..AuthorRecentOpenRelations.Names,
            ..AuthorTextIndexRelations.Select(item => item.Relation),
            ..AuthorTextPropertyIndexRelations.Select(item => item.Relation),
            AuthorTextRebuildRelation,
            DocumentExportsRelation,
            ArticleBodyInsertionRelation,
            PublicationCanonicalRelation,
            PublicationMediaRelation,
            PublicationCoverRelation,
            ..PublicationProofRelations.Names,
            PublicationTransparencyRelation,
            PublicationHeadRelation,
            SiteTrafficRelation,
            ..ArticleReadRelations.Names,
            PropertySnapshotRelation,
            SitePasskeyNameRelation
        ],
        columnRelations:
        [
            PublicationHistoryRelation,
            AdminArticleRollbackRelation,
            AuthoringWorkspaceRelation,
            AuthorTextDocumentRelation,
            AuthorTextPostingRelation,
            ArticleRevisionRelation,
            DocumentExportsRelation,
            ArticleBodyInsertionRelation,
            PublicationProofRelation
        ],
        checkRelations:
        [
            ArticleRevisionRelation,
            AuthorTextDocumentRelation,
            AuthorTextPostingRelation,
            CommentAuthorEditedRelation,
            DocumentExportsRelation
        ]);

    internal static Task<CatalogPresenceSnapshot> LoadCatalogPresenceSnapshotAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken cancellationToken) =>
        CatalogPresenceSnapshot.LoadAsync(connection, transaction, CatalogProbeScope, cancellationToken);
}
