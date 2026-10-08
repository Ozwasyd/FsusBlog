using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "ArticleVaultLeaseProtocol")]
public sealed class ArticleVaultLeaseProtocolTests
{
    internal static ArticleVaultAgentBinding Binding
    {
        get;
    } = new(
        "site-test", "vault-test", "device-test", "agent-test", "session-test",
        new string('a', 64), new string('b', 64), "1.0.0", 1);

    [Fact]
    public void LiveOrStaleReceipt_CannotBeImplicitlyPreempted()
    {
        ArticleVaultWriterLeaseReceipt lease = Acquire();
        foreach (long now in new long[] { 1, 60001 })
        {
            Assert.Throws<InvalidDataException>(() => ArticleVaultWriterLease.Transition(
                lease, Binding with
                {
                    AgentInstanceIdentity = "agent-other"
                },
                ArticleVaultWriterLeaseAction.Acquire, lease.ContentSha256, now));
        }
    }

    [Fact]
    public void ExpirationAndReacquisition_FenceOldGenerationAndReceipt()
    {
        ArticleVaultWriterLeaseReceipt lease = Acquire();
        ArticleVaultWriterLeaseReceipt expired = ArticleVaultWriterLease.Transition(
            lease, Binding, ArticleVaultWriterLeaseAction.Expire, lease.ContentSha256, 60000);
        ArticleVaultWriterLeaseReceipt next = ArticleVaultWriterLease.Transition(
            expired, Binding with
            {
                AgentInstanceIdentity = "agent-other"
            },
            ArticleVaultWriterLeaseAction.Acquire, expired.ContentSha256, 60001);
        Assert.Equal(2, next.Generation);
        Assert.Equal(expired.ContentSha256, next.PreviousReceiptSha256);
        Assert.True(ArticleVaultWriterLease.Verify(next));
        Assert.Throws<InvalidDataException>(() => ArticleVaultWriterLease.Transition(
            next, Binding, ArticleVaultWriterLeaseAction.Renew, lease.ContentSha256, 60002));
    }

    [Theory]
    [InlineData(ArticleVaultWriterLeaseAction.Renew)]
    [InlineData(ArticleVaultWriterLeaseAction.Release)]
    [InlineData(ArticleVaultWriterLeaseAction.Revoke)]
    [InlineData(ArticleVaultWriterLeaseAction.Expire)]
    public void EveryOwnerTransition_RejectsAnotherSession(ArticleVaultWriterLeaseAction action)
    {
        ArticleVaultWriterLeaseReceipt lease = Acquire();
        Assert.Throws<InvalidDataException>(() => ArticleVaultWriterLease.Transition(
            lease, Binding with
            {
                UserSessionIdentity = "another-session"
            }, action, lease.ContentSha256, 60000));
    }

    [Fact]
    public void Renewal_RejectsDeadlineClockRollbackAndTampering()
    {
        ArticleVaultWriterLeaseReceipt lease = Acquire();
        Assert.Throws<InvalidDataException>(() => ArticleVaultWriterLease.Transition(
            lease, Binding, ArticleVaultWriterLeaseAction.Renew, lease.ContentSha256, 60000));
        ArticleVaultWriterLeaseReceipt renewed = ArticleVaultWriterLease.Transition(
            lease, Binding, ArticleVaultWriterLeaseAction.Renew, lease.ContentSha256, 20);
        Assert.Throws<InvalidDataException>(() => ArticleVaultWriterLease.Transition(
            renewed, Binding, ArticleVaultWriterLeaseAction.Renew, renewed.ContentSha256, 19));
        Assert.False(ArticleVaultWriterLease.Verify(renewed with
        {
            Generation = 3
        }));
    }

    [Theory]
    [InlineData("absolutePath", "/etc/passwd")]
    [InlineData("shell", "private-shell-sentinel")]
    [InlineData("networkProxy", "https://example.test")]
    [InlineData("payload", "private article text")]
    [InlineData("serviceCredentials", "secret")]
    public void WireUnknownFields_AreClosedAndErrorsAreRedacted(string field, string value)
    {
        string json = Encoding.UTF8.GetString(ArticleVaultAgentProtocol.Encode(Request()));
        json = json[..^1] + $",\"{field}\":\"{value}\"}}";
        InvalidDataException error = Assert.Throws<InvalidDataException>(
            () => ArticleVaultAgentRequestCodec.Decode(Encoding.UTF8.GetBytes(json)));
        Assert.Equal("agent_frame_schema_invalid", error.Message);
        Assert.Null(error.InnerException);
        Assert.DoesNotContain(value, error.ToString());
    }

    [Fact]
    public void DuplicateMissingNumericAndUnknownCommands_AreRejected()
    {
        string json = Encoding.UTF8.GetString(ArticleVaultAgentProtocol.Encode(Request()));
        foreach (string candidate in new[]
        {
            json[..^1] + ",\"command\":\"inspect-status\"}",
            json.Replace("\"inspect-status\"", "\"execute-shell\"", StringComparison.Ordinal),
            json.Replace("\"inspect-status\"", "4", StringComparison.Ordinal),
            json.Replace("\"reference\":null,", string.Empty, StringComparison.Ordinal),
            json.Replace("\"protocolVersion\":1", "\"protocolVersion\":2", StringComparison.Ordinal),
            json.Replace("\"siteIdentity\":\"site-test\"", "\"siteIdentity\":\"/etc\"", StringComparison.Ordinal)
        })
        {
            Assert.Throws<InvalidDataException>(() => ArticleVaultAgentRequestCodec.Decode(Encoding.UTF8.GetBytes(candidate)));
        }
    }

    [Theory]
    [InlineData(ArticleVaultAgentCommand.ObserveBatch, ArticleVaultAgentReferenceKind.ObservationBatch)]
    [InlineData(ArticleVaultAgentCommand.RequestPlanner, ArticleVaultAgentReferenceKind.PlannerInput)]
    [InlineData(ArticleVaultAgentCommand.ExecuteVerifiedPlan, ArticleVaultAgentReferenceKind.VerifiedPlan)]
    [InlineData(ArticleVaultAgentCommand.MaterializeVerifiedInstruction, ArticleVaultAgentReferenceKind.VerifiedMaterializationInstruction)]
    [InlineData(ArticleVaultAgentCommand.Cancel, ArticleVaultAgentReferenceKind.Operation)]
    public void CommandPurpose_BindsOnlyItsClosedReference(
        ArticleVaultAgentCommand command,
        ArticleVaultAgentReferenceKind kind)
    {
        ArticleVaultAgentRequest request = Seal(Request() with
        {
            Command = command,
            Reference = new(kind, "ref-test", new string('c', 64))
        });
        Assert.Equal(request, ArticleVaultAgentRequestCodec.Decode(ArticleVaultAgentProtocol.Encode(request)));
        Assert.False(ArticleVaultAgentRequestCodec.Verify(Seal(request with
        {
            Reference = null
        })));
        Assert.False(ArticleVaultAgentRequestCodec.Verify(request with
        {
            Reference = request.Reference! with
            {
                Kind = (ArticleVaultAgentReferenceKind)99
            }
        }));
    }

    internal static ArticleVaultWriterLeaseReceipt Acquire()
        => ArticleVaultWriterLease.Transition(null, Binding, ArticleVaultWriterLeaseAction.Acquire, null, 0);

    [Fact]
    public void JournalTransitionVerification_RejectsResealedOwnerAndStateForgery()
    {
        ArticleVaultWriterLeaseReceipt lease = Acquire();
        Assert.True(ArticleVaultWriterLease.VerifyTransition(null, lease));
        ArticleVaultWriterLeaseReceipt renewed = ArticleVaultWriterLease.Transition(
            lease, Binding, ArticleVaultWriterLeaseAction.Renew, lease.ContentSha256, 1);
        Assert.True(ArticleVaultWriterLease.VerifyTransition(lease, renewed));
        ArticleVaultWriterLeaseReceipt forged = renewed with
        {
            Binding = Binding with
            {
                AgentInstanceIdentity = "agent-other"
            },
            ContentSha256 = string.Empty
        };
        forged = forged with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(forged)
        };
        Assert.True(ArticleVaultWriterLease.Verify(forged));
        Assert.False(ArticleVaultWriterLease.VerifyTransition(lease, forged));
    }

    [Fact]
    public void Receipts_ContainOnlyMetadataAndRequireCanonicalCompletion()
    {
        ArticleVaultAgentCommandReceipt receipt = ArticleVaultAgentCommandReceipts.Create(
            Request(), 512, ArticleVaultAgentCommandStatus.Blocked, "canonical_producer_missing");
        Assert.Equal(receipt, ArticleVaultAgentCommandReceipts.Decode(ArticleVaultAgentProtocol.Encode(receipt)));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentCommandReceipts.Create(
            Request(), 512, ArticleVaultAgentCommandStatus.Completed, null));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentCommandReceipts.Create(
            Request(), 512, ArticleVaultAgentCommandStatus.Blocked, "private body content or token"));
        string encoded = Encoding.UTF8.GetString(ArticleVaultAgentProtocol.Encode(receipt));
        foreach (string field in new[] { "token", "secret", "body", "payload", "absolutePath" })
        {
            Assert.DoesNotContain('"' + field + '"', encoded);
        }
    }

    internal static ArticleVaultAgentRequest Request()
        => Seal(new(ArticleVaultAgentProtocol.RequestSchema, Binding, "request-test", 1,
            Acquire().ContentSha256, ArticleVaultAgentCommand.InspectStatus, 1000, "cancel-test", null, string.Empty));

    internal static ArticleVaultAgentRequest Seal(ArticleVaultAgentRequest request)
        => request with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(request with
            {
                ContentSha256 = string.Empty
            })
        };
}
