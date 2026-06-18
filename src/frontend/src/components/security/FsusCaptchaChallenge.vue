<template>
  <section class="fsus-captcha" data-fsus-captcha="true" :aria-busy="busy">
    <div class="fsus-captcha__header">
      <div>
        <p class="fsus-captcha__eyebrow">图形校验</p>
        <h3 class="fsus-captcha__title">输入图中字符</h3>
      </div>
      <el-button
        data-test="captcha-refresh"
        :disabled="busy || disabled"
        @click="refreshChallenge"
      >
        刷新
      </el-button>
    </div>

    <div class="fsus-captcha__canvas-wrap">
      <canvas
        ref="canvasRef"
        class="fsus-captcha__canvas"
        :width="rasterWidth"
        :height="rasterHeight"
        role="img"
        aria-label="图形验证码"
      />
      <div v-if="loading" class="fsus-captcha__loading" role="status" aria-live="polite">
        正在加载
      </div>
    </div>

    <el-alert
      v-if="errorMessage"
      class="fsus-captcha__alert"
      :title="errorMessage"
      type="error"
      show-icon
      :closable="false"
    />

    <div class="fsus-captcha__form">
      <label for="fsus-captcha-answer" class="fsus-captcha__label">验证码</label>
      <el-input
        id="fsus-captcha-answer"
        v-model="answer"
        autocomplete="off"
        inputmode="text"
        maxlength="8"
        :disabled="submitDisabled"
        @keyup.enter="submitChallenge"
      />
    </div>

    <div class="fsus-captcha__actions">
      <el-button
        data-test="captcha-submit"
        type="primary"
        :loading="submitting"
        :disabled="submitDisabled || answer.trim().length === 0"
        @click="submitChallenge"
      >
        验证
      </el-button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  issueSecurityChallenge,
  SecurityChallengeKind,
  verifySecurityChallenge,
  type IssueSecurityChallengeRequest,
  type SecurityChallengeAssignment,
  type SecurityChallengeIssueResponse,
  type SecurityChallengeVerifyResponse,
  type VerifySecurityChallengeRequest
} from '@/api/security'
import { createCaptchaWorkerClient, type CaptchaWorkerClient } from '@/services/securityCaptchaClient'
import type { CaptchaRaster } from '@/../wasm/security/captcha'
import {
  buildCaptchaVerifyProviderPayload,
  mapCaptchaErrorMessage,
  selectCaptchaChallenge
} from '@/components/security/captchaChallengeModel'

const props = defineProps<{
  action: string
  routeKey: string
  attributes?: Record<string, unknown>
  autoLoad?: boolean
  disabled?: boolean
  issueChallenge?: (request: IssueSecurityChallengeRequest) => Promise<SecurityChallengeIssueResponse>
  verifyChallenge?: (request: VerifySecurityChallengeRequest) => Promise<SecurityChallengeVerifyResponse>
  workerClient?: CaptchaWorkerClient
}>()

const emit = defineEmits<{
  verified: [value: SecurityChallengeVerifyResponse]
  error: [value: string]
  refresh: []
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const answer = ref('')
const loading = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const currentAssignment = ref<SecurityChallengeAssignment | null>(null)
const currentProviderPayload = ref<Record<string, string> | null>(null)
const currentRaster = ref<CaptchaRaster | null>(null)
const challengeStartedAt = ref(0)

let ownedWorkerClient: CaptchaWorkerClient | null = null

const busy = computed(() => loading.value || submitting.value)
const disabled = computed(() => props.disabled === true)
const rasterWidth = computed(() => currentRaster.value?.width ?? 256)
const rasterHeight = computed(() => currentRaster.value?.height ?? 96)
const submitDisabled = computed(() =>
  disabled.value
    || busy.value
    || !currentAssignment.value
    || !currentProviderPayload.value
    || Boolean(errorMessage.value)
)

const resolveWorkerClient = (): CaptchaWorkerClient => {
  if (props.workerClient) {
    return props.workerClient
  }
  ownedWorkerClient ??= createCaptchaWorkerClient()
  return ownedWorkerClient
}

const resolveIssueChallenge = () => props.issueChallenge ?? issueSecurityChallenge
const resolveVerifyChallenge = () => props.verifyChallenge ?? verifySecurityChallenge

async function refreshChallenge(): Promise<void> {
  if (disabled.value || loading.value) {
    return
  }

  loading.value = true
  submitting.value = false
  errorMessage.value = ''
  answer.value = ''
  currentAssignment.value = null
  currentProviderPayload.value = null
  currentRaster.value = null
  emit('refresh')

  try {
    const response = await resolveIssueChallenge()({
      action: props.action,
      routeKey: props.routeKey,
      attributes: props.attributes
    })
    const selected = selectCaptchaChallenge(response)
    const raster = await resolveWorkerClient().render(selected.payload)
    currentAssignment.value = selected.assignment
    currentProviderPayload.value = selected.payload
    currentRaster.value = raster
    challengeStartedAt.value = Date.now()
    await nextTick()
    drawRaster(raster)
  } catch (error) {
    currentAssignment.value = null
    currentProviderPayload.value = null
    setError(mapCaptchaError(error))
  } finally {
    loading.value = false
  }
}

async function submitChallenge(): Promise<void> {
  const assignment = currentAssignment.value
  const payload = currentProviderPayload.value
  const answerText = answer.value.trim()
  if (submitDisabled.value || !assignment || !payload || !answerText) {
    return
  }

  submitting.value = true
  errorMessage.value = ''
  try {
    const proof = await resolveWorkerClient().solve(payload, answerText)
    const solveDurationMs = Math.max(0, Date.now() - challengeStartedAt.value)
    const verification = await resolveVerifyChallenge()({
      challengeId: assignment.challengeId,
      kind: SecurityChallengeKind.CaptchaV1,
      action: assignment.action,
      routeKey: assignment.routeKey,
      providerPayload: buildCaptchaVerifyProviderPayload(payload, answerText, proof, solveDurationMs)
    })
    if (!verification.verified) {
      setError(verification.reason || '验证码无效，请重试')
      return
    }
    emit('verified', verification)
  } catch (error) {
    setError(mapCaptchaError(error))
  } finally {
    submitting.value = false
  }
}

function drawRaster(raster: CaptchaRaster): void {
  const canvas = canvasRef.value
  const context = canvas?.getContext?.('2d')
  if (!canvas || !context || typeof ImageData === 'undefined') {
    return
  }

  canvas.width = raster.width
  canvas.height = raster.height
  const imagePixels = new Uint8ClampedArray(raster.pixels.length)
  imagePixels.set(raster.pixels)
  context.putImageData(new ImageData(imagePixels, raster.width, raster.height), 0, 0)
}

function setError(message: string): void {
  errorMessage.value = message
  emit('error', message)
}

function mapCaptchaError(error: unknown): string {
  return mapCaptchaErrorMessage(error)
}

watch(currentRaster, async (raster) => {
  if (!raster) {
    return
  }
  await nextTick()
  drawRaster(raster)
})

onMounted(() => {
  if (props.autoLoad !== false) {
    void refreshChallenge()
  }
})

onBeforeUnmount(() => {
  if (!props.workerClient) {
    ownedWorkerClient?.dispose()
  }
  ownedWorkerClient = null
})
</script>

<style scoped>
.fsus-captcha {
  display: grid;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--fsusblog-panel-border, var(--el-border-color));
  border-radius: var(--fsus-radius-panel, 12px);
  background: var(--fsusblog-panel-bg, var(--el-bg-color));
  color: var(--fsusblog-text-primary, var(--el-text-color-primary));
}

.fsus-captcha__header,
.fsus-captcha__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.fsus-captcha__eyebrow {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--fsusblog-text-muted, var(--el-text-color-secondary));
}

.fsus-captcha__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.35;
}

.fsus-captcha__canvas-wrap {
  position: relative;
  min-height: 96px;
  overflow: hidden;
  border: 1px solid var(--fsusblog-panel-border, var(--el-border-color));
  border-radius: var(--fsus-radius-control, 6px);
  background: var(--el-fill-color-lighter);
}

.fsus-captcha__canvas {
  display: block;
  width: 100%;
  height: auto;
  min-height: 96px;
}

.fsus-captcha__loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  color: var(--fsusblog-text-muted, var(--el-text-color-secondary));
  background: color-mix(in srgb, var(--el-bg-color) 82%, transparent);
}

.fsus-captcha__alert {
  margin: 0;
}

.fsus-captcha__form {
  display: grid;
  gap: 8px;
}

.fsus-captcha__label {
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--fsusblog-text-secondary, var(--el-text-color-regular));
}

@media (max-width: 640px) {
  .fsus-captcha__header,
  .fsus-captcha__actions {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fsus-captcha,
  .fsus-captcha * {
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
  }
}
</style>
