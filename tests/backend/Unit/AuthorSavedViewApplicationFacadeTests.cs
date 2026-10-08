using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorSavedViewApplicationFacadeTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(42, "https://site.test");

    [Fact]
    public async Task Reads_DeriveOwnerFromEachAuthenticatedRequestAndConfiguredSite()
    {
        var fixture = new Fixture();
        Guid viewId = Guid.CreateVersion7();
        await fixture.Facade.GetAsync(viewId);
        await fixture.Facade.ListAsync(null, 25);
        await fixture.Facade.VerifyAsync();
        Assert.Equal(3, fixture.Store.Calls.Count);
        Assert.All(fixture.Store.Calls, call => Assert.Equal(s_owner, call.Owner));
        Assert.Equal(viewId, fixture.Store.Calls[0].Input);
        Assert.Equal((null, 25), ((AuthorSavedViewPageCursor?, int))fixture.Store.Calls[1].Input!);

        fixture.Accessor.HttpContext!.User = Principal("second", "81");
        fixture.Configuration["SITE_BASEURL"] = "https://second.test/";
        await fixture.Facade.GetAsync(viewId);
        Assert.Equal(new AuthorSavedViewOwner(81, "https://second.test"), fixture.Store.Calls[^1].Owner);
    }

    [Theory]
    [InlineData("unauthenticated")]
    [InlineData("anonymous")]
    [InlineData("missing-session")]
    [InlineData("blank-session")]
    [InlineData("missing-permission")]
    [InlineData("invalid-principal")]
    [InlineData("missing-context")]
    public async Task InvalidRequestIdentity_IsDeniedBeforeAnyStoreReadOrWrite(string refusal)
    {
        var fixture = new Fixture();
        fixture.Accessor.HttpContext = refusal == "missing-context"
            ? null
            : new DefaultHttpContext
            {
                User = Principal(
                    refusal == "missing-session" ? null : refusal == "blank-session" ? " " : "session-42",
                    refusal == "invalid-principal" ? "0" : "42",
                    authenticated: refusal != "unauthenticated",
                    administrator: refusal != "anonymous",
                    permitted: refusal != "missing-permission")
            };

        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.GetAsync(Guid.NewGuid()));
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.ListAsync(null, 10));
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.VerifyAsync());
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.CreateAsync(Create(s_owner)));
        Assert.Empty(fixture.Store.Calls);
    }

    [Theory]
    [InlineData(81, "https://site.test")]
    [InlineData(42, "https://other.test")]
    public async Task EveryCommand_RejectsCrossUserOrSiteBeforeStore(long principalId, string site)
    {
        var fixture = new Fixture();
        await InvokeCommandsAsync(fixture.Facade, new(principalId, site), denied: true);
        Assert.Empty(fixture.Store.Calls);
    }

    [Fact]
    public async Task EveryCommand_PreservesOriginalCasIdempotencyAndStoreExceptions()
    {
        var fixture = new Fixture();
        await InvokeCommandsAsync(fixture.Facade, s_owner, denied: false);
        Assert.Equal(9, fixture.Store.Calls.Count);
        Assert.All(fixture.Store.Calls, call => Assert.Equal(s_owner, call.Owner));
        CreateAuthorSavedViewCommand create = Assert.IsType<CreateAuthorSavedViewCommand>(fixture.Store.Calls[0].Input);
        Assert.Equal(17, create.ExpectedCollectionRevision);
        Assert.NotEqual(Guid.Empty, create.RequestId);
        UpdateAuthorSavedViewCommand update = Assert.IsType<UpdateAuthorSavedViewCommand>(fixture.Store.Calls[1].Input);
        Assert.Equal(19, update.ExpectedViewRevision);
        Assert.Equal(17, update.ExpectedCollectionRevision);

        var conflict = new AuthorSavedViewRevisionConflictException(19, 20);
        fixture.Store.BeforeReturn = () => throw conflict;
        Assert.Same(conflict, await Assert.ThrowsAsync<AuthorSavedViewRevisionConflictException>(() =>
            fixture.Facade.UpdateAsync(update)));
    }

    [Theory]
    [InlineData("principal")]
    [InlineData("session")]
    [InlineData("site")]
    [InlineData("permission")]
    public async Task IdentityChangeDuringStoreAwait_DoesNotExposePriorPrivateResponse(string drift)
    {
        var fixture = new Fixture();
        fixture.Store.BeforeReturn = () =>
        {
            if (drift == "site")
            {
                fixture.Configuration["SITE_BASEURL"] = "https://new.test";
            }
            else
            {
                fixture.Accessor.HttpContext!.User = Principal(
                    drift == "session" ? "new-session" : "session-42",
                    drift == "principal" ? "81" : "42",
                    permitted: drift != "permission");
            }
        };
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.ListAsync(null, 25));
        Assert.Single(fixture.Store.Calls);
    }

    [Fact]
    public async Task Cancellation_IsCheckedBeforeAndAfterStoreAwaitWithoutFallback()
    {
        var fixture = new Fixture();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Facade.ListAsync(null, 25, cancellation.Token));
        Assert.Empty(fixture.Store.Calls);

        using var duringAwait = new CancellationTokenSource();
        fixture.Store.BeforeReturn = duringAwait.Cancel;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Facade.ListAsync(null, 25, duringAwait.Token));
        Assert.Equal(duringAwait.Token, Assert.Single(fixture.Store.Calls).Token);
    }

    private static async Task InvokeCommandsAsync(
        AuthorSavedViewApplicationFacade facade,
        AuthorSavedViewOwner owner,
        bool denied)
    {
        Guid id = Guid.NewGuid();
        Guid requestId = Guid.NewGuid();
        var revisions = new Dictionary<Guid, long> { [id] = 19 };
        Func<Task>[] commands =
        [
            () => facade.CreateAsync(Create(owner)),
            () => facade.UpdateAsync(new(id, owner, 17, 19, requestId, Query())),
            () => facade.RenameAsync(new(id, owner, 17, 19, requestId, "renamed")),
            () => facade.SetPinnedAsync(new(id, owner, 17, 19, requestId, true)),
            () => facade.ReorderPinnedAsync(new(owner, 17, requestId, [id], revisions)),
            () => facade.MovePinnedAsync(new(owner, 17, requestId, [id], null, revisions)),
            () => facade.SetDefaultAsync(new(owner, 17, requestId, id, 19)),
            () => facade.RetireAsync(new(id, owner, 17, 19, requestId,
                AuthorSavedViewDefaultDisposition.ClearToSystem, null, null, "retire")),
            () => facade.DeleteAsync(new(id, owner, 17, 19, requestId,
                AuthorSavedViewDefaultDisposition.ClearToSystem, null, null, "delete"))
        ];
        foreach (Func<Task> command in commands)
        {
            if (denied)
            {
                await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(command);
            }
            else
            {
                await command();
            }
        }
    }

    private static CreateAuthorSavedViewCommand Create(AuthorSavedViewOwner owner)
        => new(Guid.NewGuid(), owner, 17, Guid.NewGuid(), "Saved", Query());

    private static AuthorSavedViewQuery Query()
        => new(AuthorSavedViewContract.SchemaVersion, [],
            new(new(AuthorSavedViewFieldKind.Date, AuthorSavedViewContract.UpdatedAtField),
                AuthorSavedViewSortDirection.Descending, AuthorSavedViewNullPlacement.Last, "temporal"), [], 25);

    private static ClaimsPrincipal Principal(
        string? session = "session-42",
        string principalId = "42",
        bool authenticated = true,
        bool administrator = true,
        bool permitted = true)
    {
        var claims = new List<Claim>
        {
            new("identity_kind", administrator ? "admin_principal" : "anonymous_account"),
            new("admin_id", principalId)
        };
        if (session is not null)
        {
            claims.Add(new("admin_sid", session));
        }
        if (permitted)
        {
            claims.Add(new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite));
        }
        return new(new ClaimsIdentity(claims, authenticated ? "test" : null));
    }

    private sealed class Fixture
    {
        public CapturingStore Store
        {
            get;
        } = new();
        public HttpContextAccessor Accessor
        {
            get;
        } = new()
        {
            HttpContext = new DefaultHttpContext
            {
                User = Principal()
            }
        };
        public IConfiguration Configuration
        {
            get;
        } = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["SITE_BASEURL"] = " https://site.test/ "
            }).Build();
        public AuthorSavedViewApplicationFacade Facade => new(Store, Accessor, Configuration);
    }

    private sealed record Call(AuthorSavedViewOwner Owner, object? Input, CancellationToken Token);

    private sealed class CapturingStore : IAuthorSavedViewStore
    {
        public List<Call> Calls
        {
            get;
        } = [];
        public Action? BeforeReturn
        {
            get; set;
        }

        private async Task<T> Capture<T>(AuthorSavedViewOwner owner, object? input, CancellationToken token)
        {
            Calls.Add(new(owner, input, token));
            await Task.Yield();
            BeforeReturn?.Invoke();
            return default(T)!;
        }

        public Task<AuthorSavedView?> GetAsync(AuthorSavedViewOwner owner, Guid viewId, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedView?>(owner, viewId, cancellationToken);
        public Task<AuthorSavedViewPage> ListAsync(AuthorSavedViewOwner owner, AuthorSavedViewPageCursor? cursor, int limit, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewPage>(owner, (cursor, limit), cancellationToken);
        public Task<AuthorSavedViewVerificationResult> VerifyAsync(AuthorSavedViewOwner owner, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewVerificationResult>(owner, null, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> CreateAsync(CreateAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> UpdateAsync(UpdateAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> RenameAsync(RenameAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> SetPinnedAsync(SetAuthorSavedViewPinnedCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> ReorderPinnedAsync(ReorderAuthorSavedViewsCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> MovePinnedAsync(MoveAuthorSavedViewsCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> SetDefaultAsync(SetDefaultAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> RetireAsync(RetireAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
        public Task<AuthorSavedViewWriteReceipt> DeleteAsync(DeleteAuthorSavedViewCommand command, CancellationToken cancellationToken = default)
            => Capture<AuthorSavedViewWriteReceipt>(command.Owner, command, cancellationToken);
    }
}
