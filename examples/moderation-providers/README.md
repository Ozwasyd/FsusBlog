# Moderation Provider Examples

这些示例用于验证 FsusBlog 第三方审核模型 Provider 契约。它们只做 mock scoring，不包含真实敏感词，也不代表生产模型质量。

## CLI JSON

```bash
echo '{"contract_version":"fsusblog-moderation-provider-v1","request_id":"01JZ0000000000000000000000","content_type":"comment","text":"normal text"}' \
  | node examples/moderation-providers/cli-json-node/provider.mjs
```

## HTTP JSON

```bash
node examples/moderation-providers/http-json-node/server.mjs --port 8787
node tools/moderation/provider-conformance.mjs --provider http-json --endpoint http://127.0.0.1:8787/v1/moderation/score
```

Provider 只能输出风险信号，不能输出 `reject_submit`、`geo_block`、`blocked_regions` 等最终动作字段。
