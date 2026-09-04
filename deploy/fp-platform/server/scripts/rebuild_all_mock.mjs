/**
 * 全平台 mock 数据统一重建脚本（v2）
 * 目标：
 *  1. 周维度精度趋势：15 周，W1=50%，前三周 ≤65%，峰值 80%，中间高低错落（非单调）
 *  2. 每个标签覆盖完整 15 周，均有 精度/样本数/FP 数据
 *  3. 结论沉淀库：补全 industry_l1 / tag_id / adopted_at，保证列表与行业维度有数据
 *  4. 聚类簇特征覆盖全部标签
 *  5. 数据更新至 = 今天（2026-09-02）
 */
import mysql from 'mysql2/promise'

const DB = {
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
}
const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 10, dateStrings: true })

// ========== 配置 ==========
// 15 周周一（2026-05-25 ~ 2026-08-31）
const WEEKS = [
  '2026-05-25', '2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22',
  '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27',
  '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31',
]
// 大盘精度曲线：W1=50，前三周≤65，峰值80，高低错落
const PANEL_PREC = [50.0, 57.3, 62.1, 68.4, 64.2, 71.5, 69.3, 76.8, 73.1, 80.0, 77.4, 72.6, 78.2, 74.9, 79.3]
// 绝对精度（略高于大盘精度 2~4pp）
const PANEL_ABS = [52.8, 59.9, 65.0, 71.2, 67.1, 74.3, 72.0, 79.1, 75.8, 82.3, 79.9, 75.4, 80.6, 77.5, 81.7]

const TODAY = '2026-09-02' // 数据更新至今天

// 50 个标签（tag_id + 名称 + 行业）
const TAGS = [
  [14599, '法规禁投', '医疗健康', '医疗服务'],
  [14655, '古代/现代领导人地位身份词', '数字传媒内容', '新闻资讯'],
  [14657, '小说短剧封建迷信内容宣传', '数字传媒内容', '小说阅读'],
  [14658, '教育国学易经/影音', '数字传媒内容', '教育培训'],
  [14660, '灵异题材小说', '数字传媒内容', '小说阅读'],
  [14669, '营销内容', '电商服务', '美妆个护'],
  [14676, '低俗诱导', '数字传媒内容', '短视频'],
  [14680, '虚假宣传', '电商服务', '综合电商'],
  [14685, '医疗效果承诺', '医疗健康', '医疗服务'],
  [14690, '药品违规推广', '医疗健康', '药品'],
  [14695, '医疗器械夸大', '医疗健康', '医疗器械'],
  [14700, '保健品夸大功效', '医疗健康', '保健品'],
  [14705, '医美效果承诺', '医疗健康', '医疗美容'],
  [14710, '化妆品虚假功效', '美妆个护', '护肤品'],
  [14715, '减肥瘦身承诺', '美妆个护', '瘦身产品'],
  [14720, '植发生发承诺', '医疗健康', '医疗美容'],
  [14725, '近视治疗承诺', '医疗健康', '眼科'],
  [14730, '口腔正畸承诺', '医疗健康', '口腔'],
  [14735, '网贷诱导', '金融', '消费金融'],
  [14740, '信用卡违规推广', '金融', '银行'],
  [14745, '保险收益承诺', '金融', '保险'],
  [14750, '虚拟货币炒作', '金融', '区块链'],
  [14755, '股票荐股', '金融', '证券'],
  [14760, '赌博引流', '游戏', '棋牌游戏'],
  [14765, '私服外挂', '游戏', '角色扮演'],
  [14770, '伪科学', '数字传媒内容', '科普'],
  [14775, '封建迷信', '数字传媒内容', '资讯'],
  [14776, '低俗诱导', '数字传媒内容', '短视频'],
  [14780, '涉政敏感', '数字传媒内容', '新闻资讯'],
  [14785, '暴力血腥', '游戏', '射击游戏'],
  [14790, '惊悚恐怖', '数字传媒内容', '短视频'],
  [14795, '违禁品交易', '电商服务', '综合电商'],
  [14800, '假冒伪劣', '电商服务', '综合电商'],
  [14805, '侵权盗版', '数字传媒内容', '影视'],
  [14810, '隐私收集', '软件工具', '工具应用'],
  [14815, '恶意扣费', '软件工具', '工具应用'],
  [14820, '诱导分享', '数字媒体平台', '社交'],
  [14825, '诱导下载', '软件工具', '应用商店'],
  [14830, '违规收集个人信息', '软件工具', '工具应用'],
  [14835, '青少年沉迷', '游戏', '手游'],
  [14840, '游戏版号违规', '游戏', '手游'],
  [14845, '教育资质造假', '数字传媒内容', '教育培训'],
  [14850, '学历造假', '数字传媒内容', '教育培训'],
  [14855, '招聘歧视', '数字传媒内容', '招聘'],
  [14860, '房地产虚假宣传', '电商服务', '房产'],
  [14865, '汽车虚假优惠', '电商服务', '汽车'],
  [14870, '旅游虚假宣传', '电商服务', '旅游'],
  [14875, '食品虚假功效', '电商服务', '食品'],
  [14880, '服饰材质造假', '服饰珠宝', '服装'],
  [14885, '珠宝以次充好', '服饰珠宝', '珠宝'],
  [15021, '违规广告', '电商服务', '综合电商'],
  [15022, '诱导点击', '数字媒体平台', '社交'],
  [15023, '夸大对比', '电商服务', '综合电商'],
  [15024, '虚构原价', '电商服务', '综合电商'],
  [15025, '隐藏收费', '软件工具', '工具应用'],
  [15026, '强制授权', '软件工具', '工具应用'],
  [15027, '赌博博彩', '游戏', '棋牌游戏'],
  [15028, '高危行为模仿', '数字传媒内容', '短视频'],
  [15029, '违禁工具售卖', '电商服务', '综合电商'],
  [15030, '虚假公益', '数字传媒内容', '资讯'],
]

const ELEMENT_TYPES = [
  ['ELEMENT_TYPE_IMAGE', '图片'],
  ['ELEMENT_TYPE_VIDEO', '视频'],
  ['ELEMENT_TYPE_TEXT', '文本'],
]
const FP_REASONS = [
  '素材未含违规内容，模型误判',
  '行业标签打标错误导致误命中',
  '相似素材混淆，实际为合规素材',
  'OCR 识别错误导致关键词误命中',
  '规则阈值过宽，正常内容被拦截',
  '素材已过审但模型未同步状态',
]

// 确定性伪随机（保证每次重建结果一致，便于复现）
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(20260902)

// ========== 1. 精度聚合表 real_data_tag_precision ==========
async function rebuildPrecision() {
  console.log('\n[1/6] 重建 real_data_tag_precision ...')
  await pool.query('DELETE FROM real_data_tag_precision')

  const cols = `tag_id, tag_name, total, fp, precision_val, sample_count,
    first_level_industry_name, second_level_industry_name, element_type, element_type_name,
    arrive_time, ds, model_version, element_fingerprint, remark, fp_reason,
    tp, fp_conf, tn, fn, review_model_precision_prime`

  // 标签权重：每个标签样本量占比（稳定不变，仅精度随周变化）
  const tagWeight = new Map()
  TAGS.forEach(([id]) => tagWeight.set(id, 0.6 + rand() * 0.8))
  const weightSum = [...tagWeight.values()].reduce((a, b) => a + b, 0)

  // 标签精度基线偏移（-14 ~ +12），制造标签间差异；并保证加权后回落到目标曲线
  const tagOffset = new Map()
  TAGS.forEach(([id], i) => tagOffset.set(id, Math.round((rand() * 26 - 14) * 10) / 10))

  let batch = []
  for (let w = 0; w < WEEKS.length; w++) {
    const ds = WEEKS[w]
    const panel = PANEL_PREC[w]     // 大盘目标精度
    const absP = PANEL_ABS[w]       // 大盘目标绝对精度

    // 本周大盘总量（约 3800，与历史同量级）
    const weekTotal = 3600 + Math.floor(rand() * 500)
    // 大盘目标 TP/FP
    const targetTp = Math.round(weekTotal * panel / 100)
    const targetFp = weekTotal - targetTp

    // 1) 先按权重分配各标签总量（最后一项补齐，保证合计=weekTotal）
    const totals = TAGS.map(([tagId]) => {
      const w8 = tagWeight.get(tagId) / weightSum
      return Math.max(20, Math.round(weekTotal * w8))
    })
    const sumT = totals.reduce((a, b) => a + b, 0)
    totals[TAGS.length - 1] = Math.max(20, totals[TAGS.length - 1] + (weekTotal - sumT))

    // 2) 再按各标签目标精度算 tp
    const rows = TAGS.map(([tagId, tagName, ind1, ind2], idx) => {
      const total = totals[idx]
      // 标签精度 = 大盘 + 偏移 + 正弦波动（高低错落）
      const wave = Math.sin((w + tagId % 7) * 0.8) * 6
      let prec
      if (w < 3) {
        // 前三周：围绕大盘目标做小波动（±7），并严格 clamp 到 ≤65%，
        // 保证大盘目标（50/57.3/62.1）与单标签「≤65%」同时成立
        const jitter = Math.sin((w * 3 + tagId) * 1.7) * 7
        prec = panel + jitter
        prec = Math.max(30, Math.min(65, prec))
      } else {
        prec = panel + tagOffset.get(tagId) + wave * 0.5
        prec = Math.max(20, Math.min(95, prec))
      }

      let tp = Math.round(total * prec / 100)
      if (tp > total) tp = total
      if (tp < 0) tp = 0
      return { tagId, tagName, ind1, ind2, total, tp, fp: total - tp, prec, absP }
    })

    // 校正：把本周 TP 总量精确对齐目标（误差摊到前若干标签）
    let curTp = rows.reduce((s, r) => s + r.tp, 0)
    let diff = targetTp - curTp
    let guard = 0
    while (diff !== 0 && guard++ < 20000) {
      for (const r of rows) {
        if (diff === 0) break
        if (diff > 0 && r.tp < r.total) { r.tp++; r.fp--; diff-- }
        else if (diff < 0 && r.tp > 0) { r.tp--; r.fp++; diff++ }
      }
    }

    // 写入批次
    for (const r of rows) {
      const absThis = Math.max(20, Math.min(98, r.absP + tagOffset.get(r.tagId) * 0.3))
      const fpConf = r.tp > 0 ? Math.max(0, Math.round(r.tp * (100 / absThis - 1))) : 0
      const precisionVal = r.total > 0 ? Number((r.tp / r.total * 100).toFixed(2)) : 0
      const primeVal = Number((precisionVal + (rand() * 4 - 2)).toFixed(2))
      const [et, etName] = ELEMENT_TYPES[r.tagId % 3]
      const fpReason = r.fp > 0 ? FP_REASONS[Math.floor(rand() * FP_REASONS.length)] : ''

      batch.push([
        r.tagId, r.tagName, r.total, r.fp, precisionVal, r.total,
        r.ind1, r.ind2, et, etName,
        TODAY, ds, 'v2.3.1', `fp_${r.tagId}_${w}`, '', fpReason,
        r.tp, fpConf, 0, 0, primeVal,
      ])
    }
  }



  // 分批插入
  const placeholders = `(${new Array(cols.split(',').length).fill('?').join(',')})`
  const CHUNK = 100
  for (let i = 0; i < batch.length; i += CHUNK) {
    const part = batch.slice(i, i + CHUNK)
    const sql = `INSERT INTO real_data_tag_precision (${cols}) VALUES ${part.map(() => placeholders).join(',')}`
    const flat = part.flat()
    await pool.query(sql, flat)
  }
  const [[c]] = await pool.query('SELECT COUNT(*) c FROM real_data_tag_precision')
  console.log(`  插入 ${c} 行（${TAGS.length} 标签 × ${WEEKS.length} 周）`)

  // 校验
  const [chk] = await pool.query(`SELECT ds,
    ROUND(SUM(tp)/(SUM(tp)+SUM(fp))*100,2) prec,
    ROUND(SUM(tp)/(SUM(tp)+SUM(fp_conf))*100,2) abs_prec
    FROM real_data_tag_precision GROUP BY ds ORDER BY ds`)
  console.log('  大盘周精度校验:')
  chk.forEach((r, i) => console.log(`    W${i + 1} ${r.ds} 精度=${r.prec}% 绝对精度=${r.abs_prec}%`))
}

// ========== 2. 样本明细表 real_data_samples ==========
async function rebuildSamples() {
  console.log('\n[2/6] 重建 real_data_samples ...')
  await pool.query('DELETE FROM real_data_samples')

  const cols = `tag_id, tag_name, sample_id, element_fingerprint, element_type, is_video,
    machine_tag, human_tag, first_level_industry_name, second_level_industry_name,
    media_url, ocr_content, asr_content, advertiser, arrive_time, ds, is_fp, fp_reason,
    remark, class_num, class_id, reviewer_name, dc_id, ops_advertiser_name,
    ai_evaluate_reviewer_name, policy_ids, ai_evaluate_policy_ids, uid`

  // 每个标签每周生成 12 条样本（保证下钻/聚类有数据且总量可控）
  const batch = []
  let seq = 0
  for (let w = 0; w < WEEKS.length; w++) {
    const monday = WEEKS[w]
    const panel = PANEL_PREC[w]

    const perTag = 12
    const weekTotal = TAGS.length * perTag
    const targetFp = Math.round(weekTotal * (100 - panel) / 100)  // 目标 FP 数

    // 先按目标精度概率生成，再精确校正 FP 总数
    const slots = []
    for (let ti = 0; ti < TAGS.length; ti++) {
      const [tagId, tagName, ind1, ind2] = TAGS[ti]
      const offset = (tagId % 17) - 8
      let prec
      if (w < 3) {
        // 前三周：围绕大盘目标小波动并 clamp ≤65%，与精度表口径一致
        const jitter = Math.sin((w * 3 + tagId) * 1.7) * 7
        prec = Math.max(30, Math.min(65, panel + jitter))
      } else {
        prec = Math.max(20, Math.min(95, panel + offset))
      }
      for (let k = 0; k < perTag; k++) {
        slots.push({ tagId, tagName, ind1, ind2, prec, isFp: rand() * 100 > prec ? 1 : 0 })
      }
    }

    // 校正本周 FP 总数到目标值
    let curFp = slots.filter(s => s.isFp).length
    let diff = targetFp - curFp
    let guard = 0
    while (diff !== 0 && guard++ < 50000) {
      for (const s of slots) {
        if (diff === 0) break
        if (diff > 0 && s.isFp === 0) { s.isFp = 1; diff-- }
        else if (diff < 0 && s.isFp === 1) { s.isFp = 0; diff++ }
      }
    }

    for (let si = 0; si < slots.length; si++) {
      const s = slots[si]
      seq++
      const dayOffset = Math.floor(rand() * 7)
      const dt = new Date(monday + 'T00:00:00')
      dt.setDate(dt.getDate() + dayOffset)
      const arrive = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      const isFp = s.isFp
      const [et] = ELEMENT_TYPES[s.tagId % 3]
      const etName = et === 'ELEMENT_TYPE_VIDEO' ? '视频' : (et === 'ELEMENT_TYPE_IMAGE' ? '图片' : '文本')
      const isVideo = et === 'ELEMENT_TYPE_VIDEO' ? 1 : 0
      // 簇 ID 与 cluster_data / cluster_features / sample_library_fine_label 保持一致
      const cid = `CL${String(s.tagId).slice(-3)}${((si % 3) + 1)}`
      const ext = isVideo ? 'mp4' : (et === 'ELEMENT_TYPE_IMAGE' ? 'jpg' : 'txt')
      const k = si % perTag

      batch.push([
        s.tagId, s.tagName, `RL-${s.tagId}-${w}-${k}`, `fp_${s.tagId}_${w}_${k}`, etName, isVideo,
        String(s.tagId), isFp ? '' : String(s.tagId), s.ind1, s.ind2,
        `https://example.com/ad/${s.tagId}_${w}_${k}.${ext}`,
        isVideo ? '' : ['限时特惠全场5折', '买一送一立即抢购', '专业团队品质保障', '免费领取名额有限'][k % 4],
        isVideo ? ['欢迎观看本视频', '点击下方链接了解更多'][k % 2] : '',
        '', arrive, arrive, isFp,
        isFp ? FP_REASONS[Math.floor(rand() * FP_REASONS.length)] : '',
        '', 0, cid, ['张三', '李四', '王五'][k % 3],
        `DC2026${String(seq).padStart(6, '0')}`, `${s.ind2}旗舰店`,
        ['张三', '李四', '王五', '赵六'][k % 4],
        String(s.tagId), isFp ? '' : String(s.tagId), '',
      ])
    }
  }

  const placeholders = `(${new Array(cols.split(',').length).fill('?').join(',')})`
  const CHUNK = 200
  for (let i = 0; i < batch.length; i += CHUNK) {
    const part = batch.slice(i, i + CHUNK)
    const sql = `INSERT INTO real_data_samples (${cols}) VALUES ${part.map(() => placeholders).join(',')}`
    await pool.query(sql, part.flat())
  }
  const [[c]] = await pool.query('SELECT COUNT(*) c FROM real_data_samples')
  console.log(`  插入 ${c} 行样本`)

  const [wk] = await pool.query(`SELECT YEARWEEK(arrive_time,1) wk, MIN(DATE(arrive_time)) ws,
    COUNT(*) c, SUM(is_fp) fp, ROUND(100*(1-SUM(is_fp)/COUNT(*)),2) prec
    FROM real_data_samples GROUP BY wk ORDER BY wk`)
  console.log('  样本表周分布校验（趋势图样本分支数据源）:')
  wk.forEach((r, i) => console.log(`    W${i + 1} ${r.ws} n=${r.c} fp=${r.fp} 精度=${r.prec}%`))
}

// ========== 3. 标签聚合表 real_data_tags（精度排行榜）==========
async function rebuildTags() {
  console.log('\n[3/6] 重建 real_data_tags ...')
  await pool.query('DELETE FROM real_data_tags')
  const rows = await pool.query(`SELECT tag_id, MAX(tag_name) nm, SUM(total) total, SUM(fp) fp, SUM(tp) tp
    FROM real_data_tag_precision GROUP BY tag_id`)
  const batch = rows[0].map(r => {
    const total = Number(r.total) || 0
    const fp = Number(r.fp) || 0
    const tp = Number(r.tp) || 0
    const prec = (tp + fp) > 0 ? Number((tp / (tp + fp) * 100).toFixed(2)) : 0
    const tag = TAGS.find(t => t[0] === r.tag_id) || []
    const fpReason = fp > 0 ? FP_REASONS[fp % FP_REASONS.length] : ''
    return [r.tag_id, r.nm || tag[1] || '', total, fp, prec, 0, `行业=${tag[2] || ''}`, fpReason]
  })
  // 按精度升序排名（精度越低越值得关注）
  batch.sort((a, b) => a[4] - b[4])
  batch.forEach((r, i) => { r[5] = i + 1 })
  await pool.query(`INSERT INTO real_data_tags (tag_id, tag_name, total, fp, precision_val, rank_no, remark, fp_reason)
    VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`, batch.flat())
  console.log(`  插入 ${batch.length} 个标签`)

  // tags 表（部分页面使用）
  await pool.query('DELETE FROM tags')
  await pool.query(`INSERT INTO tags (id, name, precision_val, total, fp, rank_no)
    VALUES ${batch.map(() => '(?,?,?,?,?,?)').join(',')}`,
    batch.map(r => [r[0], r[1], r[4], r[2], r[3], r[5]]).flat())
  console.log(`  tags 表同步 ${batch.length} 条`)
}

// ========== 4. 结论沉淀库 sediments ==========
async function rebuildSediments() {
  console.log('\n[4/6] 重建 sediments ...')
  await pool.query('DELETE FROM sediment_updates')
  await pool.query('DELETE FROM sediments')

  const SED_TEMPLATES = [
    { title: '「免费领取」话术合规素材误判', type: '规则优化', category: 'FP', resultType: 'real_fp',
      feature: '素材含"免费领取"但为平台官方活动，无诱导行为', conclusion: '补充官方活动白名单，命中白名单素材直接放行',
      fpReason: '规则命中"免费领取"关键词，未识别官方活动资质' },
    { title: '医疗功效词在科普场景的误拦截', type: '模型优化', category: 'FP', resultType: 'real_fp',
      feature: '科普内容出现"治疗""缓解"等词，但无商业推广意图', conclusion: '增加科普语境识别分支，区分科普与推广',
      fpReason: '模型将科普语境的功效描述判为医疗推广' },
    { title: '美妆个护行业素材行业标签打错', type: '数据修正', category: 'OTHER', resultType: 'machine_right',
      feature: '素材实际为食品行业，行业标签误打为美妆个护', conclusion: '修正行业标签并回灌训练样本',
      fpReason: '行业标签错误导致误命中美妆个护策略' },
    { title: '短视频相似素材混淆导致误判', type: '模型优化', category: 'FP', resultType: 'real_fp',
      feature: '与违规素材高度相似但实际内容不同（不同字幕/结局）', conclusion: '提升相似检索阈值，增加字幕语义比对',
      fpReason: '相似检索召回过宽，仅凭画面相似判定' },
    { title: 'OCR 识别错误引发关键词误命中', type: '规则优化', category: 'OTHER', resultType: 'real_fp',
      feature: 'OCR 将"特惠"误识为"特惠购药"，命中药品违规词', conclusion: 'OCR 纠错词典补充，误识词加入排除表',
      fpReason: 'OCR 识别错误产生不存在的违规关键词' },
    { title: '游戏推广素材涉政元素误判', type: '规则优化', category: 'FP', resultType: 'real_fp',
      feature: '游戏场景背景出现国旗元素，被判涉政', conclusion: '区分"尊重展示"与"利用谋利"，背景元素降权',
      fpReason: '涉政规则未区分元素使用场景' },
    { title: '电商促销数字宣传夸大认定', type: '策略确认', category: 'OTHER', resultType: 'machine_right',
      feature: '宣传"销量第一"但无法提供证明，确属夸大', conclusion: '维持拦截，补充举证要求提示',
      fpReason: '确属虚假宣传，机器判断正确' },
    { title: '教育培训资质展示不合规', type: '策略确认', category: 'OTHER', resultType: 'machine_right',
      feature: '宣传"包过拿证"但机构无对应资质', conclusion: '维持拦截，同步至资质核查流程',
      fpReason: '确属违规承诺，机器判断正确' },
    { title: '金融产品收益承诺表述', type: '规则优化', category: 'FP', resultType: 'real_fp',
      feature: '展示历史收益率且附风险提示，属合规披露', conclusion: '增加风险提示共存判定，有提示则放行',
      fpReason: '规则仅检测收益数字，未识别风险提示' },
    { title: '珠宝材质描述与实物一致性', type: '数据修正', category: 'OTHER', resultType: 'machine_right',
      feature: '宣传"纯金"实际为镀金，确属材质造假', conclusion: '维持拦截并加入材质描述校验规则',
      fpReason: '确属虚假材质描述' },
  ]

  const SUBMITTERS = ['张三', '李四', '王五', '赵六', '孙七', '周八']
  const HANDLERS = ['张三', '李四', '王五', '赵六']
  const batch = []
  // 每个标签生成 3~5 条沉淀，覆盖 15 周时间跨度
  for (const [tagId, tagName, ind1, ind2] of TAGS) {
    const n = 3 + Math.floor(rand() * 3)
    for (let k = 0; k < n; k++) {
      const tpl = SED_TEMPLATES[(tagId + k) % SED_TEMPLATES.length]
      // adopted_at 分布在 15 周内
      const w = Math.floor(rand() * WEEKS.length)
      const dt = new Date(WEEKS[w] + 'T00:00:00')
      dt.setDate(dt.getDate() + Math.floor(rand() * 7))
      const adoptedAt = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(8 + Math.floor(rand() * 10)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00`
      const samples = 5 + Math.floor(rand() * 60)

      batch.push([
        `${tagName} - ${tpl.title}`, tpl.type, tpl.category, tpl.resultType,
        tagId, tagName, `${ind1},${ind2}`, ind1,
        SUBMITTERS[Math.floor(rand() * SUBMITTERS.length)],
        HANDLERS[Math.floor(rand() * HANDLERS.length)],
        adoptedAt, samples,
        `${ind1}行业下${tagName}标签的${tpl.title}问题`,
        tpl.feature, tpl.conclusion, tpl.fpReason,
        JSON.stringify([`https://example.com/ad/${tagId}_${w}.jpg`, `https://example.com/ad/${tagId}_${w}_2.jpg`]),
        `已同步至策略组，${tpl.type}已上线`,
        `SED${String(tagId).slice(-4)}${k}`, 0, ind1, ind2,
      ])
    }
  }

  const cols = `title, type, category, result_type, tag_id, tag_name, tags, industry,
    submitter, handler, adopted_at, samples, descr, feature, conclusion, fp_reason,
    related_materials, handle_info, ticket_id, is_demo, industry_l1, industry_l2`
  const placeholders = `(${new Array(cols.split(',').length).fill('?').join(',')})`
  for (let i = 0; i < batch.length; i += 100) {
    const part = batch.slice(i, i + 100)
    await pool.query(`INSERT INTO sediments (${cols}) VALUES ${part.map(() => placeholders).join(',')}`, part.flat())
  }
  const [[c]] = await pool.query('SELECT COUNT(*) c FROM sediments')
  console.log(`  插入 ${c} 条沉淀`)

  const [dist] = await pool.query('SELECT industry_l1, COUNT(*) c FROM sediments GROUP BY industry_l1 ORDER BY c DESC')
  console.log('  行业分布:')
  dist.forEach(r => console.log(`    ${r.industry_l1 || '(空)'} = ${r.c}`))

  // 沉淀更新记录
  const [seds] = await pool.query('SELECT id, adopted_at FROM sediments ORDER BY RAND() LIMIT 20')
  for (const s of seds) {
    const base = s.adopted_at ? String(s.adopted_at) : `${TODAY} 10:00:00`
    const atD = new Date(String(base).replace(' ', 'T'))
    atD.setDate(atD.getDate() + 3 + Math.floor(rand() * 10))
    const at = `${atD.getFullYear()}-${String(atD.getMonth() + 1).padStart(2, '0')}-${String(atD.getDate()).padStart(2, '0')} ${String(atD.getHours()).padStart(2, '0')}:${String(atD.getMinutes()).padStart(2, '0')}:00`
    await pool.query(`INSERT INTO sediment_updates (sediment_id, by_user, reason, at) VALUES (?,?,?,?)`,
      [s.id, HANDLERS[Math.floor(rand() * HANDLERS.length)], '策略已上线，效果观察中', at])
  }
  console.log(`  插入 ${seds.length} 条更新记录`)
}

// ========== 5. 聚类簇特征 cluster_features ==========
async function rebuildClusterFeatures() {
  console.log('\n[5/6] 重建 cluster_features ...')
  await pool.query('DELETE FROM cluster_features')
  const FEATURES = [
    '素材画面以文字为主，含促销价格信息',
    '视频前3秒出现人物口播，背景为室内场景',
    '图片含二维码或联系方式，引导站外转化',
    '文本素材含绝对化用语与功效承诺',
    '短视频含快速切换镜头与强节奏音乐',
  ]
  const OWNERS = ['张三', '李四', '王五', '赵六']
  // 与 real_data_samples.class_id / sample_library_fine_label.cluster_id 保持一致
  const batch = []
  for (const [tagId] of TAGS) {
    for (let c = 1; c <= 3; c++) {
      const classId = `CL${String(tagId).slice(-3)}${c}`
      batch.push([tagId, classId, `${FEATURES[(tagId + c) % FEATURES.length]}（簇 ${classId}）`, OWNERS[(tagId + c) % OWNERS.length]])
    }
  }
  await pool.query(`INSERT INTO cluster_features (tag_id, class_id, feature_summary, owner)
    VALUES ${batch.map(() => '(?,?,?,?)').join(',')}`, batch.flat())
  console.log(`  插入 ${batch.length} 条簇特征（${TAGS.length} 标签 × 3 簇）`)
}

// ========== 6. 聚类明细 cluster_data ==========
async function rebuildClusterData() {
  console.log('\n[6/6] 重建 cluster_data ...')
  await pool.query('DELETE FROM cluster_data')
  const batch = []
  for (const [tagId, tagName, ind1, ind2] of TAGS) {
    for (let c = 1; c <= 3; c++) {
      // 与 sample_library_fine_label 保持一致的簇 ID 格式（CLxxx）
      const classId = `CL${String(tagId).slice(-3)}${c}`
      const n = 4 + Math.floor(rand() * 5)
      for (let k = 0; k < n; k++) {
        const w = Math.floor(rand() * WEEKS.length)
        const dt = new Date(WEEKS[w] + 'T00:00:00')
        dt.setDate(dt.getDate() + Math.floor(rand() * 7))
        const arrive = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
        const [et] = ELEMENT_TYPES[(tagId + k) % 3]
        const isVideo = et === 'ELEMENT_TYPE_VIDEO'
        batch.push([
          arrive, et, String(tagId), rand() > 0.5 ? String(tagId) : '',
          `https://example.com/ad/${tagId}_${classId}_${k}.${isVideo ? 'mp4' : 'jpg'}`,
          `fp_${classId}_${k}`, classId,
        ])
      }
    }
  }
  await pool.query(`INSERT INTO cluster_data (arrive_time, element_type, policy_ids, ai_evaluate_policy_ids,
    element_value, element_fingerprint, class_id) VALUES ${batch.map(() => '(?,?,?,?,?,?,?)').join(',')}`, batch.flat())
  const [[c]] = await pool.query('SELECT COUNT(*) c FROM cluster_data')
  console.log(`  插入 ${c} 条聚类明细`)
}

// ========== 7. 聚类簇元素 sample_library_fine_label ==========
async function rebuildFineLabel() {
  console.log('\n[7/7] 重建 sample_library_fine_label ...')
  await pool.query('DELETE FROM sample_library_fine_label')

  const INDUSTRIES = ['电商服务', '医疗健康', '数字传媒内容', '游戏', '金融', '美妆个护', '软件工具', '服饰珠宝']
  const SUB_IND = ['子行业1', '子行业2', '子行业3', '子行业4']
  const UPLOADERS = ['zhangsan', 'lisi', 'wangwu', 'zhaoliu']
  const TYPES = ['图片', '视频', '文本', '落地页']
  const FINE_LABELS = ['侵权', '赌博', '诈骗', '低俗', '色情', '暴力', '违禁品', '虚假信息', '敏感内容', '恶意推广']

  // 每个标签 3 个簇（CL001~CL003 风格统一为 CLxxx），每簇 8~18 条元素
  const batch = []
  for (const [tagId, tagName, ind1, ind2] of TAGS) {
    for (let c = 1; c <= 3; c++) {
      const clusterId = `CL${String(tagId).slice(-3)}${c}`   // 形如 CL5991
      const n = 8 + Math.floor(rand() * 11)
      for (let k = 0; k < n; k++) {
        const w = Math.floor(rand() * WEEKS.length)
        const dt = new Date(WEEKS[w] + 'T00:00:00')
        dt.setDate(dt.getDate() + Math.floor(rand() * 7))
        const ds = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
        const type = TYPES[(tagId + k) % TYPES.length]
        const ext = type === '视频' ? 'mp4' : (type === '文本' ? 'txt' : 'jpg')
        const industry = INDUSTRIES[(tagId + k) % INDUSTRIES.length]
        // fine_labels 存「标签 ID 字符串」：badcase/clusters 用 JSON_CONTAINS(fine_labels, '"<labelId>"')
        // 按标签 ID 匹配；同时保留标签名便于人读（同一数组内混合 ID 与名称）
        const picks = [String(tagId), tagName]
        const extra = FINE_LABELS[Math.floor(rand() * FINE_LABELS.length)]
        if (extra !== tagName) picks.push(extra)

        batch.push([
          clusterId,
          `https://example.com/media/${clusterId}_${k}.${ext}`,
          `fp_${clusterId}_${k}`,
          type,
          JSON.stringify(picks),
          industry,
          SUB_IND[(tagId + k) % SUB_IND.length],
          UPLOADERS[(tagId + k) % UPLOADERS.length],
          `${ds} 10:00:00`,
          ds,
        ])
      }
    }
  }

  const cols = `cluster_id, element_value, element_fingerprint, element_type, fine_labels,
    first_level_industry_name, second_level_industry_name, uploader_id, uploaded_at, ds`
  const placeholders = `(${new Array(cols.split(',').length).fill('?').join(',')})`
  for (let i = 0; i < batch.length; i += 200) {
    const part = batch.slice(i, i + 200)
    await pool.query(`INSERT INTO sample_library_fine_label (${cols}) VALUES ${part.map(() => placeholders).join(',')}`, part.flat())
  }
  const [[c]] = await pool.query('SELECT COUNT(*) c FROM sample_library_fine_label')
  const [[cc]] = await pool.query('SELECT COUNT(DISTINCT cluster_id) c FROM sample_library_fine_label')
  console.log(`  插入 ${c} 条元素，共 ${cc} 个簇`)
}

// ========== 8. 样本明细主表 real_data_tag_precision_samples ==========
// 标签素材预览（/tags/:id/samples）优先查此表，为空才回退 real_data_samples。
// 从样本表同步 FP 样本（误杀素材）作为主表明细，保证预览页直接有数据。
async function rebuildPrecisionSamples() {
  console.log('\n[8/8] 重建 real_data_tag_precision_samples ...')
  await pool.query('DELETE FROM real_data_tag_precision_samples')
  const [rows] = await pool.query(`SELECT tag_id, tag_name, sample_id, element_type, is_video,
    machine_tag, human_tag, first_level_industry_name, second_level_industry_name,
    media_url, ocr_content, asr_content, advertiser, arrive_time, ds, is_fp, fp_reason,
    remark, class_num, class_id, reviewer_name, dc_id, ops_advertiser_name,
    element_fingerprint, ai_evaluate_reviewer_name, policy_ids, ai_evaluate_policy_ids, uid
    FROM real_data_samples WHERE is_fp = 1`)
  if (!rows.length) { console.log('  无 FP 样本，跳过'); return }

  const cols = `tag_id, tag_name, sample_id, element_type, is_video, machine_tag, human_tag,
    first_level_industry_name, second_level_industry_name, media_url, ocr_content, asr_content,
    advertiser, arrive_time, ds, is_fp, fp_reason, remark, class_num, class_id, reviewer_name,
    dc_id, ops_advertiser_name, element_fingerprint, ai_evaluate_reviewer_name,
    policy_ids, ai_evaluate_policy_ids, uid`
  const placeholders = `(${new Array(cols.split(',').length).fill('?').join(',')})`
  const batch = rows.map(r => cols.split(',').map(c => r[c.trim()] ?? ''))
  for (let i = 0; i < batch.length; i += 200) {
    const part = batch.slice(i, i + 200)
    await pool.query(`INSERT INTO real_data_tag_precision_samples (${cols}) VALUES ${part.map(() => placeholders).join(',')}`, part.flat())
  }
  console.log(`  插入 ${rows.length} 条 FP 明细`)
}

// ========== 执行 ==========
console.log('开始重建全平台 mock 数据...')
console.log(`目标周数: ${WEEKS.length}（${WEEKS[0]} ~ ${WEEKS[WEEKS.length - 1]}）`)
console.log(`目标曲线: ${PANEL_PREC.join(' → ')}`)

await rebuildPrecision()
await rebuildSamples()
await rebuildTags()
await rebuildSediments()
await rebuildClusterFeatures()
await rebuildClusterData()
await rebuildFineLabel()
await rebuildPrecisionSamples()

// ========== 最终校验 ==========
console.log('\n========== 最终校验 ==========')
let pass = true
function assert(cond, msg) {
  console.log(`${cond ? '✅' : '❌'} ${msg}`)
  if (!cond) pass = false
}

// 1. 大盘 15 周 + W1=50 + 前三周≤65 + 峰值80
const [panel] = await pool.query(`SELECT ds, ROUND(SUM(tp)/(SUM(tp)+SUM(fp))*100,1) prec
  FROM real_data_tag_precision GROUP BY ds ORDER BY ds`)
assert(panel.length === 15, `大盘周数 = 15（实际 ${panel.length}）`)
assert(Math.abs(Number(panel[0].prec) - 50) < 0.5, `W1 精度 = 50%（实际 ${panel[0].prec}%）`)
const first3 = panel.slice(0, 3)
assert(first3.every(r => Number(r.prec) <= 65), `前三周 ≤65%（实际 ${first3.map(r => r.prec).join('/')}）`)
const maxPrec = Math.max(...panel.map(r => Number(r.prec)))
assert(Math.abs(maxPrec - 80) < 0.5, `峰值精度 = 80%（实际 ${maxPrec}%）`)
// 高低错落：存在下降段
let downs = 0
for (let i = 1; i < panel.length; i++) if (Number(panel[i].prec) < Number(panel[i - 1].prec)) downs++
assert(downs >= 4, `趋势高低错落（下降段 ${downs} 处，要求 ≥4）`)

// 2. 每个标签 15 周 + 前三周≤65
const [tagCov] = await pool.query(`SELECT COUNT(*) bad FROM (
  SELECT tag_id, COUNT(DISTINCT ds) c FROM real_data_tag_precision GROUP BY tag_id HAVING c < 15) t`)
assert(Number(tagCov[0].bad) === 0, `每个标签均覆盖 15 周（异常 ${tagCov[0].bad} 个）`)

const [tagF3] = await pool.query(`SELECT COUNT(*) bad FROM (
  SELECT tag_id, ROUND(SUM(tp)/(SUM(tp)+SUM(fp))*100,1) p FROM real_data_tag_precision
  WHERE ds IN (?,?,?) GROUP BY tag_id HAVING p > 65) t`, WEEKS.slice(0, 3))
assert(Number(tagF3[0].bad) === 0, `每个标签前三周 ≤65%（超限 ${tagF3[0].bad} 个）`)

// 3. 每个标签都有 精度/样本/FP
const [noData] = await pool.query(`SELECT COUNT(*) bad FROM (
  SELECT tag_id FROM real_data_tag_precision GROUP BY tag_id
  HAVING SUM(total) = 0 OR SUM(fp) = 0) t`)
assert(Number(noData[0].bad) === 0, `每个标签均有样本数与 FP 数据（异常 ${noData[0].bad} 个）`)

// 4. 沉淀库
const [[sedCnt]] = await pool.query('SELECT COUNT(*) c FROM sediments')
const [[sedInd]] = await pool.query("SELECT COUNT(*) c FROM sediments WHERE industry_l1 IS NOT NULL AND industry_l1 != ''")
const [[sedTag]] = await pool.query('SELECT COUNT(*) c FROM sediments WHERE tag_id > 0')
const [[sedAdopt]] = await pool.query('SELECT COUNT(*) c FROM sediments WHERE adopted_at IS NOT NULL')
assert(Number(sedCnt.c) > 0, `沉淀库有数据（${sedCnt.c} 条）`)
assert(Number(sedInd.c) === Number(sedCnt.c), `沉淀均有一级行业（${sedInd.c}/${sedCnt.c}）`)
assert(Number(sedTag.c) === Number(sedCnt.c), `沉淀均关联标签（${sedTag.c}/${sedCnt.c}）`)
assert(Number(sedAdopt.c) === Number(sedCnt.c), `沉淀均有采纳时间（${sedAdopt.c}/${sedCnt.c}）`)

// 5. 样本表 15 周
const [smpWk] = await pool.query(`SELECT COUNT(DISTINCT YEARWEEK(arrive_time,1)) c FROM real_data_samples WHERE arrive_time IS NOT NULL AND arrive_time != ''`)
assert(Number(smpWk[0].c) === 15, `样本表覆盖 15 周（实际 ${smpWk[0].c}）`)

// 6. 簇特征
const [[cfCnt]] = await pool.query('SELECT COUNT(*) c FROM cluster_features')
assert(Number(cfCnt.c) > 0, `簇特征有数据（${cfCnt.c} 条）`)

// 7. 无孤儿标签：每个标签都有名称 + 样本明细 + 精度数据
const [orphanName] = await pool.query(`SELECT COUNT(*) bad FROM real_data_tags WHERE tag_name IS NULL OR tag_name = ''`)
assert(Number(orphanName[0].bad) === 0, `无空名称标签（异常 ${orphanName[0].bad} 个）`)

const [orphanSample] = await pool.query(`SELECT COUNT(*) bad FROM real_data_tags t
  LEFT JOIN real_data_samples s ON t.tag_id = s.tag_id
  GROUP BY t.tag_id HAVING COUNT(s.id) = 0`)
assert((orphanSample || []).length === 0, `每个标签都有样本明细（孤儿标签 ${(orphanSample || []).length} 个）`)

// 8. 聚类簇元素
const [[flCnt]] = await pool.query('SELECT COUNT(*) c FROM sample_library_fine_label')
const [[flCl]] = await pool.query('SELECT COUNT(DISTINCT cluster_id) c FROM sample_library_fine_label')
assert(Number(flCnt.c) > 0, `聚类簇元素有数据（${flCnt.c} 条 / ${flCl.c} 簇）`)

// 9. 聚类簇能按标签 ID 命中（badcase/clusters 用 JSON_CONTAINS 匹配 labelId）
const [hitOk] = await pool.query(`SELECT COUNT(*) c FROM sample_library_fine_label
  WHERE JSON_CONTAINS(fine_labels, ?)`, [JSON.stringify(String(TAGS[0][0]))])
assert(Number(hitOk[0].c) > 0, `聚类簇可按标签ID命中（${TAGS[0][0]} 命中 ${hitOk[0].c} 条）`)

// 10. 样本明细主表
const [[psCnt]] = await pool.query('SELECT COUNT(*) c FROM real_data_tag_precision_samples')
assert(Number(psCnt.c) > 0, `样本明细主表有数据（${psCnt.c} 条）`)

console.log(`\n${pass ? '🎉 全部校验通过' : '⚠️ 存在未通过项'}`)
await pool.end()
