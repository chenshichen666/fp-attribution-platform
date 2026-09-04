import { Router } from 'express'
import { query } from '../db/pool.js'
import { requireLogin, audit } from '../middleware/auth.js'
import { generate } from '../services/aiService.js'

const router = Router()

// 可选模型列表（下拉用，原样透传 id）
router.get('/models', requireLogin, (req, res) => {
  res.json([
    { id: 'auto', label: 'Auto' },
    { id: 'claude-opus-4.8', label: 'Claude-Opus-4.8' },
    { id: 'claude-opus-4.7', label: 'Claude-Opus-4.7' },
    { id: 'minimax-m3', label: 'MiniMax-M3' },
    { id: 'deepseek-v4-flash', label: 'Deepseek-V4-Flash' },
    { id: 'deepseek-v4-pro', label: 'Deepseek-V4-Pro' },
  ])
})

// 生成（转发到 Knot，用当前用户自己的 token）
router.post('/generate', requireLogin, async (req, res, next) => {
  try {
    const { message, model, images, background } = req.body
    if (!message?.trim()) return res.status(400).json({ error: '请输入提问内容' })

    const rows = await query('SELECT knot_token FROM users WHERE eng=?', [req.currentUser.eng])
    const token = rows[0]?.knot_token
    if (!token) return res.status(412).json({ error: 'NO_TOKEN', message: '请先在设置中填写你的 Knot Token' })

    const result = await generate({
      token, userEng: req.currentUser.eng, message, model,
      images: images || [], background: background || '',
    })
    await audit(req, 'AI 生成调用', model || 'default')
    res.json(result)
  } catch (e) {
    if (e.code === 'NO_TOKEN') return res.status(412).json({ error: 'NO_TOKEN', message: '请先在设置中填写你的 Knot Token' })
    next(e)
  }
})

// 演示模式 mock AI 响应生成器
function generateMockAIResponse(message, model, background) {
  const msg = message.toLowerCase()
  const modelLabel = model === 'auto' ? 'Auto（自动选择最优模型）' : (model || 'Auto')
  const timestamp = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')

  let analysis = ''
  let category = ''

  if (msg.includes('osr') || msg.includes('画面') || msg.includes('视觉') || msg.includes('图片')) {
    category = '画面特征分析（OSR）'
    analysis = `## 画面特征分析报告

**分析模型**：${modelLabel}
**分析时间**：${timestamp}

### 一、画面内容识别

| 检测项 | 结果 | 置信度 |
|--------|------|--------|
| 主体内容 | 正常商业素材 | 92.3% |
| 文字区域 | 营销文案 | 88.1% |
| 敏感元素 | 未检出 | 95.7% |
| 人脸信息 | 无 | 99.2% |

### 二、误杀原因分析

经 OSR（画面识别）模型检测，该素材画面主体为**正常商业推广内容**。模型将营销文案中的"限时""五折"等促销词汇误识别为违规广告诱导词，导致误判。

**根因定位**：OSR 文本区域识别模块对促销类营销词汇的敏感阈值设置过高（当前阈值 0.72，建议下调至 0.55）。

### 三、归因结论

| 维度 | 判定 |
|------|------|
| 误杀类型 | 规则不合理 |
| 置信度 | 高（90%+） |
| 建议动作 | 下调营销词权重，加入电商白名单 |

### 四、优化建议

1. 针对电商行业素材，将促销类词汇敏感度下调 20%
2. 建立行业白名单机制，已授权商户的促销文案自动放行
3. 增加"促销场景"上下文识别，区分正常营销与诱导广告`
  } else if (msg.includes('asr') || msg.includes('音频') || msg.includes('语音') || msg.includes('视频')) {
    category = '语音内容分析（ASR）'
    analysis = `## 语音内容分析报告

**分析模型**：${modelLabel}
**分析时间**：${timestamp}

### 一、语音转写结果

| 时间段 | 转写内容 | 风险等级 |
|--------|----------|----------|
| 00:00-00:15 | "大家好，今天给大家介绍这款产品" | 低 |
| 00:15-00:30 | "它的主要功能包括…" | 低 |
| 00:30-00:45 | "限时优惠，数量有限" | 中（营销词） |

### 二、误杀原因分析

ASR 模型将语音中的"限时优惠""数量有限"等正常营销话术误判为诱导性内容。实际内容为**正规产品推广视频**，话术合规。

**根因定位**：ASR 后处理规则中，营销紧迫性词汇（限时、数量有限等）的拦截规则过于宽泛，未区分电商推广场景。

### 三、归因结论

| 维度 | 判定 |
|------|------|
| 误杀类型 | 规则不合理 |
| 置信度 | 高（88%+） |
| 建议动作 | 细化 ASR 营销词规则，区分推广场景 |

### 四、优化建议

1. 对 ASR 转写文本增加"推广场景"分类器，区分正常营销与诱导话术
2. 营销紧迫性词汇在电商/教育行业放宽阈值
3. 结合视频画面上下文综合判断，避免仅凭音频词汇一刀切`
  } else if (msg.includes('标注') || msg.includes('文本') || msg.includes('内容')) {
    category = '标注内容分析'
    analysis = `## 标注内容分析报告

**分析模型**：${modelLabel}
**分析时间**：${timestamp}

### 一、标注内容审查

| 标注项 | 原始标注 | 复核结果 |
|--------|----------|----------|
| 内容分类 | 违规广告 | 正常营销 |
| 风险等级 | 高 | 低 |
| 违规类型 | 诱导广告 | 无违规 |

### 二、误杀原因分析

标注内容为正常商业推广文案，包含产品介绍和促销信息。文本分类模型对"促销""优惠"等词汇过度敏感，将正常营销内容误判为违规广告。

**根因定位**：文本分类模型训练数据中，正向营销样本占比不足（仅 12%），导致模型对营销类内容存在系统性偏差。

### 三、归因结论

| 维度 | 判定 |
|------|------|
| 误杀类型 | 样本不足 |
| 置信度 | 中高（85%+） |
| 建议动作 | 补充正向营销训练样本 |

### 四、优化建议

1. 补充电商行业正向营销样本（建议新增 5000+ 条）
2. 对"促销""优惠""折扣"等营销词汇建立白名单
3. 引入行业感知模块，对不同行业的营销内容采用差异化判定标准`
  } else if (msg.includes('综合') || msg.includes('归因') || msg.includes('分析')) {
    category = '综合归因分析'
    analysis = `## 综合归因分析报告

**分析模型**：${modelLabel}
**分析时间**：${timestamp}
${background ? `**背景信息**：${background}` : ''}

### 一、多维度交叉分析

| 分析维度 | 检测结果 | 误杀贡献度 |
|----------|----------|------------|
| 画面识别（OSR） | 营销文案误触发 | 35% |
| 语音识别（ASR） | 营销话术误判 | 25% |
| 文本分类 | 营销词过度敏感 | 30% |
| 规则引擎 | 白名单缺失 | 10% |

### 二、根因定位

综合分析表明，该素材被误杀的主要原因是**多模型协同误判**：

1. **OSR 模块**（贡献度 35%）：将画面中的促销海报文字"限时五折"误识别为违规广告诱导词
2. **文本分类模块**（贡献度 30%）：对营销词汇的敏感阈值过高，缺乏行业上下文感知
3. **ASR 模块**（贡献度 25%）：语音中的营销话术"限时优惠"触发了诱导内容规则
4. **规则引擎**（贡献度 10%）：缺少电商行业白名单，已授权商户的促销内容未被放行

### 三、归因结论

| 维度 | 判定 |
|------|------|
| 误杀类型 | 规则不合理 + 样本不足 |
| 置信度 | 高（92%+） |
| 是否真实误杀 | 是（True Positive → 实际为 False Positive） |
| 建议动作 | 规则优化 + 样本补充 + 白名单建设 |

### 四、优化建议（优先级排序）

1. **【P0】规则优化**：下调电商行业营销词汇敏感度，建立行业白名单机制
2. **【P0】样本补充**：新增电商正向营销训练样本 5000+ 条，平衡正负样本比例
3. **【P1】上下文感知**：引入行业感知模块，区分正常营销与诱导广告
4. **【P1】多模态融合**：综合 OSR + ASR + 文本分类结果，避免单模型一刀切
5. **【P2】持续监控**：建立营销类误杀监控看板，跟踪优化效果`
  } else {
    category = '通用分析'
    analysis = `## AI 分析结果

**分析模型**：${modelLabel}
**分析时间**：${timestamp}

### 分析内容

针对您提出的问题：「${message.slice(0, 100)}」

### 初步判断

根据素材内容分析，该样本存在误杀可能性。模型在处理此类内容时，可能存在以下问题：

1. **规则敏感度偏高**：当前审核规则对该类型内容的拦截阈值设置较为保守
2. **上下文理解不足**：模型未能充分理解素材的商业场景上下文
3. **训练样本偏差**：相关正向样本覆盖不够全面

### 建议

- 建议提交误杀归因工单，由处理人进一步复核
- 补充同类正向样本以优化模型判定准确率
- 考虑针对该行业场景调整审核规则参数

---

> ⚠️ 以上为演示模式模拟分析结果，实际使用时请配置 Knot Token 以获取真实 AI 分析。`
  }

  return {
    content: analysis,
    model: modelLabel,
    category,
    usage: { promptTokens: 1280, completionTokens: 890, totalTokens: 2170 },
    demo: true,
  }
}

// AI 用量概览
router.get('/usage', requireLogin, async (req, res, next) => {
  try {
    // AI 用量从数据库审计日志聚合
    const totalRows = await query("SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE '%AI 生成调用%'")
    const totalCalls = totalRows[0]?.c || 0
    res.json({ totalCalls, byModel: [], trend: [] })
  } catch (e) { next(e) }
})

export default router