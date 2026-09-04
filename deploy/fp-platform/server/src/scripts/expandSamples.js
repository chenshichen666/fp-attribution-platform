/**
 * expandSamples.js — 生成样本明细表（30 标签 × 2 簇 = 60 个聚类簇）
 *
 * 【规模】
 *   标签 30 个 × 每标签 2 个创意簇 × 每簇 70 条 = 4200 条样本
 *   聚类簇总数 = 30 × 2 = 60（与用户要求一致）
 *
 * 【为什么需要足够样本量】
 * 曾用 200 条样本，按周聚合后仅约 50 条/周，出现「大盘 83.7% / 绝对 100%」的失真值
 * （两线差 16pp）。扩充到数千条后，周聚合波动降到 1~3pp，统计口径才稳定可信。
 *
 * 【合规】
 * 素材文案取自 tagCatalog 的合规商业文案库；分析对象是「误杀」= 正常素材被误判，
 * 因此样本内容本就应当是合规的正常商业内容。
 *
 * 【依赖】标签体系统一取自 tagCatalog.js
 *
 * 用法：node src/scripts/expandSamples.js
 */

import { db } from '../db/pool.js'
import {
  TAGS, CREATIVE_LIBRARY, INDUSTRY, ELEMENT_TYPES, REVIEWERS,
  TARGET_CLUSTERS, clustersForTag,
  randInt, rnd, pick, resetSeed, toDateStr, weekStartOf,
} from './tagCatalog.js'

// ===== 规模配置 =====
// 簇总数与每标签簇数分配统一取自 tagCatalog（TARGET_CLUSTERS = 500）
// 公共 CC0 示例视频（Google gtv-videos-bucket，稳定可直连）
const VIDEO_SAMPLES = ['ForBiggerBlazes','ForBiggerEscapes','ForBiggerFun','ForBiggerJoyrides','ForBiggerMeltdowns']

const PER_CLUSTER = 30        // 每簇素材条数 → 500 × 30 = 15000 条样本
const TOTAL_WEEKS = 13        // 与精度表一致（13 周）

// ===== 簇文本生成 =====
// 每标签只有 2~4 条基础文案，要生成 17 个簇，必须靠「前缀变体」派生。
// 前缀集合长度 ≥ 单标签最大簇数(17)，保证同一标签内各簇前缀互不相同 → 文本可区分。
const CLUSTER_PREFIX = [
  '', '限时！', '【官方】', '热推·', '🔥', '独家·', '重磅！',
  '新品·', '会员·', '专享·', '爆款·', '特惠·', '直供·',
  '甄选·', '人气·', '推荐·', '热门·',
]
// 簇内轻微扰动：同簇素材不完全一致，使相似检索有层次（同簇 ~0.9，而非恒为 1.0）
const CLUSTER_TAIL = ['', ' 现货发售', ' 详情进店', ' 欢迎选购', ' 支持退换']

/**
 * 生成某簇第 k 条素材的文本
 * @param phrase 基础文案
 * @param ci 簇索引（决定前缀，同簇共享）
 * @param k 簇内序号（决定尾部扰动）
 */
function makeClusterText(phrase, ci, k) {
  const p = CLUSTER_PREFIX[ci % CLUSTER_PREFIX.length]
  const t = CLUSTER_TAIL[k % CLUSTER_TAIL.length]
  return `${p}${phrase}${t}`.trim()
}

// 生成「最近 n 周」覆盖的全部日期：从 n-1 周前的周一，到今天。
// 与精度表的周范围严格对齐，避免边界周取不到对应精度而回退到整体均值。
function dateRangeByWeeks(n) {
  const out = []
  const today = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const start = new Date(monday)
  start.setDate(monday.getDate() - (n - 1) * 7)
  const d = new Date(start)
  while (d <= today) {
    out.push(toDateStr(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

function run() {
  resetSeed(20260903)
  console.log('==> 开始生成样本明细表（30 标签 / 60 聚类簇）...')

  // 其他标签 ID 池：用于簇内机审标签的混合命中，避免命中率恒为 100%
  const OTHER_TAG_IDS = TAGS.map(([id]) => id)

  const dsList = dateRangeByWeeks(TOTAL_WEEKS)

  // 各「标签 × 周」的目标误杀率（来自精度表）
  //
  // 关键：必须按 (tag, 周) 而非按 tag 整体配额。
  // 若按标签整体配额，样本的 arrive_time 随机分布后，
  // 按周聚合出来的精度不体现时间趋势。
  // 注意精度表的 ds 语义是「周起始日」（周一），因此这里把样本日期
  // 先归到所属周，再用该周的误杀率抽样。
  const statByTagWeek = new Map() // tagId -> { weekStart -> {fpRate, confRatio} }
  for (const [tagId] of TAGS) {
    const rows = db.prepare(`
      SELECT ds, SUM(tp) tp, SUM(fp) fp, SUM(fp_conf) fc
      FROM real_data_tag_precision WHERE tag_id = ? GROUP BY ds
    `).all(tagId)
    const byWeek = {}
    let sumTp = 0, sumFp = 0, sumFc = 0
    for (const r of rows) {
      const tp = Number(r.tp) || 0
      const fp = Number(r.fp) || 0
      const fc = Number(r.fc) || 0
      sumTp += tp; sumFp += fp; sumFc += fc
      byWeek[r.ds] = {
        fpRate: tp + fp > 0 ? fp / (tp + fp) : 0.35,
        confRatio: fp > 0 ? fc / fp : 0.9,
      }
    }
    statByTagWeek.set(tagId, {
      byWeek,
      overall: {
        fpRate: sumTp + sumFp > 0 ? sumFp / (sumTp + sumFp) : 0.35,
        confRatio: sumFp > 0 ? sumFc / sumFp : 0.9,
      },
    })
  }

  // 日期 → 所属周（周一）
  const weekOf = new Map()
  for (const ds of dsList) {
    weekOf.set(ds, weekStartOf(ds))
  }

  // 清空重建
  const cols = db.pragma('table_info("real_data_samples")').map((c) => c.name)
  const hasFpConfirmed = cols.includes('fp_confirmed')
  try {
    const n = db.prepare('DELETE FROM real_data_samples').run()
    console.log(`    已清空原有 ${n.changes} 条样本`)
  } catch (e) {
    console.error('    清空失败:', e.message); return
  }

  const sql = hasFpConfirmed
    ? `INSERT INTO real_data_samples (
         tag_id, tag_name, sample_id, element_fingerprint, dc_id, element_type, is_video,
         policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name,
         media_url, ocr_content, asr_content, class_num, class_id, uid, ops_advertiser_name,
         ai_evaluate_reviewer_name, arrive_time, ds, is_fp, fp_confirmed, fp_reason, remark
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    : `INSERT INTO real_data_samples (
         tag_id, tag_name, sample_id, element_fingerprint, dc_id, element_type, is_video,
         policy_ids, ai_evaluate_policy_ids, first_level_industry_name, second_level_industry_name,
         media_url, ocr_content, asr_content, class_num, class_id, uid, ops_advertiser_name,
         ai_evaluate_reviewer_name, arrive_time, ds, is_fp, fp_reason, remark
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  const insert = db.prepare(sql)

  let total = 0
  let clusterCount = 0
  const tx = db.transaction(() => {
    for (const [tagIdx, [tagId, tagName, defInd1, defInd2]] of TAGS.entries()) {
      const creatives = CREATIVE_LIBRARY[tagName] || ['通用商品宣传素材', '品牌活动推广素材']
      const stat = statByTagWeek.get(tagId) || { byWeek: {}, overall: { fpRate: 0.35, confRatio: 0.9 } }

      // 该标签全部样本：clustersForTag 个簇 × PER_CLUSTER 条（先不分配 ds）
      // 簇文本 = 基础文案 + 簇前缀（同簇共享）+ 簇内尾部扰动
      const nClusters = clustersForTag(tagIdx)
      const bucket = []
      for (let ci = 0; ci < nClusters; ci++) {
        clusterCount++
        const phrase = creatives[ci % creatives.length]
        for (let k = 0; k < PER_CLUSTER; k++) {
          bucket.push({ ci, k, text: makeClusterText(phrase, ci, k) })
        }
      }

      // 打乱，避免误杀集中在某些簇
      for (let i = bucket.length - 1; i > 0; i--) {
        const j = randInt(0, i)
        ;[bucket[i], bucket[j]] = [bucket[j], bucket[i]]
      }

      // 先给每条样本分配日期（均匀铺满 84 天）
      for (let i = 0; i < bucket.length; i++) {
        bucket[i].ds = dsList[i % dsList.length]
      }

      // 按 (tag, ds) 的真实误杀率做概率抽样
      //
      // 为什么不用「分组精确配额」：4200 条 ÷ (30 标签 × 84 天) ≈ 1.7 条/组，
      // 配额取整会把每组推成全 0 或全 1，实测周波动高达 50pp。
      // 改用概率抽样后，单条无偏、周聚合样本量约 350 条，
      // 二项分布标准差约 2.5pp，趋势与波动都在可接受范围。
      const fpFlag = new Array(bucket.length).fill(0)
      const confFlag = new Array(bucket.length).fill(0)
      for (let i = 0; i < bucket.length; i++) {
        const st = stat.byWeek[weekOf.get(bucket[i].ds)] || stat.overall
        if (rnd() < st.fpRate) {
          fpFlag[i] = 1
          // 确认误杀是误杀的子集：仅在已判误杀的样本中按确认比例抽样
          if (rnd() < st.confRatio) confFlag[i] = 1
        }
      }

      for (let i = 0; i < bucket.length; i++) {
        const { ci, k, text, ds } = bucket[i]
        const elIdx = randInt(0, ELEMENT_TYPES.length - 1)
        const [elType] = ELEMENT_TYPES[elIdx]
        const isVideo = elType === 'ELEMENT_TYPE_VIDEO' ? 1 : 0
        const classId = `c_${tagId}_${String(ci + 1).padStart(2, '0')}`
        const variant = text
        const arriveTime = `${ds} ${String(randInt(0, 23)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00`
        // 一半用标签自带行业，一半轮转，保证行业维度有分布
        const [ind1, ind2] = (i % 2 === 0)
          ? [defInd1, defInd2]
          : INDUSTRY[randInt(0, INDUSTRY.length - 1)]

        const isFp = fpFlag[i]
        const fpConfirmed = confFlag[i]

        // ===== 机审 / 人审标签建模 =====
        //
        // 早期版本把 policy_ids 与 ai_evaluate_policy_ids 都设为 tagId，
        // 导致任意簇对任意标签都是「机审 100% / 人审 100%」，
        // 四象限图所有点全挤在「双高」象限，完全失去分析价值。
        //
        // 正确建模（也是「误杀」的定义）：
        //   误杀 FP = 机审命中、人审未命中
        // 因此：
        //   - 机审：以本簇标签为主（~72%），混入少量其他标签（模拟同批素材被不同策略命中）
        //   - 人审：误杀样本人审不命中（空）；非误杀样本多数被确认命中，少量留待复核
        const isSelfTag = rnd() < 0.72
        const machineTag = isSelfTag ? tagId : OTHER_TAG_IDS[randInt(0, OTHER_TAG_IDS.length - 1)]
        let humanTag = ''
        if (isFp) {
          humanTag = ''                      // 机审命中 + 人审未命中 = 误杀
        } else if (rnd() < 0.88) {
          humanTag = machineTag              // 人审确认命中
        }                                     // 其余留空 = 待复核

        const base = [
          tagId, tagName, `S-${tagId}-${ci + 1}-${k + 1}`,
          `fp_${tagId}_${ci}_${k}_${randInt(10000, 99999)}`,
          `DC-${randInt(1000, 9999)}`, elType, isVideo,
          String(machineTag), String(humanTag),
          ind1, ind2,
          // 公共 CC0 占位资源（无隐私内容，外网可直接访问）：
          //   图片 picsum.photos —— seed 取自素材指纹，同一素材永远同一张图
          //   视频 Google 公共示例桶（gtv-videos-bucket），轮转 5 个短片
          isVideo
            ? `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/${VIDEO_SAMPLES[(tagId + ci + k) % VIDEO_SAMPLES.length]}.mp4`
            : `https://picsum.photos/seed/${tagId}-${ci}-${k}/400/300`,
          isVideo ? '' : variant,
          isVideo ? variant : '',
          ci, classId, `uid_${randInt(10000, 99999)}`,
          `广告主_${randInt(1, 50)}`, pick(REVIEWERS),
          arriveTime, ds, isFp,
        ]
        const tail = hasFpConfirmed ? [fpConfirmed, '', ''] : ['', '']
        insert.run(...base, ...tail)
        total++
      }
    }
  })
  tx()

  console.log(`    已生成 ${total} 条样本，覆盖 ${clusterCount} 个聚类簇`)

  // ===== 自检 =====
  const s = db.prepare('SELECT COUNT(*) n, SUM(is_fp) fp, SUM(COALESCE(fp_confirmed,0)) fc FROM real_data_samples').get()
  const clusters = db.prepare('SELECT COUNT(DISTINCT class_id) c FROM real_data_samples').get()
  const tags = db.prepare('SELECT COUNT(DISTINCT tag_id) c FROM real_data_samples').get()

  console.log('\n==> 自检')
  console.log(`    样本总数  : ${s.n}`)
  console.log(`    标签数    : ${tags.c}   （要求 ${TAGS.length}）`)
  console.log(`    聚类簇数  : ${clusters.c}   （要求 ${TARGET_CLUSTERS}）`)
  console.log(`    样本表精度: ${((s.n - s.fp) / s.n * 100).toFixed(1)}%`)
  console.log(`    样本表绝对: ${((s.n - s.fc) / s.n * 100).toFixed(1)}%`)

  // 周度趋势
  // 注意：极差同时包含「趋势跨度」与「噪声」，不能当作波动指标。
  // 真正要衡量的是去掉趋势后的残差 —— 这里用相邻周差值的标准差。
  const weekRows = db.prepare(`
    SELECT ds, COUNT(*) n, SUM(is_fp) fp, SUM(COALESCE(fp_confirmed,0)) fc
    FROM real_data_samples GROUP BY ds ORDER BY ds
  `).all()
  const weekMap = new Map()
  for (const r of weekRows) {
    if (!r.ds) continue
    const wk = weekStartOf(r.ds)
    if (!weekMap.has(wk)) weekMap.set(wk, { n: 0, fp: 0, fc: 0 })
    const w = weekMap.get(wk)
    w.n += r.n; w.fp += r.fp; w.fc += r.fc
  }
  const wkList = [...weekMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const pans = wkList.map(([, w]) => (w.n - w.fp) / w.n * 100)
  const abss = wkList.map(([, w]) => (w.n - w.fc) / w.n * 100)

  // 去趋势残差：实际值 - 线性拟合值
  const nW = pans.length
  const meanX = (nW - 1) / 2
  const meanY = pans.reduce((a, b) => a + b, 0) / nW
  let num = 0, den = 0
  pans.forEach((y, x) => { num += (x - meanX) * (y - meanY); den += (x - meanX) ** 2 })
  const slope = den ? num / den : 0
  const resid = pans.map((y, x) => y - (meanY + slope * (x - meanX)))
  const residStd = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / (nW || 1))

  const drops = pans.filter((v, i) => i > 0 && v < pans[i - 1]).length
  const gaps = pans.map((v, i) => Math.abs(v - abss[i]))

  console.log(`    周趋势      : ${pans[0].toFixed(1)}% → ${pans[nW - 1].toFixed(1)}%  （要求 ~50% → ~80%）`)
  console.log(`    回落次数    : ${drops} 次（>0 表示有波动，非单调）`)
  console.log(`    去趋势残差  : ${residStd.toFixed(2)}pp（越小趋势越平滑）`)
  console.log(`    周度两线差  : 平均 ${(gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1)).toFixed(2)}pp / 最大 ${Math.max(...gaps).toFixed(2)}pp`)
  const minAll = Math.min(...pans, ...abss), maxAll = Math.max(...pans, ...abss)
  console.log(`    取值区间    : [${minAll.toFixed(1)}%, ${maxAll.toFixed(1)}%]  ${minAll > 5 && maxAll < 95 ? '✅ 无 0%/100%' : '❌ 出现极端值'}`)
}

run()
