using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure.Helpers.Initializer;

public sealed record CacheInitializationRollbackEntry(int UserId, string AccountSubjectHash, Interfaces.BanStateSnapshot PreviousState);

public sealed record CacheInitializationResult(IReadOnlyList<CacheInitializationRollbackEntry> RollbackEntries)
{
    public static CacheInitializationResult Empty { get; } = new([]);
}

public interface ICacheInitializer
{
    Task<CacheInitializationResult> InitializeAsync();

    Task RollbackAsync(CacheInitializationResult result, CancellationToken cancellationToken = default);
}

/// <summary>
/// Compatibility boundary for the lifecycle bootstrap. Ban state now comes
/// from one bounded keyset authority scan; rollback is intentionally a no-op
/// because no external cache is mutated.
/// </summary>
public sealed class CacheInitializer(IBanStateProjectionAuthorityLoader loader) : ICacheInitializer
{
    public async Task<CacheInitializationResult> InitializeAsync()
    {
        _ = await loader.InitializeAsync().ConfigureAwait(false);
        return CacheInitializationResult.Empty;
    }

    public Task RollbackAsync(
        CacheInitializationResult result,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(result);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.CompletedTask;
    }
}
