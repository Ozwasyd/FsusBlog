namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotBackfillGenerator
{
    Task GenerateAndStoreAsync(PublicAotBackfillRequest request, CancellationToken cancellationToken = default);
}
