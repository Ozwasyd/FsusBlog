using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Security;

using SqlSugar;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class TestBanStateProjectionRuntime
{
    public static (BanStateProjection Projection, IBanStateProjectionObligationCoordinator Obligations) Create(
        ISqlSugarClient db)
    {
        var projection = new BanStateProjection(new Source(db));
        return (projection, new LocalObligations(projection));
    }

    private sealed class Source(ISqlSugarClient db) : IBanStateProjectionSource
    {
        public async ValueTask<BanStateProjectionUpdate?> LoadAsync(
            int accountId,
            string accountSubjectHash,
            CancellationToken cancellationToken = default)
        {
            Entities.User? user = await db.Queryable<Entities.User>()
                .Where(item => item.Id == accountId)
                .FirstAsync(cancellationToken);
            if (user?.AccountSubjectHash is null
                || !string.Equals(user.AccountSubjectHash, accountSubjectHash, StringComparison.Ordinal))
            {
                return null;
            }

            return BanStateProjectionFacts.Create(
                user.AccountSubjectHash,
                user.Status,
                user.BanStateGeneration);
        }
    }

    private sealed class LocalObligations(BanStateProjection projection)
        : IBanStateProjectionObligationCoordinator
    {
        public Task<DistributedInvalidationEvent?> PrepareAsync(
            IReadOnlyCollection<BanStateProjectionUpdate> updates,
            CancellationToken cancellationToken = default)
            => Task.FromResult<DistributedInvalidationEvent?>(null);

        public Task<DistributedInvalidationPublishResult?> ApplyLocalAndPublishPreparedAsync(
            DistributedInvalidationEvent? invalidation,
            IReadOnlyCollection<BanStateProjectionUpdate> updates,
            CancellationToken cancellationToken = default)
        {
            foreach (BanStateProjectionUpdate update in updates)
            {
                _ = projection.Apply(update);
            }
            return Task.FromResult<DistributedInvalidationPublishResult?>(null);
        }
    }
}
