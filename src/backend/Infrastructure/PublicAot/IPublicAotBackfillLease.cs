namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotBackfillLease
{
    ValueTask<IPublicAotBackfillLeaseHandle?> TryAcquireAsync(
        PublicAotBackfillRequest request,
        CancellationToken cancellationToken = default);
}

public interface IPublicAotBackfillLeaseHandle : IAsyncDisposable
{
    TimeSpan RenewInterval
    {
        get;
    }

    Task<bool> RenewAsync(CancellationToken cancellationToken = default);
}
