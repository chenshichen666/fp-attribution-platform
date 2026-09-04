import { defineStore } from 'pinia'

export const useTicketFlowStore = defineStore('ticketFlow', {
  state: () => ({
    active: false,
    samples: [],
    // 整体勾选的聚类簇（选中簇时携带簇特征 + 簇内全部 case）
    clusters: [],
    // 标签上下文：从标签详情/预分类页带入工单表单
    tagContext: null, // { tagId, tag, elementType, industryL1, industryL2 }
    // 发起「前往提需」时所在的来源页面路由（fullPath），用于退出提需流程时返回
    origin: null,
  }),
  actions: {
    begin() { this.active = true; this.samples = []; this.clusters = []; this.tagContext = null },
    setSamples(ids, ctx) {
      this.samples = [...ids]
      if (ctx) this.tagContext = ctx
    },
    // 设置整体勾选的聚类簇（簇卡片 + 簇内全部 case）
    setClusters(clusters) {
      this.clusters = Array.isArray(clusters) ? clusters.map(c => ({ ...c, elements: [...(c.elements || [])] })) : []
    },
    // 记录发起提需时的来源页面（选素材页），退出提需时用于返回
    setOrigin(path) { if (path) this.origin = path },
    // 取出并清空来源页面路由
    consumeOrigin() {
      const o = this.origin
      this.origin = null
      return o
    },
    consume() {
      const s = [...this.samples]
      const clusters = this.clusters.map(c => ({ ...c, elements: [...(c.elements || [])] }))
      const ctx = this.tagContext
      this.active = false
      this.samples = []
      this.clusters = []
      this.tagContext = null
      return { samples: s, clusters, tagContext: ctx }
    },
    cancel() { this.active = false; this.samples = []; this.clusters = []; this.tagContext = null; this.origin = null },
  },
})
