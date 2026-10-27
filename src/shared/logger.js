import pino from 'pino'

import { config } from '../config/index.js'

/**
 * 全局日志器。
 * 测试环境静音，否则每个用例都会往终端刷几百行请求日志。
 */
export const logger = pino({
  level: config.nodeEnv === 'test' ? 'silent' : 'info',
})
