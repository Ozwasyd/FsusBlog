using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Services.Authoring;

public sealed class ServerDraftConflictException(ServerDraftConflictResponse conflict)
    : Exception("draft_conflict")
{
    public ServerDraftConflictResponse Conflict { get; } = conflict;
}
