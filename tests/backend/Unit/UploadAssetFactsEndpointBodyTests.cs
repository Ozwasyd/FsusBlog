using System.Buffers;
using System.Security.Claims;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UploadAssetFactsEndpointBodyTests
{
    [Theory]
    [InlineData(0, 0)]
    [InlineData(0, 1)]
    [InlineData(0, 4096)]
    [InlineData(1, 0)]
    [InlineData(70, 0)]
    public async Task UnknownLengthNonSeekableBody_OnlyExactFrameReachesObserver(int trim, int trailing)
    {
        var aeds = new AedsEncoder();
        byte[] frame = CreateFrame(aeds);
        Assert.Equal(80, frame.Length);
        byte[] body = [.. frame.AsSpan(0, frame.Length - trim).ToArray(), .. new byte[trailing]];
        await using var stream = new UnknownLengthStream(body);
        var pool = new RecordingPool();
        using ServiceProvider services = CreateServices(pool);
        DefaultHttpContext context = CreateContext(stream, services);
        IFileService observer = CreateObserver();

        var result = await BinaryEndpoints.HandleUploadAssetFactsAsync("upload", context, observer, aeds, CancellationToken.None);
        await result.ExecuteAsync(context);
        Result<AedsDecodeResult> decoded = aeds.TryDecode(((MemoryStream)context.Response.Body).ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var pod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(pod);
        Assert.Equal(trim == 0 && trailing == 0 ? ErrorCode.NotFound : ErrorCode.Validation, error.Code);
        Assert.Equal(trim == 0 && trailing == 0 ? 1 : 0, observer.ReceivedCalls().Count());
        Assert.Null(context.Request.ContentLength);
        Assert.False(stream.CanSeek);
        Assert.Equal("private, no-store", context.Response.Headers.CacheControl.ToString());
        Assert.Equal(0, pool.Outstanding);
        BinaryRequestBufferLeaseScope.Release(context, "test-cleanup");
        Assert.Equal(0, pool.Outstanding);
        await context.Request.BodyReader.CompleteAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationWhileAwaitingEof_DisposesPayloadWithoutObserving(bool cancelRequest)
    {
        var aeds = new AedsEncoder();
        await using var stream = new UnknownLengthStream(CreateFrame(aeds), blockAtEnd: true);
        var pool = new RecordingPool();
        using ServiceProvider services = CreateServices(pool);
        DefaultHttpContext context = CreateContext(stream, services);
        using var requestCancellation = new CancellationTokenSource();
        using var argumentCancellation = new CancellationTokenSource();
        context.RequestAborted = requestCancellation.Token;
        IFileService observer = CreateObserver();
        Task operation = BinaryEndpoints.HandleUploadAssetFactsAsync("upload", context, observer, aeds, argumentCancellation.Token);
        try
        {
            await stream.EofReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(operation.IsCompleted);
            (cancelRequest ? requestCancellation : argumentCancellation).Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
            Assert.Empty(observer.ReceivedCalls());
            Assert.Equal(0, pool.Outstanding);
        }
        finally
        {
            requestCancellation.Cancel();
            argumentCancellation.Cancel();
            try
            {
                await operation;
            }
            catch (OperationCanceledException)
            {
            }
            BinaryRequestBufferLeaseScope.Release(context, "test-cleanup");
            await context.Request.BodyReader.CompleteAsync();
        }
    }

    [Theory]
    [InlineData(false, ErrorCode.Unauthorized)]
    [InlineData(true, ErrorCode.Forbidden)]
    public async Task IdentityRefusal_DoesNotReadBodyOrObserve(bool authenticated, ErrorCode expected)
    {
        var aeds = new AedsEncoder();
        await using var stream = new UnknownLengthStream(CreateFrame(aeds));
        using ServiceProvider services = CreateServices(new RecordingPool());
        DefaultHttpContext context = CreateContext(stream, services);
        context.User = authenticated ? Principal(withPermission: false) : new ClaimsPrincipal();
        IFileService observer = CreateObserver();

        var result = await BinaryEndpoints.HandleUploadAssetFactsAsync("upload", context, observer, aeds, CancellationToken.None);
        await result.ExecuteAsync(context);
        Result<AedsDecodeResult> decoded = aeds.TryDecode(((MemoryStream)context.Response.Body).ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var pod));
        Assert.Equal(expected, PodBinaryCodec.ToErrorDetail(pod).Code);
        Assert.Equal(0, stream.ReadCalls);
        Assert.Empty(observer.ReceivedCalls());
    }

    [Fact]
    public async Task ExistingFrameRead_RemainsOptInAndDoesNotConsumeTrailingBody()
    {
        var aeds = new AedsEncoder();
        byte[] frame = CreateFrame(aeds);
        await using var stream = new UnknownLengthStream([.. frame, 1]);
        var pool = new RecordingPool();
        using ServiceProvider services = CreateServices(pool);
        DefaultHttpContext context = CreateContext(stream, services);
        using BinaryRequestPayload payload = await services.GetRequiredService<IBinaryEndpointRequestContext>()
            .ReadFrameAsync(context, aeds, AedsFrameType.UploadCompleteRequest, CancellationToken.None, 80);
        Assert.True(payload.IsSuccess);
        Assert.Equal(64, payload.Payload.Length);
        payload.Dispose();
        Assert.Equal(0, pool.Outstanding);
        BinaryRequestBufferLeaseScope.Release(context, "test-cleanup");
        await context.Request.BodyReader.CompleteAsync();
    }

    private static byte[] CreateFrame(AedsEncoder aeds)
        => aeds.Encode(AedsFrameType.UploadCompleteRequest, Encoding.ASCII.GetBytes(new string('a', 64)));

    private static ServiceProvider CreateServices(RecordingPool pool)
        => new ServiceCollection()
            .AddSingleton<IBinaryEndpointRequestContext>(new BinaryEndpointRequestContext(
                new BinaryRequestBinder(pool), Substitute.For<IHotArticlesCacheVersionProvider>()))
            .BuildServiceProvider();

    private static DefaultHttpContext CreateContext(Stream stream, IServiceProvider services)
    {
        var context = new DefaultHttpContext
        {
            User = Principal(withPermission: true), RequestServices = services
        };
        context.Request.Body = stream;
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = null;
        context.Request.Headers["X-Fsus-Upload-Token"] = "private-test-token";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static ClaimsPrincipal Principal(bool withPermission)
    {
        var identity = new ClaimsIdentity("test");
        identity.AddClaim(new Claim("identity_kind", "admin_principal"));
        identity.AddClaim(new Claim("admin_id", "1"));
        identity.AddClaim(new Claim("admin_sid", "session"));
        if (withPermission)
        {
            identity.AddClaim(new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite));
        }
        return new ClaimsPrincipal(identity);
    }

    private static IFileService CreateObserver()
    {
        IFileService observer = Substitute.For<IFileService>();
        observer.ObserveCommittedUploadAsync(Arg.Any<UploadSessionAccess>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(Result<UploadAssetObservation>.Failure(ErrorCode.NotFound, "observed")));
        observer.ClearReceivedCalls();
        return observer;
    }

    private sealed class RecordingPool : ArrayPool<byte>
    {
        private readonly HashSet<byte[]> _rented = [];
        public int Outstanding => _rented.Count;
        public override byte[] Rent(int minimumLength)
        {
            var bytes = new byte[minimumLength];
            Assert.True(_rented.Add(bytes));
            return bytes;
        }
        public override void Return(byte[] array, bool clearArray = false)
        {
            Assert.True(clearArray);
            Assert.True(_rented.Remove(array));
            Array.Clear(array);
        }
    }

    private sealed class UnknownLengthStream(byte[] bytes, bool blockAtEnd = false) : Stream
    {
        private int _offset;
        public TaskCompletionSource EofReadStarted
        {
            get;
        } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int ReadCalls
        {
            get; private set;
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            ReadCalls++;
            cancellationToken.ThrowIfCancellationRequested();
            if (_offset < bytes.Length)
            {
                int count = Math.Min(Math.Min(7, buffer.Length), bytes.Length - _offset);
                bytes.AsMemory(_offset, count).CopyTo(buffer);
                _offset += count;
                return count;
            }
            EofReadStarted.TrySetResult();
            if (blockAtEnd)
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            return 0;
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
