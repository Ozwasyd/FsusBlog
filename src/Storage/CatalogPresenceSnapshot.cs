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

    internal string RequireRelationInScope(string qualifiedName)
    {
        var name = NormalizePublicName(qualifiedName);
        if (!_relations.Contains(name))
            throw new InvalidOperationException($"Relation '{qualifiedName}' is outside the catalog presence snapshot scope.");
        return name;
    }

    internal string RequireColumnRelationInScope(string qualifiedName)
    {
        var name = NormalizePublicName(qualifiedName);
        if (!_columnRelations.Contains(name))
            throw new InvalidOperationException($"Column metadata for '{qualifiedName}' is outside the catalog presence snapshot scope.");
        return name;
    }

    internal string RequireCheckRelationInScope(string qualifiedName)
    {
        var name = NormalizePublicName(qualifiedName);
        if (!_checkRelations.Contains(name))
            throw new InvalidOperationException($"CHECK metadata for '{qualifiedName}' is outside the catalog presence snapshot scope.");
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
//   - Specialized post-shape index and business-data invariant checks (VerifySitePageCoordinatesAsync,
//     VerifyTaxonomyEpochAsync, VerifyAppearanceActivationAsync, VerifyRootCommentPowPolicyAsync,
//     VerifyArticleReadEpochAsync, VerifyAuthorTextArticleOwnerIndexAsync, VerifyDocumentExportIndexesAsync)
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

    private CatalogPresenceSnapshot(
        CatalogPresenceScope scope,
        Dictionary<string, char> relations,
        Dictionary<string, Dictionary<string, CatalogColumnInfo>> columns,
        Dictionary<string, List<CatalogCheckInfo>> checks,
        int observedColumnCount,
        int observedCheckCount)
    {
        _scope = scope;
        _relations = relations;
        _columns = columns;
        _checks = checks;
        ObservedColumnCount = observedColumnCount;
        ObservedCheckCount = observedCheckCount;
    }

    internal int ScopedRelationCount => _scope.RelationNames.Length;
    internal int ScopedColumnRelationCount => _scope.ColumnRelationNames.Length;
    internal int ScopedCheckRelationCount => _scope.CheckRelationNames.Length;
    internal int ObservedRelationCount => _relations.Count;
    internal int ObservedColumnCount { get; }
    internal int ObservedCheckCount { get; }

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

        var relations = new Dictionary<string, char>(scope.RelationNames.Length, StringComparer.Ordinal);
        var columns = new Dictionary<string, Dictionary<string, CatalogColumnInfo>>(scope.ColumnRelationNames.Length, StringComparer.Ordinal);
        var checks = new Dictionary<string, List<CatalogCheckInfo>>(scope.CheckRelationNames.Length, StringComparer.Ordinal);
        var observedColumns = 0;
        var observedChecks = 0;

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
                        relations[relation] = itemName[0];
                    break;
                case "c":
                    if (!columns.TryGetValue(relation, out var relationColumns))
                    {
                        relationColumns = new Dictionary<string, CatalogColumnInfo>(StringComparer.Ordinal);
                        columns[relation] = relationColumns;
                    }
                    relationColumns[itemName] = new CatalogColumnInfo(
                        NotNull: reader.GetBoolean(3),
                        TypeName: reader.IsDBNull(6) ? "" : reader.GetString(6));
                    observedColumns++;
                    break;
                case "k":
                    if (!checks.TryGetValue(relation, out var relationChecks))
                    {
                        relationChecks = [];
                        checks[relation] = relationChecks;
                    }
                    relationChecks.Add(new CatalogCheckInfo(
                        Name: itemName,
                        IsValidated: reader.GetBoolean(3),
                        IsLocal: reader.GetBoolean(4),
                        IsStrictEnforced: reader.GetBoolean(5),
                        CompactExpression: reader.IsDBNull(6) ? "" : reader.GetString(6),
                        ConstraintDefinition: reader.IsDBNull(7) ? "" : reader.GetString(7)));
                    observedChecks++;
                    break;
                default:
                    throw new InvalidOperationException($"Unexpected catalog snapshot row kind '{kind}'.");
            }
        }

        return new CatalogPresenceSnapshot(scope, relations, columns, checks, observedColumns, observedChecks);
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

    internal bool HasCheckConstraint(string qualifiedRelation, string constraintName, bool requireLocalValidated = false)
    {
        var relation = _scope.RequireCheckRelationInScope(qualifiedRelation);
        if (!_checks.TryGetValue(relation, out var relationChecks)) return false;
        foreach (var check in relationChecks)
        {
            if (string.Equals(check.Name, constraintName, StringComparison.Ordinal) &&
                (!requireLocalValidated || (check.IsValidated && check.IsLocal)))
            {
                return true;
            }
        }
        return false;
    }

    internal bool HasColumnAndCheck(string qualifiedRelation, string columnName, string constraintName,
        string incomplete, bool requireLocalValidated = false)
    {
        var found = (HasColumn(qualifiedRelation, columnName) ? 1 : 0) +
            (HasCheckConstraint(qualifiedRelation, constraintName, requireLocalValidated) ? 1 : 0);
        return CurrentSchema.Complete(found, 2, incomplete);
    }

    internal string? FindStrictLocalCheckExpression(string qualifiedRelation, string constraintName)
    {
        var relation = _scope.RequireCheckRelationInScope(qualifiedRelation);
        if (!_checks.TryGetValue(relation, out var relationChecks)) return null;
        foreach (var check in relationChecks)
        {
            if (string.Equals(check.Name, constraintName, StringComparison.Ordinal) &&
                check.IsValidated && check.IsLocal && check.IsStrictEnforced)
            {
                return check.CompactExpression;
            }
        }
        return null;
    }

    internal bool HasValidatedCheckDefinition(string qualifiedRelation, params string[] definitions)
    {
        var relation = _scope.RequireCheckRelationInScope(qualifiedRelation);
        if (!_checks.TryGetValue(relation, out var relationChecks)) return false;
        foreach (var check in relationChecks)
        {
            if (!check.IsValidated) continue;
            foreach (var definition in definitions)
            {
                if (string.Equals(check.ConstraintDefinition, definition, StringComparison.Ordinal))
                    return true;
            }
        }
        return false;
    }

    internal bool HasValidatedCheckExpression(string qualifiedRelation, string compactExpression)
    {
        var relation = _scope.RequireCheckRelationInScope(qualifiedRelation);
        if (!_checks.TryGetValue(relation, out var relationChecks)) return false;
        foreach (var check in relationChecks)
        {
            if (check.IsValidated && string.Equals(check.CompactExpression, compactExpression, StringComparison.Ordinal))
                return true;
        }
        return false;
    }
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
            ..PrivateMediaImportRelations,
            LegacyReleaseOriginRelation,
            SiteSubscriptionRelation,
            ..SiteRecoveryKeyRelations,
            AdminInboxReplyRelation,
            AdminInboxStatusRelation,
            AdminInboxNoticeRelation,
            AdminInboxReadRelation,
            AuthoringWorkspaceRelation,
            ..SiteRefreshRelations,
            ..SitePageEditorRelations,
            ..AppearanceActivationRelations,
            ..RootCommentPowPolicyRelations,
            ..SavedViewRelations,
            ..SavedViewPlacementRelations,
            ..AdminTagMetadataRelations,
            ..AdminCategoryMetadataRelations,
            ..AdminArticleRollbackRelations,
            ..AdminArticleTrashRestoreRelations,
            ..CommentAuthorDeleteRelations,
            ..CommentAuthorEditRelations,
            CommentReportRelation,
            ..CommentAppealRelations,
            CommentReplyRelation,
            ..AdminCommentBatchRelations,
            ..AuthorRecentOpenRelations,
            ..AuthorTextIndexRelations.Select(item => item.Relation),
            ..AuthorTextPropertyIndexRelations,
            AuthorTextRebuildRelation,
            DocumentExportsRelation,
            ArticleBodyInsertionRelation,
            PublicationCanonicalRelation,
            PublicationMediaRelation,
            PublicationCoverRelation,
            ..PublicationProofRelations,
            PublicationTransparencyRelation,
            PublicationHeadRelation,
            SiteTrafficRelation,
            ..ArticleReadRelations,
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
