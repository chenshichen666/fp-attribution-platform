import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const routes = [
  { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
  { path: '/apply', name: 'apply', component: () => import('../views/ApplyView.vue'), meta: { noRole: true } },
  {
    path: '/',
    component: () => import('../layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/analysis' },
      { path: 'analysis', name: 'analysis', component: () => import('../views/analysis/AnalysisView.vue'), meta: { roles: ['submitter', 'admin'] } },
      { path: 'classify/tag/:id', name: 'tagDetail', component: () => import('../views/analysis/TagDetailView.vue'), meta: { roles: ['submitter', 'admin'] } },
      { path: 'classify', name: 'classify', component: () => import('../views/classify/ClassifyView.vue'), meta: { roles: ['submitter', 'admin'] } },
      { path: 'tickets', name: 'tickets', component: () => import('../views/tickets/TicketsView.vue') },
      { path: 'sediment', name: 'sediment', component: () => import('../views/sediment/SedimentView.vue') },
      { path: 'my-permission', name: 'myPermission', component: () => import('../views/MyPermissionView.vue'), meta: { anyRole: true } },
      { path: 'manage/users', name: 'manageUsers', component: () => import('../views/manage/UsersView.vue'), meta: { roles: ['admin'] } },
      { path: 'manage/data', name: 'manageData', component: () => import('../views/manage/DataManageView.vue'), meta: { roles: ['admin'] } },
      { path: 'manage/audit', name: 'manageAudit', component: () => import('../views/manage/AuditView.vue'), meta: { roles: ['admin'] } },
      { path: 'manage/dashboard', name: 'manageDashboard', component: () => import('../views/manage/DashboardView.vue'), meta: { roles: ['admin'] } },
      { path: 'manage/approval', name: 'manageApproval', component: () => import('../views/manage/ApprovalView.vue'), meta: { roles: ['admin'] } },
      { path: 'manage/feedback', name: 'manageFeedback', component: () => import('../views/manage/FeedbackView.vue'), meta: { roles: ['admin'] } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.meta.public) return true
  if (!auth.isLogin) return { name: 'login' }
  // 无角色用户：仅可访问首页、申请页与"我的权限"页，其余强制回首页
  if (!auth.hasRole) return (to.name === 'apply' || to.name === 'myPermission') ? true : { name: '/' }
  // 角色级守卫
  if (to.meta.roles && !to.meta.roles.some((r) => auth.roles.includes(r))) {
    return { name: 'tickets' }
  }
  return true
})

export default router