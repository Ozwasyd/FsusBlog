using System.Collections.Frozen;
using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using FsusBlogV2.Storage;
using Microsoft.Net.Http.Headers;
using Npgsql;

namespace FsusBlog.V2.Server;

internal sealed class PublicSnapshot
{
    private static readonly byte[] SearchProfileDomain =
        Encoding.ASCII.GetBytes(FormattableString.Invariant($"public-search-bm25-v{WireLimits.SearchFas4Profile}\0"));
    private readonly byte[][] _index;
    private readonly LocalSearchCorpusSnapshot? _corpus;
    private readonly EntityTagHeaderValue[] _corpusTags;
    private readonly CorpusDelta? _corpusDelta;
    private readonly FrozenDictionary<int, Article> _byId;
    private readonly PublicArticleCache _details;
    private readonly PublicListProjection _listing;
    private readonly ArticleSearchIndex? _search;
    private readonly PublishedMediaProjection? _media;
    internal long Generation { get; }
    internal string GenerationHeader { get; }
    internal long Watermark { get; }
    internal long TaxonomyEpoch { get; }
    internal long SiteConfigRevision { get; }
    internal int SitePagesMask { get; }
    internal byte[] Home { get; }
    internal byte[] EnglishHome { get; }
    internal TaxonomyProjection Taxonomy { get; }
    internal RelatedReadingProjection RelatedReading { get; }
    internal DistributionSnapshot? Distribution { get; }
    internal int IndexPageCount => _index.Length;
    internal int CorpusPageCount => _corpus?.Pages.Count ?? 0;
    internal int ReusedCorpusPageCount => _corpus?.ReusedPageCount ?? 0;
    internal int PublicArticleCount => _byId.Count;
    internal IReadOnlyList<Article> WideSearchArticles => _byId.Values;

    internal PublicSnapshot(long watermark, IReadOnlyList<Article> articles, TaxonomyRows taxonomy, WebPages pages, PublicListCursor cursor,
        PublicSnapshot? previous, ILogger log, RuntimeEvidence? evidence, DistributionSettings? distribution, CancellationToken cancellationToken,
        long taxonomyEpoch = 0, PublishedMediaProjection? media = null, long siteConfigRevision = 0, int sitePagesMask = 0)
    {
        Watermark = watermark;
        TaxonomyEpoch = taxonomyEpoch;
        SiteConfigRevision = siteConfigRevision;
        SitePagesMask = sitePagesMask;
        _corpus = LocalSearchCorpus.BuildSnapshot(articles, previous?._corpus, cancellationToken);
        _corpusTags = _corpus is null ? [] : CorpusTags(_corpus, previous, cancellationToken);
        _search = ArticleSearchIndex.Build(articles, cancellationToken);
        Generation = PublicGeneration(articles, taxonomyEpoch, _corpus?.Pages, _search?.UsesWideProfile is true, cancellationToken);
        GenerationHeader = Generation.ToString(CultureInfo.InvariantCulture);
        Taxonomy = new TaxonomyProjection(taxonomy, articles, pages);
        RelatedReading = new RelatedReadingProjection(articles, cancellationToken);
        _byId = articles.ToFrozenDictionary(article => article.Id);
        _corpusDelta = BuildCorpusDelta(previous, cancellationToken);
        _media = media;
        _details = new PublicArticleCache(_byId, pages, Generation, log, evidence, media, siteConfigRevision);
        _details.Warm(articles.Take(1200), previous?._details, cancellationToken);
        _listing = new PublicListProjection(Generation, articles, cursor);
        var first = articles.Take(10).ToArray();
        Home = pages.PublicPage(HomeContent(first, SiteLocale.Default), publicPath: "/");
        EnglishHome = pages.PublicPage(HomeContent(first, "en"), publicPath: "/", locale: "en");
        _index = articles.Count == 0 ? [PublicArticles.EncodeSearch([], 0)] : articles.Chunk(WireLimits.SearchIndexPageSize)
            .Select(part => PublicArticles.EncodeSearch(part, part.Length)).ToArray();
        Distribution = DistributionSnapshot.Build(distribution, articles, cancellationToken);
    }

    private static string HomeContent(IReadOnlyList<Article> articles, string locale)
    {
        var html = new StringBuilder($"<section class=\"reading-column editorial-page\"><h1 class=\"visually-hidden\">{SiteLocale.Html(locale, "reading.latestPosts")}</h1>");
        if (articles.Count == 0)
            html.Append($"<p class=\"muted\">{SiteLocale.Html(locale, "page.emptyArticles")}</p>");
        else
        {
            html.Append("<ol class=\"article-list\">");
            foreach (var article in articles)
            {
                html.Append($"<li><article><h2><a href=\"/article/{article.Id.ToString(CultureInfo.InvariantCulture)}\">{HtmlEncoder.Default.Encode(article.Title)}</a></h2><div class=\"article-taxonomy metadata\">");
                if (article.PublishedAt.ToUnixTimeMilliseconds() != 0)
                {
                    var date = article.PublishedAt.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                    html.Append($"<time datetime=\"{date}\">{date}</time>");
                }
                if (article.Category is { Id: > 0 } category)
                    html.Append($"<a href=\"/category/{category.Id.ToString(CultureInfo.InvariantCulture)}\">{HtmlEncoder.Default.Encode(category.Name)}</a>");
                foreach (var tag in article.Tags ?? [])
                    html.Append($"<a href=\"/tag/{tag.Id.ToString(CultureInfo.InvariantCulture)}\">#{HtmlEncoder.Default.Encode(tag.Name)}</a>");
                html.Append("</div>");
                if (!string.IsNullOrEmpty(article.Summary))
                    html.Append($"<p>{HtmlEncoder.Default.Encode(article.Summary)}</p>");
                html.Append("</article></li>");
            }
            html.Append("</ol>");
        }
        return html.Append("</section>").ToString();
    }

    internal Article? Article(int id) => _byId.GetValueOrDefault(id);

    internal bool HasArticle(int id) => _byId.ContainsKey(id);

    internal bool HasPublishedImages(int id) => _media?.HasImages(id) is true;

    internal IReadOnlyList<PublishedArticleImage>? PublishedImages(int id, long publication) =>
        _byId.TryGetValue(id, out var article) && article.Publication == publication
            ? _media?.Images(id, publication) ?? [] : null;

    internal ValueTask<PublicArticleBytes?> Detail(int id, CancellationToken ct) => _details.Read(id, ct);

    internal byte[]? Index(int page) => page > 0 && page <= _index.Length ? _index[page - 1] : null;

    internal byte[]? Corpus(int page) => _corpus is not null && page > 0 && page <= _corpus.Pages.Count ? _corpus.Pages[page - 1] : null;

    internal EntityTagHeaderValue CorpusTag(int page) => _corpusTags[page - 1];

    internal byte[]? CorpusPatch(int page, string baseGeneration, string? baseTag) =>
        _corpusDelta is { } delta && delta.Page == page && delta.BaseGeneration == baseGeneration &&
        delta.BaseTag == baseTag ? delta.Bytes : null;

    internal byte[] List(string scope, int page, int size, string? keyword, string? sort, string? cursor,
        CancellationToken ct, Func<Article, bool>? filter = null) =>
        _listing.Read(PublicListQuery.Parse(scope, page, size, keyword, sort, cursor), ct, filter);

    internal byte[]? Search(string keyword, CancellationToken ct) =>
        SearchPage(keyword, ArticleSearchSort.Relevance, 1, 200, ct)?.Bytes;

    internal (byte[] Bytes, int Total)? SearchPage(string keyword, ArticleSearchSort sort, int page, int size,
        CancellationToken ct)
    {
        if (_search is null) return null;
        var matching = _search.SearchPage(keyword, sort, page, size, ct);
        return (PublicArticles.EncodeSearch(matching.Articles, matching.Articles.Length), matching.Total);
    }

    private static EntityTagHeaderValue[] CorpusTags(LocalSearchCorpusSnapshot corpus, PublicSnapshot? previous, CancellationToken ct)
    {
        var pages = corpus.Pages;
        var priorPages = previous?._corpus?.Pages;
        var tags = new EntityTagHeaderValue[pages.Count];
        for (var index = 0; index < tags.Length; index++)
        {
            ct.ThrowIfCancellationRequested();
            var reusedFrom = corpus.ReusedFromPageIndex(index);
            if (reusedFrom >= 0 && previous is not null && priorPages is not null &&
                reusedFrom < priorPages.Count && reusedFrom < previous._corpusTags.Length &&
                ReferenceEquals(pages[index], priorPages[reusedFrom]))
            {
                tags[index] = previous._corpusTags[reusedFrom];
                continue;
            }
            tags[index] = new($"\"{Convert.ToHexStringLower(SHA256.HashData(pages[index]))}\"");
        }
        return tags;
    }

    private CorpusDelta? BuildCorpusDelta(PublicSnapshot? previous, CancellationToken ct)
    {
        if (previous?._corpus?.Pages is not { } basis || _corpus?.Pages is not { } target || previous.Generation == Generation ||
            previous.PublicArticleCount != PublicArticleCount || basis.Count != target.Count || target.Count < 2 ||
            !previous._corpusTags[0].Equals(_corpusTags[0])) return null;

        var changed = -1;
        for (var index = 1; index < target.Count; index++)
        {
            ct.ThrowIfCancellationRequested();
            if (previous._corpusTags[index].Equals(_corpusTags[index])) continue;
            if (changed >= 0) return null;
            changed = index;
        }
        if (changed < 0) return null;

        var baseTag = previous._corpusTags[changed].Tag.ToString();
        var targetTag = _corpusTags[changed].Tag.ToString();
        var bytes = SearchCorpusPatch.TryCreate(previous.Generation, Generation, changed + 1, basis[changed], target[changed],
            Convert.FromHexString(baseTag[1..^1]), Convert.FromHexString(targetTag[1..^1]), ct);
        return bytes is null ? null : new CorpusDelta(changed + 1, previous.GenerationHeader, baseTag, bytes);
    }

    private sealed record CorpusDelta(int Page, string BaseGeneration, string BaseTag, byte[] Bytes);

    private static long PublicGeneration(IReadOnlyList<Article> articles, long taxonomyEpoch,
        IReadOnlyList<byte[]>? corpus, bool wideSearch, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> coordinates = stackalloc byte[20];
        // One coordinate covers every HTTP representation. A restart with unchanged
        // article rows still cannot serve changed corpus bytes at the old coordinate.
        hash.AppendData("public-generation-corpus-v1\0"u8);
        hash.AppendData(SearchProfileDomain);
        if (wideSearch) hash.AppendData("public-search-bm25-wide-v1\0"u8);
        AppendNumber(corpus?.Count ?? -1);
        if (corpus is not null)
        {
            foreach (var page in corpus)
            {
                ct.ThrowIfCancellationRequested();
                AppendNumber(page.Length);
                hash.AppendData(page);
            }
        }
        AppendNumber(articles.Count);
        foreach (var article in articles)
        {
            ct.ThrowIfCancellationRequested();
            BinaryPrimitives.WriteInt32LittleEndian(coordinates, article.Id);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates[4..], article.Revision);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates[12..], article.Publication);
            hash.AppendData(coordinates);
            TaxonomyProjection.AppendGeneration(hash, article);
            if (article.CoverMediaDigest is { } cover)
            {
                hash.AppendData("public-cover-v1\0"u8);
                hash.AppendData(Convert.FromHexString(cover));
            }
        }
        if (taxonomyEpoch != 0)
        {
            hash.AppendData("taxonomy-epoch-v1"u8);
            BinaryPrimitives.WriteInt64LittleEndian(coordinates, taxonomyEpoch);
            hash.AppendData(coordinates[..sizeof(long)]);
        }
        return BinaryPrimitives.ReadInt64LittleEndian(hash.GetHashAndReset()) & long.MaxValue;

        void AppendNumber(int value)
        {
            Span<byte> number = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32LittleEndian(number, value);
            hash.AppendData(number);
        }
    }
}

internal sealed class Publications(NpgsqlDataSource db, WebPages pages, ILogger<Publications> log, InstanceLease? lease = null,
    RuntimeEvidence? evidence = null, DistributionSettings? distribution = null, PublishedMediaStore? media = null,
    PublicProjection? projection = null, bool siteConfigOverrideActive = false, SitePages? sitePages = null)
{
    private readonly SemaphoreSlim _writers = new(1, 1);
    private readonly PublicListCursor _listCursor = new(TimeProvider.System);
    private readonly PublicProjection _projection = projection ?? new();
    private PublicSnapshot? _lastProjection;
    private bool? _taxonomyEpochInstalled;
    private bool? _siteConfigOverrideInstalled;
    internal PublicSnapshot? Snapshot => lease?.IsCurrent is false ? null : _projection.Current?.Source;
    internal bool LeaseCurrent => lease?.IsCurrent is not false;

    internal async Task<(ArticleState Article, bool Changed)> Command(Store store, string? token,
        ArticleAction action, Edit edit, CancellationToken ct, string? expectedSession = null,
        ArticleBodyInsertionCommand? insertion = null, ArticleBodyInsertionsCommand? insertions = null,
        ArticleBodyEditsCommand? bodyEdits = null) =>
        await Change(action is ArticleAction.Publish or ArticleAction.Retract or ArticleAction.Delete,
            invalidate => store.WithSession(token, true, async (connection, tx, actor) =>
            {
                if (insertion is null && insertions is null && bodyEdits is null)
                    FsusBlog.V2.Server.Sessions.SiteSessions.IfCurrent(actor.Id, token, expectedSession);
                else FsusBlog.V2.Server.Sessions.SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedSession);
                var update = bodyEdits is not null ? await Store.SaveBodyEdits(connection, tx, actor, edit, bodyEdits, ct) :
                    insertions is not null ? await Store.SaveBodyInsertions(connection, tx, actor, edit, insertions, ct) :
                    insertion is not null ? await Store.SaveBodyInsertion(connection, tx, actor, edit, insertion, ct) :
                    await Store.Execute(connection, tx, actor, action, edit, ct);
                if (insertions is not null || bodyEdits is not null)
                    FsusBlog.V2.Server.Sessions.SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedSession);
                if (update.Changed) invalidate();
                return update;
            }, ct), ct);

    internal Task Attest(Func<Task> mint, CancellationToken ct) => Change(invalidate: false, async _ =>
    {
        await mint();
        return true;
    }, ct);

    internal Task<T> AdministrativePublication<T>(Func<Action, Task<T>> transact, CancellationToken ct) =>
        Change(invalidate: true, transact, ct);

    internal Task<(ArticleState Article, bool Changed)> PublishWithImages(Store store, string? token, string? expectedSession,
        PublishedMediaStore media, int articleId, long expectedRevision, Guid commandKey, IReadOnlyList<Guid> assetIds,
        CancellationToken ct)
    {
        var edit = Publishing.Validate(ArticleAction.Publish, new(articleId, expectedRevision, commandKey, "", ""));
        var selection = PublishedMediaSelection.Create(assetIds);
        return Change(invalidate: true, invalidate => store.WithSession(token, true, async (connection, tx, actor) =>
        {
            FsusBlog.V2.Server.Sessions.SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expectedSession);
            var result = await Store.PublishWithImages(connection, tx, actor, edit, media, selection, ct);
            if (result.Changed) invalidate();
            return result;
        }, ct), ct);
    }

    private async Task<T> Change<T>(bool invalidate, Func<Action, Task<T>> transact, CancellationToken ct)
    {
        lease?.RequireCurrent();
        if (!await _writers.WaitAsync(TimeSpan.FromSeconds(5), ct)) throw new PublicUnavailableException();
        try
        {
            lease?.RequireCurrent();
            var result = await transact(() =>
            {
                // After an ambiguous commit or interruption, the old public bytes remain unservable.
                // The worker rebuilds from the committed durable state.
                if (invalidate) _projection.Replace(null);
            });

            if (invalidate && Snapshot is null)
            {
                try { await Rebuild(ct); }
                catch (OperationCanceledException) when (!LeaseCurrent && !ct.IsCancellationRequested)
                {
                    throw new PublicUnavailableException();
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    log.LogError(ex, "The article command committed; public projection awaits durable outbox recovery.");
                    throw new PublicUnavailableException();
                }
            }
            lease?.RequireCurrent();
            return result;
        }
        finally { _writers.Release(); }
    }

    internal async Task Refresh(CancellationToken ct)
    {
        lease?.RequireCurrent();
        await _writers.WaitAsync(ct);
        try
        {
            try { await PublishScheduled(ct); }
            catch (NpgsqlException error) when (LeaseCurrent && !ct.IsCancellationRequested)
            {
                log.LogError(error, "Scheduled publication batch rolled back or awaits outbox recovery.");
            }
            await Rebuild(ct);
        }
        finally { _writers.Release(); }
    }

    private async Task PublishScheduled(CancellationToken ct)
    {
        using var attribution = evidence?.PublicationWork();
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct);
        if (await Authoring.ArticleScheduleStore.PublishDue(connection, tx, ct) != 0)
            _projection.Replace(null);
        await InstanceLease.CommitProtected(tx, lease, ct);
    }

    private async Task Rebuild(CancellationToken ct)
    {
        using var attribution = evidence?.PublicationWork();
        lease?.RequireCurrent();
        using var stop = lease is null ? null : CancellationTokenSource.CreateLinkedTokenSource(ct, lease.Stopped);
        ct = stop?.Token ?? ct;
        await using var connection = await db.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(connection, lease, ct, System.Data.IsolationLevel.RepeatableRead);
        var (maxEvent, taxonomyEpoch, siteConfigRevision, sitePagesMask) = await ReadWatermarks(connection, tx, ct);
        var next = Snapshot;
        var rebuilt = next is null || next.Watermark != maxEvent || next.TaxonomyEpoch != taxonomyEpoch ||
            next.SiteConfigRevision != siteConfigRevision || next.SitePagesMask != sitePagesMask;
        if (rebuilt)
        {
            var taxonomy = await TaxonomyStore.Read(connection, tx, ct);
            var mediaProjection = media is null ? null : await PublishedMediaProjection.Read(connection, tx, ct);
            await using var cmd = Store.Sql(connection, tx, """
                select a.id,r.revision,p.publication_id,r.title,r.body,a.created_at,r.happened_at,p.published_at,
                    p.publication_no, c.id, c.name, tags.ids, tags.names, s.id,
                    w.enabled,w.license_type,w.copyright_holder,w.copyright_year,w.rights_statement,w.attribution_template,
                    w.copy_policy,w.max_excerpt_chars,w.allow_code_copy,w.show_public_badge,w.proof_binding_enabled,r.author_summary
                from public.article_publication p join public.article a on a.id=p.article_id
                join public.article_revision r on r.article_id=p.article_id and r.revision=p.revision
                join public.article_publication_rights s on s.article_id=p.article_id and s.publication_id=p.publication_id and s.revision=p.revision
                join public.article_revision_rights w on w.article_id=s.article_id and w.revision=s.revision
                left join public.article_revision_category link on link.article_id=p.article_id and link.revision=p.revision
                left join public.category c on c.id=link.category_id
                left join lateral (
                    select array_agg(t.id order by t.id) as ids, array_agg(t.name order by t.id) as names
                    from public.article_revision_tag tag_link join public.tag t on t.id=tag_link.tag_id
                    where tag_link.article_id=p.article_id and tag_link.revision=p.revision
                ) tags on true
                where not a.deleted and a.published_revision=p.revision
                order by a.created_at desc, a.id desc
                """);
            await using var row = await cmd.ExecuteReaderAsync(ct);
            var articles = new List<Article>();
            while (await row.ReadAsync(ct))
            {
                var revision = row.GetInt64(1);
                var publication = row.GetInt64(2);
                var id = row.GetInt32(0);
                PublishedArticleRights rights;
                try
                {
                    rights = new(row.GetInt64(13), Authoring.PublicationRightsStore.ReadPolicy(row, 14, id, revision));
                }
                catch (ProtocolException)
                {
                    log.LogWarning("Article {ArticleId} publication {PublicationId} has an invalid immutable rights policy.", id, publication);
                    continue;
                }
                var body = row.GetString(4);
                var limit = Math.Min(body.Length, 200);
                if (limit > 0 && char.IsHighSurrogate(body[limit - 1])) limit--;
                var summary = row.IsDBNull(25) ? body[..limit] : row.GetString(25);
                var category = row.IsDBNull(9) ? null : new TaxonomyName(row.GetInt32(9), row.GetString(10));
                var tags = row.IsDBNull(11) ? [] : row.GetFieldValue<int[]>(11).Zip(row.GetFieldValue<string[]>(12),
                    (tagId, name) => new TaxonomyName(tagId, name)).ToArray();
                articles.Add(new Article(id, revision, publication, checked((int)revision), row.GetInt32(8),
                    row.GetString(3), body, row.GetFieldValue<DateTimeOffset>(5), row.GetFieldValue<DateTimeOffset>(6),
                    row.GetFieldValue<DateTimeOffset>(7), summary, category, tags, rights, mediaProjection?.CoverDigest(id, publication)));
            }
            next = new PublicSnapshot(maxEvent, articles, taxonomy, pages, _listCursor, _lastProjection, log, evidence, distribution,
                ct, taxonomyEpoch, mediaProjection, siteConfigRevision, sitePagesMask);
        }
        await using (var advance = Store.Sql(connection, tx, """
            update public.blog_outbox set processed_at=now() where processed_at is null
            """)) await advance.ExecuteNonQueryAsync(ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        _lastProjection = next;
        _projection.Replace(next);
        evidence?.CountRefresh(rebuilt);
    }

    private async Task<(long Article, long Taxonomy, long SiteConfig, int SitePagesMask)> ReadWatermarks(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        _taxonomyEpochInstalled ??= await CurrentSchema.HasAdminTagMetadataAsync(connection, tx, ct);
        var siteConfig = siteConfigOverrideActive ? (pages.SiteConfig ?? distribution?.Site) : null;
        if (siteConfig is not null)
            _siteConfigOverrideInstalled ??= await CurrentSchema.HasSiteConfigOverrideSchemaAsync(connection, tx, ct);
        var readSiteConfig = siteConfig is not null && _siteConfigOverrideInstalled == true;
        const string articles = "select coalesce(max(id),0) from public.blog_outbox where kind in ('publish','retract','delete')";
        var taxonomyExpr = _taxonomyEpochInstalled.Value ? "(select revision from public.taxonomy_epoch where singleton)" : "0::bigint";
        var siteConfigExpr = readSiteConfig ? "(select revision from public.site_config_override where singleton)" : "0::bigint";
        var sql = $"select ({articles}), {taxonomyExpr}, {siteConfigExpr}";
        long articleWatermark, taxonomyEpoch, siteConfigRevision;
        await using (var command = Store.Sql(connection, tx, sql))
        await using (var row = await command.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw new InvalidOperationException("The public watermarks are missing.");
            articleWatermark = row.GetInt64(0);
            taxonomyEpoch = row.GetInt64(1);
            siteConfigRevision = row.GetInt64(2);
        }
        if (readSiteConfig && siteConfig!.Revision != siteConfigRevision)
            await SiteConfigOverrideStore.SyncAsync(connection, tx, siteConfig, ct);
        var sitePagesMask = sitePages is null ? 0 : await sitePages.ConfiguredMaskAsync(connection, tx, ct);
        return (articleWatermark, taxonomyEpoch, siteConfigRevision, sitePagesMask);
    }
}

internal sealed class PublicUnavailableException : Exception;

internal sealed class OutboxWorker(Publications publications, ILogger<OutboxWorker> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            if (!publications.LeaseCurrent) return;
            try { await publications.Refresh(stoppingToken); }
            catch (Exception) when (!publications.LeaseCurrent) { return; }
            catch (Exception error) when (!stoppingToken.IsCancellationRequested)
            {
                log.LogError(error, "Public projection refresh failed; pending work remains durable.");
            }
        }
    }
}
