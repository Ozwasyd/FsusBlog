using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Partial relevance facts from indexed tokens, without a fresh permission grant or product rank.</summary>
public sealed record AuthorSearchTokenCandidate(
    AuthorSearchDocument Document, ImmutableArray<AuthorSearchSourceRange> Ranges,
    int PhraseClauses, int MatchedRanges, int FieldWeight);

/// <summary>
/// Internal bounded query-stage evidence. Candidates are unadmitted index facts, not
/// a response, total, facet, snippet, receipt, or permission-safe selection target.
/// The instance identity is retained from the request snapshot across every await;
/// a replacement writer cannot rebind evidence by reusing its local generation.
/// The remaining ranking factors require their original current-source authorities.
/// </summary>
public sealed record AuthorSearchTokenEvaluation(
    string QueryDigest, Guid IndexInstanceId, long IndexGeneration, long SourceGeneration, string SnapshotDigest,
    ImmutableArray<AuthorSearchTokenCandidate> Candidates);

/// <summary>
/// Executes the existing closed AST against the sole index's actual immutable read API.
/// It owns no source/index producer, substitute tokenizer, raw corpus or permission
/// authority. Transport must not expose its output before current permission/source
/// revalidation and complete ranking/snippet/result admission are implemented.
/// </summary>
public sealed partial class AuthorFullTextSearchQueryEvaluator(AuthorFullTextSearchIndex index)
{
    /// <summary>
    /// Computes bounded token candidates after the canonical AST predicates. Indexed
    /// Allowed facts are never a fresh grant; this does not return an admitted result.
    /// Date predicates and pagination remain unavailable without complete current facts.
    /// Cancellation and an index reread reject work on a superseded source snapshot.
    /// Property token fields additionally revalidate their canonical typed binding and
    /// supplied definitions before and after the final await. This grants no fresh access.
    /// </summary>
    internal Task<AuthorSearchTokenEvaluation> InspectIndexAsync(
        AuthorSearchQuery query, IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        CancellationToken cancellationToken = default)
        => InspectIndexCoreAsync(query, definitions, null, cancellationToken);

    private async Task<AuthorSearchTokenEvaluation> InspectIndexCoreAsync(
        AuthorSearchQuery query, IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        CurrentPermissionFence? permissionFence, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AuthorFullTextSearchContract.ValidateQuery(query, definitions);
        ValidatePropertyPredicates(query, definitions);
        if (query.Cursor is not null)
        {
            throw new AuthorSearchContractException("author_search_complete_ranking_cursor_unavailable");
        }
        if (query.Clauses.Any(static clause => clause.Kind == AuthorSearchClauseKind.Date))
        {
            throw new AuthorSearchContractException("author_search_current_updated_at_unavailable");
        }
        // Every read uses the immutable request identity, including the final reread.
        // Reading index.IndexInstanceId here would silently rebind an old request.
        AuthorSearchRegistrySnapshot registry = AuthorFullTextSearchVerifier.CaptureRegistry();
        AuthorSearchIndexReadSnapshot snapshot = await index.ReadSnapshotAsync(query.UserId,
            query.SiteScope, query.IndexInstanceId, query.IndexGeneration, cancellationToken).ConfigureAwait(false);
        if (snapshot.RegistryDigest != registry.ContentDigest)
        {
            throw new AuthorSearchContractException("author_search_registry_tampered_or_stale");
        }
        if (permissionFence is not null)
        {
            await permissionFence.BindAsync(snapshot, cancellationToken).ConfigureAwait(false);
            permissionFence.RequireIndexCurrent(index);
        }
        AuthorFullTextSearchContract.ValidateQuery(query, definitions);
        ValidatePropertyPredicates(query, definitions);
        ImmutableArray<CompiledClause> clauses = Compile(query.Clauses);
        var candidates = new List<AuthorSearchTokenCandidate>();
        foreach (AuthorSearchIndexedArticle article in snapshot.Articles.Values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (permissionFence is not null && !permissionFence.Allows(article) || article.Deleted)
            {
                continue;
            }
            foreach (AuthorSearchTokenizedDocument tokenized in article.Documents)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ValidateIndexedFacts(tokenized, query, article.ArticleId, snapshot.RegistryDigest);
                ValidatePropertyDocument(tokenized.Document, article, definitions);
            }
            if (!SystemFiltersMatch(article, query.Clauses)
                || !PropertyPredicatesMatch(article, query, definitions))
            {
                continue;
            }
            var hits = new Dictionary<AuthorSearchTokenizedDocument, DocumentHits>();
            bool matches = true;
            foreach (CompiledClause clause in clauses)
            {
                bool clauseMatched = false;
                foreach (AuthorSearchTokenizedDocument document in article.Documents)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (clause.Field.HasValue && document.Document.Field.Kind != clause.Field.Value)
                    {
                        continue;
                    }
                    ImmutableArray<AuthorSearchSourceRange> ranges = Match(document.Tokens, clause, cancellationToken);
                    if (ranges.IsEmpty)
                    {
                        continue;
                    }
                    clauseMatched = true;
                    if (!hits.TryGetValue(document, out DocumentHits? collected))
                    {
                        if (hits.Count >= 512)
                        {
                            throw new AuthorSearchContractException("author_search_matching_field_budget_exceeded");
                        }
                        hits.Add(document, collected = new());
                    }
                    collected.Ranges.UnionWith(ranges);
                    if (collected.Ranges.Count > AuthorFullTextSearchContract.MaxHighlights)
                    {
                        throw new AuthorSearchContractException("author_search_highlight_budget_exceeded");
                    }
                    if (clause.Phrase)
                    {
                        collected.PhraseClauses++;
                    }
                }
                if (!clauseMatched)
                {
                    matches = false;
                    break;
                }
            }
            if (!matches)
            {
                continue;
            }
            foreach ((AuthorSearchTokenizedDocument document, DocumentHits hitsForDocument) in hits)
            {
                ImmutableArray<AuthorSearchSourceRange> ordered = [.. hitsForDocument.Ranges
                    .OrderBy(static range => range.Utf16Start).ThenBy(static range => range.Utf16End)];
                if (ordered.Length > AuthorFullTextSearchContract.MaxHighlights)
                {
                    throw new AuthorSearchContractException("author_search_highlight_budget_exceeded");
                }
                candidates.Add(new(document.Document, ordered,
                    hitsForDocument.PhraseClauses, ordered.Length,
                    registry.FieldWeights.Single(pair => pair.Key == document.Document.Field.Kind).Value));
            }
            // Keep only one page of partial relevance facts; do not retain the corpus of hits.
            candidates = Order(candidates).Take(query.PageSize).ToList();
        }
        cancellationToken.ThrowIfCancellationRequested();
        AuthorSearchIndexReadSnapshot current = await index.ReadSnapshotAsync(query.UserId,
            query.SiteScope, query.IndexInstanceId, query.IndexGeneration, cancellationToken).ConfigureAwait(false);
        if (permissionFence is not null)
        {
            await permissionFence.CheckAsync(cancellationToken).ConfigureAwait(false);
            permissionFence.RequireIndexCurrent(index);
        }
        if (current.IndexInstanceId != snapshot.IndexInstanceId
            || current.SourceGeneration != snapshot.SourceGeneration
            || current.RegistryDigest != snapshot.RegistryDigest
            || !ReferenceEquals(current.Articles, snapshot.Articles))
        {
            throw new AuthorSearchContractException("author_search_index_source_snapshot_stale");
        }
        AuthorFullTextSearchContract.ValidateQuery(query, definitions);
        ValidatePropertyPredicates(query, definitions);
        // Definitions are supplied through a potentially changing collection. Recheck
        // canonical property bindings after the final actual index await as well.
        foreach (AuthorSearchIndexedArticle article in current.Articles.Values)
        {
            if (permissionFence is not null && !permissionFence.Allows(article))
            {
                continue;
            }
            foreach (AuthorSearchTokenizedDocument document in article.Documents)
            {
                cancellationToken.ThrowIfCancellationRequested();
                ValidatePropertyDocument(document.Document, article, definitions);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return new(query.ContentDigest, snapshot.IndexInstanceId, snapshot.IndexGeneration, snapshot.SourceGeneration, SnapshotDigest(snapshot, cancellationToken),
            [.. Order(candidates)]);
    }

    /// <summary>Rejects reuse after any indexed source change; it grants no current permission or result admission.</summary>
    public async Task RevalidateIndexAsync(
        AuthorSearchQuery query, AuthorSearchTokenEvaluation evaluation, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (query.SchemaVersion != AuthorFullTextSearchContract.QuerySchemaVersion
            || query.Schema != AuthorFullTextSearchContract.QuerySchema
            || query.ContentDigest != AuthorFullTextSearchContract.SealQuery(query).ContentDigest
            || evaluation.QueryDigest != query.ContentDigest || evaluation.IndexInstanceId != query.IndexInstanceId
            || evaluation.IndexInstanceId == Guid.Empty || evaluation.IndexGeneration != query.IndexGeneration)
        {
            throw new AuthorSearchContractException("author_search_query_evaluation_stale");
        }
        AuthorSearchIndexReadSnapshot current = await index.ReadSnapshotAsync(query.UserId,
            query.SiteScope, query.IndexInstanceId, query.IndexGeneration, cancellationToken).ConfigureAwait(false);
        if (evaluation.IndexInstanceId != current.IndexInstanceId
            || evaluation.SourceGeneration != current.SourceGeneration
            || evaluation.SnapshotDigest != SnapshotDigest(current, cancellationToken))
        {
            throw new AuthorSearchContractException("author_search_index_source_snapshot_stale");
        }
        cancellationToken.ThrowIfCancellationRequested();
    }

    /// <summary>
    /// Recomputes parity through the original bounded index-source port and verifier.
    /// This requires its real adapter; fixture parity is not production permission,
    /// parse-package, durability or snippet admission. Index changes reject the stage.
    /// </summary>
    public async Task RevalidateSourceAsync(
        AuthorSearchQuery query, AuthorSearchTokenEvaluation evaluation,
        IAuthorFullTextSearchIndexSource source, CancellationToken cancellationToken = default)
    {
        await RevalidateIndexAsync(query, evaluation, cancellationToken).ConfigureAwait(false);
        AuthorSearchIndexReadSnapshot snapshot = await index.ReadSnapshotAsync(query.UserId,
            query.SiteScope, query.IndexInstanceId, query.IndexGeneration, cancellationToken).ConfigureAwait(false);
        await AuthorFullTextSearchIndexVerifier.VerifyAsync(snapshot, source, cancellationToken).ConfigureAwait(false);
        await RevalidateIndexAsync(query, evaluation, cancellationToken).ConfigureAwait(false);
    }

    private static string SnapshotDigest(AuthorSearchIndexReadSnapshot snapshot, CancellationToken cancellationToken)
    {
        var facts = new StringBuilder(snapshot.RegistryDigest);
        foreach (AuthorSearchIndexedArticle article in snapshot.Articles.Values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            facts.Append('|').Append(article.ArticleId.ToString(CultureInfo.InvariantCulture))
                .Append(':').Append(article.SourceSequence.ToString(CultureInfo.InvariantCulture))
                .Append(':').Append(article.Deleted ? '1' : '0');
            if (article.PropertyCoordinates is not null || article.PropertySnapshotDigest is not null)
            {
                facts.Append('|').Append(article.PropertySnapshotDigest)
                    .Append(':').Append(JsonSerializer.Serialize(article.PropertyCoordinates));
            }
            foreach (AuthorSearchTokenizedDocument document in article.Documents)
            {
                cancellationToken.ThrowIfCancellationRequested();
                facts.Append('|').Append(document.ContentDigest);
            }
        }
        return AuthorFullTextSearchContract.Digest(facts.ToString());
    }

    private static IOrderedEnumerable<AuthorSearchTokenCandidate> Order(IEnumerable<AuthorSearchTokenCandidate> candidates)
        => candidates.OrderByDescending(static candidate => candidate.PhraseClauses)
            .ThenByDescending(static candidate => candidate.MatchedRanges)
            .ThenByDescending(static candidate => candidate.FieldWeight)
            .ThenBy(static candidate => candidate.Document.Identity.SiteScope, StringComparer.Ordinal)
            .ThenBy(static candidate => candidate.Document.Identity.ArticleId)
            .ThenBy(static candidate => candidate.Document.Field.Kind)
            .ThenBy(static candidate => candidate.Ranges[0].Utf16Start);

    private static ImmutableArray<CompiledClause> Compile(ImmutableArray<AuthorSearchClause> clauses)
    {
        var compiled = ImmutableArray.CreateBuilder<CompiledClause>();
        foreach (AuthorSearchClause clause in clauses.Where(static clause => clause.Kind is
            AuthorSearchClauseKind.PlainText or AuthorSearchClauseKind.QuotedPhrase
            or AuthorSearchClauseKind.FieldText or AuthorSearchClauseKind.FieldPhrase))
        {
            string text = clause.Values[0];
            ImmutableArray<string> terms = AuthorFullTextSearchTokenizer.TokenizeQueryValue(text);
            if (terms.IsEmpty)
            {
                throw new AuthorSearchContractException("author_search_query_has_no_searchable_tokens");
            }
            compiled.Add(new(clause.Field,
                clause.Kind is AuthorSearchClauseKind.QuotedPhrase or AuthorSearchClauseKind.FieldPhrase,
                terms));
        }
        if (compiled.Count == 0)
        {
            throw new AuthorSearchContractException("author_search_filter_only_query_unavailable");
        }
        return compiled.ToImmutable();
    }

    private static ImmutableArray<AuthorSearchSourceRange> Match(
        ImmutableArray<AuthorSearchToken> tokens, CompiledClause clause, CancellationToken cancellationToken)
    {
        var ranges = ImmutableArray.CreateBuilder<AuthorSearchSourceRange>();
        var termsFound = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < tokens.Length; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (clause.Phrase)
            {
                if (i + clause.Terms.Length > tokens.Length)
                {
                    break;
                }
                bool phraseMatches = true;
                for (int j = 0; j < clause.Terms.Length; j++)
                {
                    if (tokens[i + j].Term != clause.Terms[j]
                        || tokens[i + j].Position != tokens[i].Position + j)
                    {
                        phraseMatches = false;
                        break;
                    }
                }
                if (phraseMatches)
                {
                    ranges.Add(tokens[i].Source with
                    {
                        Utf16End = tokens[i + clause.Terms.Length - 1].Source.Utf16End,
                        Utf8End = tokens[i + clause.Terms.Length - 1].Source.Utf8End
                    });
                }
            }
            else if (clause.Terms.Contains(tokens[i].Term, StringComparer.Ordinal))
            {
                termsFound.Add(tokens[i].Term);
                ranges.Add(tokens[i].Source);
            }
            if (ranges.Count > AuthorFullTextSearchContract.MaxHighlights)
            {
                throw new AuthorSearchContractException("author_search_highlight_budget_exceeded");
            }
        }
        return clause.Phrase || clause.Terms.All(termsFound.Contains) ? ranges.ToImmutable() : [];
    }

    private static ArticlePropertyDefinition PropertyDefinition(
        AuthorSearchClause clause, IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions)
    {
        if (!definitions.TryGetValue(clause.PropertyDefinitionId!.Value, out var definition) || definition is null)
        {
            throw new AuthorSearchContractException("author_search_property_unknown");
        }
        // Reuse query validation for owner/eligibility/schema checks at every await
        // boundary; the value owner independently checks the exact entry digest.
        return definition;
    }

    private static void ValidatePropertyPredicates(
        AuthorSearchQuery query, IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions)
    {
        foreach (AuthorSearchClause clause in query.Clauses.Where(static clause => clause.Kind == AuthorSearchClauseKind.Property))
        {
            AuthorFullTextSearchContract.ValidatePropertyPredicate(clause.PropertyOperand!, PropertyDefinition(clause, definitions));
        }
    }

    private static bool PropertyPredicatesMatch(
        AuthorSearchIndexedArticle article, AuthorSearchQuery query,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions)
    {
        foreach (AuthorSearchClause clause in query.Clauses.Where(static clause => clause.Kind == AuthorSearchClauseKind.Property))
        {
            if (article.PropertyCoordinates is null || article.PropertySnapshotDigest is null
                || !article.PropertyValues.TryGetValue(clause.PropertyDefinitionId!.Value, out var value))
            {
                // An absent indexed entry is unavailable input, not canonical Missing.
                throw new AuthorSearchContractException("author_search_property_snapshot_unavailable");
            }
            if (!AuthorSearchPropertyValueProjection.Matches(PropertyDefinition(clause, definitions), value, clause.PropertyOperand!))
            {
                return false;
            }
        }
        return true;
    }

    private static bool SystemFiltersMatch(AuthorSearchIndexedArticle article, ImmutableArray<AuthorSearchClause> clauses)
    {
        foreach (AuthorSearchClause clause in clauses)
        {
            if (clause.Kind == AuthorSearchClauseKind.Status && !article.Documents.Any(document =>
                clause.Values.Contains(document.Document.Identity.Status.ToString().ToLowerInvariant(), StringComparer.Ordinal)))
            {
                return false;
            }
            if (clause.Kind is AuthorSearchClauseKind.Category or AuthorSearchClauseKind.Tag)
            {
                AuthorSearchFieldKind kind = clause.Kind == AuthorSearchClauseKind.Category
                    ? AuthorSearchFieldKind.Category : AuthorSearchFieldKind.Tag;
                if (!article.Documents.Any(document => document.Document.Field.Kind == kind
                    && document.Document.Field.TaxonomyId.HasValue
                    && clause.Values.Contains(document.Document.Field.TaxonomyId.Value.ToString(CultureInfo.InvariantCulture))))
                {
                    return false;
                }
            }
        }
        return true;
    }

    private static void ValidatePropertyDocument(
        AuthorSearchDocument document, AuthorSearchIndexedArticle article,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions)
    {
        if (document.Field.Kind != AuthorSearchFieldKind.Property)
        {
            return;
        }
        if (!document.Field.PropertyDefinitionId.HasValue
            || !article.PropertyValues.TryGetValue(document.Field.PropertyDefinitionId.Value, out var value)
            || !definitions.TryGetValue(document.Field.PropertyDefinitionId.Value, out var definition)
            || definition is null || article.PropertyCoordinates is null || article.PropertySnapshotDigest is null
            || document.Field.DefinitionDigest != value.Entry.DefinitionDigest
            || document.Field.PropertyValueDigest != value.Entry.ValueDigest)
        {
            throw new AuthorSearchContractException("author_search_property_field_binding_invalid");
        }
        // Reuse the sole canonical entry/definition policy and string payloads.
        // This is indexed evidence revalidation, never fresh permission/parse admission.
        if (AuthorSearchPropertyValueProjection.Project(definition, value.Entry) != value)
        {
            throw new AuthorSearchContractException("author_search_property_projection_stale");
        }
        string raw = value.Entry.Value switch
        {
            ArticlePropertyTextValue text => text.Text,
            ArticlePropertyUrlValue url => url.Url,
            _ => throw new AuthorSearchContractException("author_search_property_field_serialization_unavailable")
        };
        AuthorFullTextSearchContract.ValidateDocument(document, raw, definitions,
            document.Source.ParserVersion, document.Source.DocumentEpoch);
    }

    private static void ValidateIndexedFacts(
        AuthorSearchTokenizedDocument tokenized, AuthorSearchQuery query, int articleId, string registryDigest)
    {
        AuthorSearchDocument document = tokenized.Document;
        AuthorSearchDocumentIdentity identity = document.Identity;
        if (identity.ArticleId != articleId || identity.UserId != query.UserId || identity.SiteScope != query.SiteScope
            || identity.Scope != query.Scope || identity.IndexGeneration != query.IndexGeneration
            || identity.Permission != AuthorSearchPermissionState.Allowed
            || identity.PermissionRevision != query.PermissionRevision
            || identity.PermissionPolicyDigest != query.PermissionPolicyDigest
            || tokenized.RegistryDigest != registryDigest
            || tokenized.ContentDigest != AuthorFullTextSearchVerifier.SealTokenDocument(tokenized).ContentDigest)
        {
            throw new AuthorSearchContractException("author_search_indexed_facts_stale_or_invalid");
        }
    }

    private sealed record CompiledClause(AuthorSearchFieldKind? Field, bool Phrase, ImmutableArray<string> Terms);

    private sealed class DocumentHits
    {
        public HashSet<AuthorSearchSourceRange> Ranges { get; } = [];
        public int PhraseClauses
        {
            get; set;
        }
    }
}
