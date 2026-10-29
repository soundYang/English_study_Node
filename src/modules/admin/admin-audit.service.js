import { logger } from '../../shared/logger.js'
import { AdminAudit } from './admin-audit.model.js'

/**
 * 记一条管理端审计（md/45 §10.1）。
 *
 * 调用方 `await`：写库失败要能看见，而且顺序确定（先落审计再返回数据，
 * 万一进程正好在这一下崩了，宁可「有记录没看到数据」也不要反过来）。
 *
 * 但失败**不抛出**：审计写不进去是运维问题，不该让客服连用户详情都打不开。
 * 失败的告警走 stdout，配合 AccessLog 里的 statusCode 仍能还原这次访问。
 */
export async function recordAdminAudit({ admin = '', action, target = '', ip = '', userAgent = '', requestId = '' }) {
  try {
    await AdminAudit.create({
      admin: String(admin ?? '').slice(0, 100),
      action,
      target: String(target ?? '').slice(0, 100),
      ip: String(ip ?? '').slice(0, 64),
      userAgent: String(userAgent ?? '').slice(0, 300),
      requestId: String(requestId ?? '').slice(0, 40),
    })
  } catch (err) {
    logger.error({ err, action, target }, '管理端审计写入失败')
  }
}
