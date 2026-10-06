using System.Data;
using System.Data.Common;

using FsusBlog.Shared.Contracts.AuthoringCanvas;
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

        await ReadRevisionCoordinatesAsync(resolved, [.. revisionIds], facts, cancellationToken).ConfigureAwait(false);
        // Includes the native reader/command's awaited cleanup, not merely scanner EOF.
        cancellationToken.ThrowIfCancellationRequested();
        return facts;
    }

    private static void ProjectCoordinates(
        IReadOnlyList<AuthoringCanvasReferenceTarget> targets,
        long revision,
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> scan,
        Dictionary<Guid, AuthoringCanvasCoordinateFact> facts)
    {
        foreach (AuthoringCanvasReferenceTarget target in targets)
        {
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

    private async Task ReadRevisionCoordinatesAsync(
        IReadOnlyList<(AuthoringCanvasReferenceTarget Target, long Revision)> resolved,
        long[] revisionIds,
        Dictionary<Guid, AuthoringCanvasCoordinateFact> facts,
        CancellationToken cancellationToken)
    {
        var targetsByRevision = resolved.GroupBy(static item => item.Revision)
            .ToDictionary(static group => group.Key, static group => group.Select(static item => item.Target).ToArray());
        DbConnection connection = db.Ado.Connection as DbConnection
            ?? throw new InvalidOperationException("canvas_reference_native_connection_required");
        if (connection.State != ConnectionState.Open)
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        }
        // Borrow the existing connection/transaction; only this command, reader and text stream are owned here.
        await using DbCommand command = connection.CreateCommand();
        command.CommandTimeout = db.Ado.CommandTimeOut;
        command.Transaction = db.Ado.Transaction as DbTransaction;
        if (db.Ado.Transaction is not null && command.Transaction is null)
        {
            throw new InvalidOperationException("canvas_reference_native_transaction_required");
        }
        command.CommandText = """
            SELECT revision.id, revision.article_id,
                   COALESCE(block.markdown_content, revision.markdown_content) AS markdown_content
            FROM article_revision revision
            LEFT JOIN article_revision_content_block block ON block.id = revision.content_block_id
            WHERE revision.id = ANY(@RevisionIds);
            """;
        DbParameter revisions = command.CreateParameter();
        revisions.ParameterName = "@RevisionIds";
        revisions.Value = revisionIds;
        command.Parameters.Add(revisions);
        await using DbDataReader reader = await command.ExecuteReaderAsync(
            CommandBehavior.SequentialAccess,
            cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            long revisionId = reader.GetInt64(0);
            int articleId = reader.GetInt32(1);
            if (!targetsByRevision.TryGetValue(revisionId, out AuthoringCanvasReferenceTarget[]? targets)
                || reader.IsDBNull(2))
            {
                continue;
            }
            AuthoringCanvasReferenceTarget[] matching = targets
                .Where(target => target.TargetArticleId == articleId).ToArray();
            if (matching.Length == 0)
            {
                continue;
            }
            string[] identities = matching.Select(static target =>
                target.NodeType == AuthoringCanvasNodeType.HeadingReference
                    ? target.TargetHeadingIdentity!
                    : target.TargetBlockIdentity!).Distinct(StringComparer.Ordinal).ToArray();
            using TextReader text = reader.GetTextReader(2);
            AuthoringCanvasAnchorSourceProjection.ScanResult scan =
                await AuthoringCanvasAnchorSourceProjection.ScanAsync(text, identities, cancellationToken).ConfigureAwait(false);
            if (scan.SourceCharacters > 0)
            {
                ProjectCoordinates(matching, revisionId, scan.Anchors, facts);
            }
        }
    }

    private sealed record ArticleCoordinateScope(bool Accessible, bool Current, long CurrentRevision);

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
    // The suffix is exactly the existing 64-character identity plus caret and separator.
    private const int MarkerSuffixLength = 66;

    internal sealed record ScanResult(
        long SourceCharacters,
        IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> Anchors);

    internal static IReadOnlyDictionary<string, AuthoringCanvasAnchorObservation> Scan(string markdown)
    {
        ArgumentNullException.ThrowIfNull(markdown);
        var scanner = new Scanner(null);
        foreach (char character in markdown)
        {
            scanner.Feed(character);
        }
        return scanner.Finish().Anchors;
    }

    internal static async Task<ScanResult> ScanAsync(
        TextReader source,
        IReadOnlyCollection<string> requestedIdentities,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(requestedIdentities);
        if (requestedIdentities.Count > AuthoringCanvasReferenceContract.MaxBatchSize)
        {
            throw new AuthoringCanvasBudgetExceededException("canvas_reference_coordinate_batch_budget_exceeded");
        }
        cancellationToken.ThrowIfCancellationRequested();
        var scanner = new Scanner(new HashSet<string>(requestedIdentities, StringComparer.Ordinal));
        // Reuse the existing snippet limit as a transport chunk, not a source-length ceiling.
        char[] buffer = new char[AuthoringCanvasReferenceContract.MaxContextSnippetLength];
        int count;
        while ((count = await source.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false)) != 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            for (int index = 0; index < count; index++)
            {
                scanner.Feed(buffer[index]);
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        ScanResult result = scanner.Finish();
        cancellationToken.ThrowIfCancellationRequested();
        return result;
    }

    private sealed class Scanner(HashSet<string>? requested)
    {
        private readonly Dictionary<string, AuthoringCanvasAnchorObservation> _anchors = new(StringComparer.Ordinal);
        private readonly List<PendingRegion> _pending = new(2);
        private readonly Queue<char> _suffix = new(MarkerSuffixLength);
        private LineFacts _line = new();
        private LineSummary? _previous;
        private string? _lastNonblankContext;
        private string? _previousContext;
        private long _sourceCharacters;
        private char _fenceMarker;
        private long _fenceLength;

        internal void Feed(char character)
        {
            _sourceCharacters++;
            if (character == '\n')
            {
                EndLine();
                return;
            }
            if (_suffix.Count == MarkerSuffixLength)
            {
                _line.Feed(_suffix.Dequeue());
            }
            _suffix.Enqueue(character);
        }

        internal ScanResult Finish()
        {
            EndLine(); // SplitLines also includes the final empty line.
            foreach (PendingRegion region in _pending)
            {
                foreach ((string identity, AuthoringCanvasAnchorObservation observation) in region.Claims)
                {
                    Merge(_anchors, identity, observation);
                }
            }
            return new ScanResult(_sourceCharacters, _anchors);
        }

        private void EndLine()
        {
            string tail = new(_suffix.ToArray());
            if (tail.EndsWith('\r'))
            {
                tail = tail[..^1];
            }
            LineFacts full = _line.Copy();
            foreach (char character in tail)
            {
                full.Feed(character);
            }
            LineSummary summary = full.Summarize();
            Marker? marker = ParseMarker(tail, _line.Length, _line.LastCharacter);
            LineSummary? owner = null;
            if (marker is not null)
            {
                LineFacts ownerFacts = _line.Copy();
                foreach (char character in tail.AsSpan(0, marker.Value.Caret))
                {
                    ownerFacts.Feed(character);
                }
                owner = ownerFacts.Summarize();
            }
            ProcessLine(summary, marker, owner);
            _previousContext = summary.BareOwner ? _lastNonblankContext : summary.Snippet;
            _previous = summary;
            if (!summary.Blank)
            {
                _lastNonblankContext = summary.Snippet;
            }
            _suffix.Clear();
            _line = new LineFacts();
        }

        private void ProcessLine(LineSummary line, Marker? marker, LineSummary? owner)
        {
            // Lookahead in the original grammar sees a bare outer closer even inside a
            // tentative inner region/fence. Each kind needs at most one pending opener:
            // another opener of that kind has exactly the same future first closer.
            for (int index = 0; index < _pending.Count; index++)
            {
                if (line.Closes(_pending[index].Kind))
                {
                    _pending.RemoveRange(index, _pending.Count - index);
                    _fenceMarker = default;
                    _fenceLength = 0;
                    return;
                }
            }
            if (_fenceMarker != default)
            {
                if (line.FenceMarker == _fenceMarker
                    && line.FenceLength >= _fenceLength && line.FenceSuffixWhite)
                {
                    _fenceMarker = default;
                    _fenceLength = 0;
                }
                return;
            }
            if (line.FenceLength >= 3)
            {
                _fenceMarker = line.FenceMarker;
                _fenceLength = line.FenceLength;
                return;
            }
            RegionKind? opener = line.Latex ? RegionKind.Latex
                : line.ContainerOpen ? RegionKind.Container : null;
            if (opener is not null && !_pending.Any(region => region.Kind == opener))
            {
                _pending.Add(new PendingRegion(opener.Value));
            }
            if (marker is null || (requested is not null && !requested.Contains(marker.Value.Id)))
            {
                return;
            }
            bool heading;
            string? context;
            if (line.StartsCaret)
            {
                if (_previous is null || _previous.Blank || !_previous.AtomicOwner)
                {
                    return;
                }
                heading = false;
                context = _previousContext;
            }
            else if (!marker.Value.FollowingLine)
            {
                if (owner is null || owner.Blank)
                {
                    return;
                }
                heading = owner.Heading;
                context = owner.Snippet;
            }
            else
            {
                heading = _previous is not null && !_previous.Blank && _previous.Heading;
                context = _previous is not null && !_previous.Blank ? _previousContext : null;
            }
            Dictionary<string, AuthoringCanvasAnchorObservation> claims =
                _pending.Count == 0 ? _anchors : _pending[^1].Claims;
            Merge(claims, marker.Value.Id, new AuthoringCanvasAnchorObservation(1, heading, context));
        }

        private static void Merge(
            Dictionary<string, AuthoringCanvasAnchorObservation> claims,
            string identity,
            AuthoringCanvasAnchorObservation observation)
        {
            if (claims.TryGetValue(identity, out AuthoringCanvasAnchorObservation? original))
            {
                claims[identity] = original with
                {
                    ClaimCount = original.ClaimCount + observation.ClaimCount
                };
            }
            else
            {
                claims.Add(identity, observation);
            }
        }
    }

    private enum RegionKind
    {
        Latex,
        Container
    }

    private sealed class PendingRegion(RegionKind kind)
    {
        internal RegionKind Kind { get; } = kind;
        internal Dictionary<string, AuthoringCanvasAnchorObservation> Claims { get; } = new(StringComparer.Ordinal);
    }

    private readonly record struct Marker(string Id, int Caret, bool FollowingLine);

    private static Marker? ParseMarker(string suffix, long prefixLength, char prefixLastCharacter)
    {
        int caret = -1;
        for (int index = suffix.Length - 1; index >= 0; index--)
        {
            char character = suffix[index];
            if (character == '^')
            {
                caret = index;
                break;
            }
            if (!(character is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') or (>= '0' and <= '9') or '-'))
            {
                return null;
            }
        }
        if (caret < 0 || caret == suffix.Length - 1 || suffix.Length - caret - 1 > 64
            || (caret > 0 && suffix[caret - 1] != ' ')
            || (caret == 0 && prefixLength > 0 && prefixLastCharacter != ' '))
        {
            return null;
        }
        string identity = suffix[(caret + 1)..];
        return BlockAnchorId.IsCanonical(identity)
            ? new Marker(identity, caret, prefixLength + caret <= 1)
            : null;
    }

    private sealed record LineSummary(
        bool Blank,
        bool Heading,
        bool StartsCaret,
        char FenceMarker,
        long FenceLength,
        bool FenceSuffixWhite,
        bool Latex,
        bool ContainerOpen,
        bool AtomicOwner,
        bool BareOwner,
        bool BareLatex,
        bool BareContainer,
        string? Snippet)
    {
        internal bool Closes(RegionKind kind) => kind == RegionKind.Latex ? BareLatex : BareContainer;
    }

    // Constant-size lexical state, two bounded snippet prefixes, and counters only.
    // No complete line, opening-token string, region stack, or unrequested-ID roster.
    private sealed class LineFacts
    {
        private readonly char[] _start = new char[4];
        private readonly bool[] _bare = [true, true, true, true];
        private static readonly string[] s_bareTokens = ["\u0060\u0060\u0060", "~~~", "$$", ":::"];
        private readonly SnippetPrefix _plain = new();
        private readonly SnippetPrefix _headingBody = new();
        private int _skipped;
        private bool _syntaxStarted;
        private long _syntaxLength;
        private bool _blank = true;
        private bool _startsCaret;
        private bool _pipe;
        private int _rawHeadingState;
        private int _rawHashes;
        private int _trimHeadingState;
        private int _trimHashes;
        private int _registeredState;
        private bool _registered;
        private char _fenceMarker;
        private long _fenceLength;
        private bool _fenceRun = true;
        private bool _fenceSuffixWhite = true;
        internal long Length
        {
            get; private set;
        }
        internal char LastCharacter
        {
            get; private set;
        }

        internal LineFacts Copy()
        {
            var copy = new LineFacts();
            Array.Copy(_start, copy._start, _start.Length);
            Array.Copy(_bare, copy._bare, _bare.Length);
            copy._plain.CopyFrom(_plain);
            copy._headingBody.CopyFrom(_headingBody);
            copy._skipped = _skipped;
            copy._syntaxStarted = _syntaxStarted;
            copy._syntaxLength = _syntaxLength;
            copy._blank = _blank;
            copy._startsCaret = _startsCaret;
            copy._pipe = _pipe;
            copy._rawHeadingState = _rawHeadingState;
            copy._rawHashes = _rawHashes;
            copy._trimHeadingState = _trimHeadingState;
            copy._trimHashes = _trimHashes;
            copy._registeredState = _registeredState;
            copy._registered = _registered;
            copy._fenceMarker = _fenceMarker;
            copy._fenceLength = _fenceLength;
            copy._fenceRun = _fenceRun;
            copy._fenceSuffixWhite = _fenceSuffixWhite;
            copy.Length = Length;
            copy.LastCharacter = LastCharacter;
            return copy;
        }

        internal void Feed(char character)
        {
            bool whitespace = char.IsWhiteSpace(character);
            if (Length == 0)
            {
                _startsCaret = character == '^';
            }
            AdvanceHeading(character, ref _rawHeadingState, ref _rawHashes);
            if (_blank && !whitespace)
            {
                _pipe = character == '|';
            }
            if (!_blank || !whitespace)
            {
                AdvanceHeading(character, ref _trimHeadingState, ref _trimHashes);
                if (_trimHeadingState == 3)
                {
                    _headingBody.Feed(character);
                }
            }
            _blank &= whitespace;
            _plain.Feed(character);
            Length++;
            LastCharacter = character;

            if (!_syntaxStarted && _skipped < 3 && whitespace)
            {
                _skipped++;
                return;
            }
            _syntaxStarted = true;
            long index = _syntaxLength++;
            if (index < _start.Length)
            {
                _start[(int)index] = character;
            }
            for (int tokenIndex = 0; tokenIndex < s_bareTokens.Length; tokenIndex++)
            {
                string token = s_bareTokens[tokenIndex];
                _bare[tokenIndex] &= index < token.Length ? character == token[(int)index] : whitespace;
            }
            if (index == 0 && character is '\u0060' or '~')
            {
                _fenceMarker = character;
            }
            if (_fenceRun && _fenceMarker != default && character == _fenceMarker)
            {
                _fenceLength++;
            }
            else
            {
                _fenceRun = false;
                _fenceSuffixWhite &= whitespace;
            }
            _registeredState = _registeredState switch
            {
                0 when character == ':' => 1,
                1 when character == ':' => 2,
                2 when character is >= 'a' and <= 'z' => 3,
                3 when character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-' => 3,
                3 when character == '[' => 4,
                _ => -1
            };
            _registered |= _registeredState == 4;
        }

        internal LineSummary Summarize()
        {
            bool latex = _syntaxLength >= 2 && _start[0] == '$' && _start[1] == '$';
            bool container = _syntaxLength >= 3 && _start[0] == ':' && _start[1] == ':' && _start[2] == ':';
            bool bareLatex = _syntaxLength >= 2 && _bare[2];
            bool bareContainer = _syntaxLength >= 3 && _bare[3];
            bool bareFence = _syntaxLength >= 3 && (_bare[0] || _bare[1]);
            return new LineSummary(
                _blank, _rawHeadingState == 3, _startsCaret,
                _fenceMarker, _fenceLength, _fenceSuffixWhite,
                latex, container && _syntaxLength > 3 && !char.IsWhiteSpace(_start[3]),
                _fenceLength >= 3 || latex || container || _pipe || _registered,
                bareFence || bareLatex || bareContainer, bareLatex, bareContainer,
                _trimHeadingState == 3 ? _headingBody.Value() : _plain.Value());
        }

        private static void AdvanceHeading(char character, ref int state, ref int hashes)
        {
            if (state == 0)
            {
                if (character == '#')
                {
                    hashes = Math.Min(hashes + 1, 7);
                }
                else
                {
                    state = hashes is >= 1 and <= 6 && char.IsWhiteSpace(character) ? 2 : -1;
                }
            }
            else if (state == 2 && !char.IsWhiteSpace(character))
            {
                state = 3;
            }
        }
    }

    private sealed class SnippetPrefix
    {
        private readonly char[] _prefix = new char[AuthoringCanvasReferenceContract.MaxContextSnippetLength];
        private long _length;
        private long _lastNonWhitespace;
        private bool _unsafe;
        private bool _pendingUnsafeWhitespace;

        internal void CopyFrom(SnippetPrefix original)
        {
            Array.Copy(original._prefix, _prefix, _prefix.Length);
            _length = original._length;
            _lastNonWhitespace = original._lastNonWhitespace;
            _unsafe = original._unsafe;
            _pendingUnsafeWhitespace = original._pendingUnsafeWhitespace;
        }

        internal void Feed(char character)
        {
            bool whitespace = char.IsWhiteSpace(character);
            if (_length == 0 && whitespace)
            {
                return;
            }
            bool unsafeControl = char.IsControl(character) && character is not '\n' and not '\r' and not '\t';
            if (whitespace)
            {
                _pendingUnsafeWhitespace |= unsafeControl;
            }
            else
            {
                _unsafe |= _pendingUnsafeWhitespace || unsafeControl || character is '<' or '>';
                _pendingUnsafeWhitespace = false;
                _lastNonWhitespace = _length + 1;
            }
            if (_length < _prefix.Length)
            {
                _prefix[(int)_length] = character;
            }
            _length++;
        }

        internal string? Value()
            => _unsafe || _lastNonWhitespace == 0 ? null
                : new string(_prefix, 0, (int)Math.Min(_lastNonWhitespace, _prefix.Length));
    }
}
