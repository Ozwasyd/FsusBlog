# Perception V2 release evidence

`perception-sealed@v2` 当前只验证 `perceptionLocalizationV2` 与 `perceptionMicroInteractionV2`。字符感知由 V3 独立承担；V2 不解析字符或文本任务。

## Gate

```bash
./tools/test.sh perception-v2-test-matrix --no-deps
```

证据必须证明两种当前 task 的 `issue -> render -> verify -> proof -> business-action-resume`，并覆盖 AEAD sealed token、坐标或步骤响应、render recipe、`RecipeHash`、assignment binding、attempt gate 与 consume-once。错误坐标/步骤、过期、重复提交、action/route/identity mismatch、recipe tamper 与未知 task 均 fail closed。

发布证据同时记录匿名、登录、admin、notification stream 和 AEDS binary 五类路径。admin policy 写仍需 admin MFA proof；notification 只允许 proof preflight 后的短效 path-bound grant；没有 JSON fallback。

运行时证据继续写入 `.tmp/security/perception-v2-e2e-runtime.json`、`.tmp/security/perception-v2-test-matrix.json` 与 `.tmp/release-evidence/perception-v2-release-evidence.json`。指标至少包含 issue/verify latency、render latency、replay/revoke、audit queue 和 provider failure。

无需重启的回退是把受影响 action 热更新为 `observe` 或恢复 last-known-good policy；不得恢复退休 task、旧 sealed-token schema、alias parser 或客户端自选 fallback。
