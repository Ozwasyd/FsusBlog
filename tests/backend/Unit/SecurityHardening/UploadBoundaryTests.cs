using System.Net;
using System.Text;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit.SecurityHardening;

public sealed class UploadBoundaryTests
{
    [Fact]
    public async Task KestrelRuntime_UsesDeclaredUploadRequestLimit()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.ConfigureFsusKestrelSingleProcessRuntime();
        await using WebApplication app = builder.Build();

        KestrelServerOptions options = app.Services.GetRequiredService<IOptions<KestrelServerOptions>>().Value;

        Assert.Equal((long?)FileService.UploadRequestBodyLimitBytes, options.Limits.MaxRequestBodySize);
    }

    [Fact]
    public async Task UploadPartTestServer_RejectsWrongContentTypeBeforeTokenOrStorage()
    {
        IFileService files = Substitute.For<IFileService>();
        await using WebApplication server = await CreateServerAsync(files);
        using HttpClient client = server.GetTestClient();
        using HttpRequestMessage request = CreateRequest(new StringContent("payload", Encoding.UTF8, "text/plain"));

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        await files.DidNotReceiveWithAnyArgs().ValidateUploadSessionTokenAsync(default!, default, default);
        await files.DidNotReceiveWithAnyArgs().UploadPartAsync(default!, default, default, default!, default, default);
    }

    [Fact]
    public async Task UploadPartTestServer_RequiresLengthAndRejectsChunkedTransfer()
    {
        IFileService files = Substitute.For<IFileService>();
        files.ValidateUploadSessionTokenAsync(
                Arg.Any<string>(),
                Arg.Any<string?>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        await using WebApplication server = await CreateServerAsync(files);
        using HttpClient client = server.GetTestClient();
        using var content = new StreamContent(new NonSeekableReadStream([1, 2, 3]));
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
        using HttpRequestMessage request = CreateRequest(content);
        request.Headers.TransferEncodingChunked = true;

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.LengthRequired, response.StatusCode);
        await files.DidNotReceiveWithAnyArgs().UploadPartAsync(default!, default, default, default!, default, default);
    }

    [Fact]
    public async Task UploadPartHandler_RejectsDeclaredBodyAboveLimitBeforeStorage()
    {
        IFileService files = Substitute.For<IFileService>();
        files.ValidateUploadSessionTokenAsync(
                Arg.Any<string>(),
                Arg.Any<string?>(),
                Arg.Any<CancellationToken>())
            .Returns(true);
        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = FileService.UploadRequestBodyLimitBytes + 1;
        context.Request.Headers["X-Fsus-Upload-Token"] = "token";
        context.Request.Headers["X-Fsus-Upload-Part"] = "0";
        context.Request.Headers["X-Fsus-Upload-Offset"] = "0";
        context.Response.Body = new MemoryStream();
        var aeds = new AedsEncoder();

        BinaryFrameResult result = await BinaryEndpoints.HandleUploadPartAsync(
            "0123456789abcdef0123456789abcdef",
            context,
            files,
            aeds,
            CancellationToken.None);
        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status413PayloadTooLarge, context.Response.StatusCode);
        await files.DidNotReceiveWithAnyArgs().UploadPartAsync(default!, default, default, default!, default, default);
    }

    [Fact]
    public async Task FileService_RejectsAvifAndTraversalAtServiceBoundary()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = new FileService(new TestWebHostEnvironment(root), NullLogger<FileService>.Instance);

            Result<UploadInitDto> avif = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "payload.avif",
                MimeType = "image/avif",
                TargetFormat = "avif",
                TotalBytes = 1024,
                ChunkSize = 1024
            });
            Result<bool> traversal = await service.AbortUploadAsync("..%2foutside");

            Assert.False(avif.IsSuccess);
            Assert.Equal(ErrorCode.Validation, avif.Error.Code);
            Assert.False(traversal.IsSuccess);
            Assert.Equal(ErrorCode.Validation, traversal.Error.Code);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task FileService_CancelledPartDoesNotPublishProgressOrIncomingArtifact()
    {
        string root = CreateTempDirectory();
        try
        {
            var service = new FileService(new TestWebHostEnvironment(root), NullLogger<FileService>.Instance);
            Result<UploadInitDto> init = await service.InitUploadSessionAsync(new UploadInitRequestDto
            {
                FileName = "payload.png",
                MimeType = "image/png",
                TargetFormat = "png",
                TotalBytes = 8,
                ChunkSize = 8
            });
            Assert.True(init.IsSuccess);
            UploadInitDto initialized = Assert.IsType<UploadInitDto>(init.Value);
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();
            var part = new FormFile(new MemoryStream([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4]), 0, 8, "file", "part");

            try
            {
                Result<UploadPartAckDto> canceled = await service.UploadPartAsync(
                    initialized.UploadId,
                    0,
                    0,
                    part,
                    payloadHash: null,
                    cancellation.Token);
                Assert.False(canceled.IsSuccess);
            }
            catch (OperationCanceledException)
            {
                // The service is also allowed to preserve the cancellation signal.
            }

            Result<UploadStatusDto> status = await service.GetUploadStatusAsync(initialized.UploadId);
            Assert.True(status.IsSuccess);
            Assert.Equal(0, status.Value!.UploadedBytes);
            string incoming = Path.Combine(root, "wwwroot", "uploads", "illustration", ".incoming");
            Assert.False(Directory.Exists(incoming) && Directory.EnumerateFileSystemEntries(incoming).Any());
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task<WebApplication> CreateServerAsync(IFileService files)
    {
        var aeds = new AedsEncoder();
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Configuration.Sources.Clear();
        builder.Services.AddRouting();
        WebApplication app = builder.Build();
        app.UseRouting();
        app.MapPut(
            "/api/binary/upload/{uploadId}/part",
            async context =>
                    {
                        string uploadId = Assert.IsType<string>(context.Request.RouteValues["uploadId"]);
                        BinaryFrameResult result = await BinaryEndpoints.HandleUploadPartAsync(
                            uploadId,
                            context,
                            files,
                            aeds,
                            context.RequestAborted);
                        await result.ExecuteAsync(context);
                    });
        await app.StartAsync();
        return app;
    }

    private static HttpRequestMessage CreateRequest(HttpContent content)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Put,
            "/api/binary/upload/0123456789abcdef0123456789abcdef/part")
        {
            Content = content
        };
        request.Headers.Add("X-Fsus-Upload-Token", "token");
        request.Headers.Add("X-Fsus-Upload-Part", "0");
        request.Headers.Add("X-Fsus-Upload-Offset", "0");
        return request;
    }

    private static string CreateTempDirectory()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-upload-boundary-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(UploadBoundaryTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class NonSeekableReadStream(byte[] payload) : MemoryStream(payload)
    {
        public override bool CanSeek => false;
    }
}
