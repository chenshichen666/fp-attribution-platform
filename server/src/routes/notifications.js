import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireLogin } from '../middleware/auth.js'

const router = Router()

// 获取当前用户的待处理消息计数（红点提醒）
// 工单侧：
//   - 提需人：有处理人提交了结论待采纳(concluded) 的工单数
//   - 处理人/管理员：公共池待抢单(submitted) 的工单数 + 自己处理中被退回(rejected) 的工单数
// 管理侧（仅管理员）：
//   - 待审批的权限申请数
router.get('/', requireLogin, async (req, res, next) => {
  try {
    const me = req.currentUser.name
    const roles = req.currentUser.roles || []
    const result = { tickets: 0, approval: 0, total: 0 }

    const isSubmitter = roles.includes('submitter') || roles.includes('admin')
    const isHandler = roles.includes('handler') || roles.includes('admin')
    const isAdmin = roles.includes('admin')

    if (isSubmitter && !isHandler) {
      const [r] = await query(
        "SELECT COUNT(*) AS c FROM tickets WHERE is_demo=0 AND submitter=? AND status='concluded'",
        [me]
      )
      result.tickets = r ? r.c : 0
    } else if (isHandler) {
      const [r1] = await query(
        "SELECT COUNT(*) AS c FROM tickets WHERE is_demo=0 AND status='submitted' AND (handler='' OR handler IS NULL)"
      )
      const [r2] = await query(
        "SELECT COUNT(*) AS c FROM tickets WHERE is_demo=0 AND handler=? AND status='rejected'",
        [me]
      )
      result.tickets = (r1 ? r1.c : 0) + (r2 ? r2.c : 0)
    }
    if (isAdmin) {
      const [r] = await query(
        "SELECT COUNT(*) AS c FROM permission_requests WHERE status='pending'"
      )
      result.approval = r ? r.c : 0
    }

    result.total = result.tickets + result.approval
    res.json(result)
  } catch (e) { next(e) }
})

// 标记已读（清除红点）——前端在进入对应模块页面时调用
router.post('/read', requireLogin, async (req, res, next) => {
  try {
    const { type } = req.body // 'tickets' | 'approval' | 'all'
    // 通知是实时计算的，标记已读仅做前端 localStorage 记录
    // 后端无需额外操作，计数会随状态变化自然清零
    res.json({ ok: true, type: type || 'all' })
  } catch (e) { next(e) }
})

export default router
