using System.Security.Claims;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorSavedViewRequestBindingTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(42, "https://site.test");
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task Commands_UseRealStoreForAllNineOperations()
    {
        var fixture = new Fixture();
        Guid first = Guid.NewGuid();
        Guid second = Guid.NewGuid();
        AuthorSavedViewMutationResponse created = await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewCreateRequest(
            first, 0, Guid.NewGuid(), "First", Query()));
        Assert.Equal((1L, 1L), (created.ViewRevision, created.CollectionRevision));
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewCreateRequest(second, 1, Guid.NewGuid(), "Second", Query()));
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewUpdateRequest(first, 2, 1, Guid.NewGuid(), Query(50)));
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewRenameRequest(first, 3, 2, Guid.NewGuid(), "Renamed"));
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewPinRequest(first, 4, 3, Guid.NewGuid(), true));
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewPinRequest(second, 5, 1, Guid.NewGuid(), true));
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewReorderRequest(6, Guid.NewGuid(),
            [second, first], new Dictionary<Guid, long> { [first] = 4, [second] = 2 }));
        AuthorSavedViewPageResponse reordered = await fixture.Facade.ListResponseAsync(null, 25);
        Assert.Equal(new[] { second, first }, reordered.Items.Select(static item => item.Snapshot.ViewId));
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewMoveRequest(7, Guid.NewGuid(), [first], second,
            new Dictionary<Guid, long> { [first] = reordered.Items[1].Snapshot.Revision }));
        AuthorSavedViewPageResponse moved = await fixture.Facade.ListResponseAsync(null, 25);
        Assert.Equal(first, moved.Items[0].Snapshot.ViewId);
        long firstRevision = moved.Items[0].Snapshot.Revision;
        long secondRevision = moved.Items[1].Snapshot.Revision;
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewDefaultRequest(8, Guid.NewGuid(), first, firstRevision));
        Assert.Equal(first, (await fixture.Facade.ListResponseAsync(null, 25)).DefaultViewId);
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewRetireRequest(first, 9, firstRevision, Guid.NewGuid(),
            AuthorSavedViewDefaultDisposition.ReplaceWithView, second, secondRevision, "user-retired"));
        AuthorSavedViewPageResponse retired = await fixture.Facade.ListResponseAsync(null, 25);
        Assert.Equal(second, retired.DefaultViewId);
        Assert.Single(retired.Items);
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewDeleteRequest(second, 10, secondRevision, Guid.NewGuid(),
            AuthorSavedViewDefaultDisposition.ClearToSystem, null, null, "user-deleted"));
        AuthorSavedViewPageResponse deleted = await fixture.Facade.ListResponseAsync(null, 25);
        Assert.Empty(deleted.Items);
        Assert.Null(deleted.DefaultViewId);
        Assert.Equal(11, deleted.CollectionRevision);
        Assert.Equal(11, fixture.Persistence.Commits);
        Assert.All(fixture.Persistence.Owners, owner => Assert.Equal(s_owner, owner));
    }

    [Fact]
    public async Task CasAndIdempotency_RemainWithRealStore()
    {
        var fixture = new Fixture();
        var request = new AuthorSavedViewCreateRequest(Guid.NewGuid(), 0, Guid.NewGuid(), "Saved", Query());
        AuthorSavedViewMutationResponse first = await fixture.Facade.ApplyRequestAsync(request);
        AuthorSavedViewMutationResponse replay = await fixture.Facade.ApplyRequestAsync(request);
        Assert.True(replay.IdempotentReplay);
        Assert.Equal(first with
        {
            IdempotentReplay = true
        }, replay);
        Assert.Equal(1, fixture.Persistence.Commits);
        await Assert.ThrowsAsync<AuthorSavedViewCollectionRevisionConflictException>(() => fixture.Facade.ApplyRequestAsync(
            new AuthorSavedViewRenameRequest(request.ViewId, 0, 1, Guid.NewGuid(), "Stale")));
        await Assert.ThrowsAsync<AuthorSavedViewRevisionConflictException>(() => fixture.Facade.ApplyRequestAsync(
            new AuthorSavedViewRenameRequest(request.ViewId, 1, 7, Guid.NewGuid(), "Stale view")));
        await Assert.ThrowsAsync<AuthorSavedViewIdempotencyConflictException>(() => fixture.Facade.ApplyRequestAsync(
            request with
            {
                Name = "Different"
            }));
        Assert.Equal(1, fixture.Persistence.Commits);
    }

    [Fact]
    public async Task Responses_DetachQueryAndPreserveAtomicSnapshotCoordinates()
    {
        var fixture = new Fixture();
        Guid id = Guid.NewGuid();
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewCreateRequest(id, 0, Guid.NewGuid(), "Saved", Query()));
        AuthorSavedViewResponse response = Assert.IsType<AuthorSavedViewResponse>(await fixture.Facade.GetResponseAsync(id));
        AuthorSavedView stored = fixture.Persistence.Views.Single();
        Assert.Equal(id, response.Snapshot.ViewId);
        Assert.Equal(stored.Revision, response.Snapshot.Revision);
        Assert.Equal(stored.Query.PageSize, response.Snapshot.Query.PageSize);
        Assert.NotSame(stored.Query.Conditions, response.Snapshot.Query.Conditions);
        Assert.NotSame(stored.Query.Conditions[0].Values, response.Snapshot.Query.Conditions[0].Values);
        Assert.Throws<NotSupportedException>(() => ((IList<string>)response.Snapshot.Query.Conditions[0].Values)[0] = "draft");
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewUpdateRequest(id, 1, 1, Guid.NewGuid(), Query(50)));
        AuthorSavedViewResponse next = Assert.IsType<AuthorSavedViewResponse>(await fixture.Facade.GetResponseAsync(id));
        Assert.Equal((1L, 25), (response.Snapshot.Revision, response.Snapshot.Query.PageSize));
        Assert.Equal((2L, 50), (next.Snapshot.Revision, next.Snapshot.Query.PageSize));
        Assert.DoesNotContain(typeof(AuthorSavedViewResponse).GetProperties(), static property => property.Name == "Owner");
    }

    [Fact]
    public async Task IdentityAndCancellationGuards_CoverProjectedResponsesAndWrites()
    {
        var fixture = new Fixture();
        Guid id = Guid.NewGuid();
        await fixture.Facade.ApplyRequestAsync(new AuthorSavedViewCreateRequest(id, 0, Guid.NewGuid(), "Saved", Query()));
        fixture.Persistence.BeforeReadReturn = () => fixture.Accessor.HttpContext!.User = Principal("new-session");
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.GetResponseAsync(id));
        fixture.Accessor.HttpContext!.User = Principal("session-42");
        fixture.Persistence.BeforeReadReturn = () => fixture.Configuration["SITE_BASEURL"] = "https://other.test";
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.ListResponseAsync(null, 25));
        fixture.Configuration["SITE_BASEURL"] = "https://site.test";
        fixture.Persistence.BeforeReadReturn = null;
        fixture.Persistence.BeforeWriteReturn = () => fixture.Accessor.HttpContext!.User = Principal("new-session");
        var rename = new AuthorSavedViewRenameRequest(id, 1, 1, Guid.NewGuid(), "Renamed");
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.ApplyRequestAsync(rename));
        fixture.Accessor.HttpContext!.User = Principal("session-42");
        fixture.Persistence.BeforeWriteReturn = null;
        Assert.True((await fixture.Facade.ApplyRequestAsync(rename)).IdempotentReplay);
        using var cancellation = new CancellationTokenSource();
        fixture.Persistence.BeforeReadReturn = cancellation.Cancel;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Facade.GetResponseAsync(id, cancellation.Token));
        fixture.Persistence.BeforeReadReturn = null;
        fixture.Accessor.HttpContext!.User = Principal("session-42", permitted: false);
        int commits = fixture.Persistence.Commits;
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.ApplyRequestAsync(rename));
        Assert.Equal(commits, fixture.Persistence.Commits);
    }

    [Fact]
    public async Task StoreUnavailable_DoesNotBecomeEmptyOrSuccessfulResponse()
    {
        var fixture = new Fixture();
        var failure = new IOException("storage unavailable");
        fixture.Persistence.BeforeReadReturn = () => throw failure;
        Assert.Same(failure, await Assert.ThrowsAsync<IOException>(() => fixture.Facade.ListResponseAsync(null, 25)));
        fixture.Persistence.BeforeWrite = () => throw failure;
        Assert.Same(failure, await Assert.ThrowsAsync<IOException>(() => fixture.Facade.ApplyRequestAsync(
            new AuthorSavedViewCreateRequest(Guid.NewGuid(), 0, Guid.NewGuid(), "Saved", Query()))));
        Assert.Equal(0, fixture.Persistence.Commits);
    }

    [Fact]
    public async Task AutomationWithoutAuthenticatedRequest_CannotReadOrWritePrivateViews()
    {
        var fixture = new Fixture();
        fixture.Accessor.HttpContext = null;
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.GetResponseAsync(Guid.NewGuid()));
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.ListResponseAsync(null, 25));
        await Assert.ThrowsAsync<AuthorSavedViewAccessDeniedException>(() => fixture.Facade.ApplyRequestAsync(
            new AuthorSavedViewCreateRequest(Guid.NewGuid(), 0, Guid.NewGuid(), "Saved", Query())));
        Assert.Empty(fixture.Persistence.Owners);
        Assert.Equal(0, fixture.Persistence.Commits);
    }

    [Fact]
    public async Task MissingDependency_RemainsRejectedByExistingValidatorBeforeCommit()
    {
        var fixture = new Fixture();
        AuthorSavedViewQuery query = Query() with
        {
            Conditions = [new(new(AuthorSavedViewFieldKind.Category, "category:1"), "identity.equals", ["1"])]
        };
        await Assert.ThrowsAsync<AuthorSavedViewDependencyException>(() => fixture.Facade.ApplyRequestAsync(
            new AuthorSavedViewCreateRequest(Guid.NewGuid(), 0, Guid.NewGuid(), "Missing dependency", query)));
        Assert.Empty(fixture.Persistence.Views);
        Assert.Equal(0, fixture.Persistence.Commits);
    }

    [Fact]
    public void Codec_DecodesOnlyTrustedOperationAndAllNineClosedShapes()
    {
        Guid id = Guid.NewGuid();
        Guid requestId = Guid.NewGuid();
        (AuthorSavedViewRequestOperation Operation, AuthorSavedViewCommandRequest Input)[] inputs =
        [
            (AuthorSavedViewRequestOperation.Create, new AuthorSavedViewCreateRequest(id, 17, requestId, "Saved", Query())),
            (AuthorSavedViewRequestOperation.Update, new AuthorSavedViewUpdateRequest(id, 17, 19, requestId, Query())),
            (AuthorSavedViewRequestOperation.Rename, new AuthorSavedViewRenameRequest(id, 17, 19, requestId, "Renamed")),
            (AuthorSavedViewRequestOperation.Pin, new AuthorSavedViewPinRequest(id, 17, 19, requestId, true)),
            (AuthorSavedViewRequestOperation.Reorder, new AuthorSavedViewReorderRequest(17, requestId, [id], new Dictionary<Guid, long> { [id] = 19 })),
            (AuthorSavedViewRequestOperation.Move, new AuthorSavedViewMoveRequest(17, requestId, [id], null, new Dictionary<Guid, long> { [id] = 19 })),
            (AuthorSavedViewRequestOperation.Default, new AuthorSavedViewDefaultRequest(17, requestId, null, null)),
            (AuthorSavedViewRequestOperation.Retire, new AuthorSavedViewRetireRequest(id, 17, 19, requestId, AuthorSavedViewDefaultDisposition.ClearToSystem, null, null, "user-retired")),
            (AuthorSavedViewRequestOperation.Delete, new AuthorSavedViewDeleteRequest(id, 17, 19, requestId, AuthorSavedViewDefaultDisposition.ClearToSystem, null, null, "user-deleted"))
        ];
        foreach ((AuthorSavedViewRequestOperation operation, AuthorSavedViewCommandRequest input) in inputs)
        {
            byte[] payload = JsonSerializer.SerializeToUtf8Bytes(input, input.GetType(), s_json);
            AuthorSavedViewCommandRequest decoded = AuthorSavedViewRequestCodec.Decode(operation, payload);
            Assert.Equal(input.GetType(), decoded.GetType());
            Assert.Equal(payload, JsonSerializer.SerializeToUtf8Bytes(decoded, decoded.GetType(), s_json));
        }
        Assert.Throws<AuthorSavedViewValidationException>(() => AuthorSavedViewRequestCodec.Decode(
            (AuthorSavedViewRequestOperation)999, Encoding.UTF8.GetBytes("{}")));
    }

    [Fact]
    public void Codec_RejectsUnknownDuplicateMissingAndPrivateAuthorityFields()
    {
        byte[] valid = JsonSerializer.SerializeToUtf8Bytes(new AuthorSavedViewRenameRequest(
            Guid.NewGuid(), 17, 19, Guid.NewGuid(), "private-value"), s_json);
        string json = Encoding.UTF8.GetString(valid);
        string[] invalid =
        [
            json.Insert(1, "\"owner\":{\"adminPrincipalId\":81,\"siteScope\":\"https://other.test\"},"),
            json.Insert(1, "\"siteScope\":\"https://other.test\","),
            json.Insert(1, "\"expectedViewRevision\":19,"),
            json.Insert(1, "\"expected\\u0056iewRevision\":19,"),
            json.Replace("\"expectedViewRevision\":19,", "", StringComparison.Ordinal),
            json.Replace("\"expectedViewRevision\"", "\"ExpectedViewRevision\"", StringComparison.Ordinal),
            json.Replace("\"private-value\"", "null", StringComparison.Ordinal),
            "null", "{}", "[]", json + "{}"
        ];
        foreach (string input in invalid)
        {
            AuthorSavedViewValidationException error = Assert.Throws<AuthorSavedViewValidationException>(() =>
                AuthorSavedViewRequestCodec.Decode(AuthorSavedViewRequestOperation.Rename, Encoding.UTF8.GetBytes(input)));
            Assert.Equal("saved_view_request_invalid", error.Message);
            Assert.Null(error.InnerException);
        }
        string nested = Encoding.UTF8.GetString(JsonSerializer.SerializeToUtf8Bytes(new AuthorSavedViewCreateRequest(
            Guid.NewGuid(), 0, Guid.NewGuid(), "Saved", Query()), s_json));
        nested = nested.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"sql\":\"private-value\"", StringComparison.Ordinal);
        Assert.Throws<AuthorSavedViewValidationException>(() => AuthorSavedViewRequestCodec.Decode(
            AuthorSavedViewRequestOperation.Create, Encoding.UTF8.GetBytes(nested)));

        Guid id = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        string reorder = Encoding.UTF8.GetString(JsonSerializer.SerializeToUtf8Bytes(new AuthorSavedViewReorderRequest(
            17, Guid.NewGuid(), [id], new Dictionary<Guid, long> { [id] = 19 }), s_json));
        reorder = reorder.Replace($"\"{id:D}\":19", $"\"{id:D}\":19,\"{id.ToString("D").ToUpperInvariant()}\":20", StringComparison.Ordinal);
        Assert.Throws<AuthorSavedViewValidationException>(() => AuthorSavedViewRequestCodec.Decode(
            AuthorSavedViewRequestOperation.Reorder, Encoding.UTF8.GetBytes(reorder)));
    }

    [Fact]
    public void Codec_EnforcesPayloadDepthAndNodeBounds()
    {
        byte[][] invalid =
        [
            [], new byte[AuthorSavedViewRequestCodec.MaxPayloadBytes + 1],
            Encoding.UTF8.GetBytes(new string('[', 17) + "0" + new string(']', 17)),
            Encoding.UTF8.GetBytes("[" + string.Join(',', Enumerable.Repeat("0", 65_537)) + "]")
        ];
        foreach (byte[] payload in invalid)
        {
            Assert.Throws<AuthorSavedViewValidationException>(() => AuthorSavedViewRequestCodec.Decode(
                AuthorSavedViewRequestOperation.Rename, payload));
        }
    }

    private static AuthorSavedViewQuery Query(int pageSize = 25)
        => new(AuthorSavedViewContract.SchemaVersion,
            [new(new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
                "identity.equals", ["published"])],
            new(new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField),
                AuthorSavedViewSortDirection.Ascending, AuthorSavedViewNullPlacement.Last, "ordinal"),
            [new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField)], pageSize);

    private static ClaimsPrincipal Principal(string session, bool permitted = true)
        => new(new ClaimsIdentity(
            [new("identity_kind", "admin_principal"), new("admin_id", "42"),
                new("admin_sid", session),
                new(AdminPermissions.PermissionClaimType, permitted ? AdminPermissions.ArticleWrite : "none")], "test"));

    private sealed class Fixture
    {
        public LocalPersistence Persistence { get; } = new();
        public HttpContextAccessor Accessor { get; } = new() { HttpContext = new DefaultHttpContext { User = Principal("session-42") } };
        public IConfigurationRoot Configuration
        {
            get;
        } = new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.test" }).Build();
        public AuthorSavedViewApplicationFacade Facade
        {
            get;
        }

        public Fixture()
        {
            Facade = new(new AuthorSavedViewStore(Persistence,
                new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([])), TimeProvider.System),
                Accessor, Configuration);
        }
    }

    // Ordinary request-binding fixture only. The production store creates mutations;
    // verifier/history audit entry points deliberately cannot run in this test class.
    private sealed class LocalPersistence : IAuthorSavedViewPersistence, IAuthorSavedViewPersistenceTransaction
    {
        private readonly Dictionary<Guid, AuthorSavedViewWriteReceipt> _receipts = [];
        private readonly List<AuthorSavedView> _views = [];
        private long? _proposedOrderKey;
        public AuthorSavedViewCollection Collection { get; private set; } = AuthorSavedViewCollection.Empty(s_owner);
        public IReadOnlyList<AuthorSavedView> Views => _views;
        public List<AuthorSavedViewOwner> Owners { get; } = [];
        public int Commits
        {
            get; private set;
        }
        public Action? BeforeReadReturn
        {
            get; set;
        }
        public Action? BeforeWrite
        {
            get; set;
        }
        public Action? BeforeWriteReturn
        {
            get; set;
        }

        public Task<AuthorSavedView?> ReadViewAsync(AuthorSavedViewOwner owner, Guid viewId, CancellationToken cancellationToken = default)
        {
            Owners.Add(owner);
            BeforeReadReturn?.Invoke();
            return Task.FromResult(_views.FirstOrDefault(view => view.Id == viewId));
        }

        public Task<AuthorSavedViewPage> ReadPageAsync(AuthorSavedViewOwner owner, AuthorSavedViewPageCursor? cursor,
            int limit, CancellationToken cancellationToken = default)
        {
            Owners.Add(owner);
            Assert.Null(cursor);
            AuthorSavedView[] items = [.. _views.Where(static view => view.LifecycleState == AuthorSavedViewLifecycleState.Active)
                .OrderByDescending(static view => view.Pinned).ThenBy(static view => view.OrderKey).ThenBy(static view => view.Id).Take(limit)];
            BeforeReadReturn?.Invoke();
            return Task.FromResult(new AuthorSavedViewPage(items, null, Collection.Revision, Collection.DefaultViewId));
        }

        public async Task<T> ExecuteAsync<T>(AuthorSavedViewOwner owner,
            Func<IAuthorSavedViewPersistenceTransaction, CancellationToken, Task<T>> operation, CancellationToken cancellationToken = default)
        {
            Owners.Add(owner);
            BeforeWrite?.Invoke();
            T result = await operation(this, cancellationToken);
            BeforeWriteReturn?.Invoke();
            return result;
        }

        public Task<AuthorSavedViewVerificationHistory> ReadVerificationHistoryAsync(AuthorSavedViewOwner owner,
            CancellationToken cancellationToken = default) => throw new NotSupportedException("audit outside permitted test scope");

        public Task<AuthorSavedViewWriteReceipt?> ReadReceiptAsync(Guid requestId, CancellationToken cancellationToken = default)
            => Task.FromResult(_receipts.GetValueOrDefault(requestId));

        public Task CommitAsync(AuthorSavedViewPersistenceMutation mutation, AuthorSavedViewWriteReceipt receipt,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _views.RemoveAll(view => mutation.Deletes.Contains(view.Id) || mutation.Upserts.Any(upsert => upsert.Id == view.Id));
            _views.AddRange(mutation.Upserts);
            Collection = mutation.Collection;
            _receipts.Add(receipt.RequestId, receipt);
            Commits++;
            return Task.CompletedTask;
        }

        public void SetProposedOrderKey(long value) => _proposedOrderKey = value;

        public bool TryTakeProposedOrderKey(out long value)
        {
            value = _proposedOrderKey ?? 0;
            bool present = _proposedOrderKey.HasValue;
            _proposedOrderKey = null;
            return present;
        }
    }
}
