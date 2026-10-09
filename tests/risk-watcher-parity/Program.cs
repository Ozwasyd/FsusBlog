using System.Buffers.Binary;
using System.Linq.Expressions;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

using FsusBlog.ArticleVault.Linux;
using FsusBlog.ArticleVault.MacOS;
using FsusBlog.ArticleVault.Observations;
using FsusBlog.ArticleVault.Windows;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace WatcherParityRisk;

// Managed negative controls only. This executable never starts either native watcher,
// opens a Vault or claims that caller-supplied inventories are native traversal receipts.
internal static class Program
{
    private const BindingFlags Internal = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static int s_failed;
    private static int s_passed;

    private static int Main(string[] args)
    {
        string filter = args.FirstOrDefault() ?? "";
        WindowsVaultWatchIdentity identity = new("site", "vault", "device", "agent", Digest, Digest, "watch", "NTFS", 0, false);
        WindowsVaultRawFact restart = Seal(new(WindowsVaultWatcherSchemas.RawFact, 1, "windows", identity,
            1, 0, WindowsVaultFactClass.WatcherRestarted, null, null, null, null, 1, 1,
            WindowsVaultPathDisposition.None, null, "windows_vault_watcher_restart", true, false, null, ""));
        WindowsVaultRawFact rename = Seal(restart with
        {
            NativeAction = 4,
            FactClass = WindowsVaultFactClass.RenameOldName,
            RawOldRelativePath = "old.md",
            PathDisposition = WindowsVaultPathDisposition.Source,
            RescanRequired = false,
            ReasonCode = null
        });
        MacVaultWatchIdentity macIdentity = new("site", "vault", "device", "agent", Digest, Digest, "watch",
            new("apfs", "volume", false, "canonical-equivalence", 1, 2));
        MacVaultRawFact mac = MacVaultRawFactCodec.Seal(new(MacVaultWatcherSchemas.RawFact, 1, "macos", macIdentity,
            1, 101, 0x100, MacVaultFactClass.NativeEvent, "article.md", null, "article.md", 7, 1, 1,
            MacVaultPathDisposition.SourceProjection, "mac_vault_rescan_pending", true, false, ""));

        void Check(string id, bool condition, object actual, object expected)
        {
            if (!id.Contains(filter, StringComparison.OrdinalIgnoreCase))
                return;
            if (condition)
                s_passed++;
            else
                s_failed++;
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                id,
                status = condition ? "PASS" : "FAIL",
                actual,
                expected
            }));
        }
        void WindowsRefusal(string id, WindowsVaultRawFact candidate)
        {
            bool actual = WindowsVaultRawFactCodec.Verify(Seal(candidate), identity);
            Check(id, !actual, new
            {
                verified = actual,
                candidate.FactClass,
                candidate.NativeAction,
                candidate.RescanRequired,
                candidate.ReasonCode,
                candidate.RawOldRelativePath,
                candidate.RawNewRelativePath
            }, new
            {
                verified = false
            });
        }

        bool restartValid = WindowsVaultRawFactCodec.Verify(restart, identity);
        bool renameValid = WindowsVaultRawFactCodec.Verify(rename, identity);
        Check("windows.valid.restart", restartValid, restartValid, true);
        Check("windows.valid.rename_old", renameValid, renameValid, true);
        WindowsRefusal("windows.refusal.restart_erases_rescan_reason", restart with
        {
            RescanRequired = false,
            ReasonCode = null
        });
        WindowsRefusal("windows.refusal.overflow_erases_rescan_reason", restart with
        {
            FactClass = WindowsVaultFactClass.BufferOverflow,
            RescanRequired = false,
            ReasonCode = null
        });
        WindowsRefusal("windows.refusal.action_class_contradiction", rename with
        {
            FactClass = WindowsVaultFactClass.Modified
        });
        WindowsRefusal("windows.refusal.rename_old_has_only_new_path", rename with
        {
            RawOldRelativePath = null,
            RawNewRelativePath = "new.md"
        });
        WindowsRefusal("windows.refusal.rename_old_has_two_paths", rename with
        {
            RawNewRelativePath = "new.md"
        });
        WindowsRefusal("windows.refusal.pathless_mutation", rename with
        {
            NativeAction = 3,
            FactClass = WindowsVaultFactClass.Modified,
            RawOldRelativePath = null
        });
        WindowsRefusal("windows.refusal.failure_contains_private_reason", restart with
        {
            ReasonCode = "private body/token\nnot_a_code"
        });
        WindowsRefusal("windows.refusal.nonpositive_timestamps", restart with
        {
            TimestampUnixMilliseconds = 0,
            MonotonicTimestamp = -1
        });
        WindowsRefusal("windows.refusal.source_path_escape", rename with
        {
            RawOldRelativePath = "..\\outside.md"
        });
        WindowsVaultWatchIdentity foreignFs = identity with
        {
            FileSystem = "ext4"
        };
        WindowsVaultRawFact foreign = Seal(restart with
        {
            Identity = foreignFs
        });
        bool acceptedFs = WindowsVaultRawFactCodec.Verify(foreign, foreignFs);
        Check("windows.refusal.non_ntfs_identity", !acceptedFs, acceptedFs, false);
        WindowsRefusal("windows.valid.refuse_clean_watermark", restart with
        {
            WatermarkValid = true
        });
        WindowsRefusal("windows.valid.refuse_content_digest_authority", restart with
        {
            SourceContentDigest = Digest
        });

        bool macValid = MacVaultRawFactCodec.Validate(mac, macIdentity);
        Check("mac.valid.fact", macValid, macValid, true);
        foreach (var pair in new[] {
            ("mac.refusal.nonpositive_timestamps", mac with { ObservedUnixMilliseconds = 0 }),
            ("mac.refusal.private_reason", mac with { ErrorCode = "private token text" }),
            ("mac.refusal.clear_rescan", mac with { RescanRequired = false }),
            ("mac.refusal.rename_invents_pair", mac with { NativeFlags = 0x800, RawOldRelativePath = "old.md", RawNewRelativePath = "new.md" }),
            ("mac.refusal.root_escape", mac with { RawObservedRelativePath = "../outside.md", RawNewRelativePath = "../outside.md" }) })
        {
            bool valid = MacVaultRawFactCodec.Validate(MacVaultRawFactCodec.Seal(pair.Item2), macIdentity);
            Check(pair.Item1, !valid, valid, false);
        }
        Type macSession = typeof(MacVaultWatcherSession);
        string gapReason = (string)macSession.GetMethod("RawReason", Internal)!.Invoke(null, new object?[] { 0x100u, 10000UL, 100UL })!;
        Check("mac.valid.global_event_ids_not_consecutive", gapReason == "mac_vault_rescan_pending", gapReason, "mac_vault_rescan_pending");

        RunWindowsQueue(identity, Check);
        RunDecoder(Check);
        RunComposite(Check);
        RunLinuxBaseline(Check);

        Check("declaration.native_windows_no_public_factory", typeof(WindowsVaultWatcherSession).GetConstructors().Length == 0,
            typeof(WindowsVaultWatcherSession).GetConstructors().Length, 0);
        Check("declaration.no_windows_or_mac_normalizer_adapter", !typeof(LinuxVaultObservationAdapter).Assembly.GetExportedTypes()
            .Any(type => type.Name.Contains("Windows") || type.Name.Contains("Mac")), "Linux adapter only", "WIP: no Windows/macOS composite acceptance");
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            summary = true,
            passed = s_passed,
            failed = s_failed,
            nativeWindowsNtfs = "UNRUN: Linux host",
            nativeMacosApfs = "UNRUN: Linux host; Darwin C uncompiled"
        }));
        int failedCount = s_failed;
        return failedCount == 0 ? 0 : 1;
    }

    private static WindowsVaultRawFact Seal(WindowsVaultRawFact fact)
        => fact with
        {
            ContentDigest = WindowsVaultRawFactCodec.ComputeContentDigest(fact)
        };

    private static void RunLinuxBaseline(Action<string, bool, object, object> check)
    {
        // Narrow managed state fixture for a pure transition: no constructor/Open, descriptors,
        // real filesystem facts, rescan operation or native success receipt is fabricated.
        Type type = typeof(LinuxVaultWatcherSession);
        var session = (LinuxVaultWatcherSession)RuntimeHelpers.GetUninitializedObject(type);
        type.GetField("_nextSequence", Internal)!.SetValue(session, 9L);
        type.GetProperty("Watermark", Internal)!.SetValue(session,
            new LinuxVaultWatermark("test-only-watch", 8, false, "linux_vault_inotify_overflow", null));
        LinuxVaultWatermark actual = session.AcknowledgeRescan(new string('c', 64));
        check("linux.baseline.refusal.digest_only_ack_must_not_clear_loss", !actual.IsValid,
            new
            {
                actual.IsValid,
                actual.LastSequence,
                actual.InvalidatedReasonCode,
                actual.RescanReceiptSha256
            },
            "remain invalid: no owner/watch-instance/event-cut/pending-loss proof supplied");
    }

    private static void RunWindowsQueue(WindowsVaultWatchIdentity identity, Action<string, bool, object, object> check)
    {
        Assembly assembly = typeof(WindowsVaultRawFact).Assembly;
        Type bufferType = assembly.GetType("FsusBlog.ArticleVault.Windows.WindowsVaultFactBuffer")!;
        Type recordType = assembly.GetType("FsusBlog.ArticleVault.Windows.WindowsVaultNativeRecord")!;
        Type admissionType = assembly.GetType("FsusBlog.ArticleVault.Windows.WindowsVaultPathAdmission")!;
        object buffer = Activator.CreateInstance(bufferType, Internal, null, new object[] { identity, 8 }, null)!;
        MethodInfo drain = bufferType.GetMethod("Drain", Internal)!;
        _ = drain.Invoke(buffer, null);
        object admission = Activator.CreateInstance(admissionType, WindowsVaultPathDisposition.Source, null)!;
        for (int index = 0; index < 50; index++)
        {
            object record = Activator.CreateInstance(recordType, 3u, $"article-{index}.md")!;
            bufferType.GetMethod("Receive", Internal)!.Invoke(buffer, new[] { record, admission });
        }
        var first = (IReadOnlyList<WindowsVaultRawFact>)drain.Invoke(buffer, null)!;
        check("windows.queue.loss_marker_preserves_prefix", first.Count == 8 && first[^1].FactClass == WindowsVaultFactClass.BufferOverflow
            && first[^1].RescanRequired, new
            {
                first.Count,
                lastClass = first[^1].FactClass.ToString(),
                lastSequence = first[^1].Sequence
            }, "8 facts; explicit overflow");
        bufferType.GetMethod("Receive", Internal)!.Invoke(buffer, new[] { Activator.CreateInstance(recordType, 3u, "after.md")!, admission });
        var after = (IReadOnlyList<WindowsVaultRawFact>)drain.Invoke(buffer, null)!;
        check("windows.queue.next_delivery_exposes_gap", after[0].Sequence > first[^1].Sequence + 1,
            new
            {
                previous = first[^1].Sequence,
                next = after[0].Sequence
            }, "next > previous + 1");
    }

    private static void RunDecoder(Action<string, bool, object, object> check)
    {
        Assembly assembly = typeof(WindowsVaultRawFact).Assembly;
        Type decoder = assembly.GetType("FsusBlog.ArticleVault.Windows.WindowsVaultNotifyDecoder")!;
        MethodInfo decode = decoder.GetMethod("Decode", Internal)!;
        Type recordType = assembly.GetType("FsusBlog.ArticleVault.Windows.WindowsVaultNativeRecord")!;
        Type receiverType = typeof(Action<>).MakeGenericType(recordType);
        var records = new List<object>();
        ParameterExpression record = Expression.Parameter(recordType);
        Delegate receiver = Expression.Lambda(receiverType,
            Expression.Call(Expression.Constant(records), typeof(List<object>).GetMethod("Add")!, Expression.Convert(record, typeof(object))), record).Compile();
        var wrapper = new DynamicMethod("RiskDecode", typeof(void), new[] { typeof(byte[]), typeof(object) }, typeof(Program).Module, true);
        ILGenerator il = wrapper.GetILGenerator();
        il.Emit(OpCodes.Ldarg_0);
        il.Emit(OpCodes.Newobj, typeof(ReadOnlySpan<byte>).GetConstructor(new[] { typeof(byte[]) })!);
        il.Emit(OpCodes.Ldarg_1);
        il.Emit(OpCodes.Castclass, receiverType);
        il.Emit(OpCodes.Call, decode);
        il.Emit(OpCodes.Ret);
        var run = (Action<byte[], object>)wrapper.CreateDelegate(typeof(Action<byte[], object>));
        byte[] good = Records((5, "new.md"), (3, "new.md"), (3, "new.md"), (4, "old.md"));
        run(good, receiver);
        uint[] actions = records.Select(item => (uint)recordType.GetProperty("Action")!.GetValue(item)!).ToArray();
        check("windows.decoder.duplicate_and_reverse_rename_order", actions.SequenceEqual(new uint[] { 5, 3, 3, 4 }), actions, new uint[] { 5, 3, 3, 4 });
        records.Clear();
        byte[] partial = Records((3, "complete-prefix.md"), (4, "broken-tail.md"));
        Array.Resize(ref partial, partial.Length - 10);
        string error = "none";
        try
        {
            run(partial, receiver);
        }
        catch (InvalidDataException exception)
        {
            error = exception.Message;
        }
        check("windows.decoder.truncated_tail_reports_failure_after_auditable_prefix", error != "none" && records.Count == 1,
            new
            {
                deliveredPrefix = records.Count,
                error
            }, "one raw prefix fact plus explicit decode failure; session must require rescan");
    }

    private static byte[] Records(params (uint Action, string Path)[] records)
    {
        var result = new List<byte>();
        for (int index = 0; index < records.Length; index++)
        {
            byte[] name = Encoding.Unicode.GetBytes(records[index].Path);
            var bytes = new byte[(12 + name.Length + 3) & ~3];
            BinaryPrimitives.WriteUInt32LittleEndian(bytes, index == records.Length - 1 ? 0 : (uint)bytes.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(4), records[index].Action);
            BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(8), (uint)name.Length);
            name.CopyTo(bytes, 12);
            result.AddRange(bytes);
        }
        return result.ToArray();
    }

    private static void RunComposite(Action<string, bool, object, object> check)
    {
        var root = new ArticleVaultRootManifest(ArticleVaultSchemas.RootManifest, 1, ArticleVaultSchemas.ControlTreeVersion,
            new(ArticleVaultSchemas.RootManifestPath, ArticleVaultSchemas.ArticleManifestDirectory, ArticleVaultSchemas.ReceiptDirectory),
            "site", "vault", "device", [new("portable-a", ".fsus/articles/portable-a.json", Digest, "articles/first.md")], [], "");
        root = root with
        {
            ContentSha256 = ArticleVaultManifestCodec.ComputeContentSha256(root)
        };
        var binding = new VaultObservationBinding(new("site", "vault", "device", "agent", Digest, root.ContentSha256, VaultPathComparisonPolicy.Ordinal), "watch");
        VaultFilesystemObservation[] inventory = [new("articles/first.md", false, null)];
        var before = new VaultObservationWatermark("watch", 0, ArticleVaultEventNormalizer.ComputeSnapshotSha256(inventory), null);
        LinuxVaultRawFact native = LinuxVaultRawFactCodec.Seal(new(LinuxVaultWatcherSchemas.RawFact, 1, "linux", "ext4", "site", "vault", "device",
            "agent", Digest, root.ContentSha256, "watch", 1, 0x4000, LinuxVaultFactClass.QueueOverflow, null, null, null,
            1, 1, LinuxVaultPathDisposition.None, "linux_vault_kernel_overflow", true, false, ""));
        IReadOnlyList<VaultRawObservation> projected = LinuxVaultObservationAdapter.Convert(binding, [native]);
        VaultObservationBatch batch = ArticleVaultEventNormalizer.Normalize(root, binding, before, projected, inventory, inventory, []);
        check("composite.real_linux_adapter_overflow_creates_obligation", batch.RescanObligations.Count == 1
            && batch.RescanObligations[0].BlocksSynchronization && !batch.CanAdmitSynchronization,
            new
            {
                obligations = batch.RescanObligations.Count,
                batch.CanAdmitSynchronization,
                reasons = batch.RescanObligations[0].ReasonCodes
            }, "one blocking root obligation; no sync");
        bool verified = ArticleVaultEventNormalizer.Verify(root, binding, before, projected, inventory, inventory, [], batch).IsValid;
        check("composite.independent_batch_verify", verified, verified, true);
        VaultObservationBatch erased = batch with
        {
            RescanObligations = [],
            Events = []
        };
        erased = erased with
        {
            ContentSha256 = ArticleVaultEventNormalizer.ComputeContentSha256(erased)
        };
        bool erasedValid = ArticleVaultEventNormalizer.Verify(root, binding, before, projected, inventory, inventory, [], erased).IsValid;
        check("composite.resealed_obligation_erasure_refused", !erasedValid, erasedValid, false);
        VaultRescanObligation running = ArticleVaultRescanTracker.Begin(batch.RescanObligations[0], "agent");
        VaultRescanObligation failed = ArticleVaultRescanTracker.Fail(running, "agent", "risk_process_interrupted");
        VaultObservationBatch continued = ArticleVaultEventNormalizer.Normalize(root, binding, batch.WatermarkAfter, [], inventory, inventory, [failed]);
        check("composite.interrupted_rescan_persists_on_empty_next_batch", continued.RescanObligations.Count == 1
            && continued.RescanObligations[0].State == VaultRescanState.Failed && continued.RescanObligations[0].BlocksSynchronization,
            new
            {
                state = continued.RescanObligations[0].State.ToString(),
                continued.CanAdmitSynchronization
            }, "Failed + blocking");
        VaultRescanObligation complete = ArticleVaultRescanTracker.CompleteStructuralScan(root,
            ArticleVaultRescanTracker.Begin(failed, "agent"), "agent", [], inventory, inventory);
        check("composite.structural_scan_does_not_manufacture_native_receipt", complete.State == VaultRescanState.AwaitingNativeVerification
            && complete.NativeTerminalReceiptSha256 is null && complete.BlocksSynchronization,
            new
            {
                state = complete.State.ToString(),
                complete.NativeTerminalReceiptSha256,
                complete.BlocksSynchronization
            }, "awaiting native; no native receipt; blocking");
    }
}
