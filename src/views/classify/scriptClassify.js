/**
 * 纯 JS 脚本预分类工具
 * 先定位具体标签（rows 已是单标签素材），再按该标签素材的 classId 优先分组，
 * classId 为空时回退到 classNum 分组（含0值也是有效分组）
 * Phase 2 读取每组全量素材文本（OCR+ASR），提取高频词/句式生成三段式特征
 *
 * 输出三段式：
 *   1. name — 分类名称（特征凝练版：高频词/句式）
 *   2. featureBrief — 高频原文短语/句式列表
 *   3. featureDetail — 具体特征（一句话）
 *   4. sampleSnapshot — 该分类下典型素材的原文摘录
 */

// ============ 停用词 ============

const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '上', '也', '很', '到', '说', '要', '去',
  '你', '会', '着', '看', '好', '自己', '这', '那', '里', '为', '可以', '这个', '那个', '如果', '但是', '因为',
  '所以', '或者', '还是', '已经', '一下', '一种', '一些', '这样', '的话', '其实', '就是', '而且', '然后', '不过',
  '只是', '只有', '什么', '怎么', '如何', '是否', '应该', '需要', '必须', '可能', '也许', '大概', '没有', '不是',
  '不要', '不能', '它们', '我们', '你们', '他们', '这些', '那些', '其中', '通过', '进行', '以及', '并且',
  '以', '及', '等', '之', '其', '此', '该', '各', '每', '任', '某', '些', '么', '吗', '呢', '吧', '啊', '哦',
  '嗯', '哈', '哎', '呀', '哇', '啦', '嘛', '喽', '哼', '嘿', '喂', '咦', '嘻', '嘎', '哟', '喔', '嗷', '诶',
  '真的', '一个', '这么', '那么', '一样', '知道', '觉得', '告诉', '直接', '一定', '现在', '时候',
  '不会', '这种', '一直', '还有', '起来', '出来', '过来', '大家', '东西', '不用', '别人',
  '这是', '一次', '两个', '很多', '非常', '朋友', '今天', '明天', '昨天', '一年', '再说',
  '一点', '里面', '上面', '下面', '前面', '后面', '外面', '旁边', '中间',
  '视频', '图片', '内容', '素材', '广告', '页面', '商品', '产品',
])

// ============ 单字停用词（用于 ngram 边界过滤） ============

const SINGLE_STOP_CHARS = new Set([
  '的','了','在','是','我','有','和','就','不','人','都','一','上','也','很','到','说','要','去',
  '你','会','着','看','好','这','那','里','为','以','及','等','之','其','此','该','各','每',
  '任','某','些','么','吗','呢','吧','啊','哦','嗯','哈','哎','呀','哇','啦','嘛','喽','哼','嘿',
  '喂','咦','嘻','嘎','哟','喔','嗷','诶','给','把','被','让','使','向','从','对','跟','与','把',
  '能','可','需','应','或','但','因','所','还','已','再','又','只','便','即','则','若','虽','却',
])

// ============ 文本工具 ============

/**
 * 从文本中提取高频关键词（2~20字 ngram）
 * - 2~4字：短关键词（产品/功效词）
 * - 5~20字：长短语（句式/表达模式）
 * 边界停用词过滤：ngram 首尾为单字停用词则跳过
 * 最低频次阈值（长度越长要求越高，避免低频长片段污染）：
 *   长度 5~7 → ≥2次，长度 8~12 → ≥3次，长度 13~20 → ≥4次
 * 返回 [{ word, count }] 按频率降序
 */
function extractKeywords(text) {
  if (!text || !text.trim()) return []
  // 对超大文本采样截断，避免 ngram 爆炸（100K 字符足以提取高频特征）
  const sampleText = text.length > 100000 ? text.slice(0, 100000) : text
  const cleaned = sampleText.replace(/[，。！？、；：""''（）【】《》\s\n\r\t,\.!?;:"'()\[\]<>\/\\@#$%^&*+=|`~\-—…]/g, ' ')
  const chineseChunks = cleaned.match(/[\u4e00-\u9fa5]{2,}/g) || []
  const freq = {}
  for (const chunk of chineseChunks) {
    for (let len = 2; len <= Math.min(20, chunk.length); len++) {
      for (let i = 0; i <= chunk.length - len; i++) {
        const ng = chunk.slice(i, i + len)
        if (STOP_WORDS.has(ng)) continue
        // 边界停用词过滤：ngram 首尾为单字停用词则跳过（长度≥3时）
        if (len >= 3) {
          if (SINGLE_STOP_CHARS.has(ng[0]) || SINGLE_STOP_CHARS.has(ng[ng.length - 1])) continue
        }
        freq[ng] = (freq[ng] || 0) + 1
      }
    }
  }
  // 也提取英文单词
  const engTokens = cleaned.match(/[a-zA-Z]{3,}/g) || []
  for (const t of engTokens) {
    const lower = t.toLowerCase()
    if (!STOP_WORDS.has(lower)) freq[lower] = (freq[lower] || 0) + 1
  }
  // 按长度分组应用最低频次阈值 + 限制返回数量上限避免后续去重 O(n²) 爆炸
  return Object.entries(freq)
    .filter(([word, count]) => {
      const wl = word.length
      if (wl >= 13 && count < 4) return false
      if (wl >= 8 && count < 3) return false
      if (wl >= 5 && count < 2) return false
      return true
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 500)  // 仅保留 top 500 高频词，足以覆盖特征提取需求
    .map(([word, count]) => ({ word, count }))
}

/**
 * 从文本中提取高频短语/句式（5~40字片段）
 * 按标点切分，统计完全相同的片段频率
 * 返回 [{ phrase, count }] 按频率降序
 */
function extractPhrases(text) {
  if (!text || !text.trim()) return []
  // 对超大文本采样截断
  const sampleText = text.length > 100000 ? text.slice(0, 100000) : text
  // 按句号/感叹号/问号/换行切分句子
  const sentences = sampleText.split(/[。！？；\n\r！？]/)
    .map(s => s.trim())
    .filter(s => s.length >= 5 && s.length <= 50)
  // 按逗号/顿号切分短句
  const shortPhrases = text.split(/[，,、；;]/)
    .map(s => s.trim())
    .filter(s => s.length >= 5 && s.length <= 30)
  const freq = {}
  for (const s of [...sentences, ...shortPhrases]) {
    // 去掉纯标点和数字
    const cleaned = s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    if (cleaned.length < 3) continue
    freq[s] = (freq[s] || 0) + 1
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .map(([phrase, count]) => ({ phrase, count }))
}

/**
 * 判断词是否有实质含义（过滤无意义的高频词）
 */
function isMeaningful(word) {
  if (STOP_WORDS.has(word)) return false
  if (/^\d+$/.test(word)) return false
  if (word.length < 2) return false
  // 过滤单个常用字重复（如"好好"、"真的"）
  if (word.length === 2 && STOP_WORDS.has(word[0]) && STOP_WORDS.has(word[1])) return false
  return true
}

/**
 * 去重相似词：基于频率比的自适应去重
 * 规则：若短词 A 是长词 B 的子串
 *   - freq(B)/freq(A) ≥ 0.5 → 移除短词 A（长词足够具体且高频）
 *   - freq(B)/freq(A) < 0.5 → 保留两者（短词是泛化高频词，长词是低频具体词）
 */
function dedupSimilarWords(keywords) {
  // 仅对 top 200 关键词做去重，避免 O(n²) 子串比较爆炸
  const list = keywords.slice(0, 200)
  const removed = new Set()

  for (let i = 0; i < list.length; i++) {
    if (removed.has(list[i].word)) continue
    for (let j = 0; j < list.length; j++) {
      if (i === j || removed.has(list[j].word)) continue

      const wi = list[i]  // 当前词
      const wj = list[j]  // 对比词

      // wi 是 wj 的子串（wi 更短）
      if (wi.word.length < wj.word.length && wj.word.includes(wi.word)) {
        const ratio = wj.count / wi.count
        if (ratio >= 0.5) {
          removed.add(wi.word)
          break
        }
      }
    }
  }

  // 返回去重后的 top 200 + 剩余未参与去重的关键词
  return [...list.filter(k => !removed.has(k.word)), ...keywords.slice(200)]
}

// ============ 主函数 ============

/**
 * 脚本预分类主函数（两阶段）
 *
 * Phase 1 — 快速分组：先定位具体标签，再按该标签素材的 classNum 直接分组（含0值）。立即返回分类名称 + 样本ID
 * Phase 2 — 渐进特征：对每个分类逐一分析文本，生成 featureBrief/featureDetail/sampleSnapshot
 *
 * @param {Array} rows - 素材行
 * @param {Object} opts - 配置项
 *   - maxSnapshotCount: 典型摘录数量
 *   - onFeature: 回调 (index, feature) => void，每完成一个分类的特征生成时触发
 * @returns {Array} Phase 1 结果（含 name, sampleIds，feature 字段为占位）
 */
export function scriptClassify(rows, opts = {}) {
  const {
    maxSnapshotCount = 3,
    onFeature = null,
  } = opts

  if (!rows || !rows.length) return []

  // ========== Phase 1: 按 classId 分组，classId 为空时回退到 classNum 分组 ==========
  // rows 已是单标签下的素材；classId 来自 AI评测明细表
  // 分组规则：
  //   - classId 以 "c" 开头（如 c1, c2）→ 各自独立一组，相同 classId 归一类
  //   - classId 以 "noise" 开头 → 全部归为"噪声"一组
  //   - classId 为空 → 回退到 classNum 分组（classNum>=0 各自独立一组）
  //   - 其他值/空值 → 各自独立分组
  const classGroups = new Map()
  for (const row of rows) {
    const raw = String(row.classId || '').trim()
    let groupKey
    if (!raw) {
      // classId 为空时回退到 classNum 分组
      const num = String(row.classNum ?? '')
      groupKey = num ? `__classNum_${num}__` : '__unclustered__'
    } else if (raw.startsWith('noise')) {
      groupKey = '__noise__'
    } else {
      groupKey = raw
    }
    if (!classGroups.has(groupKey)) classGroups.set(groupKey, [])
    classGroups.get(groupKey).push(row)
  }

  // 排序：聚类簇在前（按数字），classNum分组次之，未聚类再次，噪声最后
  function groupRank(key) {
    if (key === '__noise__') return 3
    if (key === '__unclustered__') return 2
    if (key.startsWith('__classNum_')) return 1
    return 0
  }
  const sortedGroups = [...classGroups.entries()].sort((a, b) => {
    const ra = groupRank(a[0]), rb = groupRank(b[0])
    if (ra !== rb) return ra - rb
    return a[0].localeCompare(b[0], undefined, { numeric: true })
  })

  // 不做数量上限：素材被 AI 分成了多少个 classId/classNum 就展示多少个分类，
  // 不再将超出部分合并到"其他"组（用户要求保留全部分类）。

  // 命名规则
  function groupName(key, idx) {
    if (key === '__noise__') return '噪声数据'
    if (key === '__unclustered__') return '未聚类'
    if (key === '__other__') return '其他'
    if (key.startsWith('__classNum_')) {
      const num = key.replace('__classNum_', '').replace('__', '')
      return `分类${num}`
    }
    if (/^c\d+$/.test(key)) return `聚类簇 ${key.slice(1)}`
    return `分类${idx + 1}`
  }

  const results = sortedGroups.map(([key, groupRows], i) => ({
    name: groupName(key, i),
    featureBrief: '',     // 占位：Phase 2 填充
    featureDetail: '',    // 占位：Phase 2 填充
    sampleSnapshot: '',   // 占位：Phase 2 填充
    sampleIds: groupRows.map(r => r.id),
    _groupRows: groupRows, // 保留引用供 Phase 2 使用
  }))

  // ========== Phase 2: 渐进式生成特征（异步，逐个分类） ==========
  // 使用 setTimeout(0) 让出主线程，确保 Phase 1 结果先渲染
  if (onFeature && typeof onFeature === 'function') {
    let idx = 0
    const processNext = () => {
      if (idx >= results.length) return
      const r = results[idx]
      const feature = generateFeatureForGroup(r._groupRows, maxSnapshotCount)
      r.featureBrief = feature.featureBrief
      r.featureDetail = feature.featureDetail
      r.sampleSnapshot = feature.sampleSnapshot
      onFeature(idx, { ...feature })
      idx++
      // 让出主线程，下一轮再处理
      setTimeout(processNext, 0)
    }
    setTimeout(processNext, 0)
  }

  return results
}

/**
 * 对单个分组生成三段式特征（同步，耗时操作）
 */
function generateFeatureForGroup(groupRows, maxSnapshotCount) {
    // 收集该组所有素材的文本
    const textItems = groupRows.map(r => ({
      id: r.id,
      text: `${r.ocr || ''} ${r.asr || ''}`.trim(),
      industryL1: r.industryL1 || '',
      industryL2: r.industryL2 || '',
      type: r.elementTypeName || r.type || '',
    }))

    // 拼接全量文本用于关键词提取
    const allText = textItems.map(t => t.text).join(' ')
    const hasAnyText = allText.trim().length > 0

    // 提取高频关键词和短语
    const rawKeywords = hasAnyText ? extractKeywords(allText) : []
    const phrases = hasAnyText ? extractPhrases(allText) : []

    // 过滤 + 去重相似词
    const meaningfulKeywords = dedupSimilarWords(
      rawKeywords.filter(k => isMeaningful(k.word))
    )
    // 分层：短关键词（2~4字，产品/功效词）与长短语（5~20字，句式/表达模式）
    const shortWords = meaningfulKeywords.filter(k => k.word.length <= 4).slice(0, 6).map(k => k.word)
    const longPhrases = meaningfulKeywords.filter(k => k.word.length >= 5).slice(0, 5).map(k => k.word)
    const topWords = [...shortWords, ...longPhrases]
    const topPhrases = phrases.slice(0, 5).map(p => p.phrase)

    // ========== 生成分类名称 ==========
    // 默认命名：分类一、分类二...（排序后在 Step 3 统一赋值）
    const name = ''

    // ========== 生成 featureBrief（高频原文短语/句式） ==========
    const briefItems = []
    // 优先放长短语 ngram（5~10字句式特征）
    for (const lp of longPhrases.slice(0, 3)) {
      briefItems.push(`"${lp}"`)
    }
    // 再放标点切分的高频短语
    for (const p of topPhrases.slice(0, 3)) {
      if (briefItems.length >= 6) break
      if (!briefItems.some(b => b.includes(p))) {
        briefItems.push(`"${p}"`)
      }
    }
    // 补充短关键词
    for (const w of shortWords.slice(0, 4)) {
      if (briefItems.length >= 8) break
      if (!briefItems.some(b => b.includes(w))) {
        briefItems.push(`"${w}"`)
      }
    }
    const featureBrief = briefItems.length
      ? briefItems.join('、')
      : (hasAnyText ? '文本特征不明显' : '无OCR/ASR文本内容')

    // ========== 生成 featureDetail（具体特征，一句话） ==========
    let featureDetail
    if (!hasAnyText) {
      featureDetail = `该分类共${groupRows.length}条素材，无OCR/ASR文本内容`
    } else {
      // 高频短词描述
      const wordDesc = shortWords.length
        ? `文本高频出现"${shortWords.slice(0, 4).join('"、"')}"等词`
        : '文本特征不明显'

      // 典型句式描述（优先用长短语 ngram）
      const phraseDesc = longPhrases.length
        ? `，典型表达如"${longPhrases[0]}"`
        : (topPhrases.length ? `，典型表达如"${topPhrases[0]}"` : '')

      // 行业信息
      const industryInfo = [...new Set(
        textItems
          .map(t => [t.industryL1, t.industryL2].filter(Boolean).join('/'))
          .filter(Boolean)
      )].slice(0, 2)
      const industryDesc = industryInfo.length
        ? `，涉及${industryInfo.join('、')}行业`
        : ''

      // 素材类型
      const typeInfo = [...new Set(textItems.map(t => t.type).filter(Boolean))].slice(0, 2)
      const typeDesc = typeInfo.length
        ? `，类型以${typeInfo.join('、')}为主`
        : ''

      featureDetail = `该分类共${groupRows.length}条素材，${wordDesc}${phraseDesc}${typeDesc}${industryDesc}`
    }

    // ========== 生成 sampleSnapshot（典型素材原文摘录） ==========
    const parts = ['①', '②', '③', '④', '⑤']
    // 优先选择有文本内容的素材
    const snapshotCandidates = textItems
      .filter(t => t.text.length > 0)
      .slice(0, maxSnapshotCount)

    const sampleSnapshot = snapshotCandidates.length
      ? snapshotCandidates
          .map((item, i) => {
            // 截取前100字作为摘录
            const excerpt = item.text.length > 100
              ? item.text.slice(0, 100) + '...'
              : item.text
            return `${parts[i] || `(${i + 1})`}"${excerpt}"（素材${item.id}）`
          })
          .join(' ')
      : `该分类暂无可用文本摘录`

    return { featureBrief, featureDetail, sampleSnapshot }
}

/**
 * 聚类簇特征总结（套路）：基于簇内元素的 OCR/ASR 文本提取高频词/句式，
 * 生成可编辑的「素材内容特征总结」文本。供「标签下钻 → 聚类簇 → 簇特征」面板使用。
 * @param {Array} rows 簇内素材行（含 ocrContent/asrContent 或 ocr/asr 字段）
 * @returns {{ summary: string, keywords: string[] }}
 */
export function generateClusterFeature(rows) {
  if (!rows || !rows.length) return { summary: '', keywords: [] }

  const texts = rows
    .map(r => `${r.ocrContent || r.ocr || ''} ${r.asrContent || r.asr || ''}`.trim())
    .filter(Boolean)
  const allText = texts.join(' ')
  if (!allText.trim()) return { summary: '该簇素材暂无 OCR/ASR 文本内容', keywords: [] }

  const rawKeywords = extractKeywords(allText)
  const phrases = extractPhrases(allText)
  const meaningful = dedupSimilarWords(rawKeywords.filter(k => isMeaningful(k.word)))
  const shortWords = meaningful.filter(k => k.word.length <= 4).slice(0, 8).map(k => k.word)
  const longPhrases = meaningful.filter(k => k.word.length >= 5).slice(0, 6).map(k => k.word)
  const topPhrases = phrases.slice(0, 5).map(p => p.phrase)
  const keywords = [...shortWords, ...longPhrases].filter((v, i, a) => a.indexOf(v) === i)

  const wordDesc = keywords.length
    ? `文本高频出现"${keywords.slice(0, 6).join('"、"')}"等词`
    : '文本特征不明显'
  const phraseDesc = longPhrases.length
    ? `，典型表达如"${longPhrases[0]}"`
    : (topPhrases.length ? `，典型表达如"${topPhrases[0]}"` : '')
  const summary = `该簇共${rows.length}条素材，${wordDesc}${phraseDesc}`

  return { summary, keywords }
}