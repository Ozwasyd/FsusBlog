# Issue #1082：Production 单一异步日志管线

## 目标与边界

Production scheduler 与 physical bundle 使用同一套异步日志协议。每个实际执行
child 只有一个权威 raw byte log；stdout/stderr 的身份、到达顺序与 byte range 写入
旁路 index。logical tier、checkpoint 和 bundle member 通过文件引用定位日志，不在
热路径复制整份输出。

该管线只改变控制面的日志传输和索引方式，不减少测试输出，不改变测试 ID、命令、
退出码或诊断证据。非 child 的 coordination-only 小型 JSON/text 日志仍可在步骤收尾
直接生成，因为它们不存在 per-chunk 热路径。

## 文件模型

一个执行单元生成三个 run-bound 文件：

```text
<id>.log                 # 唯一权威原始 byte stream
<id>.log.index.jsonl     # stdout/stderr + sequence + monotonic time + byte range
<id>.log.pipeline.json   # flush/backpressure/console/digest evidence
```

index 使用 `fsusblog.async-log-index.v1`：

- header 绑定 raw log；
- chunk 保存 `sequence`、`stream`、`offset`、`length`、`monotonicNs`；
- footer 保存 chunk/byte 总数、complete 状态和可能的截断原因。

raw log 不做 UTF-8 解码，因此跨 chunk 的多字节字符、非 UTF-8 错误字节和二进制诊断
均保持原样。combined view 按 sequence/byte range 读取 raw log；stdout-only 或
stderr-only view 按 `stream` 过滤同一 index，不需要第二份 payload。

## Backpressure 与错误语义

raw writer 和 index writer 都是长生命周期 `fs.createWriteStream()`，各自声明
high-water mark。任一 writer 返回 backpressure 时，管线暂停该 child 的 stdout 与
stderr input；两者都 drain 后再一起恢复，避免另一个 stream 绕过同一物理写盘容量。

writer/open/pipe/flush 错误会使 execution fail closed。scheduler 会终止对应 tier；
bundle 会终止对应 step process group。不会把缺失或长度不一致的 raw log标记为成功。

`fsusblog.async-log-pipeline.v1` evidence 至少记录：

- stdout/stderr/input/file bytes 与 raw SHA-256；
- chunk 数；
- backpressure event 数、累计时间和 high-water mark；
- console bytes、suppressed bytes 和有界队列上限；
- flush complete/partial/failed、error 与 truncation reason。

## Console tee 与双写消除

top-level scheduler 的 tier log只记录其直接 child（physical bundle）的控制输出。
physical bundle 内 step 的完整 child bytes 默认只进入 step raw log，不再转发到父
scheduler 后复制成 tier log。

需要本机交互诊断时可显式设置：

```bash
FSUSBLOG_PRODUCTION_CHILD_CONSOLE_TEE=1 ./tools/test.sh production
```

该模式只启用有界派生 console sink，不改变权威日志。console sink 变慢时，排队字节
受固定上限约束；超过上限的 console 副本计入 `suppressedBytes`，child 只受权威
raw/index writer 的 backpressure 控制。Production 默认关闭该诊断 tee，以防完整
step payload 再进入父 tier log。

## Settle、取消与回退

- normal close：等待 raw/index writer finish，再写 atomic pipeline evidence；
- command failure：完整 flush 已接收 bytes，保留 failure 的完整诊断日志；
- SIGINT/SIGTERM：先终止 process group、关闭 pipe，再完成幂等 pipeline close；
- deadline/SIGKILL escalation：证据标记 `partial` 和明确 truncation reason；
- writer failure：证据标记 `failure`，execution 不得成功。

回退时可撤销 scheduler/bundle 的 pipeline 接线并保留三个 evidence 文件供诊断；不得
恢复 per-chunk `appendFileSync()`。若必须临时观察实时 child 输出，应只使用上述有界
diagnostic tee，而不是重新建立第二份完整 tier payload。

## 验证范围

专项测试覆盖：

- 高频小 chunk 与 writer backpressure；
- stdout/stderr 原始字节和 combined view 重建；
- 慢 console sink 的有界内存与显式降级；
- writer error fail closed；
- scheduler checkpoint 的 raw/index/evidence 绑定；
- scheduler/run-bundle 热路径不存在 `appendFileSync()`。

最终 Production 验收还需在相同 SHA、相同机器执行至少三次 before/after，并比较日志
payload bytes、write syscall/同步写次数、event-loop delay、I/O wait、CPU-seconds 与
wall-clock。任何收益不得来自丢弃权威 stdout/stderr 或减少测试覆盖。
