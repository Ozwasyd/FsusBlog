# Content Credentials 离线原型

FsusBlog 的 Content Credentials 能力目前固定为 `prototype / opt-in / default-off`。它为文章、渲染投影、封面和附件生成一个可复现的 canonical package，再交给显式安装的 C2PA 工具生成外部 manifest。普通 HTML、Markdown、AEDS 读取、notification stream 和登录流程均不依赖该工具或 manifest。

## Canonicalization v1

权威版本为 `fsusblog.article-canonical.v1`：

- Markdown 转为 UTF-8、NFC、LF，并以一个换行结尾；不包含草稿、评论、阅读统计或用户状态。
- 渲染 HTML 使用稳定文章投影；CSP `nonce`、`data-csp-nonce` 和标记为 `data-c2pa-volatile` 的节点不参与摘要。
- metadata 仅包含公开的 article/revision 坐标、标题、摘要、canonical URL、发布时间、语言、版权、内容级 AI 使用披露和 release receipt 摘要。
- 封面与附件逐项记录 URI、MIME、关系和 SHA-256。动态主题、locale 外壳、评论、统计和私有草稿不属于 ingredient。
- manifest URL 必须与文章同源、无 query/fragment，并使用 `/credentials/articles/{articleId}/revisions/{revisionId}/manifest.c2pa` 不可变路径。

生成包包含：

```text
canonical/article.md
canonical/article.html
canonical/metadata.json
manifest-definition.json
html-association.txt
package-manifest.json
assets/*
```

HTML 关联遵循 C2PA 2.4 的外部 manifest 发现形式：

```html
<link rel="c2pa-manifest" type="application/c2pa" href="https://fsus.blog/credentials/articles/1179/revisions/3/manifest.c2pa">
```

manifest 缺失、验证器不可用或验证失败只影响“验证出处”结果，不改变正文可读性，也不把文章自动判定为恶意。

## 本地命令

普通离线自检不需要 C2PA 工具：

```bash
node tools/content-credentials/c2pa-prototype.mjs check
node --test tests/tools/content-credentials-prototype.test.mjs
```

生成 canonical package：

```bash
node tools/content-credentials/c2pa-prototype.mjs build \
  --fixture tests/fixtures/content-credentials/article.json \
  --out /tmp/fsusblog-c2pa-package
```

C2PA 专项互操作显式运行，固定主验证器为 `c2patool 0.26.60`：

```bash
C2PATOOL=/opt/c2patool-0.26.60/c2patool \
node tools/content-credentials/c2pa-prototype.mjs interop \
  --out /tmp/fsusblog-c2pa-interop
```

Linux release asset 与 SHA-256 固定在 `config/content-credentials/c2pa-interop-policy.json`。操作者必须离线核验归档摘要；专项命令不会自行下载或升级验证器。

工具缺失时命令返回 `status=unavailable` 与 `productionDefault=false`，不下载工具、不访问在线验证服务，也不阻塞普通测试。测试证书只允许生成原型证据；生产签名必须使用隔离 signer，见 [Content Credentials 密钥生命周期](security/content-credentials-key-lifecycle.md)。

专项命令同时输出 `verification-entry.json`。该本地验证入口只公开 manifest 存在性、签名/内容绑定结果、有限 signer 信息、发布时间、article/revision 坐标、声明动作和固定错误码；不会输出完整证书链、私钥或内部身份。内置测试证书会准确显示为 `credential_untrusted`，即使签名和内容绑定本身有效，也不得升级为受信任生产凭证。

## 篡改与升级门禁

普通自检固定覆盖 Markdown、metadata、封面、附件和 manifest URL 五类负例。`config/content-credentials/c2pa-interop-policy.json` 要求 production-default 前同时具备：

- 两个不同 implementation family 的离线验证器正例；
- 静态下载、缓存恢复和重新部署后仍可验证的收据；
- 无 JavaScript 正文可读证据；
- 密钥轮换、撤销和事故恢复演练；
- 隐私审查以及体积、签名延迟、验证延迟和发布耗时预算。

只由 `c2patool` 或同一 `c2pa-rs` 家族的多个包装器通过，不满足“双独立实现”。缺少任一收据时决策保持 `blocked`；仓库不得宣称标准互操作完成或不可篡改。

## 降级与回退

该原型未接入生产请求链，无需重启即可维持现状。未来 opt-in 接线后，运行时回退顺序必须是：停止发布新的 manifest 关联、保留既有不可变 manifest 供历史验证、继续提供正常 HTML/Markdown/AEDS 内容。不得通过删除正文、清空历史 manifest 或放宽验签来“修复”失败。
