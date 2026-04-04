using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct TokenResponsePod
{
    public readonly Utf8Fixed512 AccessToken;
    public readonly Utf8Fixed512 RefreshToken;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct LoginResponsePod
{
    public readonly int Id;
    public readonly Utf8Fixed64 Username;
    public readonly Utf8Fixed32 Role;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserListItemPod
{
    public readonly int Id;
    public readonly int Status;
    public readonly long CreateTimeUnixMs;
    public readonly long LastLoginTimeUnixMs;
    public readonly Utf8Fixed64 Username;
    public readonly Utf8Fixed32 Role;
    public readonly Utf8Fixed64 LastLoginIp;
    public readonly byte HasLastLoginIp;
    public readonly byte HasLastLoginTime;
    public readonly ushort Reserved;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserListPagePod
{
    public readonly PagedPodEnvelope Envelope;
}
