using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Text;

using FsusBlog.Contracts.Migration;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Migration;

internal sealed record ArticlePreservationDiscardedDomain(string Name, long Count, string Reason);
internal sealed record ArticlePreservationSourceReadResult(
    ArticlePreservationSourceData Data, OfflineMigrationSourceObservation Observation,
    ImmutableArray<ArticlePreservationDiscardedDomain> DiscardedDomains,
    string? ConfiguredSiteAuthor);

/// <summary>
/// Reads the supported historical profile through the original observer and the caller's
/// one consistent native session. It does not open a connection, mutate a transaction,
/// read current entities or require historical users to map to current accounts.
/// </summary>
internal static class ArticlePreservationSourceReader
{
    private static readonly UTF8Encoding s_utf8 = new(false, true);

    internal static Task<ArticlePreservationSourceReadResult> ReadAsync(
        CurrentSchemaProviderKind provider, DbConnection connection, DbTransaction transaction,
        OfflineMigrationSourceObserver observer, CurrentSchemaArtifactReference originArtifact,
        Uri documentBase, ArticlePreservationLimits limits, TimeSpan readBudget,
        CancellationToken cancellationToken)
        => ReadCoreAsync(provider, connection, transaction, observer,
            token => observer.ObserveAsync(provider, connection, transaction, token),
            originArtifact, documentBase, limits, readBudget, cancellationToken);

    // Only the original native session can mint this run-owned context. Generic
    // connection/transaction tuples cannot grant a MySQL source read.
    internal static async Task<ArticlePreservationSourceReadResult> ReadMySqlOwnedAsync(
        OfflineMigrationMySqlNativeSession.OwnedReadContext originalRead,
        OfflineMigrationSourceObserver observer, CurrentSchemaArtifactReference originArtifact,
        Uri documentBase, ArticlePreservationLimits limits, TimeSpan readBudget,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(originalRead);
        using CancellationTokenSource ownedReadScope = originalRead.CreateReadScope(cancellationToken);
        return await ReadCoreAsync(CurrentSchemaProviderKind.MySql,
            originalRead.OriginalConnection, originalRead.OriginalTransaction, observer,
            token => observer.ObserveAsync(CurrentSchemaProviderKind.MySql,
                originalRead.OriginalConnection, originalRead.OriginalTransaction, token),
            originArtifact, documentBase, limits, readBudget, ownedReadScope.Token, originalRead).ConfigureAwait(false);
    }

    // Apply-phase only: the original observer validates the complete journal DDL
    // before excluding that exact infrastructure object. Planning above still
    // observes all objects and refuses a journal or an unknown/partial schema.
    internal static Task<ArticlePreservationSourceReadResult> ReadApplyAsync(
        DbConnection connection, DbTransaction transaction, OfflineMigrationSourceObserver observer,
        CurrentSchemaArtifactReference originArtifact, Uri documentBase,
        ArticlePreservationLimits limits, TimeSpan readBudget, CancellationToken cancellationToken)
        => ReadCoreAsync(CurrentSchemaProviderKind.PostgreSql, connection, transaction, observer,
            token => observer.ObserveLegacyAfterValidatedJournalAsync(connection, transaction, token),
            originArtifact, documentBase, limits, readBudget, cancellationToken);

    private static async Task<ArticlePreservationSourceReadResult> ReadCoreAsync(
        CurrentSchemaProviderKind provider, DbConnection connection, DbTransaction transaction,
        OfflineMigrationSourceObserver observer,
        Func<CancellationToken, Task<OfflineMigrationSourceObservation>> observe,
        CurrentSchemaArtifactReference originArtifact, Uri documentBase,
        ArticlePreservationLimits limits, TimeSpan readBudget, CancellationToken cancellationToken,
        OfflineMigrationMySqlNativeSession.OwnedReadContext? originalMySqlRead = null)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        ArgumentNullException.ThrowIfNull(observer);
        ArgumentNullException.ThrowIfNull(observe);
        ArgumentNullException.ThrowIfNull(limits);
        if (originalMySqlRead is null)
            RequireReadSession(provider, connection, transaction);
        else if (provider != CurrentSchemaProviderKind.MySql
            || !ReferenceEquals(connection, originalMySqlRead.OriginalConnection)
            || !ReferenceEquals(transaction, originalMySqlRead.OriginalTransaction))
            throw new InvalidOperationException("article_preservation_consistent_source_session_required");
        RequireReadBudget(limits, readBudget);
        RequireReadInputs(originArtifact, documentBase);

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(readBudget);
        CancellationToken token = deadline.Token;
        token.ThrowIfCancellationRequested();
        if (originalMySqlRead is not null)
            await originalMySqlRead.RequireBoundaryAsync(token).ConfigureAwait(false);
        OfflineMigrationSourceObservation observation = await observe(token).ConfigureAwait(false);
        if (OfflineMigrationSourceFingerprints.CreateRegistry().Match(observation).Id != OfflineMigrationSourceFingerprints.LegacyId)
            throw new InvalidOperationException("article_preservation_source_fingerprint_unsupported");
        if (provider == CurrentSchemaProviderKind.Sqlite)
            await SqliteArticlePreservationSourceReader.RequireBoundedTextAsync(
                connection, transaction, limits, readBudget, token).ConfigureAwait(false);

        var budget = new ReadBudget(limits);
        ImmutableArray<LegacyArticlePreservationTaxonomy> categories = await ReadTaxonomyAsync(
            "category", provider, connection, transaction, budget, readBudget, token).ConfigureAwait(false);
        ImmutableArray<LegacyArticlePreservationTaxonomy> tags = await ReadTaxonomyAsync(
            "tag", provider, connection, transaction, budget, readBudget, token).ConfigureAwait(false);
        var articles = ImmutableArray.CreateBuilder<LegacyArticlePreservationRow>();
        await using (DbCommand command = Command(connection, transaction, readBudget,
                         $"SELECT id,title,content,summary,categoryid,views,createtime,isdeleted FROM {Table(provider, "article")} ORDER BY id"))
        await using (DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                budget.Article();
                int id = reader.GetInt32(0);
                string title = await budget.TextAsync(reader, 1, token).ConfigureAwait(false)
                    ?? throw new InvalidOperationException("article_preservation_source_title_missing");
                string? markdown = await budget.TextAsync(reader, 2, token).ConfigureAwait(false);
                string? summary = await budget.TextAsync(reader, 3, token).ConfigureAwait(false);
                articles.Add(new(id, title, markdown, summary, reader.GetInt32(4), [], reader.GetInt32(5),
                    reader.GetDateTime(6), reader.GetBoolean(7)));
            }
        }
        var articleIndex = articles.Select((article, index) => (article.Id, Index: index))
            .ToDictionary(static item => item.Id, static item => item.Index);
        var tagIds = tags.Select(static tag => tag.Id).ToHashSet();
        var articleTags = new Dictionary<int, ImmutableArray<int>.Builder>();
        await using (DbCommand command = Command(connection, transaction, readBudget,
                         $"SELECT articleid,tagid FROM {Table(provider, "article_tag")} ORDER BY articleid,tagid"))
        await using (DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                budget.Relation();
                int articleId = reader.GetInt32(0);
                int tagId = reader.GetInt32(1);
                if (!articleIndex.ContainsKey(articleId) || !tagIds.Contains(tagId))
                    throw new InvalidOperationException("article_preservation_orphan_source_taxonomy");
                if (!articleTags.TryGetValue(articleId, out ImmutableArray<int>.Builder? ids))
                    articleTags.Add(articleId, ids = ImmutableArray.CreateBuilder<int>());
                ids.Add(tagId);
            }
        }
        foreach ((int articleId, ImmutableArray<int>.Builder ids) in articleTags)
        {
            int index = articleIndex[articleId];
            articles[index] = articles[index] with
            {
                TagIds = ids.ToImmutable()
            };
        }
        string? configuredSiteAuthor = null;
        await using (DbCommand command = Command(connection, transaction, readBudget,
                         $"SELECT value FROM {Table(provider, "sys_systemconfig")} WHERE {Quote(provider, "key")} = @key"))
        {
            DbParameter parameter = command.CreateParameter();
            parameter.ParameterName = "@key";
            parameter.Value = PublicSiteAuthorPolicy.ConfigurationKey;
            command.Parameters.Add(parameter);
            await using DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token).ConfigureAwait(false);
            if (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                configuredSiteAuthor = await budget.TextAsync(reader, 0, token).ConfigureAwait(false);
                if (await reader.ReadAsync(token).ConfigureAwait(false))
                    throw new InvalidOperationException("article_preservation_ambiguous_site_author");
            }
        }
        var discarded = ImmutableArray.CreateBuilder<ArticlePreservationDiscardedDomain>();
        // Counts only: never copy user credentials, comment authors or message identity payloads.
        foreach (string table in new[] { "sys_user", "comment", "sys_message", "sys_user_message", "sys_visit_log" })
        {
            await using DbCommand command = Command(connection, transaction, readBudget,
                $"SELECT COUNT(*) FROM {Table(provider, table)}");
            long count = Convert.ToInt64(await command.ExecuteScalarAsync(token).ConfigureAwait(false),
                System.Globalization.CultureInfo.InvariantCulture);
            discarded.Add(new(table, count, "outside_article_preservation_scope"));
        }
        token.ThrowIfCancellationRequested();
        // Recheck the original full observation in the same snapshot, including non-MVCC sequence state.
        OfflineMigrationSourceObservation rechecked = await observe(token).ConfigureAwait(false);
        if (ArticlePreservationSemanticReceipt.Digest("article-source-observation-v1", observation)
            != ArticlePreservationSemanticReceipt.Digest("article-source-observation-v1", rechecked))
            throw new InvalidOperationException("article_preservation_source_changed");
        if (originalMySqlRead is not null)
            await originalMySqlRead.RequireBoundaryAsync(token).ConfigureAwait(false);
        var data = new ArticlePreservationSourceData(OfflineMigrationSourceFingerprints.LegacyId,
            observation.ContentDigest, originArtifact, documentBase, articles.Count, categories.Length, tags.Length,
            articles.ToImmutable(), categories, tags, configuredSiteAuthor, discarded.ToImmutable());
        return new(data, observation, discarded.ToImmutable(), configuredSiteAuthor);
    }

    // MySQL is admitted only through the original run-owned context above, never
    // a raw driver transaction, isolation enum or session default. The original
    // PostgreSQL/SQLite shape predicate is unchanged; their native owners still
    // perform real observation and source admission.
    internal static void RequireReadSession(CurrentSchemaProviderKind provider,
        DbConnection connection, DbTransaction transaction)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        if (!Enum.IsDefined(provider) || connection.State != ConnectionState.Open || transaction.Connection != connection)
            throw new InvalidOperationException("article_preservation_consistent_source_session_required");
        if (provider == CurrentSchemaProviderKind.MySql
            || transaction.IsolationLevel is not (IsolationLevel.RepeatableRead or IsolationLevel.Serializable))
            throw new InvalidOperationException("article_preservation_consistent_source_session_required");
    }

    internal static void RequireReadBudget(ArticlePreservationLimits limits, TimeSpan readBudget)
    {
        ArgumentNullException.ThrowIfNull(limits);
        if (limits.MaximumArticles <= 0 || limits.MaximumTaxonomyRows <= 0 || limits.MaximumMetadataBytes <= 0
            || readBudget <= TimeSpan.Zero || readBudget.TotalMilliseconds > uint.MaxValue - 1)
            throw new ArgumentOutOfRangeException(nameof(readBudget), "Finite source limits and read budget are required.");
    }

    internal static void RequireReadInputs(CurrentSchemaArtifactReference originArtifact, Uri documentBase)
    {
        if (originArtifact is null || string.IsNullOrWhiteSpace(originArtifact.Reference)
            || !ArticlePreservationSemanticReceipt.IsDigest(originArtifact.Sha256)
            || documentBase is null || !documentBase.IsAbsoluteUri)
            throw new InvalidOperationException("article_preservation_source_origin_required");
    }

    private static async Task<ImmutableArray<LegacyArticlePreservationTaxonomy>> ReadTaxonomyAsync(
        string table, CurrentSchemaProviderKind provider, DbConnection connection, DbTransaction transaction,
        ReadBudget budget, TimeSpan readBudget, CancellationToken cancellationToken)
    {
        var rows = ImmutableArray.CreateBuilder<LegacyArticlePreservationTaxonomy>();
        await using DbCommand command = Command(connection, transaction, readBudget,
            $"SELECT id,name FROM {Table(provider, table)} ORDER BY id");
        await using DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            budget.Taxonomy();
            int id = reader.GetInt32(0);
            string name = await budget.TextAsync(reader, 1, cancellationToken).ConfigureAwait(false)
                ?? throw new InvalidOperationException("article_preservation_taxonomy_name_missing");
            rows.Add(new(id, name));
        }
        return rows.ToImmutable();
    }

    private static DbCommand Command(DbConnection connection, DbTransaction transaction, TimeSpan budget, string sql)
    {
        DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = checked((int)Math.Ceiling(budget.TotalSeconds));
        command.CommandText = sql;
        return command;
    }

    private static string Table(CurrentSchemaProviderKind provider, string name)
        => provider == CurrentSchemaProviderKind.PostgreSql ? $"\"public\".{Quote(provider, name)}" : Quote(provider, name);
    private static string Quote(CurrentSchemaProviderKind provider, string name)
        => provider == CurrentSchemaProviderKind.MySql ? $"`{name}`" : $"\"{name}\"";

    private sealed class ReadBudget(ArticlePreservationLimits limits)
    {
        private int _articles;
        private int _taxonomy;
        private long _bytes;
        internal void Article()
        {
            if (++_articles > limits.MaximumArticles)
                throw new InvalidOperationException("article_preservation_source_article_budget");
        }
        internal void Taxonomy()
        {
            if (++_taxonomy > limits.MaximumTaxonomyRows)
                throw new InvalidOperationException("article_preservation_source_taxonomy_budget");
        }
        internal void Relation() => Charge(8);
        private void Charge(long bytes)
        {
            _bytes = checked(_bytes + bytes);
            if (_bytes > limits.MaximumMetadataBytes)
                throw new InvalidOperationException("article_preservation_source_byte_budget");
        }
        internal async Task<string?> TextAsync(DbDataReader reader, int ordinal, CancellationToken cancellationToken)
        {
            if (await reader.IsDBNullAsync(ordinal, cancellationToken).ConfigureAwait(false))
                return null;
            using TextReader text = reader.GetTextReader(ordinal);
            var result = new StringBuilder();
            char[] buffer = new char[4096];
            while (true)
            {
                int read = await text.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                    break;
                if ((long)result.Length + read > limits.MaximumMetadataBytes - _bytes)
                    throw new InvalidOperationException("article_preservation_source_byte_budget");
                result.Append(buffer, 0, read);
            }
            string value = result.ToString();
            Charge(s_utf8.GetByteCount(value));
            return value;
        }
    }
}
