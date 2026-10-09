using System.Data;

using Npgsql;

using SqlSugar;

using FsusBlog.Shared.Contracts.ArticleEmbeds;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Internal persisted mapping only. Permission, site and lifecycle admission remain with their owners.</summary>
public sealed record ArticleRelationArticleCoordinate(int ArticleId, string ArticleIdentity);

/// <summary>A persisted immutable source incarnation, independent of editor runtime/session epochs.</summary>
public sealed record ArticleRelationRevisionCoordinate(
    int ArticleId,
    long RevisionId,
    int RevisionNo,
    string ArticleIdentity,
    string RevisionIdentity,
    Guid SourceEpoch);

/// <summary>Content-free refusal; no source text, metadata or database diagnostics leave this boundary.</summary>
public sealed class ArticleRelationSourceCoordinateException(string reasonCode) : InvalidOperationException(reasonCode);

/// <summary>
/// Sole canonical persistence owner for article and immutable revision coordinates.
/// The caller owns authorization, transaction/fence and commit/rollback. No registration,
/// schema DDL, current pointer, relation index, draft store or lifecycle generation lives here.
/// </summary>
/// <remarks>
/// Shared revision owner: dispose SaveAsync's RETURNING reader, then call ProvisionRevisionAsync
/// with the actual article/revision IDs before outer commit. This covers create/update/fixture
/// and revision-producing rollback. Non-revision lifecycle owners read the selected exact binding.
/// Import owner: call ProvisionImportedRevisionAsync only with identity supplied by its authorized
/// contract; no imported revision identity is inferred. DI and migration owners register this
/// authority and its NEW definition through their existing producers. Until those hooks land,
/// legacy and unprovisioned sources remain unavailable; draft support is not claimed.
/// </remarks>
public sealed class ArticleRelationSourceCoordinateAuthority
{
    private const string RevisionSelect = """
        SELECT revision.article_id, revision.id, revision.revision_no,
               article_binding.portable_identity, source.revision_identity, source.source_epoch
        FROM article_revision revision
        JOIN article ON article.id = revision.article_id
        JOIN article_relation_article_binding article_binding ON article_binding.article_id = revision.article_id
        JOIN article_relation_source_coordinate source
          ON source.revision_id = revision.id AND source.article_id = revision.article_id
        WHERE revision.article_id = @articleId AND revision.id = @revisionId;
        """;

    /// <summary>Zero-write exact read. Missing or wrong article/revision bindings return null.</summary>
    public async Task<ArticleRelationRevisionCoordinate?> ReadRevisionAsync(
        ISqlSugarClient db,
        int articleId,
        long revisionId,
        CancellationToken cancellationToken = default)
    {
        ValidateCoordinates(articleId, revisionId);
        NativeSession session = await BorrowReadAsync(db, cancellationToken).ConfigureAwait(false);
        return await ReadRevisionAsync(session, articleId, revisionId, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Resolve one codec-validated portable article identity; this does not authorize access.</summary>
    public async Task<ArticleRelationArticleCoordinate?> FindArticleAsync(
        ISqlSugarClient db,
        string portableArticleIdentity,
        CancellationToken cancellationToken = default)
    {
        Guid identity = ParseArticleIdentity(portableArticleIdentity);
        NativeSession session = await BorrowReadAsync(db, cancellationToken).ConfigureAwait(false);
        ArticleRelationArticleCoordinate? result;
        await using (NpgsqlCommand command = session.CreateCommand("""
            SELECT binding.article_id, binding.portable_identity
            FROM article_relation_article_binding binding
            JOIN article ON article.id = binding.article_id
            WHERE binding.portable_identity = @identity;
            """, cancellationToken))
        {
            command.Parameters.AddWithValue("identity", identity);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            result = await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                ? new(reader.GetInt32(0), ArticleIdentity(reader.GetGuid(1)))
                : null;
        }
        session.Validate(cancellationToken);
        return result;
    }

    /// <summary>Provision independently random identities against actual rows in the caller's live transaction.</summary>
    public Task<ArticleRelationRevisionCoordinate> ProvisionRevisionAsync(
        ISqlSugarClient db,
        int articleId,
        long revisionId,
        CancellationToken cancellationToken = default)
        => ProvisionAsync(db, articleId, revisionId, null, cancellationToken);

    /// <summary>
    /// Bind the portable article identity supplied by an authorized import contract, rejecting remap/collision.
    /// Revision identity and source epoch are allocated locally; no portable revision import contract is assumed.
    /// </summary>
    public Task<ArticleRelationRevisionCoordinate> ProvisionImportedRevisionAsync(
        ISqlSugarClient db,
        int articleId,
        long revisionId,
        string suppliedPortableArticleIdentity,
        CancellationToken cancellationToken = default)
        => ProvisionAsync(db, articleId, revisionId, ParseArticleIdentity(suppliedPortableArticleIdentity), cancellationToken);

    private static async Task<ArticleRelationRevisionCoordinate> ProvisionAsync(
        ISqlSugarClient db,
        int articleId,
        long revisionId,
        Guid? importedArticleIdentity,
        CancellationToken cancellationToken)
    {
        ValidateCoordinates(articleId, revisionId);
        NativeSession session = Borrow(db, requireTransaction: true, cancellationToken);
        // Serialize all provisioning for this article, including concurrent retries and different revisions.
        // Lock actual source rows before any binding writes; deleted/restored articles keep their coordinates.
        object? article = await ScalarAsync(session,
            "SELECT id FROM article WHERE id = @articleId FOR UPDATE;",
            articleId, revisionId, cancellationToken).ConfigureAwait(false);
        Require(article is int, "article_relation_article_missing");
        object? revision = await ScalarAsync(session,
            "SELECT revision_no FROM article_revision WHERE article_id = @articleId AND id = @revisionId FOR KEY SHARE;",
            articleId, revisionId, cancellationToken).ConfigureAwait(false);
        Require(revision is int revisionNo && revisionNo > 0, "article_relation_revision_missing_or_wrong_article");

        ArticleRelationRevisionCoordinate? existing = await ReadRevisionAsync(
            session, articleId, revisionId, cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            Require(!importedArticleIdentity.HasValue
                || existing.ArticleIdentity == ArticleIdentity(importedArticleIdentity.Value), "article_relation_article_remap_refused");
            return existing;
        }

        object? storedArticleIdentity = await ScalarAsync(session,
            "SELECT portable_identity FROM article_relation_article_binding WHERE article_id = @articleId;",
            articleId, revisionId, cancellationToken).ConfigureAwait(false);
        if (storedArticleIdentity is Guid savedIdentity)
        {
            Require(savedIdentity != Guid.Empty, "article_relation_binding_invalid");
            Require(!importedArticleIdentity.HasValue || importedArticleIdentity == savedIdentity,
                "article_relation_article_remap_refused");
        }

        try
        {
            if (storedArticleIdentity is null)
            {
                await InsertAsync(session,
                    "INSERT INTO article_relation_article_binding(article_id, portable_identity) VALUES (@articleId, @identity);",
                    articleId, revisionId, importedArticleIdentity ?? Guid.NewGuid(), null, cancellationToken).ConfigureAwait(false);
            }
            await InsertAsync(session,
                """
                INSERT INTO article_relation_source_coordinate(article_id, revision_id, revision_identity, source_epoch)
                VALUES (@articleId, @revisionId, @identity, @epoch);
                """,
                articleId, revisionId, Guid.NewGuid(), Guid.NewGuid(), cancellationToken).ConfigureAwait(false);
        }
        catch (PostgresException exception) when (exception.SqlState is "23505" or "23503" or "23514")
        {
            // Caller must terminate its transaction after refusal; do not expose driver row/constraint details.
            throw new ArticleRelationSourceCoordinateException("article_relation_binding_conflict");
        }

        return await ReadRevisionAsync(session, articleId, revisionId, cancellationToken).ConfigureAwait(false)
            ?? throw new ArticleRelationSourceCoordinateException("article_relation_binding_unavailable");
    }

    private static async Task<ArticleRelationRevisionCoordinate?> ReadRevisionAsync(
        NativeSession session,
        int articleId,
        long revisionId,
        CancellationToken cancellationToken)
    {
        ArticleRelationRevisionCoordinate? result = null;
        await using (NpgsqlCommand command = session.CreateCommand(RevisionSelect, cancellationToken))
        {
            AddCoordinates(command, articleId, revisionId);
            await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                Guid articleIdentity = reader.GetGuid(3);
                Guid revisionIdentity = reader.GetGuid(4);
                Guid epoch = reader.GetGuid(5);
                Require(articleIdentity != Guid.Empty && revisionIdentity != Guid.Empty && epoch != Guid.Empty
                    && reader.GetInt32(2) > 0, "article_relation_binding_invalid");
                result = new(reader.GetInt32(0), reader.GetInt64(1), reader.GetInt32(2),
                    ArticleIdentity(articleIdentity), $"revision:{revisionIdentity:D}", epoch);
            }
        }
        session.Validate(cancellationToken);
        return result;
    }

    private static async Task<object?> ScalarAsync(
        NativeSession session, string sql, int articleId, long revisionId, CancellationToken cancellationToken)
    {
        object? result;
        await using (NpgsqlCommand command = session.CreateCommand(sql, cancellationToken))
        {
            AddCoordinates(command, articleId, revisionId);
            result = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        }
        session.Validate(cancellationToken);
        return result is DBNull ? null : result;
    }

    private static async Task InsertAsync(
        NativeSession session, string sql, int articleId, long revisionId, Guid identity, Guid? epoch,
        CancellationToken cancellationToken)
    {
        await using (NpgsqlCommand command = session.CreateCommand(sql, cancellationToken))
        {
            AddCoordinates(command, articleId, revisionId);
            command.Parameters.AddWithValue("identity", identity);
            if (epoch.HasValue)
            {
                command.Parameters.AddWithValue("epoch", epoch.Value);
            }
            Require(await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false) == 1,
                "article_relation_binding_write_failed");
        }
        session.Validate(cancellationToken);
    }

    private static void AddCoordinates(NpgsqlCommand command, int articleId, long revisionId)
    {
        command.Parameters.AddWithValue("articleId", articleId);
        command.Parameters.AddWithValue("revisionId", revisionId);
    }

    private static string ArticleIdentity(Guid identity) => $"article:{identity:D}";

    private static Guid ParseArticleIdentity(string identity)
    {
        Require(ArticleEmbedTargetCodec.IsPortableArticleIdentity(identity), "article_relation_article_identity_invalid");
        return Guid.ParseExact(identity["article:".Length..], "D");
    }

    private static void ValidateCoordinates(int articleId, long revisionId)
        => Require(articleId > 0 && revisionId > 0, "article_relation_source_coordinate_invalid");

    private static async Task<NativeSession> BorrowReadAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        NativeSession session = Borrow(db, requireTransaction: false, cancellationToken);
        if (session.Connection.State != ConnectionState.Open)
        {
            await session.Connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        }
        session.Validate(cancellationToken);
        return session;
    }

    private static NativeSession Borrow(ISqlSugarClient db, bool requireTransaction, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        cancellationToken.ThrowIfCancellationRequested();
        Require(db.CurrentConnectionConfig.DbType == SqlSugar.DbType.PostgreSQL
            && db.Ado.Connection is NpgsqlConnection, "article_relation_postgres_connection_required");
        var connection = (NpgsqlConnection)db.Ado.Connection;
        var transaction = db.Ado.Transaction as NpgsqlTransaction;
        Require((db.Ado.Transaction is null || transaction is not null)
            && (!requireTransaction || transaction is not null)
            && (transaction is null || (HasUsableTransaction(transaction, connection)
                && connection.State == ConnectionState.Open)), "article_relation_caller_transaction_required");
        return new(db, connection, transaction);
    }

    private static bool HasUsableTransaction(NpgsqlTransaction transaction, NpgsqlConnection connection)
    {
        try
        {
            // Npgsql's public getter runs its own CheckReady and refuses completed/disposed transactions.
            // The isolation label itself supplies no authority and is never interpreted here.
            _ = transaction.IsolationLevel;
            return ReferenceEquals(transaction.Connection, connection);
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private sealed record NativeSession(ISqlSugarClient Db, NpgsqlConnection Connection, NpgsqlTransaction? Transaction)
    {
        public void Validate(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Require(ReferenceEquals(Db.Ado.Connection, Connection)
                && ReferenceEquals(Db.Ado.Transaction, Transaction)
                && Connection.State == ConnectionState.Open
                && (Transaction is null || HasUsableTransaction(Transaction, Connection)),
                "article_relation_caller_transaction_changed");
        }

        public NpgsqlCommand CreateCommand(string sql, CancellationToken cancellationToken)
        {
            Validate(cancellationToken);
            return new NpgsqlCommand(sql, Connection, Transaction) { CommandTimeout = Db.Ado.CommandTimeOut };
        }
    }

    private static void Require(bool condition, string reason)
    {
        if (!condition)
        {
            throw new ArticleRelationSourceCoordinateException(reason);
        }
    }
}
