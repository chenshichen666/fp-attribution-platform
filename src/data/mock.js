// 平台静态字典 —— 仅保留确认要写死的问题分类，以及纯函数 tagStatus
// 所有业务数据（标签/工单/沉淀/用户/审批/反馈/大盘等）均已改为后端真实接口驱动

// ============ 问题分类（提工单/沉淀下拉选项，写死） ============
export const PROBLEM_CATEGORIES = [
  { code: 'RULE_CHANGE', label: '规则/尺度变更' },
  { code: 'RULE_UNREASONABLE', label: '规则不合理' },
  { code: 'MODEL_ISSUE', label: '模型问题' },
  { code: 'OTHER', label: '其他' },
]

// ============ 标签精度档位判定（纯函数） ============
export function tagStatus(p) {
  // 无正例判定（tp+fp=0）时精度无定义，归为中性"无数据"档
  if (p === null || p === undefined || p === '' || Number.isNaN(Number(p))) {
    return { label: '无数据', cls: 'gray', color: '#b4bac6' }
  }
  const v = Number(p)
  if (v < 50) return { label: '精度异常', cls: 'red', color: '#f0454b' }
  if (v < 85) return { label: '精度关注', cls: 'orange', color: '#f5a000' }
  return { label: '精度正常', cls: 'green', color: '#1fb574' }
}

// ============ 标签精度五档判定（demo v2 配色，用于状态徽章+进度条） ============
export function precLevel(p) {
  if (p === null || p === undefined || p === '' || Number.isNaN(Number(p))) {
    return { label: '无数据', cls: 'gray', color: '#b4bac6' }
  }
  const v = Number(p)
  if (v < 50) return { label: '严重偏低', cls: 'red', color: '#ef4444' }
  if (v < 70) return { label: '偏低', cls: 'orange', color: '#f97316' }
  if (v < 80) return { label: '一般', cls: 'yellow', color: '#eab308' }
  if (v < 90) return { label: '良好', cls: 'lightgreen', color: '#86efac' }
  return { label: '优秀', cls: 'green', color: '#22c55e' }
}

// 异常判定（异常Tab筛选依据）：近7天FP≥100 && 精度≤60%
// 接受标签对象 { precision, recent7dFp, isAbnormal }，优先用后端预计算的 isAbnormal
export function isSevere(t) {
  if (t && typeof t === 'object') {
    if (t.isAbnormal !== undefined) return !!t.isAbnormal
    const v = precVal(t.precision)
    const fp = Number(t.fp ?? t.recent7dFp ?? 0)
    return v !== null && v <= 60 && fp >= 100
  }
  const v = precVal(t)
  return v !== null && v <= 60
}
function precVal(p) {
  if (p === null || p === undefined || p === '' || Number.isNaN(Number(p))) return null
  return Number(p)
}