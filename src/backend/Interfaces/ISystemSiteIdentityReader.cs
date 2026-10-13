using FsusBlog.Server.Models.ReadModels;

namespace FsusBlog.Server.Interfaces;

/// <summary>Reads the installation authority without provisioning or accepting caller identity assertions.</summary>
public interface ISystemSiteIdentityReader
{
    /// <summary>Only Current is authoritative. Storage and cancellation errors propagate.</summary>
    Task<SystemSiteIdentityReadModel> ReadCurrentSiteIdentityAsync(CancellationToken cancellationToken = default);
}
