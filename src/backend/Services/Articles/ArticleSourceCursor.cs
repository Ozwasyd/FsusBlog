namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Persisted numeric lifecycle counters for a local article. RecordMutationAsync returns
/// a transaction-local allocation: only the original owner may publish it after commit.
/// A cursor grants no baseline, portable binding, permission or index-generation authority.
/// </summary>
public sealed record ArticleSourceCursor(int ArticleId, long SourceGeneration, long SourceSequence);
