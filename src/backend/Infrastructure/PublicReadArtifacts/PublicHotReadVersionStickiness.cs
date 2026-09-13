namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

/// <summary>
/// Cause that may advance a public hot-read generation pin.
/// Soft refresh stays inside the stickiness window; content publish and
/// hard invalidation do not.
/// </summary>
internal enum PublicHotReadPublishCause : byte
{
    SoftRefresh = 0,
    Content = 1,
    HardInvalidation = 2
}

internal enum PublicHotReadCacheTier : byte
{
    L0 = 0,
    L1 = 1,
    L2 = 2,
    Endpoint = 3
}

internal readonly record struct PublicHotReadVersionPin(
    string Key,
    long Generation,
    string ETag,
    DateTimeOffset StickyUntilUtc);

internal readonly record struct PublicHotReadVersionCandidate(
    string Key,
    long Generation,
    string ETag,
    PublicHotReadCacheTier Tier);

internal readonly record struct PublicHotReadVersionSelection(
    bool Serve,
    long Generation,
    string ETag,
    PublicHotReadCacheTier Tier,
    PublicHotReadVersionPin NextPin,
    string Reason);

/// <summary>
/// Short-window generation pin so L0/L1/L2/endpoint do not flap adjacent
/// generations for the same client/key without a publish or hard invalidation.
/// </summary>
internal static class PublicHotReadVersionStickiness
{
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromSeconds(2);

    public static TimeSpan ResolveWindow(TimeSpan configured, TimeSpan maxSnapshotAge)
    {
        if (configured < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(configured),
                configured,
                "Version stickiness window cannot be negative.");
        }

        if (configured > maxSnapshotAge)
        {
            return maxSnapshotAge;
        }

        return configured;
    }

    public static bool IsAdjacent(long left, long right)
        => left > 0 && right > 0 && left != right && Math.Abs(left - right) == 1;

    public static bool PinIsActive(in PublicHotReadVersionPin pin, string key, DateTimeOffset now)
        => pin.Generation > 0
            && now < pin.StickyUntilUtc
            && string.Equals(pin.Key, key, StringComparison.Ordinal);

    public static PublicHotReadPublishCause Classify(
        PublicHotArtifactDirtyReason dirtyReason,
        string reason,
        long currentVersion)
    {
        if (currentVersion <= 0)
        {
            return PublicHotReadPublishCause.Content;
        }

        if ((dirtyReason & PublicHotArtifactDirtyReason.ScheduledPublish) != 0)
        {
            return PublicHotReadPublishCause.Content;
        }

        bool contentMutation = false;
        bool softRefresh = dirtyReason == PublicHotArtifactDirtyReason.ViewProjection
            || (dirtyReason & PublicHotArtifactDirtyReason.SoftRefresh) != 0;
        ReadOnlySpan<char> remaining = (reason ?? string.Empty).AsSpan();
        while (!remaining.IsEmpty)
        {
            int plus = remaining.IndexOf('+');
            ReadOnlySpan<char> part = plus < 0 ? remaining : remaining[..plus];
            if (IsSoftRefreshReason(part))
            {
                softRefresh = true;
            }
            else if (!part.IsWhiteSpace())
            {
                contentMutation = true;
            }

            if (plus < 0)
            {
                break;
            }

            remaining = remaining[(plus + 1)..];
        }

        if (contentMutation
            || ((dirtyReason & PublicHotArtifactDirtyReason.Content) != 0
                && (dirtyReason & PublicHotArtifactDirtyReason.SoftRefresh) != 0))
        {
            return PublicHotReadPublishCause.Content;
        }

        if (softRefresh)
        {
            return PublicHotReadPublishCause.SoftRefresh;
        }

        return (dirtyReason & PublicHotArtifactDirtyReason.Content) != 0
            ? PublicHotReadPublishCause.Content
            : PublicHotReadPublishCause.SoftRefresh;
    }

    public static PublicHotReadVersionSelection Select(
        string key,
        PublicHotReadVersionPin pin,
        IReadOnlyList<PublicHotReadVersionCandidate> candidates,
        DateTimeOffset now,
        TimeSpan window,
        PublicHotReadPublishCause cause)
    {
        ArgumentException.ThrowIfNullOrEmpty(key);
        ArgumentNullException.ThrowIfNull(candidates);

        if (cause == PublicHotReadPublishCause.HardInvalidation)
        {
            return new(
                false,
                0,
                string.Empty,
                PublicHotReadCacheTier.L0,
                default,
                "hard-invalidation");
        }

        PublicHotReadVersionCandidate? latest = null;
        PublicHotReadVersionCandidate? pinned = null;
        foreach (PublicHotReadVersionCandidate candidate in candidates)
        {
            if (!string.Equals(candidate.Key, key, StringComparison.Ordinal) || candidate.Generation <= 0)
            {
                continue;
            }

            if (pin.Generation > 0 && candidate.Generation == pin.Generation)
            {
                pinned = PreferTier(pinned, candidate);
            }

            latest = PreferNewer(latest, candidate);
        }

        if (cause == PublicHotReadPublishCause.Content)
        {
            return Advance(key, latest, now, window, "publish");
        }

        bool pinActive = window > TimeSpan.Zero && PinIsActive(pin, key, now);
        if (pinActive)
        {
            if (pinned is { } sticky)
            {
                if (latest is not { } newest
                    || newest.Generation == sticky.Generation
                    || IsAdjacent(sticky.Generation, newest.Generation))
                {
                    return new(
                        true,
                        sticky.Generation,
                        sticky.ETag,
                        sticky.Tier,
                        pin,
                        "sticky");
                }
            }
            else if (latest is { } newest && IsAdjacent(pin.Generation, newest.Generation))
            {
                return new(
                    false,
                    pin.Generation,
                    pin.ETag,
                    PublicHotReadCacheTier.L0,
                    pin,
                    "sticky-missing");
            }
        }

        string reason = pin.Generation > 0 && now >= pin.StickyUntilUtc ? "expired" : "ok";
        return Advance(key, latest, now, window, reason);
    }

    private static PublicHotReadVersionSelection Advance(
        string key,
        PublicHotReadVersionCandidate? latest,
        DateTimeOffset now,
        TimeSpan window,
        string reason)
    {
        if (latest is not { } chosen)
        {
            return new(false, 0, string.Empty, PublicHotReadCacheTier.L0, default, reason);
        }

        DateTimeOffset until = window > TimeSpan.Zero ? now + window : now;
        return new(
            true,
            chosen.Generation,
            chosen.ETag,
            chosen.Tier,
            new PublicHotReadVersionPin(key, chosen.Generation, chosen.ETag, until),
            reason);
    }

    private static PublicHotReadVersionCandidate PreferNewer(
        PublicHotReadVersionCandidate? current,
        PublicHotReadVersionCandidate candidate)
    {
        if (current is not { } existing)
        {
            return candidate;
        }

        if (candidate.Generation != existing.Generation)
        {
            return candidate.Generation > existing.Generation ? candidate : existing;
        }

        return candidate.Tier < existing.Tier ? candidate : existing;
    }

    private static PublicHotReadVersionCandidate PreferTier(
        PublicHotReadVersionCandidate? current,
        PublicHotReadVersionCandidate candidate)
    {
        if (current is not { } existing)
        {
            return candidate;
        }

        return candidate.Tier < existing.Tier ? candidate : existing;
    }

    private static bool IsSoftRefreshReason(ReadOnlySpan<char> part)
        => part.StartsWith("last-good", StringComparison.OrdinalIgnoreCase)
            || part.Equals("sanity-age-refresh", StringComparison.OrdinalIgnoreCase)
            || part.Contains("view-projection", StringComparison.OrdinalIgnoreCase);
}
