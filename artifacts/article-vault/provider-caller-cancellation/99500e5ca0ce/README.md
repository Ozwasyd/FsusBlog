# 当前 caller cancellation 源码验证

实际执行候选 `99500e5ca0ceeafd9b3ef0791de54b6eb95c972e`；分支 `codex/chain-1975-provider-facts-only`。原始四文件选择器：61 个控制，原54名称全部保留、新增7名称；原始正向2个和 focused61个实际通过，无 focused 跳过、worker全退出。原始三个 matrix 源码控制32个及 locator5个实际通过，共37个，无跳过。这些为普通 controlled source/unit 证据，qualification=false；不是 HTTP/PoW/浏览器/数据库/receipt/custody/race 验收。

新增取消行为在原共享 commit promise 上等待真实结算，然后检查加入调用者的原 AbortSignal。加入者取消不撤销原调用者控制，不丢弃原任务，不提前发送 DELETE；原调用者和两个信号各自的取消原因保留。当前 contracts/testing 文档已描述原 facts 路径及这些控制。

mandatory preflight 首先因真实 cgroup `/..` 拒绝；消费 sole1686 `c46e7348d7b8c4e05df821152b6184c21542e629` 精确8文件，以及 sole2899 source `503eded7c3804c956806daa928e050a882053891` / published head `8fa5b44107194afe2cdb75caa805219442641270` 原定位器及匹配 hunks后，当前 preflight实际 exit0。保留源路径差异、schema-Ajv setup、全部先前拒绝及本候选自产 authority，不拷贝上游生成收据。原 lifecycle producer因缺少当前backend Debug上下文拒绝；采用已有上游的准确注册 hunks，未将该失败改为成功。

失败历史：第一次 list 命令遗漏 `--json=<输出路径>`，把测试文件当作输出覆盖；该执行停止、原覆盖内容保存，并恢复精确HEAD文件后另起正确的四文件发现，61名称验证通过。Node37执行exit0，但初始collector假设TAP，collector exit1；已从同一次真实 spec 输出读取37/37，无重跑。两种失误均不作为运行通过证据。

工具：官方 Node24.16.0（校验官方SHASUMS）、锁定 Vitest4.1.11、actual FsusUI8db0ac8f49749e3e5f28be5051bb3d3ed71ada71；源alias helper实际7647a45344d4dec32d7b7007a6ab1fba13f26446，旧54 installer75e6标签错误由当前证据补正，旧包不改写。旧54证据仍绑定98dc；current61仅绑定此候选。type-only df6边界已供消费。remaining import guard5/fullapplication types失败271属于原范围；fullapplication类型delta仅绑定实际6d91执行，未重新标记此SHA。

所有16 issue依然OPEN/部分或等待；旧issue-status表中的54仅为历史，本增量2258普通控制为61。1975仍缺真实terminal migration qualification，1976等待其接受。新的 runtime borrow source在另一独立分支进行，不能从本61推导Writer集成资格。无 PR/issue正文/评论/标签写入、合并、关闭、部署或生产数据库动作。
