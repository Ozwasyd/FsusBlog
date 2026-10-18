using System.Collections.Immutable;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions.Tests;

public sealed class AuthoringWorkspacePanelContractTests
{
    [Fact]
    public void ClosedDeclarationAndReadOnlyNodes_RoundTripAndBindStableDigests()
    {
        Fixture f = Create();
        AuthoringWorkspacePanelCandidate candidate = WithModel(f.Candidate, f.Candidate.Model with
        {
            Nodes = [new("text", AuthoringWorkspacePanelNodeKind.Text, "Overview 中文", null, null, null),
                new("pair", AuthoringWorkspacePanelNodeKind.Pair, "Count", "12", null, null),
                new("status", AuthoringWorkspacePanelNodeKind.Status, "Ready", null, null, AuthoringWorkspacePanelTone.Information),
                new("command", AuthoringWorkspacePanelNodeKind.CommandReference, "Open", null, "host.command.open", null)]
        });
        AuthoringWorkspacePanelDeclaration declaration = AuthoringWorkspacePanelContract.ParseDeclaration(JsonSerializer.SerializeToUtf8Bytes(candidate.Declaration));
        AuthoringWorkspacePanelModel model = AuthoringWorkspacePanelContract.ParseModel(JsonSerializer.SerializeToUtf8Bytes(candidate.Model));
        AuthoringWorkspacePanelAdmission first = Admit(f, candidate with
        {
            Declaration = declaration,
            Model = model
        });
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.Admitted, first.Status);
        Assert.Equal(first, Admit(f, candidate));
        Assert.Equal(64, first.AdmissionSha256.Length);
        Assert.DoesNotContain("Overview", JsonSerializer.Serialize(first));
        Assert.DoesNotContain(candidate.ExpectedBinding.DocumentId, JsonSerializer.Serialize(first));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(1000)]
    public void BoundedBatch_UsesHostActiveCapAndDeterministicOrder(int count)
    {
        Fixture f = Create(count);
        ImmutableArray<AuthoringWorkspacePanelCandidate> candidates = [.. Enumerable.Range(0, count).Select(index => Panel(f, index)).Reverse()];
        ImmutableArray<AuthoringWorkspacePanelAdmission> result = AuthoringWorkspacePanelContract.AdmitSet(candidates, f.Host);
        Assert.Equal(count, result.Length);
        Assert.Equal(Math.Min(count, 2), result.Count(item => item.Status == AuthoringWorkspacePanelAdmissionStatus.Admitted));
        Assert.Equal(Math.Max(0, count - 2), result.Count(item => item.Status == AuthoringWorkspacePanelAdmissionStatus.ActiveLimit));
        Assert.Equal(result.OrderBy(item => item.PanelId, StringComparer.Ordinal).ToArray(), result.ToArray());
        Assert.Equal(result.ToArray(), AuthoringWorkspacePanelContract.AdmitSet([.. candidates.Reverse()], f.Host).ToArray());
    }

    [Fact]
    public void HostRoster_AdmitsEveryExactRegisteredSlot()
    {
        Fixture f = Create();
        foreach (AuthoringWorkspacePanelSlot slot in f.Host.Slots)
            Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.Admitted, Admit(f, WithDeclaration(f.Candidate, f.Candidate.Declaration with
            {
                SlotId = slot.Id
            })).Status);
    }

    [Theory]
    [InlineData("unknown.slot")]
    [InlineData("host.core.rail")]
    [InlineData("host.core.inspector")]
    [InlineData("host.core.tab")]
    [InlineData("host.core.group")]
    [InlineData("fsusblog.core.rail")]
    [InlineData("HOST.extension.right")]
    [InlineData("host.extension.*")]
    [InlineData("floating/window")]
    [InlineData("host.extension.right\n")]
    public void UnknownCoreAndNoncanonicalSlots_AreRejected(string slot)
    {
        Fixture f = Create();
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithDeclaration(f.Candidate, f.Candidate.Declaration with { SlotId = slot })));
    }

    [Fact]
    public void HostCannotSupplyCoreSlotAsAnExtensionSlot_OrOmitFacts()
    {
        Fixture f = Create();
        foreach (AuthoringWorkspacePanelHostFacts host in new[]
        {
            f.Host with { Slots = default }, f.Host with { CoreSlotIds = default }, f.Host with { AllowedCommandIds = default },
            f.Host with { UsedResources = null! }, f.Host with { MaximumResources = null! },
            f.Host with { Slots = [f.Host.Slots[0], f.Host.Slots[0]] }, f.Host with { CoreSlotIds = [f.Host.Slots[0].Id] },
            f.Host with { ActivePanels = 1 }, f.Host with { Slots = [f.Host.Slots[0] with { Platforms = default }] },
            f.Host with { Slots = [f.Host.Slots[0] with { AvailableSize = null! }] }, f.Host with { Platform = (AuthoringHostPlatform)99 }
        })
            Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.AdmitSet([f.Candidate], Seal(host)));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.AdmitSet([f.Candidate], null!));
    }

    [Theory]
    [InlineData("preferred")]
    [InlineData("min")]
    [InlineData("max")]
    [InlineData("role")]
    [InlineData("lifecycle")]
    [InlineData("platform")]
    [InlineData("viewport")]
    [InlineData("duplicate-command")]
    [InlineData("duplicate-platform")]
    [InlineData("schema")]
    [InlineData("nodes")]
    [InlineData("budget")]
    public void DeclarationUnknownAndUnboundedValues_AreRejected(string field)
    {
        Fixture f = Create();
        AuthoringWorkspacePanelDeclaration d = f.Candidate.Declaration;
        d = field switch
        {
            "preferred" => d with { PreferredSize = new(1000, 300) },
            "min" => d with { MinimumSize = new(0, 100) },
            "max" => d with { MaximumSize = new(100, 100) },
            "role" => d with { Role = (AuthoringWorkspacePanelRole)99 },
            "lifecycle" => d with { LifecyclePolicy = (AuthoringWorkspacePanelLifecyclePolicy)99 },
            "platform" => d with { Platforms = [(AuthoringHostPlatform)99] },
            "viewport" => d with { Viewports = [(AuthoringWorkspacePanelViewport)99] },
            "duplicate-command" => d with { CommandIds = ["host.command.open", "host.command.open"] },
            "duplicate-platform" => d with { Platforms = [AuthoringHostPlatform.Browser, AuthoringHostPlatform.Browser] },
            "schema" => d with { SchemaVersion = 2 },
            "nodes" => d with { MaximumNodes = 257 },
            _ => d with { Budget = Zero() }
        };
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithDeclaration(f.Candidate, d)));
    }

    [Theory]
    [InlineData("Html")]
    [InlineData("Css")]
    [InlineData("Svg")]
    [InlineData("Iframe")]
    [InlineData("Component")]
    [InlineData("Props")]
    [InlineData("Callback")]
    [InlineData("Route")]
    [InlineData("DockTree")]
    [InlineData("MutationPlan")]
    public void GenericUiAndMutationProperties_AreRejectedByClosedJson(string property)
    {
        Fixture f = Create();
        JsonObject declaration = JsonNode.Parse(JsonSerializer.Serialize(f.Candidate.Declaration))!.AsObject();
        declaration[property] = "unregistered";
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseDeclaration(Encoding.UTF8.GetBytes(declaration.ToJsonString())));
        JsonObject model = JsonNode.Parse(JsonSerializer.Serialize(f.Candidate.Model))!.AsObject();
        model["Nodes"]![0]![property] = "unregistered";
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseModel(Encoding.UTF8.GetBytes(model.ToJsonString())));
    }

    [Fact]
    public void EveryRequiredJsonField_TopLevelAndNested_MustBeExplicit()
    {
        Fixture f = Create();
        JsonObject declaration = JsonNode.Parse(JsonSerializer.Serialize(f.Candidate.Declaration))!.AsObject();
        foreach (string key in declaration.Select(item => item.Key).ToArray())
        {
            JsonObject changed = declaration.DeepClone().AsObject();
            changed.Remove(key);
            Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseDeclaration(Encoding.UTF8.GetBytes(changed.ToJsonString())));
        }
        foreach (string parent in new[] { "MinimumSize", "MaximumSize", "PreferredSize", "Budget" })
            foreach (string key in declaration[parent]!.AsObject().Select(item => item.Key).ToArray())
            {
                JsonObject changed = declaration.DeepClone().AsObject();
                changed[parent]!.AsObject().Remove(key);
                Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseDeclaration(Encoding.UTF8.GetBytes(changed.ToJsonString())));
            }
        JsonObject model = JsonNode.Parse(JsonSerializer.Serialize(f.Candidate.Model))!.AsObject();
        foreach (string key in model.Select(item => item.Key).ToArray())
        {
            JsonObject changed = model.DeepClone().AsObject();
            changed.Remove(key);
            Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseModel(Encoding.UTF8.GetBytes(changed.ToJsonString())));
        }
        foreach (string parent in new[] { "Binding", "Node" })
        {
            JsonObject original = parent == "Binding" ? model["Binding"]!.AsObject() : model["Nodes"]![0]!.AsObject();
            foreach (string key in original.Select(item => item.Key).ToArray())
            {
                JsonObject changed = model.DeepClone().AsObject();
                (parent == "Binding" ? changed["Binding"]!.AsObject() : changed["Nodes"]![0]!.AsObject()).Remove(key);
                Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseModel(Encoding.UTF8.GetBytes(changed.ToJsonString())));
            }
        }
    }

    [Fact]
    public void DuplicateJsonFields_DepthAndByteBounds_AreRejected()
    {
        Fixture f = Create();
        string d = JsonSerializer.Serialize(f.Candidate.Declaration);
        string m = JsonSerializer.Serialize(f.Candidate.Model);
        foreach (string changed in new[]
        {
            d.Replace("\"SchemaVersion\":1", "\"SchemaVersion\":1,\"SchemaVersion\":1", StringComparison.Ordinal),
            d.Replace("\"Inline\":100", "\"Inline\":100,\"Inline\":100", StringComparison.Ordinal)
        })
            Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseDeclaration(Encoding.UTF8.GetBytes(changed)));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseModel(Encoding.UTF8.GetBytes(m.Replace("\"Id\":\"text\"", "\"Id\":\"text\",\"Id\":\"text\"", StringComparison.Ordinal))));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseModel(new byte[AuthoringWorkspacePanelContract.MaximumPayloadBytes + 1]));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseModel(Encoding.UTF8.GetBytes(new string('[', 20) + new string(']', 20))));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.ParseDeclaration([]));
    }

    [Theory]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("<svg onload=run()>")]
    [InlineData("position: fixed")]
    [InlineData("POSITION : fixed")]
    [InlineData("url(https://example.invalid)")]
    [InlineData("@import x")]
    [InlineData("javascript:run()")]
    [InlineData("style=display:none")]
    public void HtmlCssAndExecutableText_AreRejected(string text)
    {
        Fixture f = Create();
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithModel(f.Candidate, f.Candidate.Model with { Nodes = [f.Candidate.Model.Nodes[0] with { Text = text }] })));
    }

    [Fact]
    public void DuplicateUnknownOrAmbiguousNodes_AndInvalidUnicode_AreRejected()
    {
        Fixture f = Create();
        AuthoringWorkspacePanelNode text = f.Candidate.Model.Nodes[0];
        foreach (ImmutableArray<AuthoringWorkspacePanelNode> nodes in new ImmutableArray<AuthoringWorkspacePanelNode>[]
        {
            [text, text], [text with { Kind = (AuthoringWorkspacePanelNodeKind)99 }], [text with { CommandId = "host.command.open" }],
            [text with { Kind = AuthoringWorkspacePanelNodeKind.Status, Tone = (AuthoringWorkspacePanelTone)99 }],
            [text with { Kind = AuthoringWorkspacePanelNodeKind.Pair }], [text with { Text = new string((char)0xd800, 1) }],
            [text with { Text = "a\0b" }], [null!]
        })
            Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithModel(f.Candidate, f.Candidate.Model with { Nodes = nodes })));
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, f.Candidate with { ExpectedBinding = f.Candidate.ExpectedBinding with { RequestId = new string((char)0xd800, 1) } }));
    }

    [Fact]
    public void HostCommandRefs_RequireBothRosters_AndCannotDuplicate()
    {
        Fixture f = Create();
        var command = new AuthoringWorkspacePanelNode("command", AuthoringWorkspacePanelNodeKind.CommandReference, "Open", null, "unknown.command", null);
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithModel(f.Candidate, f.Candidate.Model with { Nodes = [command] })));
        command = command with
        {
            CommandId = "host.command.open"
        };
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithModel(f.Candidate, f.Candidate.Model with { Nodes = [command, command with { Id = "other" }] })));
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, host: Seal(f.Host with { AllowedCommandIds = [] })));
    }

    [Theory]
    [InlineData("workspace")]
    [InlineData("snapshot")]
    [InlineData("group")]
    [InlineData("tab")]
    [InlineData("document")]
    [InlineData("epoch")]
    [InlineData("revision")]
    [InlineData("generation")]
    [InlineData("request")]
    [InlineData("runtime")]
    public void StaleInstanceCoordinates_AreRejectedEvenWithRecomputedModelDigest(string field)
    {
        Fixture f = Create();
        AuthoringWorkspacePanelBinding b = f.Candidate.Model.Binding;
        b = field switch
        {
            "workspace" => b with { WorkspaceId = "other" },
            "snapshot" => b with { WorkspaceSnapshotSha256 = new string('9', 64) },
            "group" => b with { GroupId = "other" },
            "tab" => b with { TabId = "other" },
            "document" => b with { DocumentId = "other" },
            "epoch" => b with { DocumentEpoch = 2 },
            "revision" => b with { SourceRevision = 2 },
            "generation" => b with { LifecycleGeneration = 2 },
            "request" => b with { RequestId = "other" },
            _ => b with { RuntimeIdentity = new string('9', 64) }
        };
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithModel(f.Candidate, f.Candidate.Model with { Binding = b })));
    }

    [Theory]
    [InlineData("panel")]
    [InlineData("version")]
    [InlineData("package")]
    [InlineData("content")]
    [InlineData("contract")]
    [InlineData("extension")]
    [InlineData("contribution")]
    public void ForeignDeclarationIdentity_IsRejected(string field)
    {
        Fixture f = Create();
        AuthoringWorkspacePanelDeclaration d = f.Candidate.Declaration;
        d = field switch
        {
            "panel" => d with { PanelId = "foreign.panel" },
            "version" => d with { ExtensionVersion = "2.0.0" },
            "package" => d with { PackageSha256 = new string('9', 64) },
            "content" => d with { ContentSha256 = new string('9', 64) },
            "contract" => d with { ContractIdentity = new string('9', 64) },
            "extension" => d with { ExtensionId = "foreign.extension" },
            _ => d with { ContributionId = "foreign.contribution" }
        };
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithDeclaration(f.Candidate, d)));
    }

    [Fact]
    public void CopiedOrTamperedContract_AndNonPanelContribution_AreRejected()
    {
        Fixture f = Create();
        VerifiedAuthoringExtensionContract contract = f.Candidate.Contract;
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, f.Candidate with { Contract = contract with { ContractIdentity = new string('9', 64) } }));
        VerifiedAuthoringExtensionContract command = AuthoringExtensionContractValidator.Verify(contract.Manifest with
        {
            Contributions = [contract.Manifest.Contributions[0] with { Kind = AuthoringContributionKind.Command }]
        });
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, WithDeclaration(f.Candidate with { Contract = command }, f.Candidate.Declaration with { ContractIdentity = command.ContractIdentity })));
    }

    [Fact]
    public void PlatformZoomEditorAndMobileFacts_ReturnExplicitBlockedResults()
    {
        Fixture f = Create();
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.SizeUnavailable, Admit(f, host: Seal(f.Host with
        {
            ZoomPercent = 200,
            Slots = [f.Host.Slots[0] with { AvailableSize = new(150, 300) }]
        })).Status);
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.EditorWidthUnavailable, Admit(f, host: Seal(f.Host with
        {
            EditorInline = 300
        })).Status);
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.UnsupportedPlatform, Admit(f, host: Seal(f.Host with
        {
            Platform = AuthoringHostPlatform.AvaloniaDesktop
        })).Status);
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.HostDrawerRequired, Admit(f, host: Seal(f.Host with
        {
            Viewport = AuthoringWorkspacePanelViewport.Mobile
        })).Status);
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.UnsupportedViewport, Admit(f, host: Seal(f.Host with
        {
            Viewport = AuthoringWorkspacePanelViewport.Mobile,
            Slots = [f.Host.Slots[0] with { MobilePolicy = AuthoringWorkspacePanelMobilePolicy.Unsupported }]
        })).Status);
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.PermissionRequired, Admit(f, f.Candidate with
        {
            HasReadPermission = false
        }).Status);
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.Disabled, Admit(f, f.Candidate with
        {
            ExtensionEnabled = false
        }).Status);
    }

    [Theory]
    [InlineData(AuthoringWorkspacePanelVisibility.Hidden)]
    [InlineData(AuthoringWorkspacePanelVisibility.Collapsed)]
    [InlineData(AuthoringWorkspacePanelVisibility.Offscreen)]
    public void NonvisiblePanels_RequireNoModelOrRetainedResources(AuthoringWorkspacePanelVisibility visibility)
    {
        Fixture f = Create();
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, f.Candidate with { Visibility = visibility }));
        AuthoringWorkspacePanelCandidate hidden = WithModel(f.Candidate, f.Candidate.Model with
        {
            Nodes = []
        }) with
        {
            Visibility = visibility,
            ObservedResources = Zero()
        };
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.Hidden, Admit(f, hidden).Status);
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, hidden with { ObservedResources = Zero() with { Timers = 1 } }));
    }

    [Fact]
    public void DuplicateRegistrations_AndMalformedLateEntries_RejectWholeBatch()
    {
        Fixture f = Create(2);
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.AdmitSet([f.Candidate, f.Candidate], f.Host));
        AuthoringWorkspacePanelCandidate bad = Panel(f, 1) with
        {
            Model = f.Candidate.Model with
            {
                ModelSha256 = new string('0', 64)
            }
        };
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.AdmitSet([f.Candidate, bad], f.Host));
    }

    [Fact]
    public void HostCountsAndResourceCeilings_AreActuallyConsumed()
    {
        Fixture f = Create(2);
        AuthoringWorkspacePanelHostFacts host = Seal(f.Host with
        {
            ActivePanels = 1,
            Slots = [f.Host.Slots[0] with { ActivePanels = 1 }]
        });
        Assert.Single(AuthoringWorkspacePanelContract.AdmitSet([Panel(f, 0), Panel(f, 1)], host).Where(item => item.Status == AuthoringWorkspacePanelAdmissionStatus.Admitted));
        host = Seal(f.Host with
        {
            UsedResources = new(AuthoringWorkspacePanelContract.MaximumTotalTextBytes, 0, 0, 0, 0, 0)
        });
        Assert.Equal(AuthoringWorkspacePanelAdmissionStatus.ResourceLimit, Admit(f, host: host).Status);
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, f.Candidate with { ObservedResources = Zero() }));
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, f.Candidate with { ObservedResources = f.Candidate.ObservedResources with { Workers = 1 } }));
    }

    [Fact]
    public void DigestTamper_IsRejectedAndModelChangesChangeAdmissionIdentity()
    {
        Fixture f = Create();
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, f.Candidate with { Declaration = f.Candidate.Declaration with { DeclarationSha256 = new string('0', 64) } }));
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, f.Candidate with { Model = f.Candidate.Model with { ModelSha256 = new string('0', 64) } }));
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f, host: f.Host with { ZoomPercent = 200 }));
        Assert.NotEqual(Admit(f).AdmissionSha256, Admit(f, WithModel(f.Candidate, f.Candidate.Model with
        {
            Nodes = [f.Candidate.Model.Nodes[0] with { Text = "different" }]
        })).AdmissionSha256);
    }

    [Fact]
    public void CallerBackingArrayMutation_AfterAdmissionIsRejectedOnReuse()
    {
        Fixture f = Create();
        AuthoringWorkspacePanelAdmission before = Admit(f);
        string serialized = JsonSerializer.Serialize(before);
        ImmutableCollectionsMarshal.AsArray(f.Candidate.Model.Nodes)![0] = f.Candidate.Model.Nodes[0] with
        {
            Text = "tampered"
        };
        Assert.Equal(serialized, JsonSerializer.Serialize(before));
        Assert.Throws<AuthoringExtensionContractException>(() => Admit(f));
    }

    [Fact]
    public void AbsoluteSetAndTypedPayloadBounds_RefuseBeforeExpensiveAdmission()
    {
        Fixture f = Create();
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.AdmitSet(default, f.Host));
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringWorkspacePanelContract.AdmitSet(
            Enumerable.Repeat(f.Candidate, 1001).ToImmutableArray(), f.Host));
        ImmutableArray<AuthoringWorkspacePanelNode> largeNodes = Enumerable.Range(0, 256)
            .Select(index => new AuthoringWorkspacePanelNode("node." + index, AuthoringWorkspacePanelNodeKind.Pair,
                new string('a', 4096), new string('b', 4096), null, null)).ToImmutableArray();
        AuthoringWorkspacePanelCandidate large = f.Candidate with
        {
            Model = f.Candidate.Model with
            {
                Nodes = largeNodes
            }
        };
        AuthoringExtensionContractException totalText = Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringWorkspacePanelContract.AdmitSet(Enumerable.Repeat(large, 9).ToImmutableArray(), f.Host));
        Assert.Equal("panel_total_text_bound", totalText.Message);
        AuthoringWorkspacePanelModel typed = f.Candidate.Model with
        {
            Nodes = largeNodes
        };
        AuthoringExtensionContractException payload = Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringWorkspacePanelContract.ComputeModelDigest(typed));
        Assert.Equal("panel_typed_payload_bound", payload.Message);
        var small = large with
        {
            Model = large.Model with
            {
                Nodes = [.. largeNodes.Select(node => node with { Text = "a", Value = "b" })]
            }
        };
        AuthoringExtensionContractException totalNodes = Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringWorkspacePanelContract.AdmitSet(Enumerable.Repeat(small, 17).ToImmutableArray(), f.Host));
        Assert.Equal("panel_total_node_bound", totalNodes.Message);
    }

    private static AuthoringWorkspacePanelAdmission Admit(Fixture f, AuthoringWorkspacePanelCandidate? candidate = null, AuthoringWorkspacePanelHostFacts? host = null) =>
        Assert.Single(AuthoringWorkspacePanelContract.AdmitSet([candidate ?? f.Candidate], host ?? f.Host));
    private static AuthoringWorkspacePanelCandidate WithDeclaration(AuthoringWorkspacePanelCandidate candidate, AuthoringWorkspacePanelDeclaration d)
    {
        d = d with
        {
            DeclarationSha256 = AuthoringWorkspacePanelContract.ComputeDeclarationDigest(d)
        };
        return WithModel(candidate with
        {
            Declaration = d
        }, candidate.Model with
        {
            DeclarationSha256 = d.DeclarationSha256
        });
    }
    private static AuthoringWorkspacePanelCandidate WithModel(AuthoringWorkspacePanelCandidate candidate, AuthoringWorkspacePanelModel m) => candidate with
    {
        Model = m with
        {
            ModelSha256 = AuthoringWorkspacePanelContract.ComputeModelDigest(m)
        }
    };
    private static AuthoringWorkspacePanelHostFacts Seal(AuthoringWorkspacePanelHostFacts h) => h with
    {
        HostFactsSha256 = AuthoringWorkspacePanelContract.ComputeHostDigest(h)
    };
    private static AuthoringWorkspacePanelResources Zero() => new(0, 0, 0, 0, 0, 0);
    private static Fixture Create(int count = 1)
    {
        AuthoringExtensionManifest original = global::FsusBlog.Server.Tests.AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = original with
        {
            SupportedPlatforms = [AuthoringHostPlatform.Browser, AuthoringHostPlatform.ServerLinux],
            Contributions = [.. Enumerable.Range(0, Math.Max(1, count)).Select(index => original.Contributions[0] with
            { Id = "acme.panel." + index, Kind = AuthoringContributionKind.WorkspacePanel, Capabilities = [AuthoringCapability.DocumentRangeRead] })]
        };
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(manifest);
        var binding = new AuthoringWorkspacePanelBinding(new string('c', 64), "workspace", new string('d', 64), "group", "tab", "synthetic-document", 1, 0, 1, "request");
        var declaration = new AuthoringWorkspacePanelDeclaration(1, "acme.panel.0", manifest.Id, manifest.Version, manifest.PackageSha256, manifest.ContentSha256,
            contract.ContractIdentity, "acme.panel.0", "host.extension.right", AuthoringWorkspacePanelRole.ReadOnlySummary, new(100, 100), new(400, 600), new(200, 300),
            AuthoringWorkspacePanelContract.ModelSchema, ["host.command.open"], [AuthoringHostPlatform.Browser],
            [AuthoringWorkspacePanelViewport.Desktop, AuthoringWorkspacePanelViewport.Mobile], 8, new(4096, 0, 0, 0, 0, 0),
            AuthoringWorkspacePanelLifecyclePolicy.ReleaseOnHideCancelOnIdentityChange, string.Empty);
        declaration = declaration with
        {
            DeclarationSha256 = AuthoringWorkspacePanelContract.ComputeDeclarationDigest(declaration)
        };
        var model = new AuthoringWorkspacePanelModel(1, declaration.PanelId, declaration.DeclarationSha256, AuthoringWorkspacePanelContract.ModelSchema,
            binding, [new("text", AuthoringWorkspacePanelNodeKind.Text, "Overview", null, null, null)], string.Empty);
        model = model with
        {
            ModelSha256 = AuthoringWorkspacePanelContract.ComputeModelDigest(model)
        };
        var slot = new AuthoringWorkspacePanelSlot(declaration.SlotId, new(400, 600), [AuthoringWorkspacePanelRole.ReadOnlySummary], [AuthoringHostPlatform.Browser],
            [AuthoringWorkspacePanelViewport.Desktop, AuthoringWorkspacePanelViewport.Mobile], AuthoringWorkspacePanelMobilePolicy.RequireHostDrawer, 0, 2);
        var host = new AuthoringWorkspacePanelHostFacts(1, AuthoringHostPlatform.Browser, AuthoringWorkspacePanelViewport.Desktop, new(1400, 900), 100, 1000, 600,
            [slot, slot with { Id = "host.extension.bottom" }], ["host.core.rail", "host.core.inspector", "host.core.tab", "host.core.group"], ["host.command.open"], 0, 2,
            Zero(), new(AuthoringWorkspacePanelContract.MaximumTotalTextBytes, 64, 64, 16, 8, 8), string.Empty);
        return new(new(contract, declaration, model, binding, true, true, AuthoringWorkspacePanelVisibility.Visible, new(512, 0, 0, 0, 0, 0)), Seal(host));
    }
    private static AuthoringWorkspacePanelCandidate Panel(Fixture f, int index)
    {
        string id = "acme.panel." + index;
        AuthoringWorkspacePanelCandidate candidate = WithDeclaration(f.Candidate, f.Candidate.Declaration with
        {
            PanelId = id,
            ContributionId = id
        });
        return WithModel(candidate, candidate.Model with
        {
            PanelId = id
        });
    }
    private sealed record Fixture(AuthoringWorkspacePanelCandidate Candidate, AuthoringWorkspacePanelHostFacts Host);
}
