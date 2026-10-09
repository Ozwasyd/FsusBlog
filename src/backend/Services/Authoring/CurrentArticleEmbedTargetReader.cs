using System.Data;

using Npgsql;

using SqlSugar;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Shared.Contracts.ArticleEmbeds;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Internal authorized source, bound to its persisted immutable incarnation. This is neither
/// an editor epoch nor a publication coordinate or a renderer projection grant.
/// </summary>
public sealed record CurrentArticleEmbedTargetSource(
    ArticleRelationRevisionCoordinate Coordinate,
    RevisionComparePackage Package);

/// <summary>
/// Zero-write portable article lookup through the canonical coordinate and authorized source
/// readers. Missing, denied, unbound and drifting targets return the same content-free null.
/// Heading/block targets require canonical projection facts and are not admitted here.
/// Requires READ COMMITTED statement snapshots in the same client/transaction context.
/// Ambient and retained snapshots fail closed; the caller owns its transaction lifecycle.
/// </summary>
public sealed class CurrentArticleEmbedTargetReader(
    ISqlSugarClient db,
    ArticleRelationSourceCoordinateAuthority coordinates,
    IAuthoringRevisionCompareAuthority authority,
    IRevisionComparePackageReader packages)
{
    public async Task<CurrentArticleEmbedTargetSource?> ReadAsync(
        RevisionCompareReadContext context,
        ArticleEmbedTargetIdentity target,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!ArticleEmbedTargetCodec.Validate(target).IsValid || target.Kind != ArticleEmbedTargetKind.Article)
        {
            return null;
        }

        if (db.CurrentConnectionConfig.DbType != SqlSugar.DbType.PostgreSQL
            || db.Ado.Connection is not NpgsqlConnection connection)
        {
            return null;
        }
        IDbTransaction? transaction = db.Ado.Transaction;
        if (!await HasFreshStatementsAsync(connection, transaction, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        ArticleRelationArticleCoordinate? article = await coordinates.FindArticleAsync(
            db, target.PortableArticleIdentity, cancellationToken).ConfigureAwait(false);
        if (article is null
            || !await HasFreshStatementsAsync(connection, transaction, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        AuthoringRevisionCompareArticle? admitted = await authority.GetAuthorizedArticleAsync(
            context, article.ArticleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (admitted?.ArticleId != article.ArticleId || admitted.CurrentRevisionId is not > 0
            || !await HasFreshStatementsAsync(connection, transaction, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        long revisionId = admitted.CurrentRevisionId.Value;
        ArticleRelationRevisionCoordinate? before = await coordinates.ReadRevisionAsync(
            db, article.ArticleId, revisionId, cancellationToken).ConfigureAwait(false);
        if (before is null || before.ArticleIdentity != target.PortableArticleIdentity
            || !await HasFreshStatementsAsync(connection, transaction, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        RevisionComparePackageReadResult read = await packages.ReadAuthorizedAsync(
            context, article.ArticleId,
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision, RevisionId: revisionId),
            cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RevisionComparePackage? package = read.Package;
        if (read.Status != RevisionComparePackageReadStatus.Available || package is null
            || package.ArticleId != before.ArticleId || package.RevisionId != before.RevisionId
            || package.RevisionNo != before.RevisionNo || package.SourceKind != RevisionCompareSourceKind.CurrentRevision
            || package.ServerRevision is not null || package.DocumentEpoch is not null
            || !RevisionComparePackageSeal.Verify(package)
            || !await HasFreshStatementsAsync(connection, transaction, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        ArticleRelationRevisionCoordinate? after = await coordinates.ReadRevisionAsync(
            db, article.ArticleId, revisionId, cancellationToken).ConfigureAwait(false);
        if (after != before
            || !await HasFreshStatementsAsync(connection, transaction, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        ArticleRelationArticleCoordinate? mapped = await coordinates.FindArticleAsync(
            db, target.PortableArticleIdentity, cancellationToken).ConfigureAwait(false);
        if (mapped != article
            || !await HasFreshStatementsAsync(connection, transaction, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }
        AuthoringRevisionCompareArticle? current = await authority.GetAuthorizedArticleAsync(
            context, article.ArticleId, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return current == admitted
            && await HasFreshStatementsAsync(connection, transaction, cancellationToken).ConfigureAwait(false)
            ? new CurrentArticleEmbedTargetSource(before, package)
            : null;
    }

    private async Task<bool> HasFreshStatementsAsync(NpgsqlConnection connection, IDbTransaction? transaction,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsSameTransactionContext(connection, transaction))
        {
            return false;
        }
        if (connection.State == ConnectionState.Closed)
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        }
        if (connection.State != ConnectionState.Open || !IsSameTransactionContext(connection, transaction))
        {
            return false;
        }

        // SQL SET TRANSACTION and suppressed ambient enlistment need not match the ADO label.
        // Observe this borrowed connector's server setting without changing its transaction.
        await using var command = new NpgsqlCommand("SHOW transaction_isolation;", connection, transaction as NpgsqlTransaction)
        {
            CommandTimeout = db.Ado.CommandTimeOut
        };
        object? isolation = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return isolation is string value && value == "read committed"
            && IsSameTransactionContext(connection, transaction);
    }

    private bool IsSameTransactionContext(NpgsqlConnection connection, IDbTransaction? transaction)
    {
        if (System.Transactions.Transaction.Current is not null
            || !ReferenceEquals(db.Ado.Connection, connection)
            || !ReferenceEquals(db.Ado.Transaction, transaction))
        {
            return false;
        }
        if (transaction is null)
        {
            return true;
        }
        try
        {
            return transaction is NpgsqlTransaction native
                && connection.State == ConnectionState.Open
                && ReferenceEquals(native.Connection, connection)
                && native.IsolationLevel == IsolationLevel.ReadCommitted;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
}
