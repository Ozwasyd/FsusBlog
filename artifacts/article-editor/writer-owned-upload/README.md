# Writer 原始上传借用观察证据

本地实现提交 `35a028c7be7f031a3f3beb986ff79418dcd08582`，分支 `codex/chain-2246-writer-owned-upload`，基线 `1a51ac8038f1d4509db5e90e29e736e863a5fba4`。实际 FsusUI baseline `0e5c56050e8dd3e9ca3735078489d35a0bb6e3d2`，官方 Node 24.16.0、锁定 Vitest 4.1.11、TypeScript 6.0.3。未推送、创建 PR、写 issue/评论/标签、合并或部署。

Writer 接入原始 pending handle、document owner、当前公共 map 和原始 flow lease。完成上传清空 public session 后，仅在短期 `withSession` 回调内逐项投影五个私有字段到原始 provider，并使用 loan signal 观察；provider、凭据不逃逸，所有退出释放 loan。Vue 深 ref 的 File 使用公开 `toRaw` 恢复原对象身份。没有新增 intent store、parser、ledger、权限/receipt，也不从 activeSession、URL、storage 重建私有会话。真实 document completion 必须在借用回调外取得原始业务权限；本方法只返回 transport observation。

已提交候选的原始 preflight exit 0，新 Writer 十二项 PASS，九文件原始回归 148 PASS，全部显式发现及完整运行名称/计数/hooks 留存，零 skip/todo。原 runtime/flow/test 三个 blob 精确匹配供应提交；原 host40/reader21和旧入口2源文件字节未修改。旧 File[] 入口缺少 intent 被明确拒绝，因此旧两项探针当前 FAIL；原有13为11 PASS/2 FAIL，不能记13 PASS。供应方通过计数没有借作 host 通过。

完整 application types exit 2，232→232，新增/移除诊断均0。五个直接 owner 文件 strict-full exit0；全部11个改动前端文件 strict-full exit1，contracts 既有两项 import-type 诊断在同依赖基线复现。原全文样式检查三项 baseline binding FAIL，原 import guard 五项既有 FAIL，原 type-only import 负向 fixture exit0。生成产品来自本候选原始 producers；wire identities 275/285 沿用供应源，只按本候选现有 roster 追加 golden catalog order 261/262，未导入无关五个供应 frames/共享 matrix receipt。协议、routes、fixture、correctness producer 检查 exit0。

全部首轮失败、中断、setup错误和重跑记录保留。首轮7/10因真实 File ref 包装导致失败；修正 Writer 身份比较后第二轮9/10，新测试对 pending placeholder 的 sourceReferenced 错误预期被纠正并增加 sourceUrl=null/state=provider-pending 断言，未改变原 adapter。回归首次计数假设20 provider控制错误；实际27名称全部纳入后148通过，未删除7项新增取消控制。环境重启时 preflight进程中断不算通过。供应历史99500e5和46d327缺 Refs footer仍FAIL，未改写历史。

生产输入适配器仍接旧 File[] 事件，真实 FsusUI只暴露 upload-image batch，缺少 File→原 pending handle 的已授权关联；不得补造。真实业务 reference/cleanup grant、HTTP/PoW/native AEDS/数据库/浏览器/held SOURCE资格未运行或仍等待原 owner，dotnet未安装。当前十问题逐项见 issue-status.json；整链未完成，tracking #1809仍OPEN。
