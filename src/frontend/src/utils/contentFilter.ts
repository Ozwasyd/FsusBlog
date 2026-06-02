// 文件路径: src/utils/contentFilter.ts
// 职责: 前端轻量内容风控，避免违规输入消耗本地 WASM 算力及服务器带宽。

export interface ValidationResult {
  isValid: boolean
  message: string
}

export type ContentRiskFactor =
  | 'ad'
  | 'redline'
  | 'url'
  | 'obfuscation'
  | 'reserved'
  | 'repetition'

export interface ContentRiskScore {
  score: number
  normalizedText: string
  factors: ContentRiskFactor[]
  firstMatch: string | null
}

export const USERNAME_CONSTRAINT = {
  minLength: 3,
  maxLength: 20,
  patternMessage: '用户名仅允许中文或英文字母，不支持数字和符号',
  lengthMessage: '用户名长度必须在 3 到 20 个字符之间'
} as const

type AhoCorasickNode = {
  next: Map<string, number>
  fail: number
  outputs: string[]
}

export type AhoCorasickMatcher = Readonly<{
  findFirst: (text: string) => string | null
  findAll: (text: string) => string[]
}>

const structuralAdRegex = /(日入\s*\d+|微信\s*[:：=]|威信\s*[:：=]|薇信\s*[:：=]|[qQ]{2}\s*[:：=]|t\.cn\/|dwz\.cn\/|suo\.im\/|url\.cn\/)/i
const whiteListRegex = /(学习|复习|练习|预习|实习|演习|习惯|习俗|习题|恶习|陋习|最近|接近|附近|靠近|亲近|近期|近日|远近|近似|和平|平安|公平|水平|平常|平静|平稳|平等|平台|生平|平局)/g
const topRedLineRegex = /([习習].{0,6}近.{0,6}平|毛.{0,6}[泽澤].{0,6}[东東]|六.{0,6}四.{0,6}事.{0,6}件)/i
const zeroWidthRegex = /[\u200B-\u200F\uFEFF\u202A-\u202E]/g
const zeroWidthDetector = /[\u200B-\u200F\uFEFF\u202A-\u202E]/
const urlLikeRegex = /(https?:\/\/|www\.|t\.cn\/|dwz\.cn\/|suo\.im\/|url\.cn\/)/i

const confusableCharacters = new Map<string, string>([
  ['習', '习'],
  ['澤', '泽'],
  ['東', '东'],
  ['薇', '微'],
  ['威', '微'],
  ['嶶', '微'],
  ['扣', 'q'],
  ['＋', '+']
])

const moderationTerms = [
  '加微',
  '加微信',
  '加vx',
  '+v',
  'vx:',
  'vx=',
  '微信:',
  '微信=',
  'qq:',
  'qq=',
  'q群',
  '加群',
  '企鹅',
  '扣扣',
  '代开',
  '代写',
  '代刷',
  '刷单',
  '兼职',
  '网赚',
  '博彩',
  '棋牌',
  '菠菜',
  '澳门金沙',
  '新葡京',
  '威尼斯人',
  '裸聊',
  '同城约',
  '上门服务',
  '富婆包养',
  't.cn/',
  'dwz.cn/',
  'suo.im/',
  'url.cn/'
] as const

const reservedUsernameTerms = [
  'admin',
  'administrator',
  'system',
  'root',
  'moderator',
  'fsusblog',
  'fsu'
] as const

function tryDecodeUriComponent(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export function normalizeModerationText(input: string): string {
  const decoded = tryDecodeUriComponent(input)
  const normalized = decoded.normalize('NFKC').replace(zeroWidthRegex, '').toLocaleLowerCase()
  let output = ''
  let previous = ''
  let repeated = 0

  for (const char of normalized) {
    if (/\s/u.test(char)) {
      continue
    }

    const mapped = confusableCharacters.get(char) ?? char
    repeated = mapped === previous ? repeated + 1 : 1
    previous = mapped

    if (repeated <= 2) {
      output += mapped
    }
  }

  return output
}

export function createAhoCorasickMatcher(patterns: readonly string[]): AhoCorasickMatcher {
  const nodes: AhoCorasickNode[] = [{ next: new Map<string, number>(), fail: 0, outputs: [] }]

  for (const pattern of patterns) {
    if (!pattern) {
      continue
    }

    let state = 0
    for (const char of pattern) {
      const existing = nodes[state].next.get(char)
      if (existing !== undefined) {
        state = existing
        continue
      }

      const nextState = nodes.length
      nodes[state].next.set(char, nextState)
      nodes.push({ next: new Map<string, number>(), fail: 0, outputs: [] })
      state = nextState
    }

    nodes[state].outputs.push(pattern)
  }

  const queue: number[] = []
  for (const state of nodes[0].next.values()) {
    nodes[state].fail = 0
    queue.push(state)
  }

  for (let index = 0; index < queue.length; index += 1) {
    const state = queue[index]
    for (const [char, nextState] of nodes[state].next) {
      let failState = nodes[state].fail
      while (failState !== 0 && !nodes[failState].next.has(char)) {
        failState = nodes[failState].fail
      }

      nodes[nextState].fail = nodes[failState].next.get(char) ?? 0
      nodes[nextState].outputs.push(...nodes[nodes[nextState].fail].outputs)
      queue.push(nextState)
    }
  }

  const step = (state: number, char: string): number => {
    while (state !== 0 && !nodes[state].next.has(char)) {
      state = nodes[state].fail
    }

    return nodes[state].next.get(char) ?? 0
  }

  return {
    findFirst(text: string): string | null {
      let state = 0
      for (const char of text) {
        state = step(state, char)
        if (nodes[state].outputs.length > 0) {
          return nodes[state].outputs[0]
        }
      }

      return null
    },
    findAll(text: string): string[] {
      const matches: string[] = []
      let state = 0
      for (const char of text) {
        state = step(state, char)
        matches.push(...nodes[state].outputs)
      }

      return matches
    }
  }
}

const adMatcher = createAhoCorasickMatcher(moderationTerms.map(normalizeModerationText))
const reservedUsernameSet = new Set(reservedUsernameTerms.map(normalizeModerationText))
const reservedUsernameMatcher = createAhoCorasickMatcher([...reservedUsernameSet])

export function createUsernamePattern(): RegExp {
  try {
    return new RegExp('^[\\p{Script=Han}\\p{L}]+$', 'u')
  } catch {
    return /^[\u4e00-\u9fa5A-Za-z]+$/
  }
}

export function isUsernameCharacterSetValid(value: string): boolean {
  return createUsernamePattern().test(value)
}

function pushFactor(factors: ContentRiskFactor[], factor: ContentRiskFactor): void {
  if (!factors.includes(factor)) {
    factors.push(factor)
  }
}

function clampRisk(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))))
}

export function scoreContentRisk(text: string): ContentRiskScore {
  const normalizedText = normalizeModerationText(text)
  const factors: ContentRiskFactor[] = []
  let score = 0
  let firstMatch: string | null = null

  if (zeroWidthDetector.test(text) || normalizedText !== text.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '')) {
    pushFactor(factors, 'obfuscation')
    score += 0.2
  }

  if (/(.)\1{3,}/u.test(text.normalize('NFKC'))) {
    pushFactor(factors, 'repetition')
    score += 0.12
  }

  firstMatch = adMatcher.findFirst(normalizedText)
  if (firstMatch || structuralAdRegex.test(text)) {
    pushFactor(factors, 'ad')
    score += 0.92
  }

  if (urlLikeRegex.test(normalizedText)) {
    pushFactor(factors, 'url')
    score += 0.35
  }

  const safeText = normalizedText.replace(whiteListRegex, '○')
  if (topRedLineRegex.test(safeText)) {
    pushFactor(factors, 'redline')
    score = 1
  }

  return {
    score: clampRisk(score),
    normalizedText,
    factors,
    firstMatch
  }
}

export function validateCommentContent(text: string): ValidationResult {
  if (!text || text.trim() === '') {
    return { isValid: false, message: '评论内容不能为空' }
  }

  const risk = scoreContentRisk(text)
  if (risk.factors.includes('redline')) {
    return { isValid: false, message: '严重违规：检测到对抗性涉政词汇。' }
  }

  if (risk.score >= 0.9) {
    return { isValid: false, message: '输入内容包含涉嫌引流的违规业务或恶意链接，已被拦截。' }
  }

  return { isValid: true, message: '' }
}

export function validateUsername(username: string): ValidationResult {
  if (!username || username.trim() === '') {
    return { isValid: false, message: '用户名不能为空' }
  }

  if (zeroWidthDetector.test(username)) {
    return { isValid: false, message: '用户名包含非法的隐形排版字符' }
  }

  const cleanName = username.trim()
  if (cleanName.length < USERNAME_CONSTRAINT.minLength || cleanName.length > USERNAME_CONSTRAINT.maxLength) {
    return { isValid: false, message: USERNAME_CONSTRAINT.lengthMessage }
  }

  if (!isUsernameCharacterSetValid(cleanName)) {
    return { isValid: false, message: USERNAME_CONSTRAINT.patternMessage }
  }

  const normalizedName = normalizeModerationText(cleanName)
  if (reservedUsernameSet.has(normalizedName) || reservedUsernameMatcher.findFirst(normalizedName) === normalizedName) {
    return { isValid: false, message: '该用户名已被系统保留，请更换' }
  }

  const risk = scoreContentRisk(cleanName)
  if (risk.factors.includes('ad')) {
    return { isValid: false, message: '用户名包含违规引流特征' }
  }

  if (risk.factors.includes('redline')) {
    return { isValid: false, message: '严重违规：用户名包含对抗性涉政词汇' }
  }

  return { isValid: true, message: '' }
}
