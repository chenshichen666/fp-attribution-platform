import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
});

// 截图中每个行业的目标数据
const INDUSTRY_TARGETS = [
  { name: '金融',           fp: 375,  reject: 834 },
  { name: '家装建材',       fp: 237,  reject: 562 },
  { name: '数字传媒内容',   fp: 7842, reject: 21708 },
  { name: '游戏',           fp: 4066, reject: 12166 },
  { name: '食品饮料',       fp: 1000, reject: 3288 },
  { name: '电商服务',       fp: 3831, reject: 13288 },
  { name: '服饰珠宝',       fp: 240,  reject: 872 },
  { name: '生活日用',       fp: 581,  reject: 2186 },
  { name: '汽车',           fp: 420,  reject: 1580 },
  { name: '美妆个护',       fp: 2715, reject: 10570 },
  { name: '教育',           fp: 199,  reject: 778 },
  { name: '医疗健康',       fp: 4077, reject: 19732 },
  { name: '通讯和IT服务',   fp: 369,  reject: 4018 },
];

// 15 周时间范围
const WEEK_STARTS = [
  '2026-05-25','2026-06-01','2026-06-08','2026-06-15','2026-06-22',
  '2026-06-29','2026-07-06','2026-07-13','2026-07-20','2026-07-27',
  '2026-08-03','2026-08-10','2026-08-17','2026-08-24','2026-08-31',
];

// 每周的大盘精度目标（从之前设定的趋势曲线）
const WEEK_PAN_PREC = [
  42.0, 46.5, 55.4, 56.2, 63.0, 52.8, 58.0, 63.7, 65.2, 66.1,
  73.5, 72.2, 69.2, 73.0, 75.3,
];

async function main() {
  console.log('Step 1: Read source rows per industry...');
  
  // 对每个行业，读取现有数据中该行业的去重样本模板
  const sourceByIndustry = {};
  for (const t of INDUSTRY_TARGETS) {
    const [rows] = await pool.query(
      `SELECT evaluation_target_type, evaluation_target_type_name,
              first_level_industry_name, second_level_industry_name,
              element_type, element_type_name,
              policy_ids, ai_evaluate_policy_ids,
              element_value, dc_id, uid, uid_name, ops_advertiser_name,
              model_version, ai_evaluate_reviewer_name, element_fingerprint,
              ocr_content, asr_content, class_num, class_id
       FROM ai_evaluate_detail
       WHERE first_level_industry_name = ?
       LIMIT ?`,
      [t.name, t.reject]
    );
    sourceByIndustry[t.name] = rows;
    console.log(`  ${t.name}: ${rows.length} source rows (need ${t.reject})`);
  }

  console.log('\nStep 2: Clear and rebuild...');
  await pool.query('DELETE FROM ai_evaluate_detail');
  await pool.query('ALTER TABLE ai_evaluate_detail AUTO_INCREMENT = 1');

  console.log('\nStep 3: Insert per-industry, distributed across 15 weeks...');
  const BATCH = 2000;

  for (const target of INDUSTRY_TARGETS) {
    const src = sourceByIndustry[target.name];
    if (!src.length) { console.log(`  SKIP ${target.name}: no source`); continue; }

    const totalNeeded = target.reject;
    const fpNeeded = target.fp;
    const fpRate = fpNeeded / totalNeeded;

    // 均匀分配到15周，但带随机波动让每周数量不同
    const weekWeights = WEEK_STARTS.map(() => 0.8 + Math.random() * 0.4);
    const wSum = weekWeights.reduce((a, b) => a + b, 0);
    const weekCounts = weekWeights.map(w => Math.round(totalNeeded * w / wSum));
    // 修正总量
    const diff = totalNeeded - weekCounts.reduce((a, b) => a + b, 0);
    weekCounts[weekCounts.length - 1] += diff;

    const insertRows = [];

    for (let wi = 0; wi < WEEK_STARTS.length; wi++) {
      const weekStart = WEEK_STARTS[wi];
      const weekBase = new Date(weekStart + 'T00:00:00Z');
      const cnt = weekCounts[wi];

      // 每周的FP比例根据周精度目标做调整
      // 总体fpRate是行业整体的，但每周略有波动
      const weekTargetPrec = WEEK_PAN_PREC[wi] / 100;
      // 行业的基础精度
      const basePrec = 1 - fpRate;
      // 每周的FP调整因子：让低精度周FP更多，高精度周FP更少
      const weekFpRate = Math.max(0.02, Math.min(0.95, fpRate * (1 + (basePrec - weekTargetPrec) * 0.5)));

      for (let i = 0; i < cnt; i++) {
        const s = src[i % src.length];
        const dayOffset = Math.floor(Math.random() * 7);
        const arriveDate = new Date(weekBase);
        arriveDate.setDate(arriveDate.getDate() + dayOffset);
        const arriveDateStr = arriveDate.toISOString().slice(0, 10);
        const dsStr = arriveDateStr.replace(/-/g, '');

        let policyIds = s.policy_ids;
        let aiPolicyIds = s.ai_evaluate_policy_ids;

        // 如果 policy_ids 为空或 '[]'，给一个标签
        if (!policyIds || policyIds === '' || policyIds === '[]') {
          policyIds = '[14662]';
        }

        // 随机决定是否为FP
        const isFp = Math.random() < weekFpRate;
        if (isFp) {
          aiPolicyIds = '[]';
        } else {
          aiPolicyIds = policyIds;
        }

        insertRows.push([
          s.evaluation_target_type, s.evaluation_target_type_name,
          s.first_level_industry_name, s.second_level_industry_name,
          s.element_type, s.element_type_name,
          policyIds, aiPolicyIds,
          s.element_value, s.dc_id, s.uid, s.uid_name, s.ops_advertiser_name,
          s.model_version, s.ai_evaluate_reviewer_name, s.element_fingerprint,
          dsStr, arriveDateStr,
          s.ocr_content, s.asr_content, s.class_num, s.class_id,
        ]);
      }
    }

    // Batch insert
    for (let b = 0; b < insertRows.length; b += BATCH) {
      const batch = insertRows.slice(b, b + BATCH);
      const placeholders = batch.map(() =>
        '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).join(',');
      await pool.query(
        `INSERT INTO ai_evaluate_detail
         (evaluation_target_type, evaluation_target_type_name,
          first_level_industry_name, second_level_industry_name,
          element_type, element_type_name,
          policy_ids, ai_evaluate_policy_ids,
          element_value, dc_id, uid, uid_name, ops_advertiser_name,
          model_version, ai_evaluate_reviewer_name, element_fingerprint,
          ds, arrive_time,
          ocr_content, asr_content, class_num, class_id)
         VALUES ${placeholders}`,
        batch.flat()
      );
    }

    // Verify
    const [[v]] = await pool.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
                  AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 1 ELSE 0 END) as fp
      FROM ai_evaluate_detail WHERE first_level_industry_name = ?
    `, [target.name]);
    const prec = v.total > 0 ? ((v.total - Number(v.fp)) / v.total * 100).toFixed(1) : 0;
    console.log(`  ${target.name}: total=${v.total} (target=${target.reject}) fp=${v.fp} (target=${target.fp}) prec=${prec}%`);
  }

  // Step 4: 微调各行业FP数量，精确匹配截图
  console.log('\nStep 4: Fine-tune FP to match exact screenshot values...');
  for (const target of INDUSTRY_TARGETS) {
    const [[curr]] = await pool.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
                  AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 1 ELSE 0 END) as fp
      FROM ai_evaluate_detail WHERE first_level_industry_name = ?
    `, [target.name]);
    
    const currentFp = Number(curr.fp);
    const targetFp = target.fp;
    const diff = currentFp - targetFp;
    
    if (diff > 0) {
      // Need to reduce FP: flip some FP rows to TP
      const [fpRows] = await pool.query(`
        SELECT id FROM ai_evaluate_detail 
        WHERE first_level_industry_name = ?
          AND (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
          AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]')
        LIMIT ?
      `, [target.name, diff]);
      if (fpRows.length > 0) {
        const ids = fpRows.map(r => r.id);
        for (let b = 0; b < ids.length; b += 5000) {
          const batch = ids.slice(b, b + 5000);
          await pool.query(
            `UPDATE ai_evaluate_detail SET ai_evaluate_policy_ids = policy_ids WHERE id IN (${batch.join(',')})`
          );
        }
      }
    } else if (diff < 0) {
      // Need to increase FP: flip some TP rows to FP
      const [tpRows] = await pool.query(`
        SELECT id FROM ai_evaluate_detail 
        WHERE first_level_industry_name = ?
          AND (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
          AND (ai_evaluate_policy_ids IS NOT NULL AND ai_evaluate_policy_ids != '' AND ai_evaluate_policy_ids != '[]')
        LIMIT ?
      `, [target.name, Math.abs(diff)]);
      if (tpRows.length > 0) {
        const ids = tpRows.map(r => r.id);
        for (let b = 0; b < ids.length; b += 5000) {
          const batch = ids.slice(b, b + 5000);
          await pool.query(
            `UPDATE ai_evaluate_detail SET ai_evaluate_policy_ids = '[]' WHERE id IN (${batch.join(',')})`
          );
        }
      }
    }
    
    // Final verify
    const [[final]] = await pool.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
                  AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 1 ELSE 0 END) as fp
      FROM ai_evaluate_detail WHERE first_level_industry_name = ?
    `, [target.name]);
    const finalPrec = final.total > 0 ? ((final.total - Number(final.fp)) / final.total * 100).toFixed(1) : 0;
    console.log(`  ${target.name}: total=${final.total} fp=${final.fp} prec=${finalPrec}% (target: ${target.reject}/${target.fp})`);
  }

  // Overall stats
  const [[overall]] = await pool.query(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
                AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 1 ELSE 0 END) as fp
    FROM ai_evaluate_detail
  `);
  console.log(`\nOverall: total=${overall.total} fp=${overall.fp} prec=${((overall.total - Number(overall.fp)) / overall.total * 100).toFixed(1)}%`);

  // Weekly trend check
  console.log('\n=== Weekly trend ===');
  const [weeklyData] = await pool.query(`
    SELECT 
      CASE 
        WHEN arrive_time >= '2026-05-25' AND arrive_time < '2026-06-01' THEN 'W1'
        WHEN arrive_time >= '2026-06-01' AND arrive_time < '2026-06-08' THEN 'W2'
        WHEN arrive_time >= '2026-06-08' AND arrive_time < '2026-06-15' THEN 'W3'
        WHEN arrive_time >= '2026-06-15' AND arrive_time < '2026-06-22' THEN 'W4'
        WHEN arrive_time >= '2026-06-22' AND arrive_time < '2026-06-29' THEN 'W5'
        WHEN arrive_time >= '2026-06-29' AND arrive_time < '2026-07-06' THEN 'W6'
        WHEN arrive_time >= '2026-07-06' AND arrive_time < '2026-07-13' THEN 'W7'
        WHEN arrive_time >= '2026-07-13' AND arrive_time < '2026-07-20' THEN 'W8'
        WHEN arrive_time >= '2026-07-20' AND arrive_time < '2026-07-27' THEN 'W9'
        WHEN arrive_time >= '2026-07-27' AND arrive_time < '2026-08-03' THEN 'W10'
        WHEN arrive_time >= '2026-08-03' AND arrive_time < '2026-08-10' THEN 'W11'
        WHEN arrive_time >= '2026-08-10' AND arrive_time < '2026-08-17' THEN 'W12'
        WHEN arrive_time >= '2026-08-17' AND arrive_time < '2026-08-24' THEN 'W13'
        WHEN arrive_time >= '2026-08-24' AND arrive_time < '2026-08-31' THEN 'W14'
        WHEN arrive_time >= '2026-08-31' THEN 'W15'
      END as week,
      COUNT(*) as total,
      SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
                AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 1 ELSE 0 END) as fp
    FROM ai_evaluate_detail
    GROUP BY week ORDER BY week
  `);
  for (const w of weeklyData) {
    const prec = w.total > 0 ? ((w.total - Number(w.fp)) / w.total * 100).toFixed(1) : 0;
    console.log(`  ${w.week}: total=${w.total} fp=${w.fp} prec=${prec}%`);
  }

  await pool.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
