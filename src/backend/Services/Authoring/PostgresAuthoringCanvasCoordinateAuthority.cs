using System.Data.Common;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Shared.Contracts.BlockLinks;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Production heading/block coordinate authority. It resolves the stable FsusUI #289
/// <c>^anchor-id</c> source markers inside the exact immutable target revision Markdown
/// owned by primary-site articles the requesting admin principal may read. It never
/// guesses coordinates from titles, slugs, URLs, content hashes, DOM or source offsets
/// and never first-matches ambiguous identities.
/// </summary>
public sealed class PostgresAuthoringCanvasCoordinateAuthority(ISqlSugarClient db)
    : IAuthoringCanvasExternalCoordinateAuthority
{
    private const string PrimarySiteScope = "primary-site";

    public async Task<IReadOnlyDictionary<Guid, AuthoringCanvasCoordinateFact>> ReadBatchAsync(
        AuthoringCanvasCoordinateFactQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        AuthoringCanvasContract.ValidateOwner(query.Owner);
        if (query.Targets.Count > AuthoringCanvasReferenceContract.MaxBatchSize)
        {
            throw new AuthoringCanvasBudgetExceededException(
                "canvas_reference_coordinate_batch_budget_exceeded");
        }
        cancellationToken.ThrowIfCancellationRequested();

        var nodeIds = new HashSet<Guid>();
        foreach (AuthoringCanvasReferenceTarget target in query.Targets)
        {
            ValidateTargetShape(target);
            if (!nodeIds.Add(target.NodeId))
            {
                throw new AuthoringCanvasValidationException("canvas_reference_coordinate_query_invalid");
            }
        }

        var facts = new Dictionary<Guid, AuthoringCanvasCoordinateFact>(query.Targets.Count);
        if (query.Targets.Count == 0)
        {
            return facts;
        }

        int[] articleIds = query.Targets
            .Select(static target => target.TargetArticleId)
            .Distinct()
            .Order()
            .ToArray();
        IReadOnlyDictionary<int, ArticleCoordinateScope> articles =
            await ReadArticleScopesAsync(query.Owner, articleIds, cancellationToken).ConfigureAwait(false);

        var resolved = new List<(AuthoringCanvasReferenceTarget Target, long Revision)>(query.Targets.Count);
        var revisionIds = new SortedSet<long>();
        foreach (AuthoringCanvasReferenceTarget target in query.Targets)
        {
            // Article lifecycle and permission facts belong to the article reader; when the
            // article is not readable current content the coordinate stays silent and the
            // resolver projects its own denied/lifecycle/source-stale state instead.
            if (!articles.TryGetValue(target.TargetArticleId, out ArticleCoordinateScope? scope)
                || !scope.Accessible
                || !scope.Current)
            {
                continue;
            }
            long revision = target.PinnedTargetRevision ?? scope.CurrentRevision;
            if (revision <= 0)
            {
                continue;
            }
            resolved.Add((target, revision));
            revisionIds.Add(revision);
        }
        if (resolved.Count == 0)
        {
            return facts;
        }

        IReadOnlyDictionary<long, RevisionMarkdownSource> sources =
            await ReadRevisionSourcesAsync([.. revisionIds], cancellationToken).ConfigureAwait(false);
        var scans = new Dictionary<long, IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation>>();
        foreach ((AuthoringCanvasReferenceTarget target, long revision) in resolved)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!sources.TryGetValue(revision, out RevisionMarkdownSource? source)
                || source.ArticleId != target.TargetArticleId
                || source.Markdown is null)
            {
                continue;
            }
            if (!scans.TryGetValue(revision, out IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation>? scan))
            {
                scan = AuthoringCanvasAnchorSourceProjection.Scan(source.Markdown);
                scans.Add(revision, scan);
            }

            string? identity = target.NodeType == AuthoringCanvasNodeType.HeadingReference
                ? target.TargetHeadingIdentity
                : target.TargetBlockIdentity;
            AuthoringCanvasReferenceCoordinateState state;
            string? contextSnippet = null;
            if (!BlockAnchorId.IsCanonical(identity))
            {
                state = AuthoringCanvasReferenceCoordinateState.Invalid;
            }
            else if (!scan.TryGetValue(identity!, out AuthoringCanvasAnchorObservation? anchor))
            {
                state = AuthoringCanvasReferenceCoordinateState.Missing;
            }
            else if (anchor.ClaimCount > 1)
            {
                state = AuthoringCanvasReferenceCoordinateState.Duplicate;
            }
            else if (target.NodeType == AuthoringCanvasNodeType.HeadingReference && !anchor.OwnsHeading)
            {
                // The anchor exists but does not name a heading; no heading coordinate
                // carries this identity, so the reference is missing rather than invalid.
                state = AuthoringCanvasReferenceCoordinateState.Missing;
            }
            else
            {
                state = AuthoringCanvasReferenceCoordinateState.Current;
                contextSnippet = anchor.ContextText;
            }

            facts[target.NodeId] = new AuthoringCanvasCoordinateFact(
                target.NodeId,
                target.NodeType,
                target.TargetArticleId,
                revision,
                state,
                contextSnippet);
        }
        return facts;
    }

    private static void ValidateTargetShape(AuthoringCanvasReferenceTarget target)
    {
        ArgumentNullException.ThrowIfNull(target);
        bool shapeValid = target.TargetArticleId > 0 && target.NodeType switch
        {
            AuthoringCanvasNodeType.HeadingReference =>
                target.TargetHeadingIdentity is not null && target.TargetBlockIdentity is null,
            AuthoringCanvasNodeType.BlockReference =>
                target.TargetBlockIdentity is not null && target.TargetHeadingIdentity is null,
            _ => false
        };
        if (!shapeValid)
        {
            throw new AuthoringCanvasValidationException("canvas_reference_coordinate_query_invalid");
        }
    }

    private async Task<IReadOnlyDictionary<int, ArticleCoordinateScope>> ReadArticleScopesAsync(
        AuthoringCanvasOwner owner,
        int[] articleIds,
        CancellationToken cancellationToken)
    {
        var scopes = new Dictionary<int, ArticleCoordinateScope>(articleIds.Length);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT article.id, article.current_revision_id, article.status, article.isdeleted,
                   EXISTS (
                       SELECT 1
                       FROM admin_principal p
                       WHERE p.id = @AdminPrincipalId
                         AND p.status = @ActiveStatus
                         AND (p.isroot OR @RequiredPermission = ANY(string_to_array(p.permissions, E'\n')))
                         AND (p.isroot OR EXISTS (
                             SELECT 1
                             FROM article_revision ownership
                             WHERE ownership.article_id = article.id
                               AND ownership.created_by_admin_principal_id = p.id))
                   ) AS has_access
            FROM article
            WHERE id = ANY(@ArticleIds)
              AND @SiteScope = 'primary-site';
            """,
            new SugarParameter("@ArticleIds", articleIds) { IsArray = true },
            new SugarParameter("@AdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@ActiveStatus", AdminPrincipalStatus.Active),
            new SugarParameter("@RequiredPermission", AdminPermissions.ArticleWrite)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            int articleId = reader.GetInt32(reader.GetOrdinal("id"));
            bool accessible = reader.GetBoolean(reader.GetOrdinal("has_access"));
            bool deleted = reader.GetBoolean(reader.GetOrdinal("isdeleted"));
            var status = (ArticleStatus)reader.GetInt32(reader.GetOrdinal("status"));
            long currentRevision = reader.IsDBNull(reader.GetOrdinal("current_revision_id"))
                ? 0
                : reader.GetInt64(reader.GetOrdinal("current_revision_id"));
            bool current = !deleted
                && status is not ArticleStatus.Deleted
                && status is not ArticleStatus.Archived;
            scopes[articleId] = new ArticleCoordinateScope(accessible, current, currentRevision);
        }
        return scopes;
    }

    private async Task<IReadOnlyDictionary<long, RevisionMarkdownSource>> ReadRevisionSourcesAsync(
        long[] revisionIds,
        CancellationToken cancellationToken)
    {
        var sources = new Dictionary<long, RevisionMarkdownSource>(revisionIds.Length);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT revision.id, revision.article_id,
                   COALESCE(block.markdown_content, revision.markdown_content) AS markdown_content
            FROM article_revision revision
            LEFT JOIN article_revision_content_block block ON block.id = revision.content_block_id
            WHERE revision.id = ANY(@RevisionIds);
            """,
            new SugarParameter("@RevisionIds", revisionIds) { IsArray = true }).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            long revisionId = reader.GetInt64(reader.GetOrdinal("id"));
            string? markdown = reader.IsDBNull(reader.GetOrdinal("markdown_content"))
                ? null
                : reader.GetString(reader.GetOrdinal("markdown_content"));
            sources[revisionId] = new RevisionMarkdownSource(
                reader.GetInt32(reader.GetOrdinal("article_id")),
                string.IsNullOrEmpty(markdown) ? null : markdown);
        }
        return sources;
    }

    private sealed record ArticleCoordinateScope(bool Accessible, bool Current, long CurrentRevision);

    private sealed record RevisionMarkdownSource(int ArticleId, string? Markdown);
}

/// <summary>
/// One observed <c>^anchor-id</c> claim inside one immutable revision. <see cref="ClaimCount"/>
/// counts every marker that reaches anchor position, so repeated identities stay ambiguous
/// instead of first-matching. <see cref="ContextText"/> is a bounded plain-text preview of the
/// owning block; it is never the whole source.
/// </summary>
internal sealed record AuthoringCanvasAnchorObservation(
    int ClaimCount,
    bool OwnsHeading,
    string? ContextText);

/// <summary>
/// Server-side same-source Markdown projection of the FsusUI #289 anchor grammar. It scans
/// immutable revision source once per revision: <c>^id</c> at a line end belongs to the
/// inline-capable block on that line, <c>^id</c> on an exclusive line belongs to the atomic
/// block directly above it, and source inside fenced, LaTeX or <c>:::</c> regions is literal
/// content, never an anchor. It produces coordinate observations only; it does not mutate
/// source, mint identities, or decode routes.
/// </summary>
internal static class AuthoringCanvasAnchorSourceProjection
{
    internal static IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> Scan(
        string markdown)
    {
        ArgumentNullException.ThrowIfNull(markdown);
        List<string> lines = SplitLines(markdown);
        bool[] insideAtomic = MarkAtomicRegionLines(lines);
        var anchors = new Dictionary<string, (int Claims, bool OwnsHeading, string? Context)>(
            StringComparer.Ordinal);
        var claimed = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < lines.Count; index++)
        {
            if (insideAtomic[index])
            {
                continue;
            }
            string text = lines[index];
            if (text.StartsWith('^') && !string.Equals(text, "^", StringComparison.Ordinal))
            {
                // Exclusive-line marker: valid only directly after an atomic owner block.
                if (!TryParseMarker(text, out AnchorMarker marker) || !marker.Valid)
                {
                    continue;
                }
                string? previous = index > 0 ? lines[index - 1] : null;
                if (previous is null || IsBlank(previous) || !IsAtomicOwnerLine(previous))
                {
                    continue;
                }
                if (!claimed.Add(marker.Id))
                {
                    (int claims, bool heading, string? snippet) = anchors[marker.Id];
                    anchors[marker.Id] = (claims + 1, heading, snippet);
                    continue;
                }
                string? context = ExclusiveOwnerContext(lines, index - 1);
                anchors[marker.Id] = (1, false, context);
                continue;
            }

            if (!TryParseMarker(text, out AnchorMarker trailing) || !trailing.Valid)
            {
                continue;
            }
            if (trailing.Placement == AnchorMarkerPlacement.LineEnd)
            {
                string ownerText = text[..trailing.MarkerStart];
                if (!IsInlineCapable(ownerText))
                {
                    continue;
                }
                if (!claimed.Add(trailing.Id))
                {
                    (int claims, bool ownsHeading, string? context) = anchors[trailing.Id];
                    anchors[trailing.Id] = (claims + 1, ownsHeading, context);
                    continue;
                }
                anchors[trailing.Id] = (1, IsHeadingText(ownerText), Snippet(ownerText));
                continue;
            }

            // A single-space exclusive marker is accepted by the upstream grammar without an
            // owner-kind check; its owner is still the directly preceding line when present.
            if (!claimed.Add(trailing.Id))
            {
                (int claims, bool ownsHeading, string? context) = anchors[trailing.Id];
                anchors[trailing.Id] = (claims + 1, ownsHeading, context);
                continue;
            }
            string? owner = index > 0 && !IsBlank(lines[index - 1]) ? lines[index - 1] : null;
            anchors[trailing.Id] = (
                1,
                owner is not null && IsHeadingText(owner),
                owner is null ? null : ExclusiveOwnerContext(lines, index - 1));
        }

        return anchors.ToDictionary(
            static pair => pair.Key,
            static pair => new AuthoringCanvasAnchorObservation(
                pair.Value.Claims,
                pair.Value.OwnsHeading,
                pair.Value.Context),
            StringComparer.Ordinal);
    }

    private enum AnchorMarkerPlacement
    {
        LineEnd = 0,
        FollowingLine = 1
    }

    private readonly record struct AnchorMarker(
        bool Valid,
        string Id,
        AnchorMarkerPlacement Placement,
        int MarkerStart);

    private static bool TryParseMarker(string text, out AnchorMarker marker)
    {
        marker = default;
        int caret = -1;
        for (int index = text.Length - 1; index >= 0; index--)
        {
            char character = text[index];
            if (character == '^')
            {
                caret = index;
                break;
            }
            if (!(character is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') or (>= '0' and <= '9') or '-'))
            {
                return false;
            }
        }
        if (caret < 0 || caret == text.Length - 1 || text.Length - caret - 1 > 64)
        {
            return false;
        }
        if (caret > 0 && text[caret - 1] != ' ')
        {
            return false;
        }
        int matchIndex = caret > 0 ? caret - 1 : 0;
        string id = text[(caret + 1)..];
        if (!BlockAnchorId.IsCanonical(id))
        {
            // Parsed but non-canonical markers are upstream diagnostics, never anchor claims.
            marker = new AnchorMarker(false, string.Empty, AnchorMarkerPlacement.LineEnd, caret);
            return true;
        }
        marker = new AnchorMarker(
            true,
            id,
            matchIndex == 0 ? AnchorMarkerPlacement.FollowingLine : AnchorMarkerPlacement.LineEnd,
            caret);
        return true;
    }

    private static List<string> SplitLines(string source)
    {
        var lines = new List<string>();
        int offset = 0;
        while (offset <= source.Length)
        {
            int newline = source.IndexOf('\n', offset);
            int end = newline < 0 ? source.Length : newline;
            if (end > offset && source[end - 1] == '\r')
            {
                end--;
            }
            lines.Add(source[offset..end]);
            if (newline < 0)
            {
                break;
            }
            offset = newline + 1;
        }
        return lines;
    }

    private static bool[] MarkAtomicRegionLines(List<string> lines)
    {
        var inside = new bool[lines.Count];
        int index = 0;
        while (index < lines.Count)
        {
            string text = lines[index];
            if (TryFenceDelimiter(text, out char fenceMarker, out int fenceLength))
            {
                int close = -1;
                for (int cursor = index + 1; cursor < lines.Count; cursor++)
                {
                    if (ClosesFence(lines[cursor], fenceMarker, fenceLength))
                    {
                        close = cursor;
                        break;
                    }
                }
                int last = close < 0 ? lines.Count - 1 : close;
                for (int cursor = index; cursor <= last; cursor++)
                {
                    inside[cursor] = true;
                }
                index = last + 1;
                continue;
            }

            Func<string, bool>? closer = null;
            if (IsLatexDelimiterLine(text))
            {
                closer = static line => IsBareDelimiterLine(line, "$$");
            }
            else if (IsContainerOpenLine(text))
            {
                closer = static line => IsBareDelimiterLine(line, ":::");
            }
            if (closer is not null)
            {
                int close = -1;
                for (int cursor = index + 1; cursor < lines.Count; cursor++)
                {
                    if (closer(lines[cursor]))
                    {
                        close = cursor;
                        break;
                    }
                }
                if (close >= 0)
                {
                    for (int cursor = index; cursor <= close; cursor++)
                    {
                        inside[cursor] = true;
                    }
                    index = close + 1;
                    continue;
                }
            }
            index++;
        }
        return inside;
    }

    private static bool TryFenceDelimiter(string text, out char marker, out int length)
    {
        marker = default;
        length = 0;
        int start = SkipWhitespace(text, 3);
        int cursor = start;
        while (cursor < text.Length && (text[cursor] == '`' || text[cursor] == '~'))
        {
            if (marker == default)
            {
                marker = text[cursor];
            }
            else if (text[cursor] != marker)
            {
                break;
            }
            cursor++;
        }
        length = cursor - start;
        return marker != default && length >= 3;
    }

    private static bool ClosesFence(string text, char marker, int openingLength)
    {
        int start = SkipWhitespace(text, 3);
        int cursor = start;
        while (cursor < text.Length && text[cursor] == marker)
        {
            cursor++;
        }
        return cursor - start >= openingLength
            && cursor - start >= 3
            && text[cursor..].Trim().Length == 0;
    }

    private static bool IsLatexDelimiterLine(string text)
        => StartsWithAfterWhitespace(text, "$$");

    private static bool IsContainerOpenLine(string text)
    {
        int start = SkipWhitespace(text, 3);
        return text.AsSpan(start).StartsWith(":::", StringComparison.Ordinal)
            && text.Length > start + 3
            && !char.IsWhiteSpace(text[start + 3]);
    }

    private static bool IsBareDelimiterLine(string text, string delimiter)
    {
        int start = SkipWhitespace(text, 3);
        return text.AsSpan(start).StartsWith(delimiter, StringComparison.Ordinal)
            && text[(start + delimiter.Length)..].Trim().Length == 0;
    }

    private static bool IsAtomicOwnerLine(string text)
        => TryFenceDelimiter(text, out _, out _)
            || IsLatexDelimiterLine(text)
            || StartsWithAfterWhitespace(text, ":::")
            || text.TrimStart().StartsWith('|')
            || IsRegisteredAtomicLine(text);

    private static bool IsRegisteredAtomicLine(string text)
    {
        int start = SkipWhitespace(text, 3);
        ReadOnlySpan<char> rest = text.AsSpan(start);
        if (!rest.StartsWith("::", StringComparison.Ordinal) || rest.Length <= 2)
        {
            return false;
        }
        rest = rest[2..];
        if (rest.IsEmpty || rest[0] is < 'a' or > 'z')
        {
            return false;
        }
        int cursor = 1;
        while (cursor < rest.Length && (rest[cursor] is >= 'a' and <= 'z' or >= '0' and <= '9' or '-'))
        {
            cursor++;
        }
        return cursor < rest.Length && rest[cursor] == '[';
    }

    private static bool IsInlineCapable(string ownerText)
    {
        if (IsHeadingText(ownerText))
        {
            return true;
        }
        foreach (char character in ownerText)
        {
            if (!char.IsWhiteSpace(character))
            {
                return true;
            }
        }
        return false;
    }

    private static bool IsHeadingText(string text)
    {
        int cursor = 0;
        while (cursor < text.Length && text[cursor] == '#')
        {
            cursor++;
        }
        if (cursor is < 1 or > 6 || cursor >= text.Length || !char.IsWhiteSpace(text[cursor]))
        {
            return false;
        }
        while (cursor < text.Length && char.IsWhiteSpace(text[cursor]))
        {
            cursor++;
        }
        return cursor < text.Length;
    }

    private static string? ExclusiveOwnerContext(List<string> lines, int ownerIndex)
    {
        string owner = lines[ownerIndex];
        if (IsBareDelimiterLine(owner, "```")
            || IsBareDelimiterLine(owner, "~~~")
            || IsBareDelimiterLine(owner, "$$")
            || IsBareDelimiterLine(owner, ":::"))
        {
            for (int cursor = ownerIndex - 1; cursor >= 0; cursor--)
            {
                if (!IsBlank(lines[cursor]))
                {
                    return Snippet(lines[cursor]);
                }
            }
            return null;
        }
        return Snippet(owner);
    }

    private static string? Snippet(string ownerText)
    {
        string candidate = ownerText.Trim();
        if (IsHeadingText(candidate))
        {
            int cursor = 0;
            while (cursor < candidate.Length && candidate[cursor] == '#')
            {
                cursor++;
            }
            candidate = candidate[cursor..].Trim();
        }
        if (candidate.Length == 0
            || candidate.Any(static character => char.IsControl(character)
                && character is not '\n' and not '\r' and not '\t')
            || candidate.Contains('<', StringComparison.Ordinal)
            || candidate.Contains('>', StringComparison.Ordinal))
        {
            return null;
        }
        return candidate.Length <= AuthoringCanvasReferenceContract.MaxContextSnippetLength
            ? candidate
            : candidate[..AuthoringCanvasReferenceContract.MaxContextSnippetLength];
    }

    private static int SkipWhitespace(string text, int maximum)
    {
        int cursor = 0;
        while (cursor < text.Length && cursor < maximum && char.IsWhiteSpace(text[cursor]))
        {
            cursor++;
        }
        return cursor;
    }

    private static bool StartsWithAfterWhitespace(string text, string token)
        => text.AsSpan(SkipWhitespace(text, 3)).StartsWith(token, StringComparison.Ordinal);

    private static bool IsBlank(string text)
        => string.IsNullOrWhiteSpace(text);
}
