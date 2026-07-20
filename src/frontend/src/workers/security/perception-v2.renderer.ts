type Rgba = readonly [number, number, number, number]
type PixelBuffer = Uint8ClampedArray<ArrayBuffer>

export type PerceptionV2TaskKind = 'localization' | 'micro-interaction'

export type PerceptionV2Point = {
  x: number
  y: number
}

export type PerceptionV2Color = string | readonly [number, number, number] | readonly [number, number, number, number]

export type PerceptionV2Layer = {
  kind?: 'rect' | 'ellipse' | 'line' | 'polyline'
  shape?: 'rect' | 'ellipse' | 'line' | 'polyline' | 'polygon'
  x?: number
  y?: number
  width?: number
  height?: number
  radiusX?: number
  radiusY?: number
  points?: PerceptionV2Point[]
  color?: PerceptionV2Color
  colorRgba?: PerceptionV2Color
  alpha?: number
  opacity?: number
  strokeSegments?: PerceptionV2StrokeSegment[]
  noiseFields?: PerceptionV2NoiseField[]
  warpFields?: PerceptionV2WarpField[]
  occluders?: PerceptionV2Occluder[]
}

export type PerceptionV2StrokeSegment = {
  points: PerceptionV2Point[]
  width?: number
  color?: PerceptionV2Color
  colorRgba?: PerceptionV2Color
  alpha?: number
}

export type PerceptionV2NoiseField = {
  seed?: number | string
  seedHex?: string
  density?: number
  intensity?: number
  alpha?: number
  color?: PerceptionV2Color
  colorRgba?: PerceptionV2Color
  cellSize?: number
  scale?: number
}

export type PerceptionV2WarpField = {
  seed?: number | string
  seedHex?: string
  amplitude?: number
  frequency?: number
  axis?: 'x' | 'y'
}

export type PerceptionV2Occluder = {
  kind?: 'rect' | 'ellipse' | 'line'
  shape?: 'rect' | 'ellipse' | 'line' | 'polygon'
  x?: number
  y?: number
  width?: number
  height?: number
  radiusX?: number
  radiusY?: number
  points?: PerceptionV2Point[]
  color?: PerceptionV2Color
  colorRgba?: PerceptionV2Color
  alpha?: number
  opacity?: number
}

export type RenderRecipeV2 = {
  schema?: string
  taskKind?: PerceptionV2TaskKind | 'microInteraction'
  v?: 2
  width?: number
  height?: number
  background?: PerceptionV2Color
  layers?: PerceptionV2Layer[]
  strokeSegments?: PerceptionV2StrokeSegment[]
  noiseFields?: PerceptionV2NoiseField[]
  warpFields?: PerceptionV2WarpField[]
  occluders?: PerceptionV2Occluder[]
  presentationHints?: Record<string, string | number | undefined> & {
    taskKind?: PerceptionV2TaskKind
    devicePixelRatio?: number
    canvasWidth?: number | string
    canvasHeight?: number | string
  }
}

export type PerceptionV2CanvasContext2D = {
  putImageData: (imageData: ImageData, dx: number, dy: number) => void
}

export type PerceptionV2CanvasLike = {
  getContext: (contextId: '2d') => PerceptionV2CanvasContext2D | null
  transferToImageBitmap?: () => ImageBitmap
}

export type PerceptionV2RenderEnvironment = {
  createOffscreenCanvas?: (width: number, height: number) => PerceptionV2CanvasLike
  createImageData?: (pixels: PixelBuffer, width: number, height: number) => ImageData
  forceCanvasFallback?: boolean
}

export type PerceptionV2RenderPayload =
  | {
      kind: 'bitmap'
      width: number
      height: number
      bitmap: ImageBitmap
    }
  | {
      kind: 'rgba-raster'
      width: number
      height: number
      pixels: PixelBuffer
    }

export type PerceptionV2RenderResult = {
  renderer: 'offscreen-canvas' | 'canvas-fallback'
  width: number
  height: number
  payload: PerceptionV2RenderPayload
  transfer: Transferable[]
}

export type PerceptionV2WorkerRequest = {
  v: 1
  type: 'render'
  requestId: number
  recipe: RenderRecipeV2
  forceCanvasFallback?: boolean
  forceWorkerFailure?: boolean
}

export type PerceptionV2WorkerResponse =
  | {
      v: 1
      type: 'rendered'
      requestId: number
      ok: true
      renderer: PerceptionV2RenderResult['renderer']
      result: PerceptionV2RenderPayload
    }
  | {
      v: 1
      type: 'error'
      requestId: number
      ok: false
      error: string
    }

export type PerceptionV2WorkerResult = {
  response: PerceptionV2WorkerResponse
  transfer: Transferable[]
}

type NormalizedRecipe = {
  width: number
  height: number
  background: Rgba
  layers: PerceptionV2Layer[]
  strokeSegments: PerceptionV2StrokeSegment[]
  noiseFields: PerceptionV2NoiseField[]
  warpFields: PerceptionV2WarpField[]
  occluders: PerceptionV2Occluder[]
}

const MAX_DIMENSION = 1024
const MAX_PIXELS = 1024 * 1024
const SEMANTIC_RECIPE_FIELDS = new Set([
  'expectedPoint',
  'expectedStep'
])

// Local DTO until #507 provides the shared RenderRecipeV2 schema.
export async function renderPerceptionRecipeV2(
  recipe: RenderRecipeV2,
  environment: PerceptionV2RenderEnvironment = {}
): Promise<PerceptionV2RenderResult> {
  const normalized = normalizeRecipe(recipe)
  const pixels = renderRecipePixels(normalized)
  const bitmapPayload = tryCreateBitmapPayload(pixels, normalized.width, normalized.height, environment)
  if (bitmapPayload) {
    return bitmapPayload
  }

  return {
    renderer: 'canvas-fallback',
    width: normalized.width,
    height: normalized.height,
    payload: {
      kind: 'rgba-raster',
      width: normalized.width,
      height: normalized.height,
      pixels
    },
    transfer: [pixels.buffer as ArrayBuffer]
  }
}

export async function handlePerceptionV2WorkerRequest(
  rawRequest: unknown,
  environment: PerceptionV2RenderEnvironment = {}
): Promise<PerceptionV2WorkerResult | null> {
  if (!isPerceptionV2WorkerRequest(rawRequest)) {
    return null
  }

  try {
    if (rawRequest.forceWorkerFailure) {
      throw new Error('perception_v2_forced_worker_failure')
    }

    const rendered = await renderPerceptionRecipeV2(rawRequest.recipe, {
      ...environment,
      forceCanvasFallback: environment.forceCanvasFallback === true || rawRequest.forceCanvasFallback === true
    })
    return {
      response: {
        v: 1,
        type: 'rendered',
        requestId: rawRequest.requestId,
        ok: true,
        renderer: rendered.renderer,
        result: rendered.payload
      },
      transfer: rendered.transfer
    }
  } catch (error) {
    return {
      response: {
        v: 1,
        type: 'error',
        requestId: rawRequest.requestId,
        ok: false,
        error: error instanceof Error ? error.message : 'perception_v2_worker_failed'
      },
      transfer: []
    }
  }
}

function isPerceptionV2WorkerRequest(value: unknown): value is PerceptionV2WorkerRequest {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  return record.v === 1
    && record.type === 'render'
    && typeof record.requestId === 'number'
    && Number.isFinite(record.requestId)
    && typeof record.recipe === 'object'
    && record.recipe !== null
}

function normalizeRecipe(recipe: RenderRecipeV2): NormalizedRecipe {
  assertNoSemanticFields(recipe)
  const width = resolveRecipeDimension(recipe, 'width', 'canvasWidth')
  const height = resolveRecipeDimension(recipe, 'height', 'canvasHeight')
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('perception_v2_invalid_dimensions')
  }

  const flattened = flattenRecipeLayers(recipe.layers)
  return {
    width,
    height,
    background: parseColor(recipe.background, [13, 19, 27, 255]),
    layers: flattened.layers,
    strokeSegments: [
      ...(Array.isArray(recipe.strokeSegments) ? recipe.strokeSegments : []),
      ...flattened.strokeSegments
    ],
    noiseFields: [
      ...(Array.isArray(recipe.noiseFields) ? recipe.noiseFields : []),
      ...flattened.noiseFields
    ],
    warpFields: [
      ...(Array.isArray(recipe.warpFields) ? recipe.warpFields : []),
      ...flattened.warpFields
    ],
    occluders: [
      ...(Array.isArray(recipe.occluders) ? recipe.occluders : []),
      ...flattened.occluders
    ]
  }
}

function resolveRecipeDimension(recipe: RenderRecipeV2, dimensionKey: 'width' | 'height', hintKey: 'canvasWidth' | 'canvasHeight'): number {
  if (recipe[dimensionKey] !== undefined) {
    return toInteger(recipe[dimensionKey])
  }
  if (recipe.presentationHints?.[hintKey] !== undefined) {
    return toInteger(recipe.presentationHints[hintKey])
  }
  return dimensionKey === 'width' ? 320 : 180
}

function flattenRecipeLayers(layers: PerceptionV2Layer[] | undefined): Pick<NormalizedRecipe, 'layers' | 'strokeSegments' | 'noiseFields' | 'warpFields' | 'occluders'> {
  const result: Pick<NormalizedRecipe, 'layers' | 'strokeSegments' | 'noiseFields' | 'warpFields' | 'occluders'> = {
    layers: [],
    strokeSegments: [],
    noiseFields: [],
    warpFields: [],
    occluders: []
  }
  if (!Array.isArray(layers)) {
    return result
  }

  for (const layer of layers) {
    if (isDrawableLayer(layer)) {
      result.layers.push(layer)
    }
    const inheritedAlpha = layer.opacity ?? layer.alpha
    result.strokeSegments.push(...withInheritedAlpha(layer.strokeSegments, inheritedAlpha))
    result.noiseFields.push(...withInheritedAlpha(layer.noiseFields, inheritedAlpha))
    result.warpFields.push(...(Array.isArray(layer.warpFields) ? layer.warpFields : []))
    result.occluders.push(...withInheritedAlpha(layer.occluders, inheritedAlpha))
  }
  return result
}

function isDrawableLayer(layer: PerceptionV2Layer): boolean {
  return Boolean(layer.kind || layer.shape || layer.x !== undefined || layer.y !== undefined || layer.points)
}

function withInheritedAlpha<T extends { alpha?: number; opacity?: number }>(items: T[] | undefined, alpha: number | undefined): T[] {
  if (!Array.isArray(items) || alpha === undefined) {
    return Array.isArray(items) ? items : []
  }

  return items.map((item) => ({
    ...item,
    alpha: item.alpha ?? item.opacity ?? alpha
  }))
}

function assertNoSemanticFields(value: unknown, path = 'recipe'): void {
  if (!value || typeof value !== 'object') {
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSemanticFields(item, `${path}[${index}]`))
    return
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SEMANTIC_RECIPE_FIELDS.has(key)) {
      throw new Error(`perception_v2_semantic_field_forbidden:${path}.${key}`)
    }
    assertNoSemanticFields(child, `${path}.${key}`)
  }
}

function renderRecipePixels(recipe: NormalizedRecipe): PixelBuffer {
  let pixels = createPixelBuffer(recipe.width * recipe.height * 4)
  fill(pixels, recipe.width, recipe.height, recipe.background)

  for (const layer of recipe.layers) {
    drawShape(pixels, recipe.width, recipe.height, layer, [224, 232, 245, 255])
  }

  for (const stroke of recipe.strokeSegments) {
    drawStrokeSegment(pixels, recipe.width, recipe.height, stroke)
  }

  for (const noise of recipe.noiseFields) {
    drawNoiseField(pixels, recipe.width, recipe.height, noise)
  }

  if (recipe.warpFields.length > 0) {
    pixels = applyWarpFields(pixels, recipe.width, recipe.height, recipe.warpFields)
  }

  for (const occluder of recipe.occluders) {
    drawShape(pixels, recipe.width, recipe.height, occluder, [8, 10, 14, 255])
  }

  return pixels
}

function tryCreateBitmapPayload(
  pixels: PixelBuffer,
  width: number,
  height: number,
  environment: PerceptionV2RenderEnvironment
): PerceptionV2RenderResult | null {
  if (environment.forceCanvasFallback) {
    return null
  }

  const createCanvas = environment.createOffscreenCanvas ?? getDefaultOffscreenCanvasFactory()
  if (!createCanvas) {
    return null
  }

  try {
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context || !canvas.transferToImageBitmap) {
      return null
    }

    context.putImageData(createImageData(pixels, width, height, environment), 0, 0)
    const bitmap = canvas.transferToImageBitmap()
    return {
      renderer: 'offscreen-canvas',
      width,
      height,
      payload: {
        kind: 'bitmap',
        width,
        height,
        bitmap
      },
      transfer: [bitmap]
    }
  } catch {
    return null
  }
}

function getDefaultOffscreenCanvasFactory(): PerceptionV2RenderEnvironment['createOffscreenCanvas'] {
  if (typeof OffscreenCanvas === 'undefined') {
    return undefined
  }

  return (width, height) => new OffscreenCanvas(width, height)
}

function createImageData(
  pixels: PixelBuffer,
  width: number,
  height: number,
  environment: PerceptionV2RenderEnvironment
): ImageData {
  if (environment.createImageData) {
    return environment.createImageData(pixels, width, height)
  }

  if (typeof ImageData !== 'undefined') {
    return new ImageData(pixels, width, height)
  }

  return { data: pixels, width, height, colorSpace: 'srgb' } as ImageData
}

function createPixelBuffer(length: number): PixelBuffer {
  return new Uint8ClampedArray(new ArrayBuffer(length))
}

function fill(pixels: PixelBuffer, width: number, height: number, color: Rgba): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      setPixel(pixels, width, x, y, color)
    }
  }
}

function drawShape(
  pixels: PixelBuffer,
  width: number,
  height: number,
  shape: PerceptionV2Layer | PerceptionV2Occluder,
  fallbackColor: Rgba
): void {
  const kind = shape.kind ?? (shape.shape === 'polygon' ? 'polyline' : shape.shape) ?? 'rect'
  if (kind === 'ellipse') {
    drawEllipse(pixels, width, height, shape, fallbackColor)
    return
  }

  if (kind === 'line' || kind === 'polyline') {
    drawShapeLine(pixels, width, height, shape, fallbackColor)
    return
  }

  drawRect(pixels, width, height, shape, fallbackColor)
}

function drawRect(
  pixels: PixelBuffer,
  width: number,
  height: number,
  shape: PerceptionV2Layer | PerceptionV2Occluder,
  fallbackColor: Rgba
): void {
  const color = withAlpha(parseColor(shape.color ?? shape.colorRgba, fallbackColor), shape.alpha ?? shape.opacity)
  const startX = clampInteger(resolveCoordinate(shape.x ?? 0, width), 0, width)
  const startY = clampInteger(resolveCoordinate(shape.y ?? 0, height), 0, height)
  const endX = clampInteger(startX + Math.max(0, resolveLength(shape.width ?? width, width, width)), 0, width)
  const endY = clampInteger(startY + Math.max(0, resolveLength(shape.height ?? height, height, height)), 0, height)

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      blendPixel(pixels, width, x, y, color)
    }
  }
}

function drawEllipse(
  pixels: PixelBuffer,
  width: number,
  height: number,
  shape: PerceptionV2Layer | PerceptionV2Occluder,
  fallbackColor: Rgba
): void {
  const color = withAlpha(parseColor(shape.color ?? shape.colorRgba, fallbackColor), shape.alpha ?? shape.opacity)
  const centerX = resolveCoordinate(shape.x, width, width / 2)
  const centerY = resolveCoordinate(shape.y, height, height / 2)
  const radiusX = Math.max(1, resolveLength(shape.radiusX, width, resolveLength(shape.width, width, width / 4) / 2))
  const radiusY = Math.max(1, resolveLength(shape.radiusY, height, resolveLength(shape.height, height, height / 4) / 2))
  const startX = clampInteger(Math.floor(centerX - radiusX), 0, width)
  const endX = clampInteger(Math.ceil(centerX + radiusX), 0, width)
  const startY = clampInteger(Math.floor(centerY - radiusY), 0, height)
  const endY = clampInteger(Math.ceil(centerY + radiusY), 0, height)

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const dx = (x + 0.5 - centerX) / radiusX
      const dy = (y + 0.5 - centerY) / radiusY
      if (dx * dx + dy * dy <= 1) {
        blendPixel(pixels, width, x, y, color)
      }
    }
  }
}

function drawShapeLine(
  pixels: PixelBuffer,
  width: number,
  height: number,
  shape: PerceptionV2Layer | PerceptionV2Occluder,
  fallbackColor: Rgba
): void {
  const points = normalizePoints(shape.points, width, height)
  if (points.length < 2) {
    return
  }

  const color = withAlpha(parseColor(shape.color ?? shape.colorRgba, fallbackColor), shape.alpha ?? shape.opacity)
  const strokeWidth = Math.max(1, resolveLength(shape.width, Math.min(width, height), 1))
  drawPolyline(pixels, width, height, points, color, strokeWidth)
}

function drawStrokeSegment(
  pixels: PixelBuffer,
  width: number,
  height: number,
  segment: PerceptionV2StrokeSegment
): void {
  const points = normalizePoints(segment.points, width, height)
  if (points.length < 2) {
    return
  }

  const color = withAlpha(parseColor(segment.color ?? segment.colorRgba, [242, 186, 73, 255]), segment.alpha)
  drawPolyline(pixels, width, height, points, color, Math.max(1, resolveLength(segment.width, Math.min(width, height), 2)))
}

function drawPolyline(
  pixels: PixelBuffer,
  width: number,
  height: number,
  points: PerceptionV2Point[],
  color: Rgba,
  strokeWidth: number
): void {
  for (let index = 1; index < points.length; index += 1) {
    drawLine(pixels, width, height, points[index - 1], points[index], color, strokeWidth)
  }
}

function drawLine(
  pixels: PixelBuffer,
  width: number,
  height: number,
  start: PerceptionV2Point,
  end: PerceptionV2Point,
  color: Rgba,
  strokeWidth: number
): void {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps
    const x = start.x + dx * progress
    const y = start.y + dy * progress
    stampCircle(pixels, width, height, x, y, strokeWidth / 2, color)
  }
}

function stampCircle(
  pixels: PixelBuffer,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  color: Rgba
): void {
  const safeRadius = Math.max(0.5, radius)
  const startX = clampInteger(Math.floor(centerX - safeRadius), 0, width)
  const endX = clampInteger(Math.ceil(centerX + safeRadius), 0, width)
  const startY = clampInteger(Math.floor(centerY - safeRadius), 0, height)
  const endY = clampInteger(Math.ceil(centerY + safeRadius), 0, height)

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const dx = x + 0.5 - centerX
      const dy = y + 0.5 - centerY
      if (dx * dx + dy * dy <= safeRadius * safeRadius) {
        blendPixel(pixels, width, x, y, color)
      }
    }
  }
}

function drawNoiseField(
  pixels: PixelBuffer,
  width: number,
  height: number,
  field: PerceptionV2NoiseField
): void {
  const seed = toSeed(field.seed ?? field.seedHex ?? 1)
  const density = clamp(finiteNumber(field.density ?? field.intensity, 0.08), 0, 1)
  const cellSize = clampInteger(resolveLength(field.cellSize ?? field.scale, Math.min(width, height), 1), 1, 16)
  const color = withAlpha(parseColor(field.color ?? field.colorRgba, [255, 255, 255, 255]), field.alpha ?? 0.12)

  for (let y = 0; y < height; y += cellSize) {
    for (let x = 0; x < width; x += cellSize) {
      if (noise(seed, x, y) > density) {
        continue
      }

      for (let py = y; py < Math.min(y + cellSize, height); py += 1) {
        for (let px = x; px < Math.min(x + cellSize, width); px += 1) {
          blendPixel(pixels, width, px, py, color)
        }
      }
    }
  }
}

function applyWarpFields(
  pixels: PixelBuffer,
  width: number,
  height: number,
  fields: PerceptionV2WarpField[]
): PixelBuffer {
  let current = pixels
  for (const field of fields) {
    const amplitude = clamp(finiteNumber(field.amplitude, 0), -16, 16)
    if (amplitude === 0) {
      continue
    }

    const frequency = clamp(finiteNumber(field.frequency, 0.08), 0.001, 1)
    const seed = toSeed(field.seed ?? field.seedHex ?? 0)
    const next = createPixelBuffer(current.length)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const wave = Math.sin((field.axis === 'y' ? x : y) * frequency + seed)
        const sampleX = field.axis === 'y' ? x : x - wave * amplitude
        const sampleY = field.axis === 'y' ? y - wave * amplitude : y
        copySample(current, next, width, height, x, y, sampleX, sampleY)
      }
    }
    current = next
  }

  return current
}

function copySample(
  source: PixelBuffer,
  target: PixelBuffer,
  width: number,
  height: number,
  targetX: number,
  targetY: number,
  sampleX: number,
  sampleY: number
): void {
  const sx = clampInteger(Math.round(sampleX), 0, width - 1)
  const sy = clampInteger(Math.round(sampleY), 0, height - 1)
  const sourceIndex = (sy * width + sx) * 4
  const targetIndex = (targetY * width + targetX) * 4
  target[targetIndex] = source[sourceIndex]
  target[targetIndex + 1] = source[sourceIndex + 1]
  target[targetIndex + 2] = source[sourceIndex + 2]
  target[targetIndex + 3] = source[sourceIndex + 3]
}

function normalizePoints(points: PerceptionV2Point[] | undefined, width: number, height: number): PerceptionV2Point[] {
  if (!Array.isArray(points)) {
    return []
  }

  return points
    .map((point) => ({
      x: resolveCoordinate(point.x, width),
      y: resolveCoordinate(point.y, height)
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
}

function setPixel(pixels: PixelBuffer, width: number, x: number, y: number, color: Rgba): void {
  const index = (y * width + x) * 4
  pixels[index] = color[0]
  pixels[index + 1] = color[1]
  pixels[index + 2] = color[2]
  pixels[index + 3] = color[3]
}

function blendPixel(pixels: PixelBuffer, width: number, x: number, y: number, source: Rgba): void {
  const index = (y * width + x) * 4
  const sourceAlpha = source[3] / 255
  const targetAlpha = pixels[index + 3] / 255
  const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
  if (outAlpha <= 0) {
    return
  }

  pixels[index] = Math.round((source[0] * sourceAlpha + pixels[index] * targetAlpha * (1 - sourceAlpha)) / outAlpha)
  pixels[index + 1] = Math.round((source[1] * sourceAlpha + pixels[index + 1] * targetAlpha * (1 - sourceAlpha)) / outAlpha)
  pixels[index + 2] = Math.round((source[2] * sourceAlpha + pixels[index + 2] * targetAlpha * (1 - sourceAlpha)) / outAlpha)
  pixels[index + 3] = Math.round(outAlpha * 255)
}

function parseColor(value: PerceptionV2Color | undefined, fallback: Rgba): Rgba {
  if (Array.isArray(value)) {
    return [
      clampInteger(value[0], 0, 255),
      clampInteger(value[1], 0, 255),
      clampInteger(value[2], 0, 255),
      clampInteger(value.length > 3 ? Math.round(clamp(value[3], 0, 1) * 255) : 255, 0, 255)
    ]
  }

  if (typeof value !== 'string') {
    return fallback
  }

  const normalized = value.trim()
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    return [
      Number.parseInt(normalized[1] + normalized[1], 16),
      Number.parseInt(normalized[2] + normalized[2], 16),
      Number.parseInt(normalized[3] + normalized[3], 16),
      255
    ]
  }

  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(1, 3), 16),
      Number.parseInt(normalized.slice(3, 5), 16),
      Number.parseInt(normalized.slice(5, 7), 16),
      255
    ]
  }

  if (/^#[0-9a-f]{8}$/i.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(1, 3), 16),
      Number.parseInt(normalized.slice(3, 5), 16),
      Number.parseInt(normalized.slice(5, 7), 16),
      Number.parseInt(normalized.slice(7, 9), 16)
    ]
  }

  return fallback
}

function withAlpha(color: Rgba, alpha: number | undefined): Rgba {
  if (typeof alpha !== 'number' || !Number.isFinite(alpha)) {
    return color
  }

  return [color[0], color[1], color[2], Math.round(color[3] * clamp(alpha, 0, 1))]
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
  }
  return 0
}

function clampInteger(value: unknown, min: number, max: number): number {
  return Math.trunc(clamp(finiteNumber(value, min), min, max))
}

function resolveCoordinate(value: unknown, size: number, fallback = 0): number {
  const numeric = finiteNumber(value, fallback)
  return numeric > 0 && numeric <= 1 ? numeric * size : numeric
}

function resolveLength(value: unknown, size: number, fallback: number): number {
  const numeric = finiteNumber(value, fallback)
  return numeric > 0 && numeric <= 1 ? numeric * size : numeric
}

function toSeed(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && value.trim()) {
    let seed = 0
    for (let index = 0; index < value.length; index += 1) {
      seed = Math.imul(seed ^ value.charCodeAt(index), 16777619)
    }
    return seed || 1
  }
  return 1
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function noise(seed: number, x: number, y: number): number {
  let value = (x + 0x9e3779b9) ^ (y * 0x85ebca6b) ^ (seed * 0xc2b2ae35)
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  value ^= value >>> 16
  return (value >>> 0) / 0xffffffff
}
