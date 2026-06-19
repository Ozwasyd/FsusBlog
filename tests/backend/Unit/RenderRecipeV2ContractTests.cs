using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RenderRecipeV2ContractTests
{
    private const string SeedA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string SeedB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Theory]
    [InlineData("answer")]
    [InlineData("glyphs")]
    [InlineData("glyphIds")]
    [InlineData("charIds")]
    [InlineData("expectedPoint")]
    [InlineData("expectedStep")]
    public void ValidateRecipeJson_RejectsForbiddenSemanticFields(string forbiddenField)
    {
        string json = $$"""
        {
          "schema": "fsus.challenge.render-recipe@v2",
          "taskKind": "character",
          "layers": [
            {
              "layerId": "ink",
              "opacity": 1,
              "strokeSegments": [
                {
                  "segmentId": "stroke-1",
                  "brush": "round",
                  "colorRgba": "#1f2937ff",
                  "width": 0.04,
                  "points": [
                    { "x": 0.12, "y": 0.24 },
                    { "x": 0.40, "y": 0.51 }
                  ],
                  "{{forbiddenField}}": "leak"
                }
              ],
              "noiseFields": [],
              "warpFields": [],
              "occluders": []
            }
          ],
          "presentationHints": {
            "inputMode": "pointer"
          }
        }
        """;

        RenderRecipeV2ValidationResult result = RenderRecipeV2Contracts.ValidateRecipeJson(json);

        Assert.False(result.IsValid);
        Assert.Equal("semantic_field_forbidden", result.ErrorCode);
    }

    [Fact]
    public void ComputeRecipeHashHex_IsStableAcrossJsonPropertyOrder()
    {
        string first = """
        {
          "schema": "fsus.challenge.render-recipe@v2",
          "taskKind": "localization",
          "layers": [
            {
              "layerId": "base",
              "opacity": 0.9,
              "strokeSegments": [
                {
                  "segmentId": "stroke-1",
                  "brush": "round",
                  "colorRgba": "#334155ff",
                  "width": 0.05,
                  "points": [
                    { "x": 0.15, "y": 0.20 },
                    { "x": 0.65, "y": 0.72 }
                  ]
                }
              ],
              "noiseFields": [
                { "fieldId": "grain", "seedHex": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "intensity": 0.35, "scale": 0.12 }
              ],
              "warpFields": [],
              "occluders": []
            }
          ],
          "presentationHints": {
            "inputMode": "pointer",
            "contrast": "normal"
          }
        }
        """;
        string sameRecipeDifferentOrder = """
        {
          "presentationHints": {
            "contrast": "normal",
            "inputMode": "pointer"
          },
          "layers": [
            {
              "occluders": [],
              "warpFields": [],
              "noiseFields": [
                { "scale": 0.12, "intensity": 0.35, "seedHex": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "fieldId": "grain" }
              ],
              "strokeSegments": [
                {
                  "points": [
                    { "y": 0.20, "x": 0.15 },
                    { "y": 0.72, "x": 0.65 }
                  ],
                  "width": 0.05,
                  "colorRgba": "#334155ff",
                  "brush": "round",
                  "segmentId": "stroke-1"
                }
              ],
              "opacity": 0.9,
              "layerId": "base"
            }
          ],
          "taskKind": "localization",
          "schema": "fsus.challenge.render-recipe@v2"
        }
        """;

        string firstHash = RenderRecipeV2Contracts.ComputeRecipeHashHex(first);
        string secondHash = RenderRecipeV2Contracts.ComputeRecipeHashHex(sameRecipeDifferentOrder);

        Assert.Equal(firstHash, secondHash);
        Assert.Matches("^[0-9a-f]{64}$", firstHash);
    }

    [Fact]
    public void ValidateRecipeJson_RejectsTamperedRecipeHash()
    {
        RenderRecipeV2 recipe = CreateRecipe(RenderRecipeV2TaskKind.MicroInteraction);
        string expectedHash = RenderRecipeV2Contracts.ComputeRecipeHashHex(recipe);
        RenderRecipeV2 tampered = recipe with
        {
            Layers =
            [
                recipe.Layers[0] with
                {
                    Occluders =
                    [
                        recipe.Layers[0].Occluders[0] with { Width = recipe.Layers[0].Occluders[0].Width + 0.01 }
                    ]
                },
                recipe.Layers[1]
            ]
        };

        RenderRecipeV2ValidationResult result = RenderRecipeV2Contracts.ValidateRecipe(tampered, expectedHash);

        Assert.False(result.IsValid);
        Assert.Equal("recipe_hash_mismatch", result.ErrorCode);
        Assert.NotEqual(expectedHash, RenderRecipeV2Contracts.ComputeRecipeHashHex(tampered));
    }

    [Theory]
    [InlineData(RenderRecipeV2TaskKind.Character)]
    [InlineData(RenderRecipeV2TaskKind.Localization)]
    [InlineData(RenderRecipeV2TaskKind.MicroInteraction)]
    public void ValidateRecipe_AcceptsSharedMultiLayerDrawingPrimitives(RenderRecipeV2TaskKind taskKind)
    {
        RenderRecipeV2 recipe = CreateRecipe(taskKind);
        string recipeHashHex = RenderRecipeV2Contracts.ComputeRecipeHashHex(recipe);

        RenderRecipeV2ValidationResult result = RenderRecipeV2Contracts.ValidateRecipe(recipe, recipeHashHex);

        Assert.True(result.IsValid, result.ErrorCode);
        Assert.Equal(recipeHashHex, result.RecipeHashHex);
        Assert.Equal(2, recipe.Layers.Count);
        Assert.NotEmpty(recipe.Layers[0].StrokeSegments);
        Assert.NotEmpty(recipe.Layers[0].NoiseFields);
        Assert.NotEmpty(recipe.Layers[0].WarpFields);
        Assert.NotEmpty(recipe.Layers[0].Occluders);
        Assert.Equal("pointer", recipe.PresentationHints["inputMode"]);
    }

    private static RenderRecipeV2 CreateRecipe(RenderRecipeV2TaskKind taskKind)
        => new(
            RenderRecipeV2Contracts.Schema,
            taskKind,
            [
                new RenderRecipeV2Layer(
                    "foreground",
                    0.92,
                    [
                        new RenderStrokeSegmentV2(
                            "stroke-1",
                            "round",
                            "#111827ff",
                            0.04,
                            [
                                new RenderPointV2(0.12, 0.18),
                                new RenderPointV2(0.38, 0.46),
                                new RenderPointV2(0.64, 0.34)
                            ])
                    ],
                    [
                        new RenderNoiseFieldV2("grain-a", SeedA, 0.22, 0.16)
                    ],
                    [
                        new RenderWarpFieldV2("warp-a", SeedB, 0.08, 1.5)
                    ],
                    [
                        new RenderOccluderV2("mask-a", "ellipse", 0.52, 0.48, 0.18, 0.11, 12, "#f8fafcff")
                    ]),
                new RenderRecipeV2Layer(
                    "background",
                    0.5,
                    [],
                    [
                        new RenderNoiseFieldV2("grain-b", SeedB, 0.12, 0.24)
                    ],
                    [],
                    [
                        new RenderOccluderV2("mask-b", "rect", 0.08, 0.12, 0.22, 0.08, 0, "#e2e8f0ff")
                    ])
            ],
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["inputMode"] = "pointer",
                ["contrast"] = "normal",
                ["motionProfile"] = "settled"
            });
}
