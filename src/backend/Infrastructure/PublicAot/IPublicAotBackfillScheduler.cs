namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotBackfillScheduler
{
    bool TrySchedule(PublicAotBackfillRequest request);
}
