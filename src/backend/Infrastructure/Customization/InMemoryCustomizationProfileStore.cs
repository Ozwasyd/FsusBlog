using System.Collections.Concurrent;

namespace FsusBlog.Server.Infrastructure.Customization;

/// <summary>
/// In-memory store for testing and development; it is not a production persistence boundary.
/// </summary>
public sealed class InMemoryCustomizationProfileStore : ICustomizationProfileStore
{
    private long _nextProfileId = 1;
    private long _nextVersionId = 1;
    private long _nextDraftId = 1;
    private long _nextChangeSetId = 1;

    private readonly ConcurrentDictionary<long, CustomizationProfile> _profiles = new();
    private readonly ConcurrentDictionary<long, CustomizationVersion> _versions = new();
    private readonly ConcurrentDictionary<long, CustomizationDraft> _drafts = new();
    private readonly ConcurrentDictionary<long, CustomizationChangeSet> _changeSets = new();

    public Task<IReadOnlyList<CustomizationProfile>> ListProfilesAsync(
        int userId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var list = _profiles.Values
            .Where(p => p.UserId == userId)
            .OrderBy(p => p.Id)
            .ToList()
            .AsReadOnly();
        return Task.FromResult<IReadOnlyList<CustomizationProfile>>(list);
    }

    public Task<CustomizationProfile?> GetProfileAsync(
        long profileId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _profiles.TryGetValue(profileId, out var profile);
        return Task.FromResult(profile);
    }

    public Task<CustomizationProfile> CreateProfileAsync(
        int userId,
        string name,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long id = Interlocked.Increment(ref _nextProfileId);
        var profile = new CustomizationProfile
        {
            Id = id,
            UserId = userId,
            Name = name,
            CreatedAtUtc = createdAtUtc,
            UpdatedAtUtc = createdAtUtc
        };
        if (!_profiles.TryAdd(id, profile))
        {
            throw new InvalidOperationException($"Profile id {id} already exists.");
        }
        return Task.FromResult(profile);
    }

    public Task<IReadOnlyList<CustomizationVersion>> ListVersionsAsync(
        long profileId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var list = _versions.Values
            .Where(v => v.ProfileId == profileId)
            .OrderByDescending(v => v.Version)
            .ToList()
            .AsReadOnly();
        return Task.FromResult<IReadOnlyList<CustomizationVersion>>(list);
    }

    public Task<CustomizationVersion> CreateVersionAsync(
        long profileId,
        string payload,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_profiles.ContainsKey(profileId))
        {
            throw new InvalidOperationException($"Profile {profileId} not found.");
        }

        int nextVersion = _versions.Values
            .Where(v => v.ProfileId == profileId)
            .Select(v => (int?)v.Version)
            .Max() ?? 0;

        long id = Interlocked.Increment(ref _nextVersionId);
        var version = new CustomizationVersion
        {
            Id = id,
            ProfileId = profileId,
            Version = nextVersion + 1,
            Payload = payload,
            CreatedAtUtc = createdAtUtc
        };
        if (!_versions.TryAdd(id, version))
        {
            throw new InvalidOperationException($"Version id {id} already exists.");
        }
        return Task.FromResult(version);
    }

    public Task<CustomizationVersion?> GetVersionAsync(
        long versionId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _versions.TryGetValue(versionId, out var version);
        return Task.FromResult(version);
    }

    public Task<CustomizationDraft?> GetDraftAsync(
        long profileId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var draft = _drafts.Values.FirstOrDefault(d => d.ProfileId == profileId);
        return Task.FromResult(draft);
    }

    public Task<CustomizationDraft?> UpsertDraftAsync(
        long profileId,
        long? versionId,
        string payload,
        string newEtag,
        string? expectedEtag,
        DateTime updatedAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_profiles.ContainsKey(profileId))
        {
            throw new InvalidOperationException($"Profile {profileId} not found.");
        }

        // Find existing draft for this profile.
        CustomizationDraft? existing = _drafts.Values.FirstOrDefault(d => d.ProfileId == profileId);

        if (existing is not null)
        {
            if (expectedEtag is not null && !string.Equals(existing.Etag, expectedEtag, StringComparison.Ordinal))
            {
                return Task.FromResult<CustomizationDraft?>(null);
            }
        }
        else if (expectedEtag is not null)
        {
            // If no draft exists but the caller expected one (i.e., passed an etag from a prior fetch),
            // and the draft was deleted since then, it's also a conflict.
            return Task.FromResult<CustomizationDraft?>(null);
        }

        if (existing is not null)
        {
            var updated = new CustomizationDraft
            {
                Id = existing.Id,
                ProfileId = profileId,
                VersionId = versionId,
                Payload = payload,
                Etag = newEtag,
                UpdatedAtUtc = updatedAtUtc
            };
            _drafts.TryUpdate(existing.Id, updated, existing);
            return Task.FromResult<CustomizationDraft?>(updated);
        }
        else
        {
            long id = Interlocked.Increment(ref _nextDraftId);
            var draft = new CustomizationDraft
            {
                Id = id,
                ProfileId = profileId,
                VersionId = versionId,
                Payload = payload,
                Etag = newEtag,
                UpdatedAtUtc = updatedAtUtc
            };
            _drafts.TryAdd(id, draft);
            return Task.FromResult<CustomizationDraft?>(draft);
        }
    }

    public Task<IReadOnlyList<CustomizationChangeSet>> ListChangeSetsAsync(
        long profileId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var list = _changeSets.Values
            .Where(cs => cs.ProfileId == profileId)
            .OrderByDescending(cs => cs.Id)
            .ToList()
            .AsReadOnly();
        return Task.FromResult<IReadOnlyList<CustomizationChangeSet>>(list);
    }

    public Task<CustomizationChangeSet> CreateChangeSetAsync(
        long profileId,
        long fromVersionId,
        long toVersionId,
        string changes,
        DateTime createdAtUtc,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_profiles.ContainsKey(profileId))
        {
            throw new InvalidOperationException($"Profile {profileId} not found.");
        }

        long id = Interlocked.Increment(ref _nextChangeSetId);
        var changeSet = new CustomizationChangeSet
        {
            Id = id,
            ProfileId = profileId,
            FromVersionId = fromVersionId,
            ToVersionId = toVersionId,
            Changes = changes,
            CreatedAtUtc = createdAtUtc
        };
        if (!_changeSets.TryAdd(id, changeSet))
        {
            throw new InvalidOperationException($"ChangeSet id {id} already exists.");
        }
        return Task.FromResult(changeSet);
    }
}
