// The ordinary production run uses V8 coverage. Vitest intentionally includes
// the coverage-provider transform decision in its filesystem-cache key even
// though the V8 provider does not transform source. The isolated perf process
// uses this no-op provider to select the same safe key without starting the V8
// profiler, collecting coverage, or writing coverage artifacts.
const runtime = {
  async startCoverage() {},
  async takeCoverage() { return null },
  async stopCoverage() {},
  async getProvider() {
    return {
      name: 'transform-cache-key-compatibility',
      initialize(ctx) {
        this.options = {
          ...ctx._coverageOptions,
          provider: 'custom',
          enabled: true,
          clean: false,
          cleanOnRerun: false,
          reportsDirectory: ctx._coverageOptions.reportsDirectory,
          exclude: ctx._coverageOptions.exclude ?? [],
          reportOnFailure: false,
          allowExternal: false,
          processingConcurrency: 1,
          reporter: [],
          excludeAfterRemap: false,
          ignoreClassMethods: [],
          skipFull: false,
          watermarks: {}
        }
      },
      resolveOptions() { return this.options },
      async clean() {},
      async onAfterSuiteRun() {},
      async generateCoverage() { return null },
      async reportCoverage() {}
    }
  }
}

export default runtime
