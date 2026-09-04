// 后端种子数据 —— 从前端 mock 抽取，仅用于首次初始化
export const DEMO_USERS = [
  { eng: 'alice', name: '艾莉斯', team: '内容安全', roles: ['submitter'], status: 'active' },
  { eng: 'bob', name: '鲍勃', team: '算法评测', roles: ['handler'], status: 'active' },
  { eng: 'karo', name: '卡萝', team: '治理策略组', roles: ['submitter', 'handler', 'admin'], status: 'active' },
  { eng: 'david', name: '大卫', team: '业务运营', roles: ['submitter', 'handler'], status: 'active' },
  { eng: 'newbie', name: '新同学', team: '内容安全', roles: [], status: 'pending' },
  { eng: 'wang', name: '老王', team: '安全合规', roles: ['submitter'], status: 'disabled' },
]


export const MANAGE_APPROVALS = [
  { id: 1, name: '新同学', eng: 'newbie', team: '内容安全', applyRoles: ['提需人'], reason: '需要提交误杀分析工单', status: 'pending', createdAt: '2026-06-29 14:20', operator: '', operatedAt: '' },
  { id: 2, name: '赵六', eng: 'zhao', team: '算法评测', applyRoles: ['处理人', '提需人'], reason: '需要处理工单和提交分析', status: 'pending', createdAt: '2026-06-28 16:45', operator: '', operatedAt: '' },
  { id: 3, name: '钱七', eng: 'qian', team: '治理策略组', applyRoles: ['管理员'], reason: '需要管理后台配置', status: 'approved', createdAt: '2026-06-25 10:00', operator: '卡萝', operatedAt: '2026-06-25 15:30' },
  { id: 4, name: '孙八', eng: 'sun', team: '内容安全', applyRoles: ['提需人'], reason: '日常误杀分析需求', status: 'rejected', createdAt: '2026-06-20 09:15', operator: '卡萝', operatedAt: '2026-06-20 11:00' },
  { id: 5, name: '周九', eng: 'zhou', team: '业务运营', applyRoles: ['提需人', '处理人'], reason: '同时需要提需和处理权限', status: 'approved', createdAt: '2026-06-18 08:30', operator: '卡萝', operatedAt: '2026-06-18 14:20' },
  { id: 6, name: '吴十', eng: 'wu', team: '安全合规', applyRoles: ['处理人'], reason: '需要处理误杀工单', status: 'pending', createdAt: '2026-06-29 11:00', operator: '', operatedAt: '' },
]

export const MANAGE_FEEDBACK = [
  { id: 'FB-1042', user: '艾莉斯', eng: 'alice', team: '内容安全', type: '功能建议', content: '希望误杀样本分析页支持按标签批量导出 CSV，现在只能单条导出效率太低。', shots: 2, status: 'pending', createdAt: '2026-06-29 16:42', reply: '' },
  { id: 'FB-1041', user: '大卫', eng: 'david', team: '业务运营', type: '体验问题', content: '工单列表筛选条件切换后没有 loading 状态，偶尔以为页面卡死了。', shots: 1, status: 'processing', createdAt: '2026-06-29 11:08', reply: '已记录，下个迭代加入骨架屏。' },
  { id: 'FB-1040', user: '鲍勃', eng: 'bob', team: '算法评测', type: 'Bug 反馈', content: 'AI 用量大盘的失败率数字偶发显示 NaN，刷新后恢复，疑似接口偶发空值。', shots: 3, status: 'resolved', createdAt: '2026-06-28 19:30', reply: '已修复空值兜底逻辑，已上线验证。' },
  { id: 'FB-1039', user: '周九', eng: 'zhou', team: '业务运营', type: '功能建议', content: '结论沉淀希望能按问题分类做聚合视图，方便复盘同类误杀。', shots: 0, status: 'pending', createdAt: '2026-06-28 14:15', reply: '' },
  { id: 'FB-1038', user: '孙八', eng: 'sun', team: '内容安全', type: '体验问题', content: '移动端访问时顶部导航栏会换行，建议做响应式收纳。', shots: 1, status: 'resolved', createdAt: '2026-06-26 09:50', reply: '已加入响应式适配，谢谢反馈。' },
  { id: 'FB-1037', user: '钱七', eng: 'qian', team: '治理策略组', type: 'Bug 反馈', content: '权限审批通过后列表角标计数没有实时刷新。', shots: 0, status: 'processing', createdAt: '2026-06-25 17:22', reply: '排查中。' },
]

export const AUDIT_LOGS = [
  { user: '卡萝', action: '采纳并确定问题分类', target: 'TKT-2045', t: '2026-06-28 09:00', ip: '10.12.3.45' },
  { user: '鲍勃', action: '提交结论', target: 'TKT-2044', t: '2026-06-28 16:20', ip: '10.12.3.88' },
  { user: '鲍勃', action: '处理人受理', target: 'TKT-2043', t: '2026-06-29 10:05', ip: '10.12.3.88' },
  { user: '大卫', action: '提交工单', target: 'TKT-2042', t: '2026-06-29 09:00', ip: '10.12.4.10' },
]
