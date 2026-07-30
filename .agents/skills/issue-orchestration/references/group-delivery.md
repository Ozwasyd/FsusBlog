# 验收组交付

本文件是重合验收组、立即交付、默认分支、worktree、本地 alias 与跨仓 owner 的唯一详细来源。

## 交付单位

重合验收组是验证、提交、推送和关闭的单位；单独成组的 issue 使用相同流程。组内所有 issue 在全部必要验收通过前保持 open。

跨仓验收组可包含按依赖排序的 FsusUI 与 FsusBlog 交付 leg。每个 leg 在责任仓形成独立 commit 并推该仓默认分支；只有全部 leg 的远端 commit 和验收仍有效后，才关闭组内 issues。

## 立即交付

一组通过后，根代理立即：

1. 复读组内 issue、验收条件、实际 diff、evidence 与未运行项；
2. 检查两仓 `git status`，只暂存本组文件，不带入用户无关改动；
3. 按各仓 current 变更契约生成 commit；FsusBlog 使用 `master`，FsusUI 使用 `main`，除非该仓最近的适用指令明确改变；
4. 由根代理直接 push 对应默认分支；
5. 复读远端 commit 与 issue 状态，提交需要的完成评论并核验组内 issues 已关闭；
6. 更新运行态 DAG 和 evidence。

不得等待无关 issue、全仓最终验收、其他分支、其他任务或长任务。不得用 draft PR、临时发布或“稍后统一交付”替代上述流程。

dry-run 必须生成同样的逐步交付计划，但停在第一个 commit、push、评论或 close 动作之前，并明确标记未执行；不得伪造远端结果。

## 分支与 worktree

可为隔离本地实现使用分支或 worktree，但只有根代理可直接 push `master`/`main`。不得创建或遗留无意义的 `codex/*` 分支、draft PR、worktree、锁或无关提交。验收组交付或放弃后，先核对远端与本地引用，再清理只属于该组的临时资源。

## 两仓 alias 与 owner

交付前解析实际生效的 FsusBlog→FsusUI 本地 alias，记录 FsusUI 绝对路径、HEAD 和 dirty state。两仓同步通过该 alias 验证；禁止为了同步发布 npm、NuGet 或其他包。

跨仓缺陷修复责任仓。可复用组件、公开 token、组件状态、共享 motion、键盘或共享可访问性缺陷归 FsusUI；产品路由、文案、组合和 FsusBlog 语义归 FsusBlog，具体事实仍以两个设计 Skill 与 current 文档为准。不得在调用仓添加兼容兜底、私有 selector 修补、假 token、组件 fork 或降级路径来隐藏责任仓缺陷。

## Terminal 前本地交付

将 issue 转为 terminal candidate 前，完成并推送全部本地可行工作；若这部分与其他 issue 重合，按正常验收组交付。随后回到 [`dag-and-scheduling.md`](dag-and-scheduling.md) 的 Terminal 合同：issue 保持 open，并使用那里唯一规定的证据、评论、恢复条件和重派门禁。
