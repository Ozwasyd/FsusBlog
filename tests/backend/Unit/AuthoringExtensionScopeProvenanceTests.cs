using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringExtensionScopeProvenanceTests
{
    [Theory]
    [InlineData("1")]
    [InlineData("document:article:1")]
    [InlineData("unsaved-draft")]
    public void Documents_RefuseBeforeAnyPersistence(string document)
    {
        var authority = new AuthoringExtensionScopeProvenanceAuthority(null!);
        AuthoringStateScope scope = AuthoringStateProcessWorker.Scope(AuthoringStateProcessWorker.Package("1.0.0", 1)) with
        {
            DocumentId = document
        };
        Assert.Throws<AuthoringExtensionContractException>(() => authority.AcquireAsync(new DefaultHttpContext(),
            AuthoringApprovalOperation.Deletion, scope, null, default));
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(1, false)]
    [InlineData(2, true)]
    [InlineData(999, true)]
    public void InvalidOperationShape_RefusesBeforeAnyPersistence(int operation, bool destination)
    {
        var authority = new AuthoringExtensionScopeProvenanceAuthority(null!);
        AuthoringStateScope scope = AuthoringStateProcessWorker.Scope(AuthoringStateProcessWorker.Package("1.0.0", 1)) with
        {
            DocumentId = null
        };
        Assert.Throws<AuthoringExtensionContractException>(() => authority.AcquireAsync(new DefaultHttpContext(),
            (AuthoringApprovalOperation)operation, scope, destination ? scope with
            {
                ExtensionVersion = "2.0.0"
            } : null, default));
    }

    [Theory]
    [InlineData("user")]
    [InlineData("site")]
    [InlineData("extension")]
    [InlineData("document")]
    public void CrossOwnerDestination_RefusesBeforeAnyPersistence(string change)
    {
        var authority = new AuthoringExtensionScopeProvenanceAuthority(null!);
        AuthoringStateScope scope = AuthoringStateProcessWorker.Scope(AuthoringStateProcessWorker.Package("1.0.0", 1)) with
        {
            DocumentId = null
        };
        AuthoringStateScope destination = scope with
        {
            ExtensionVersion = "2.0.0"
        };
        destination = change switch
        {
            "user" => destination with { UserId = "foreign" },
            "site" => destination with { SiteId = "foreign" },
            "extension" => destination with { ExtensionId = "foreign" },
            _ => destination with { DocumentId = "document:article:1" }
        };
        Assert.Throws<AuthoringExtensionContractException>(() => authority.AcquireAsync(new DefaultHttpContext(),
            AuthoringApprovalOperation.Migration, scope, destination, default));
    }
}
