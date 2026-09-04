import { defineStore } from 'pinia'

// 正式账号上传解析后的样本级明细数据 store
// AnalysisView 上传文件 → aggregateRows() 解析 → 将样本明细存入此 store
// TagDetailView 读取此 store 获取该标签下的样本明细（不依赖后端 API）
export const useAnalysisStore = defineStore('analysis', {
  state: () => ({
    // 是否已有正式账号本地解析数据
    hasLocalData: false,
    // 文件名
    fileName: '',
    // 所有样本明细（按标签分组前的原始行数据，包含行业/元素类型/OCR/ASR等字段）
    // 结构: [{ id, type, isVideo, machineTag, humanTag, industryL1, industryL2, mediaUrl, ocrContent, asrContent, isFp, fpReason, remark, tagId, tagName }]
    allSamples: [],
    // 标签级聚合（与 TAGS reactive 对齐）
    tags: [],
    // KPI 概览
    kpi: { precision: 0, fpRate: 0, fpCount: 0, tagCount: 0, sampleTotal: 0, fileName: '' },
  }),
  actions: {
    // 设置解析后的完整数据
    setData({ samples, tags, kpi, fileName }) {
      this.allSamples = samples
      this.tags = tags
      this.kpi = { ...kpi, fileName }
      this.fileName = fileName
      this.hasLocalData = true
    },
    // 获取指定标签下的样本明细
    getSamplesByTag(tagId) {
      return this.allSamples.filter(s => `${s.tagId}` === `${tagId}`)
    },
    // 清空数据
    clear() {
      this.hasLocalData = false
      this.fileName = ''
      this.allSamples = []
      this.tags = []
      this.kpi = { precision: 0, fpRate: 0, fpCount: 0, tagCount: 0, sampleTotal: 0, fileName: '' }
    },
  },
})
