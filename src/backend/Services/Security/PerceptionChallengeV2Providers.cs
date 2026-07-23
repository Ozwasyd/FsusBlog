using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Services.Security;

public sealed class PerceptionChallengeV2TokenProtector(IPerceptionSealedTokenService sealedTokens)
    : IPerceptionChallengeV2TokenProtector
{
    public Task<PerceptionChallengeV2SealResult> SealAsync(
        PerceptionChallengeV2TokenClaims claims,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(claims);
        cancellationToken.ThrowIfCancellationRequested();

        var payload = new PerceptionSealedTokenPayload(
            claims.ChallengeId,
            PerceptionChallengeV2Contracts.ToWireTaskKind(claims.TaskKind),
            claims.Action,
            claims.RouteKey,
            claims.SubjectHash,
            claims.ClientIpHash,
            claims.DeviceFpHash,
            HashValue(claims.ContextualUserAgentMaterial()),
            claims.Algorithm,
            claims.Family,
            claims.Variant,
            claims.RecipeHashHex,
            claims.ExpectedX.HasValue && claims.ExpectedY.HasValue
                ? PerceptionChallengeV2Hashing.HashPointHex(claims.ExpectedX.Value, claims.ExpectedY.Value)
                : string.Empty,
            CoordinateToleranceToPixels(claims.CoordinateTolerance),
            claims.ExpectedStepHashHex ?? string.Empty,
            claims.IssuedAt.ToUnixTimeMilliseconds(),
            claims.ExpiresAt.ToUnixTimeMilliseconds(),
            claims.MaxAttempts,
            750,
            60_000,
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)),
            claims.KeyVersion,
            claims.PolicyVersion)
        {
            ExpectedX = claims.ExpectedX,
            ExpectedY = claims.ExpectedY,
            CoordinateTolerance = claims.CoordinateTolerance
        };

        string sealedToken = sealedTokens.Seal(payload);
        string signatureHex = HashValue(sealedToken);
        return Task.FromResult(new PerceptionChallengeV2SealResult(true, "ok", sealedToken, signatureHex, payload.KeyVersion));
    }

    public Task<PerceptionChallengeV2UnsealResult> UnsealAsync(
        string sealedToken,
        string signatureHex,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string token = sealedToken ?? string.Empty;
        string expectedSignature = HashValue(token);
        if (!PerceptionChallengeV2Hashing.FixedTimeEqualsHex(signatureHex ?? string.Empty, expectedSignature))
        {
            return Task.FromResult(PerceptionChallengeV2UnsealResult.Failed("token_tampered"));
        }

        PerceptionSealedTokenOpenResult opened = sealedTokens.Open(token);
        if (!opened.Succeeded || opened.Payload is null)
        {
            return Task.FromResult(PerceptionChallengeV2UnsealResult.Failed(opened.Reason));
        }

        PerceptionSealedTokenPayload payload = opened.Payload;
        if (!PerceptionChallengeV2Contracts.TryParseWireTaskKind(payload.TaskKind, out RenderRecipeV2TaskKind taskKind))
        {
            return Task.FromResult(PerceptionChallengeV2UnsealResult.Failed("task_kind_invalid"));
        }

        SecurityChallengeKind challengeKind = PerceptionChallengeV2Contracts.ToChallengeKind(taskKind);
        var claims = new PerceptionChallengeV2TokenClaims(
            payload.ChallengeId,
            SecurityChallengeContracts.ToWireName(challengeKind),
            payload.Algorithm,
            payload.KeyVersion,
            taskKind,
            payload.Action,
            payload.RouteKey,
            payload.SubjectHash,
            payload.ClientIpHash,
            payload.DeviceFpHash,
            payload.PolicyVersion,
            payload.RecipeHashHex,
            DateTimeOffset.FromUnixTimeMilliseconds(payload.IssuedAtUnixMs),
            DateTimeOffset.FromUnixTimeMilliseconds(payload.ExpiresAtUnixMs),
            payload.MaxAttempts,
            string.IsNullOrWhiteSpace(payload.ExpectedStepHashHex) ? null : payload.ExpectedStepHashHex,
            payload.ExpectedX,
            payload.ExpectedY,
            payload.CoordinateTolerance)
        {
            Family = payload.Family,
            Variant = payload.Variant
        };

        return Task.FromResult(PerceptionChallengeV2UnsealResult.Success(claims));
    }

    private static int CoordinateToleranceToPixels(double? tolerance)
        => tolerance.HasValue ? Math.Clamp((int)Math.Ceiling(tolerance.Value * 128), 0, 128) : 0;

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}

public static class PerceptionChallengeV2TokenClaimExtensions
{
    public static string ContextualUserAgentMaterial(this PerceptionChallengeV2TokenClaims claims)
        => string.Join('|', claims.ChallengeId, claims.Action, claims.RouteKey, claims.PolicyVersion);
}

public sealed class DefaultPerceptionChallengeV2TaskSource(IConfiguration configuration)
    : IPerceptionChallengeV2TaskSource
{
    private const int CanvasWidth = 320;
    private const int CanvasHeight = 180;
    private const string FixedRecipeSeedKey = "Security:PerceptionV2:Generator:FixedSeed";

    public Task<PerceptionChallengeV2TaskMaterial> CreateAsync(
        PerceptionChallengeV2TaskSourceRequest request,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string family = PerceptionChallengeV2GeneratorFamilyRegistry.NormalizeFamily(request.Family);
        string variant = NormalizeVariant(family, request.Variant);
        PerceptionChallengeV2TaskMaterial material = request.TaskKind switch
        {
            RenderRecipeV2TaskKind.Localization => CreateLocalizationMaterial(request, family, variant),
            RenderRecipeV2TaskKind.MicroInteraction => CreateMicroInteractionMaterial(request, family, variant),
            _ => throw new ArgumentOutOfRangeException(nameof(request), request.TaskKind, "Unsupported perception task kind.")
        };

        return Task.FromResult(material);
    }

    private PerceptionChallengeV2TaskMaterial CreateLocalizationMaterial(
        PerceptionChallengeV2TaskSourceRequest request,
        string family,
        string variant)
    {
        double x = ReadCoordinate("Security:PerceptionV2:Localization:FixedX", 0.60, CanvasWidth);
        double y = ReadCoordinate("Security:PerceptionV2:Localization:FixedY", 0.55, CanvasHeight);
        string seed = ResolveRecipeSeed(request, family, variant, string.Create(CultureInfo.InvariantCulture, $"{x:0.######},{y:0.######}"));
        return new PerceptionChallengeV2TaskMaterial(
            RenderRecipeV2TaskKind.Localization,
            CreateRecipe(RenderRecipeV2TaskKind.Localization, family, variant, seed, x, y),
            x,
            y,
            ResolveCoordinateTolerance(family, variant, 10d / CanvasWidth),
            null);
    }

    private PerceptionChallengeV2TaskMaterial CreateMicroInteractionMaterial(
        PerceptionChallengeV2TaskSourceRequest request,
        string family,
        string variant)
    {
        string? step = configuration["Security:PerceptionV2:MicroInteraction:FixedSteps"];
        if (string.IsNullOrWhiteSpace(step))
        {
            step = "drag:confirm";
        }

        (double x, double y) = ResolveFinalStepPoint(step);
        string seed = ResolveRecipeSeed(request, family, variant, step);
        return new PerceptionChallengeV2TaskMaterial(
            RenderRecipeV2TaskKind.MicroInteraction,
            CreateRecipe(RenderRecipeV2TaskKind.MicroInteraction, family, variant, seed, x, y),
            x,
            y,
            ResolveCoordinateTolerance(family, variant, 8d / CanvasWidth),
            step);
    }

    private string ResolveRecipeSeed(
        PerceptionChallengeV2TaskSourceRequest request,
        string family,
        string variant,
        string truthSeed)
    {
        string? fixedSeed = configuration[FixedRecipeSeedKey];
        string root = string.IsNullOrWhiteSpace(fixedSeed) ? "runtime" : fixedSeed.Trim();
        return string.Join(
            '|',
            root,
            request.TaskKind,
            request.Action,
            request.RouteKey,
            request.PolicyVersion,
            family,
            variant,
            truthSeed);
    }

    private static RenderRecipeV2 CreateRecipe(
        RenderRecipeV2TaskKind taskKind,
        string family,
        string variant,
        string seed,
        double? targetX = null,
        double? targetY = null)
    {
        RecipeBuildContext context = RecipeBuildContext.Create(taskKind, family, variant, seed, targetX, targetY);
        IReadOnlyList<RenderRecipeV2Layer> layers = family switch
        {
            PerceptionChallengeV2GeneratorFamilyRegistry.SplineField => BuildSplineField(context),
            PerceptionChallengeV2GeneratorFamilyRegistry.FourierField => BuildFourierField(context),
            PerceptionChallengeV2GeneratorFamilyRegistry.PiecewiseWarp => BuildPiecewiseWarp(context),
            PerceptionChallengeV2GeneratorFamilyRegistry.TopologyCut => BuildTopologyCut(context),
            PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField => BuildLocalizationField(context),
            _ => BuildLocalizationField(context)
        };
        return new RenderRecipeV2(
            RenderRecipeV2Contracts.Schema,
            taskKind,
            layers,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["canvasWidth"] = CanvasWidth.ToString(CultureInfo.InvariantCulture),
                ["canvasHeight"] = CanvasHeight.ToString(CultureInfo.InvariantCulture),
                ["inputMode"] = "pointer",
                ["motionProfile"] = ResolveMotionProfile(family, variant),
                ["palette"] = ResolvePalette(family),
                ["contrast"] = IsDenseVariant(variant) ? "high" : "normal"
            });
    }

    private static IReadOnlyList<RenderRecipeV2Layer> BuildSplineField(RecipeBuildContext context)
    {
        bool split = context.Variant.Contains("split", StringComparison.OrdinalIgnoreCase) ||
                     context.Variant.Contains("curve-b", StringComparison.OrdinalIgnoreCase);
        IReadOnlyList<RenderStrokeSegmentV2> foreground = split
            ? [
                Stroke("spline-a", "calligraphic", "#172033ff", 0.030, context.Points((0.08, 0.30), (0.24, 0.54), (0.42, 0.42), (0.62, 0.66))),
                Stroke("spline-b", "round", "#475569ff", 0.022, context.Points((0.18, 0.20), (0.40, 0.35), (0.68, 0.28), (0.88, 0.50)))
            ]
            : [
                Stroke("spline-a", "calligraphic", "#172033ff", 0.027, context.Points((0.10, 0.34), (0.32, 0.52), (0.56, 0.44), (0.82, 0.62)))
            ];

        return
        [
            new RenderRecipeV2Layer(
                "spline-foreground",
                0.90,
                foreground,
                [new RenderNoiseFieldV2("spline-grain", context.SeedHex("spline-grain"), split ? 0.20 : 0.13, split ? 0.26 : 0.18)],
                [new RenderWarpFieldV2("spline-warp", context.SeedHex("spline-warp"), split ? 0.075 : 0.045, split ? 12.0 : 7.0)],
                split
                    ? [Mask("spline-gap", "ellipse", 0.50, 0.48, 0.15, 0.10, 18, "#f8fafcbb")]
                    : []),
            new RenderRecipeV2Layer(
                "spline-guide",
                split ? 0.50 : 0.34,
                [
                    Stroke("guide-a", "round", "#94a3b8aa", split ? 0.012 : 0.010, context.Points((0.12, 0.78), (0.44, 0.70), (0.80, 0.78)))
                ],
                [],
                [],
                [])
        ];
    }

    private static IReadOnlyList<RenderRecipeV2Layer> BuildFourierField(RecipeBuildContext context)
    {
        bool shifted = context.Variant.Contains("shift", StringComparison.OrdinalIgnoreCase) ||
                       context.Variant.Contains("phase-b", StringComparison.OrdinalIgnoreCase);
        double phase = shifted ? 0.12 + context.ByteUnit(8) * 0.10 : context.ByteUnit(8) * 0.06;
        return
        [
            new RenderRecipeV2Layer(
                "fourier-wave",
                0.88,
                [
                    Stroke("wave-a", "round", "#0f172aff", 0.024, WavePoints(context, 0.30 + phase, shifted ? 0.12 : 0.08, 0.0)),
                    Stroke("wave-b", "texture", "#334155dd", 0.018, WavePoints(context, 0.56 - phase, shifted ? 0.10 : 0.06, 0.33))
                ],
                [
                    new RenderNoiseFieldV2("phase-grain-a", context.SeedHex("phase-grain-a"), shifted ? 0.24 : 0.16, shifted ? 0.36 : 0.24),
                    new RenderNoiseFieldV2("phase-grain-b", context.SeedHex("phase-grain-b"), shifted ? 0.12 : 0.08, shifted ? 0.12 : 0.18)
                ],
                [
                    new RenderWarpFieldV2("phase-warp-a", context.SeedHex("phase-warp-a"), shifted ? 0.11 : 0.06, shifted ? 18.0 : 9.0),
                    new RenderWarpFieldV2("phase-warp-b", context.SeedHex("phase-warp-b"), shifted ? 0.04 : 0.025, shifted ? 32.0 : 16.0)
                ],
                shifted
                    ? [Mask("phase-mask", "rect", 0.44, 0.50, 0.22, 0.08, -16, "#f1f5f9aa")]
                    : [Mask("phase-mask", "ellipse", 0.62, 0.40, 0.16, 0.09, 0, "#f8fafcaa")])
        ];
    }

    private static IReadOnlyList<RenderRecipeV2Layer> BuildPiecewiseWarp(RecipeBuildContext context)
    {
        bool tiled = context.Variant.Contains("tile", StringComparison.OrdinalIgnoreCase) ||
                     context.Variant.Contains("warp-b", StringComparison.OrdinalIgnoreCase);
        return
        [
            new RenderRecipeV2Layer(
                "warp-bands",
                0.82,
                [
                    Stroke("band-a", "square", "#1e293bff", tiled ? 0.026 : 0.032, context.Points((0.12, 0.26), (0.36, 0.30), (0.60, 0.26), (0.84, 0.34))),
                    Stroke("band-b", "round", "#475569ee", tiled ? 0.020 : 0.024, context.Points((0.10, 0.62), (0.32, 0.58), (0.56, 0.66), (0.82, 0.60)))
                ],
                [
                    new RenderNoiseFieldV2("warp-grain", context.SeedHex("warp-grain"), tiled ? 0.26 : 0.18, tiled ? 0.16 : 0.28)
                ],
                tiled
                    ? [
                        new RenderWarpFieldV2("warp-tile-x", context.SeedHex("warp-tile-x"), 0.10, 24.0),
                        new RenderWarpFieldV2("warp-tile-y", context.SeedHex("warp-tile-y"), 0.07, 36.0)
                    ]
                    : [
                        new RenderWarpFieldV2("warp-band-top", context.SeedHex("warp-band-top"), 0.08, 10.0),
                        new RenderWarpFieldV2("warp-band-bottom", context.SeedHex("warp-band-bottom"), 0.05, 6.0)
                    ],
                tiled
                    ? [
                        Mask("tile-a", "rect", 0.30, 0.46, 0.12, 0.10, 0, "#e2e8f0bb"),
                        Mask("tile-b", "rect", 0.66, 0.52, 0.13, 0.11, 0, "#f8fafcbb")
                    ]
                    : [
                        Mask("band-cut", "polygon", 0.52, 0.48, 0.24, 0.08, 22, "#f8fafccc")
                    ]),
            new RenderRecipeV2Layer(
                "warp-register",
                tiled ? 0.42 : 0.32,
                [Stroke("register-a", "round", "#64748baa", 0.011, context.Points((0.20, 0.80), (0.50, 0.76), (0.80, 0.82)))],
                [],
                [],
                [])
        ];
    }

    private static IReadOnlyList<RenderRecipeV2Layer> BuildTopologyCut(RecipeBuildContext context)
    {
        bool island = context.Variant.Contains("island", StringComparison.OrdinalIgnoreCase) ||
                      context.Variant.Contains("cut-b", StringComparison.OrdinalIgnoreCase);
        return
        [
            new RenderRecipeV2Layer(
                "topology-ink",
                0.90,
                [
                    Stroke("topology-a", "texture", "#111827ff", island ? 0.026 : 0.030, context.Points((0.14, 0.22), (0.34, 0.48), (0.54, 0.30), (0.76, 0.58))),
                    Stroke("topology-b", "calligraphic", "#334155ee", island ? 0.019 : 0.023, context.Points((0.18, 0.72), (0.38, 0.56), (0.62, 0.72), (0.84, 0.50)))
                ],
                [new RenderNoiseFieldV2("topology-grain", context.SeedHex("topology-grain"), island ? 0.22 : 0.16, 0.20)],
                [new RenderWarpFieldV2("topology-warp", context.SeedHex("topology-warp"), island ? 0.070 : 0.050, island ? 14.0 : 8.0)],
                island
                    ? [
                        Mask("island-a", "ellipse", 0.40, 0.44, 0.16, 0.15, 0, "#f8fafccc"),
                        Mask("island-b", "ellipse", 0.62, 0.58, 0.12, 0.12, 0, "#e2e8f0cc")
                    ]
                    : [
                        Mask("bridge-cut", "rect", 0.50, 0.48, 0.28, 0.08, -18, "#f8fafccc")
                    ]),
            new RenderRecipeV2Layer(
                island ? "topology-islands" : "topology-bridge",
                island ? 0.46 : 0.38,
                island
                    ? [
                        Stroke("island-ring-a", "round", "#64748baa", 0.010, context.Points((0.32, 0.42), (0.42, 0.34), (0.52, 0.44))),
                        Stroke("island-ring-b", "round", "#64748baa", 0.010, context.Points((0.54, 0.60), (0.66, 0.50), (0.74, 0.62)))
                    ]
                    : [
                        Stroke("bridge-a", "square", "#64748baa", 0.012, context.Points((0.26, 0.50), (0.74, 0.50)))
                    ],
                [],
                [],
                [])
        ];
    }

    private static IReadOnlyList<RenderRecipeV2Layer> BuildLocalizationField(RecipeBuildContext context)
    {
        bool region = context.Variant.Contains("region", StringComparison.OrdinalIgnoreCase) ||
                      context.Variant.Contains("anchor-b", StringComparison.OrdinalIgnoreCase);
        double x = context.TargetX;
        double y = context.TargetY;
        return
        [
            new RenderRecipeV2Layer(
                "anchor-field",
                0.88,
                [
                    Stroke("anchor-cross-a", "round", "#0f172aff", region ? 0.018 : 0.014, context.BoundPoints((x - 0.10, y), (x - 0.025, y), (x + 0.09, y))),
                    Stroke("anchor-cross-b", "round", "#0f172aff", region ? 0.018 : 0.014, context.BoundPoints((x, y - 0.10), (x, y - 0.025), (x, y + 0.09))),
                    Stroke("anchor-ring", "calligraphic", "#334155dd", region ? 0.016 : 0.012, context.BoundPoints((x - 0.07, y - 0.04), (x, y - 0.07), (x + 0.07, y - 0.04), (x + 0.04, y + 0.06), (x - 0.05, y + 0.05)))
                ],
                [
                    new RenderNoiseFieldV2("anchor-grain", context.SeedHex("anchor-grain"), region ? 0.18 : 0.12, region ? 0.18 : 0.30)
                ],
                [
                    new RenderWarpFieldV2("anchor-warp", context.SeedHex("anchor-warp"), region ? 0.045 : 0.025, region ? 10.0 : 5.0)
                ],
                region
                    ? [
                        Mask("anchor-region-mask", "ellipse", ClampUnit(x + 0.04), ClampUnit(y - 0.03), 0.18, 0.13, 12, "#f8fafc99")
                    ]
                    : [
                        Mask("anchor-grid-mask", "rect", ClampUnit(x - 0.05), ClampUnit(y + 0.04), 0.12, 0.08, -8, "#f1f5f999")
                    ]),
            new RenderRecipeV2Layer(
                region ? "anchor-region" : "anchor-grid",
                region ? 0.44 : 0.36,
                [
                    Stroke("reference-a", "square", "#94a3b8aa", 0.010, context.BoundPoints((0.16, y), (0.84, y))),
                    Stroke("reference-b", "square", "#94a3b8aa", 0.010, context.BoundPoints((x, 0.18), (x, 0.82)))
                ],
                [],
                [],
                [])
        ];
    }

    private static IReadOnlyList<RenderPointV2> WavePoints(RecipeBuildContext context, double centerY, double amplitude, double phase)
    {
        var points = new List<RenderPointV2>(8);
        for (int i = 0; i < 8; i++)
        {
            double x = 0.08 + i * 0.12;
            double y = centerY + Math.Sin((x + phase) * Math.PI * 4d) * amplitude + context.Jitter(i + 20, 0.02);
            points.Add(new RenderPointV2(ClampUnit(x), ClampUnit(y)));
        }

        return points;
    }

    private static RenderStrokeSegmentV2 Stroke(
        string id,
        string brush,
        string color,
        double width,
        IReadOnlyList<RenderPointV2> points)
        => new(id, brush, color, Math.Clamp(width, 0.004, 0.12), points);

    private static RenderOccluderV2 Mask(
        string id,
        string shape,
        double x,
        double y,
        double width,
        double height,
        double rotation,
        string color)
        => new(id, shape, ClampUnit(x), ClampUnit(y), Math.Clamp(width, 0.01, 1), Math.Clamp(height, 0.01, 1), rotation, color);

    private static string ResolveMotionProfile(string family, string variant)
        => family switch
        {
            PerceptionChallengeV2GeneratorFamilyRegistry.FourierField => variant.Contains("shift", StringComparison.OrdinalIgnoreCase) ? "phase-shift" : "wave",
            PerceptionChallengeV2GeneratorFamilyRegistry.PiecewiseWarp => variant.Contains("tile", StringComparison.OrdinalIgnoreCase) ? "tiled" : "banded",
            PerceptionChallengeV2GeneratorFamilyRegistry.TopologyCut => variant.Contains("island", StringComparison.OrdinalIgnoreCase) ? "island-cut" : "bridge-cut",
            PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField => variant.Contains("region", StringComparison.OrdinalIgnoreCase) ? "anchored-region" : "anchored-grid",
            PerceptionChallengeV2GeneratorFamilyRegistry.SplineField => variant.Contains("split", StringComparison.OrdinalIgnoreCase) ? "split-curve" : "soft-curve",
            _ => IsDenseVariant(variant) ? "dense-stroke" : "static"
        };

    private static string ResolvePalette(string family)
        => family switch
        {
            PerceptionChallengeV2GeneratorFamilyRegistry.FourierField => "wave",
            PerceptionChallengeV2GeneratorFamilyRegistry.PiecewiseWarp => "warp",
            PerceptionChallengeV2GeneratorFamilyRegistry.TopologyCut => "topology",
            PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField => "anchor",
            PerceptionChallengeV2GeneratorFamilyRegistry.SplineField => "curve",
            _ => "ink"
        };

    private static double ResolveCoordinateTolerance(string family, string variant, double fallback)
    {
        if (family == PerceptionChallengeV2GeneratorFamilyRegistry.LocalizationField)
        {
            return variant.Contains("region", StringComparison.OrdinalIgnoreCase) ? 12d / CanvasWidth : 8d / CanvasWidth;
        }

        if (family == PerceptionChallengeV2GeneratorFamilyRegistry.TopologyCut)
        {
            return 9d / CanvasWidth;
        }

        return fallback;
    }

    private static bool IsDenseVariant(string variant)
        => variant.Contains("dense", StringComparison.OrdinalIgnoreCase) ||
           variant.Contains("split", StringComparison.OrdinalIgnoreCase) ||
           variant.Contains("island", StringComparison.OrdinalIgnoreCase) ||
           variant.Contains("tiled", StringComparison.OrdinalIgnoreCase);

    private static string NormalizeVariant(string family, string? variant)
    {
        string normalized = (variant ?? string.Empty).Trim();
        if (normalized.Length == 0 || normalized.Length > 64 || !IsSafeToken(normalized))
        {
            return PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(family);
        }

        return normalized;
    }

    private static bool IsSafeToken(string value)
    {
        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (!((ch >= 'a' && ch <= 'z') ||
                  (ch >= 'A' && ch <= 'Z') ||
                  (ch >= '0' && ch <= '9') ||
                  ch is '-' or '_' or ':' or '.'))
            {
                return false;
            }
        }

        return true;
    }

    private static double ClampUnit(double value)
        => double.IsFinite(value) ? Math.Clamp(value, 0d, 1d) : 0d;

    private sealed record RecipeBuildContext(
        RenderRecipeV2TaskKind TaskKind,
        string Family,
        string Variant,
        byte[] Digest,
        string RootSeedHex,
        double TargetX,
        double TargetY)
    {
        public static RecipeBuildContext Create(
            RenderRecipeV2TaskKind taskKind,
            string family,
            string variant,
            string seed,
            double? targetX,
            double? targetY)
        {
            byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes($"{taskKind}:{family}:{variant}:{seed}"));
            double fallbackX = 0.36 + digest[0] / 255d * 0.28;
            double fallbackY = 0.34 + digest[1] / 255d * 0.26;
            return new RecipeBuildContext(
                taskKind,
                family,
                variant,
                digest,
                Convert.ToHexStringLower(digest),
                ClampUnit(targetX ?? fallbackX),
                ClampUnit(targetY ?? fallbackY));
        }

        public double ByteUnit(int index)
            => Digest[index % Digest.Length] / 255d;

        public double Jitter(int index, double span)
            => (ByteUnit(index) - 0.5d) * span;

        public string SeedHex(string salt)
            => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{RootSeedHex}:{salt}")));

        public IReadOnlyList<RenderPointV2> Points(params (double X, double Y)[] points)
        {
            var result = new List<RenderPointV2>(points.Length);
            for (int i = 0; i < points.Length; i++)
            {
                result.Add(new RenderPointV2(
                    ClampUnit(points[i].X + Jitter(i, 0.05)),
                    ClampUnit(points[i].Y + Jitter(i + 9, 0.05))));
            }

            return result;
        }

        public IReadOnlyList<RenderPointV2> BoundPoints(params (double X, double Y)[] points)
        {
            var result = new List<RenderPointV2>(points.Length);
            foreach ((double x, double y) in points)
            {
                result.Add(new RenderPointV2(ClampUnit(x), ClampUnit(y)));
            }

            return result;
        }
    }

    private double ReadCoordinate(string key, double fallback, int pixelScale)
    {
        string? raw = configuration[key];
        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out double value) || !double.IsFinite(value))
        {
            return fallback;
        }

        if (value > 1)
        {
            value /= pixelScale;
        }

        return Math.Clamp(value, 0d, 1d);
    }

    private static (double X, double Y) ResolveFinalStepPoint(string step)
    {
        string last = step.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault() ?? string.Empty;
        int colon = last.IndexOf(':');
        string coordinates = colon >= 0 ? last[(colon + 1)..] : last;
        string[] parts = coordinates.Split(',', StringSplitOptions.TrimEntries);
        if (parts.Length >= 2 &&
            double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out double x) &&
            double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out double y))
        {
            if (x > 1)
                x /= CanvasWidth;
            if (y > 1)
                y /= CanvasHeight;
            return (Math.Clamp(x, 0d, 1d), Math.Clamp(y, 0d, 1d));
        }

        return (0.70, 0.35);
    }
}

public abstract class PerceptionChallengeV2ProviderBase(
    IPerceptionChallengeV2IssueService issueService,
    IPerceptionChallengeV2VerifyService verifyService,
    RenderRecipeV2TaskKind taskKind,
    SecurityChallengeKind challengeKind,
    bool requiresHighRiskEscalation) : ISecurityChallengeProvider
{
    private const string GenericFailure = "perception_challenge_failed";
    private static readonly JsonSerializerOptions s_renderRecipeJsonOptions = CreateRenderRecipeJsonOptions();

    public string Kind => SecurityChallengeContracts.ToWireName(challengeKind);

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(
        SecurityChallengeProviderIssueRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        long startedAt = Stopwatch.GetTimestamp();

        if (requiresHighRiskEscalation && request.EscalationLevel < 2)
        {
            return SecurityChallengeProviderIssueResult.Failed("perception_micro_interaction_escalation_required");
        }

        PerceptionChallengeV2IssueResult issued = await issueService.IssueAsync(
            new PerceptionChallengeV2IssueRequest(
                request.Context,
                request.Action,
                request.RouteKey,
                request.TenantId,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.PolicyVersion,
                request.EscalationLevel,
                request.Traceparent,
                taskKind)
            {
                ChallengeId = request.ChallengeId,
                RiskScore = request.RiskScore,
                EffectiveRiskScore = request.EffectiveRiskScore,
                GeneratorDistributionPolicy = request.GeneratorDistributionPolicy
            },
            cancellationToken);

        if (!issued.Succeeded || issued.Assignment is null)
        {
            return SecurityChallengeProviderIssueResult.Failed(issued.Reason);
        }

        SecurityChallengeAssignment assignment = issued.Assignment.Kind == challengeKind
            ? issued.Assignment
            : issued.Assignment with
            {
                Kind = challengeKind
            };

        IReadOnlyDictionary<string, string> providerPayload = ToProviderPayload(issued.Payload);
        FsusObservability.RecordSecurityChallengeV2Issued(
            Kind,
            request.Action,
            request.PolicyVersion,
            PerceptionChallengeV2Contracts.ToWireTaskKind(taskKind),
            EstimateProviderPayloadBytes(providerPayload),
            FsusObservability.GetElapsed(startedAt));
        return SecurityChallengeProviderIssueResult.Success(assignment, providerPayload);
    }

    public async Task<SecurityChallengeProviderVerifyResult> VerifyAsync(
        SecurityChallengeProviderVerifyRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        long startedAt = Stopwatch.GetTimestamp();
        int payloadBytes = EstimateProviderPayloadBytes(request.ProviderPayload);
        TimeSpan? solveDuration = ReadSolveDuration(request.ProviderPayload);

        PerceptionChallengeV2VerifyResult verified = await verifyService.VerifyAsync(
            new PerceptionChallengeV2VerifyRequest(
                request.Context,
                request.Kind,
                request.ChallengeId,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.PolicyVersion,
                request.ProviderPayload),
            cancellationToken);
        if (!verified.Verified)
        {
            RecordV2Failed(request, verified.Reason, payloadBytes, startedAt, solveDuration);
            return SecurityChallengeProviderVerifyResult.Failed(GenericFailure);
        }

        FsusObservability.RecordSecurityChallengeV2Verified(
            Kind,
            request.Action,
            request.PolicyVersion,
            PerceptionChallengeV2Contracts.ToWireTaskKind(taskKind),
            payloadBytes,
            FsusObservability.GetElapsed(startedAt),
            solveDuration);
        return SecurityChallengeProviderVerifyResult.Success(verified.ProofExpiresAt);
    }

    protected static bool IsEnabled(IConfiguration configuration, string key)
        => SecuritySystemModes.IsEnforcing(SecuritySystemModes.Normalize(configuration[key] ?? SecuritySystemModes.Disabled));

    private IReadOnlyDictionary<string, string> ToProviderPayload(PerceptionChallengeV2IssuePayload payload)
    {
        string recipeJson = JsonSerializer.Serialize(payload.Recipe, s_renderRecipeJsonOptions);
        return new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["algorithm"] = payload.Algorithm,
            ["keyVersion"] = payload.KeyVersion,
            ["taskKind"] = PerceptionChallengeV2Contracts.ToWireTaskKind(payload.TaskKind),
            ["recipeJson"] = recipeJson,
            ["recipeHashHex"] = payload.RecipeHashHex,
            ["sealedToken"] = payload.SealedToken,
            ["signatureHex"] = payload.SignatureHex,
            ["issuedAtUnixMs"] = payload.IssuedAtUnixMs.ToString(CultureInfo.InvariantCulture),
            ["expiresAtUnixMs"] = payload.ExpiresAtUnixMs.ToString(CultureInfo.InvariantCulture)
        };
    }

    private static JsonSerializerOptions CreateRenderRecipeJsonOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
        return options;
    }

    private void RecordV2Failed(
        SecurityChallengeProviderVerifyRequest request,
        string reason,
        int payloadBytes,
        long startedAt,
        TimeSpan? solveDuration)
        => FsusObservability.RecordSecurityChallengeV2Failed(
            Kind,
            request.Action,
            reason,
            request.PolicyVersion,
            PerceptionChallengeV2Contracts.ToWireTaskKind(taskKind),
            payloadBytes,
            FsusObservability.GetElapsed(startedAt),
            solveDuration);

    private static TimeSpan? ReadSolveDuration(IReadOnlyDictionary<string, string> providerPayload)
        => TryGetInt(providerPayload, "solveDurationMs", out int solveDurationMs) && solveDurationMs >= 0
            ? TimeSpan.FromMilliseconds(solveDurationMs)
            : null;

    private static int EstimateProviderPayloadBytes(IReadOnlyDictionary<string, string> payload)
    {
        int bytes = 2;
        foreach (KeyValuePair<string, string> item in payload)
        {
            bytes += Encoding.UTF8.GetByteCount(item.Key);
            bytes += Encoding.UTF8.GetByteCount(item.Value ?? string.Empty);
            bytes += 6;
        }

        return bytes;
    }

    private static bool TryGet(IReadOnlyDictionary<string, string> payload, string key, out string value)
    {
        value = string.Empty;
        if (!payload.TryGetValue(key, out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        value = raw.Trim();
        return true;
    }

    private static bool TryGetInt(IReadOnlyDictionary<string, string> payload, string key, out int value)
    {
        value = 0;
        return TryGet(payload, key, out string raw) &&
               int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }

}

internal static class PerceptionChallengeV2StandaloneFactory
{
    public static IPerceptionChallengeV2IssueService CreateIssueService(IConfiguration configuration, TimeProvider timeProvider)
        => new PerceptionChallengeV2IssueService(
            new DefaultPerceptionChallengeV2TaskSource(configuration),
            CreateTokenProtector(configuration, timeProvider),
            timeProvider);

    public static IPerceptionChallengeV2TokenProtector CreateTokenProtector(IConfiguration configuration, TimeProvider timeProvider)
        => new PerceptionChallengeV2TokenProtector(
            new PerceptionSealedTokenService(
                new ConfigurationBackedOptionsMonitor<PerceptionSealedTokenOptions>(CreateTokenOptions(configuration)),
                timeProvider));

    private static PerceptionSealedTokenOptions CreateTokenOptions(IConfiguration configuration)
    {
        const string FallbackKeyVersion = "current";
        string currentKeyVersion = NormalizeToken(
            configuration[$"{PerceptionSealedTokenOptions.SectionName}:CurrentKeyVersion"],
            FallbackKeyVersion);
        var options = new PerceptionSealedTokenOptions
        {
            CurrentKeyVersion = currentKeyVersion
        };

        IConfigurationSection keysSection = configuration.GetSection($"{PerceptionSealedTokenOptions.SectionName}:Keys");
        foreach (IConfigurationSection child in keysSection.GetChildren())
        {
            if (!string.IsNullOrWhiteSpace(child.Key) && !string.IsNullOrWhiteSpace(child.Value))
            {
                options.Keys[child.Key.Trim()] = child.Value.Trim();
            }
        }

        if (options.Keys.Count == 0)
        {
            throw new InvalidOperationException($"{PerceptionSealedTokenOptions.SectionName}:Keys must contain at least one signing key.");
        }

        if (!options.Keys.ContainsKey(options.CurrentKeyVersion))
        {
            throw new InvalidOperationException(
                $"{PerceptionSealedTokenOptions.SectionName}:CurrentKeyVersion '{options.CurrentKeyVersion}' must reference configured {PerceptionSealedTokenOptions.SectionName}:Keys:{options.CurrentKeyVersion}.");
        }

        return options;
    }

    private static string NormalizeToken(string? value, string fallback)
        => string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}

public sealed class PerceptionLocalizationV2Provider(
    IPerceptionChallengeV2IssueService issueService,
    IPerceptionChallengeV2VerifyService verifyService)
    : PerceptionChallengeV2ProviderBase(
        issueService,
        verifyService,
        RenderRecipeV2TaskKind.Localization,
        SecurityChallengeKind.PerceptionLocalizationV2,
        false)
{
    public const string WireKind = "perceptionLocalizationV2";
    public const string Algorithm = PerceptionChallengeV2Constants.WireAlgorithm;
}

public sealed class PerceptionMicroInteractionV2Provider : PerceptionChallengeV2ProviderBase
{
    public const string WireKind = "perceptionMicroInteractionV2";
    public const string Algorithm = PerceptionChallengeV2Constants.WireAlgorithm;

    public PerceptionMicroInteractionV2Provider(
        IPerceptionChallengeV2IssueService issueService,
        IPerceptionChallengeV2VerifyService verifyService,
        IConfiguration configuration)
        : base(
            new FeatureGatedIssueService(issueService, configuration),
            verifyService,
            RenderRecipeV2TaskKind.MicroInteraction,
            SecurityChallengeKind.PerceptionMicroInteractionV2,
            true)
    {
    }

    private sealed class FeatureGatedIssueService(
        IPerceptionChallengeV2IssueService inner,
        IConfiguration configuration) : IPerceptionChallengeV2IssueService
    {
        public Task<PerceptionChallengeV2IssueResult> IssueAsync(
            PerceptionChallengeV2IssueRequest request,
            CancellationToken cancellationToken = default)
        {
            string mode = SecuritySystemModes.Normalize(configuration["Security:PerceptionV2:MicroInteraction:Mode"]);
            return SecuritySystemModes.IsEnforcing(mode)
                ? inner.IssueAsync(request, cancellationToken)
                : Task.FromResult(PerceptionChallengeV2IssueResult.Failed("perception_micro_interaction_disabled"));
        }
    }
}

internal sealed class ConfigurationBackedOptionsMonitor<T>(T value) : IOptionsMonitor<T>
{
    public T CurrentValue { get; } = value;

    public T Get(string? name) => CurrentValue;

    public IDisposable? OnChange(Action<T, string?> listener) => null;
}
