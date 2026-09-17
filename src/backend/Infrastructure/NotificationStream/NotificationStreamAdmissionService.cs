using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamAdmissionService
{
    Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken);
}

internal sealed record NotificationStreamAdmissionResult(bool IsAllowed, int StatusCode, string? ErrorCode)
{
    public static NotificationStreamAdmissionResult Allowed { get; } = new(true, StatusCodes.Status200OK, null);

    public static NotificationStreamAdmissionResult Denied(int statusCode, string errorCode)
        => new(false, statusCode, errorCode);
}

internal sealed class NotificationStreamAdmissionService(
    IBlacklistService blacklistService,
    IUserAccountReader users,
    NotificationStreamAccountAdmissionCache accountCache) : INotificationStreamAdmissionService
{
    public NotificationStreamAdmissionService(IBlacklistService blacklistService, IUserAccountReader users)
        : this(blacklistService, users, new NotificationStreamAccountAdmissionCache())
    {
    }

    public async Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(userId) || !int.TryParse(userId, out int numericUserId))
        {
            return NotificationStreamAdmissionResult.Allowed;
        }

        NotificationStreamAccountAdmissionCacheResult cached = await accountCache.GetOrCreateAsync(
            numericUserId,
            users,
            cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordNotificationStreamAdmissionAccountState(cached.Hit, cached.LoadedFromDb);

        UserAccountSnapshot? userSnapshot = cached.Account;
        if (userSnapshot == null || userSnapshot.Value.DeletedAt.HasValue || userSnapshot.Value.Status == 2)
        {
            FsusObservability.RecordNotificationStreamAdmissionRejected("account_deleted");
            return NotificationStreamAdmissionResult.Denied(StatusCodes.Status401Unauthorized, "account_deleted");
        }

        if (!AccountSubjectHashRequirement.TryResolve(
                userSnapshot.Value.AccountSubjectHash,
                out string accountSubjectHash))
        {
            FsusObservability.RecordNotificationStreamAdmissionRejected("account_subject_invalid");
            return NotificationStreamAdmissionResult.Denied(
                StatusCodes.Status401Unauthorized,
                "account_subject_invalid");
        }

        var banState = await blacklistService.GetBanStateAsync(numericUserId, accountSubjectHash);
        if (!banState.IsKnown)
        {
            FsusObservability.RecordNotificationStreamAdmissionRejected("ban_state_unknown");
            return NotificationStreamAdmissionResult.Denied(
                StatusCodes.Status503ServiceUnavailable,
                "ban_state_unknown");
        }

        if (banState.IsDeleted)
        {
            FsusObservability.RecordNotificationStreamAdmissionRejected("account_deleted");
            return NotificationStreamAdmissionResult.Denied(
                StatusCodes.Status401Unauthorized,
                "account_deleted");
        }

        if (banState.IsBanned)
        {
            FsusObservability.RecordNotificationStreamAdmissionRejected("account_blocked");
            return NotificationStreamAdmissionResult.Denied(StatusCodes.Status423Locked, "account_blocked");
        }

        return NotificationStreamAdmissionResult.Allowed;
    }
}

internal sealed record NotificationStreamAccountAdmissionCacheResult(
    UserAccountSnapshot? Account,
    bool Hit,
    bool LoadedFromDb);

internal sealed class NotificationStreamAccountAdmissionCacheOptions
{
    internal const string SectionName = "NotificationStream:AccountAdmissionCache";

    public int MaxEntries { get; set; } = 100_000;

    public long MaxLogicalBytes { get; set; } = 48L * 1024 * 1024;

    public long MaxCapacityBytes { get; set; } = 96L * 1024 * 1024;

    internal static NotificationStreamAccountAdmissionCacheOptions FromConfiguration(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var options = new NotificationStreamAccountAdmissionCacheOptions();
        configuration.GetSection(SectionName).Bind(options);
        options.Validate();
        return options;
    }

    internal void Validate()
    {
        if (MaxEntries <= 0 || MaxLogicalBytes <= 0 || MaxCapacityBytes < MaxLogicalBytes)
        {
            throw new InvalidOperationException("Notification stream account admission cache budgets are invalid.");
        }
    }
}

internal readonly record struct NotificationStreamAccountAdmissionCacheSnapshot(
    int Entries,
    long LogicalBytes,
    long CapacityBytes,
    int MaxEntries,
    long MaxLogicalBytes,
    long MaxCapacityBytes);

internal sealed class NotificationStreamAccountAdmissionCache
{
    private static readonly TimeSpan s_entryTtl = TimeSpan.FromSeconds(60);
    private const long EntryLogicalOverhead = 64;
    private const long EntryCapacityOverhead = 192;
    private readonly object _gate = new();
    private readonly Dictionary<int, CacheEntry> _entries = [];
    private readonly LinkedList<int> _insertionOrder = [];
    private readonly NotificationStreamAccountAdmissionCacheOptions _options;
    private readonly TimeProvider _timeProvider;
    private long _logicalBytes;
    private long _capacityBytes;

    public NotificationStreamAccountAdmissionCache()
        : this(new NotificationStreamAccountAdmissionCacheOptions(), TimeProvider.System)
    {
    }

    internal NotificationStreamAccountAdmissionCache(
        NotificationStreamAccountAdmissionCacheOptions options,
        TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(timeProvider);
        options.Validate();
        _options = options;
        _timeProvider = timeProvider;
    }

    public async Task<NotificationStreamAccountAdmissionCacheResult> GetOrCreateAsync(
        int accountId,
        IUserAccountReader users,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(users);
        lock (_gate)
        {
            long nowTicks = _timeProvider.GetUtcNow().UtcTicks;
            SweepExpiredLocked(nowTicks);
            if (_entries.TryGetValue(accountId, out CacheEntry? current))
            {
                return new NotificationStreamAccountAdmissionCacheResult(current.Account, Hit: true, LoadedFromDb: false);
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        UserAccountSnapshot? loaded = await users.GetAccountByIdAsync(accountId).ConfigureAwait(false);
        lock (_gate)
        {
            long nowTicks = _timeProvider.GetUtcNow().UtcTicks;
            SweepExpiredLocked(nowTicks);
            RemoveLocked(accountId);
            if (loaded.HasValue
                && AccountSubjectHashRequirement.TryResolve(loaded.Value.AccountSubjectHash, out _))
            {
                AddWithinBudgetLocked(accountId, loaded.Value, nowTicks + s_entryTtl.Ticks);
            }
        }

        return new NotificationStreamAccountAdmissionCacheResult(loaded, Hit: false, LoadedFromDb: true);
    }

    internal NotificationStreamAccountAdmissionCacheSnapshot Snapshot()
    {
        lock (_gate)
        {
            SweepExpiredLocked(_timeProvider.GetUtcNow().UtcTicks);
            return new NotificationStreamAccountAdmissionCacheSnapshot(
                _entries.Count,
                _logicalBytes,
                _capacityBytes,
                _options.MaxEntries,
                _options.MaxLogicalBytes,
                _options.MaxCapacityBytes);
        }
    }

    private void AddWithinBudgetLocked(int accountId, UserAccountSnapshot account, long expiresAtUtcTicks)
    {
        (long logicalBytes, long capacityBytes) = Measure(account);
        if (logicalBytes > _options.MaxLogicalBytes || capacityBytes > _options.MaxCapacityBytes)
        {
            return;
        }

        while (_insertionOrder.First is { } oldest
            && (_entries.Count >= _options.MaxEntries
                || _logicalBytes + logicalBytes > _options.MaxLogicalBytes
                || _capacityBytes + capacityBytes > _options.MaxCapacityBytes))
        {
            RemoveLocked(oldest.Value);
        }

        if (_entries.Count >= _options.MaxEntries
            || _logicalBytes + logicalBytes > _options.MaxLogicalBytes
            || _capacityBytes + capacityBytes > _options.MaxCapacityBytes)
        {
            return;
        }

        LinkedListNode<int> orderNode = _insertionOrder.AddLast(accountId);
        _entries.Add(accountId, new CacheEntry(account, expiresAtUtcTicks, logicalBytes, capacityBytes, orderNode));
        _logicalBytes += logicalBytes;
        _capacityBytes += capacityBytes;
    }

    private void SweepExpiredLocked(long nowTicks)
    {
        while (_insertionOrder.First is { } oldest
            && _entries.TryGetValue(oldest.Value, out CacheEntry? entry)
            && entry.ExpiresAtUtcTicks <= nowTicks)
        {
            RemoveLocked(oldest.Value);
        }
    }

    private void RemoveLocked(int accountId)
    {
        if (!_entries.Remove(accountId, out CacheEntry? removed))
        {
            return;
        }

        _insertionOrder.Remove(removed.OrderNode);
        _logicalBytes -= removed.LogicalBytes;
        _capacityBytes -= removed.CapacityBytes;
    }

    private static (long LogicalBytes, long CapacityBytes) Measure(UserAccountSnapshot account)
    {
        string?[] strings =
        [
            account.BanReason,
            account.PublicHandle,
            account.IdentityKind,
            account.AnonymousCredentialStatus,
            account.AnonymousCredentialLevel,
            account.AccountSubjectHash,
            account.RegistrationState
        ];
        long logicalBytes = EntryLogicalOverhead;
        long capacityBytes = EntryCapacityOverhead;
        foreach (string? value in strings)
        {
            if (value is null)
            {
                continue;
            }

            logicalBytes += Encoding.UTF8.GetByteCount(value);
            capacityBytes += 24L + (value.Length * sizeof(char));
        }

        return (logicalBytes, Math.Max(logicalBytes, capacityBytes));
    }

    private sealed record CacheEntry(
        UserAccountSnapshot Account,
        long ExpiresAtUtcTicks,
        long LogicalBytes,
        long CapacityBytes,
        LinkedListNode<int> OrderNode);
}
