import type { DeepStringShape } from '../keys'
import type { zhCN } from '../zh-CN'
import { admin } from './admin'
import { article } from './article'
import { auth } from './auth'
import { common } from './common'
import { errors } from './errors'
import { identity } from './identity'
import { layout } from './layout'
import { messages } from './messages'
import { publicMessages } from './public'
import { security } from './security'

export const es419 = {
    common, public: publicMessages, article, auth, identity, layout, messages, security, admin, errors
} as const satisfies DeepStringShape<typeof zhCN>
