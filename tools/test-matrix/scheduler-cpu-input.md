# Scheduler CPU input

The ordinary Fresh `runDag(options)` API accepts `cpuCapacity` containing
`selection`, `identity` and `topology` from the existing CPU capacity producer.
It calls `cpuCapacitySchedulerInput` once before acquiring the run owner or
publishing a checkpoint. The producer verifies the selected run and current
machine binding and returns immutable scheduler inputs. The scheduler consumes
that CPU envelope through its existing `systemResources` admission path and
retains the selected `cpuCapacityReceipt` in the canonical checkpoint.

The adapter preserves current memory and load observations; CPU capacity is
bounded by the selected envelope, including fractional capacity. The scheduler
does not reload the active calibration pointer during execution. A fallback
selection retains its explicit uncalibrated status. Controlled observations and
ordinary input tests do not establish physical calibration qualification.

Resume rejects this input until restoration of the original selected capacity
has its own verified implementation. Existing calls without `cpuCapacity` retain
the existing resource input path. The runner CLI still needs its actual machine
observation and selection owner to supply this API input; this module does not
manufacture those observations or create another resource authority.

The ordinary runner API also accepts an optional `AbortSignal` as `signal`.
Pre-aborted calls preserve the caller's exact reason and refuse run ownership.
Later cancellation uses the existing scheduler interrupt and active-execution
termination path, closes pending admission even with `collectFailures`, and
removes the signal subscription during finalization. In-process `executeTier`
adapters receive the same signal in their context and still own their settlement
through the existing `abortTier` port. Controlled cancellation tests do not
qualify physical process cleanup or nested executor grant uptake.
