# User session metadata privacy

普通账号 `UserSession` 只保存维持撤销、审计、粗粒度会话展示和低权重登录风险比较所需的数据。客户端提供的 `X-Fsus-Device-Fp` 是不可信提示，不是 credential；它不能授权、绑定账号、扩大 refresh-token 撤销范围、豁免 step-up，或证明两个会话属于同一真实设备/用户。

## 持久化边界

登录和首枚 Passkey enrollment 在请求生命周期内读取客户端 IP、User-Agent 和可选 device signal，然后立即转换：

- device signal：规范化后以 `account:{accountId}` 作为作用域，使用 `Security:RiskPseudonymization` current epoch HMAC 生成 `device_signal_hash` / `device_signal_epoch`；
- network signal：IPv4 先最小化为 `/24`、IPv6 先最小化为 `/48`，再使用相同 account scope 和独立 IP domain 生成 `network_signal_hash` / `network_signal_epoch`；
- User-Agent：只解析并保存 `browser_family`、`os_family`、`form_factor`，例如 `Chrome / Linux / Desktop`。

原始 fingerprint、完整 IP 和完整 User-Agent 不进入 `sys_user_session`、响应、日志、trace 或 telemetry。`Security:RiskPseudonymization` key 由部署独立配置，epoch 参与 HMAC domain；同一 signal 在不同账号、部署或 epoch 下不可直接比较。轮换重叠期只接受 current 与一个有截止时间的 previous epoch，窗口结束后旧 session signal 自动失去风险匹配能力。内部 HMAC 值永不返回浏览器。

## 风险与授权边界

缺失 device signal、空/裁剪后的 User-Agent、UA reduction、VPN 或代理环境都不阻止 Passkey 登录。已提供但变化的 signal 只能增加风险分并可能要求 step-up；它不能单独允许请求，也不能把多个 session 关联后批量撤销。refresh replay 和 session revoke 只按受验证的 session/family authority 执行。

无需重启的降级开关是 `Security:UserSessions:MetadataRiskSignalsEnabled=false`。reloadable configuration 生效后，登录风险评估忽略 device/network/UA signal，仍保留 Passkey、refresh lineage、session 限额和撤销校验；恢复为 `true` 后继续按 current/previous epoch 比较。该开关不恢复任何原始值写入。

## 迁移、保留与删除

`20260720-pre-user-session-metadata-minimization` 增加 coarse/HMAC 字段，把旧 User-Agent 转为低基数标签，并在同一事务把遗留 `devicefingerprint`、`lastip`、`useragent` 值清空。旧列只作为 rollback-compatible 空壳保留，应用实体和写路径不再映射它们。

后台 retention worker 每日清除已撤销 session，或最近活动早于 `Security:UserSessions:MetadataRetentionDays` 的 device/network HMAC 与 epoch；配置范围为 1–90 天，默认 30 天。粗粒度标签可保留到 session 行按既有账号/session 生命周期删除。删除账号继续删除其所有 `UserSession` 行；备份和审计保留遵循各自已有的有限保留与密码学擦除策略。

若需要加速隐私降级，可通过 reloadable configuration 把 retention 调到 1 天并触发既有 leader cleanup 周期；不得把旧原始列重新映射为运行时 fallback。
