import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
});

// 参考图精度排行榜数据
const INDUSTRY_TARGETS = [
  { name: '数字传媒内容', prec: 79.6, fp: 37256, reject: 182583 },
  { name: '电商服务', prec: 82.4, fp: 53192, reject: 301845 },
  { name: '游戏', prec: 87.5, fp: 8559, reject: 68711 },
  { name: '教育', prec: 88.0, fp: 1075, reject: 8984 },
  { name: '通讯和IT服务', prec: 88.0, fp: 11191, reject: 93597 },
  { name: '医疗健康', prec: 88.5, fp: 104768, reject: 122812 },
  { name: '生活日用', prec: 90.2, fp: 4462, reject: 45387 },
  { name: '美妆个护', prec: 90.2, fp: 24662, reject: 252410 },
  { name: '食品饮料', prec: 94.8, fp: 6340, reject: 122272 },
];

// 参考图交叉分析热力图数据（行业 × 模态精度）
const CROSS_TARGETS = {
  '医疗健康': { '视频': { prec: 88.5, fp: 104768 }, '图片': { prec: 88.5, fp: 14500 }, '文本': { prec: 88.5, fp: 8500 }, '落地页': { prec: 88.5, fp: 5500 } },
  '电商服务': { '视频': { prec: 82.4, fp: 53192 }, '图片': { prec: 82.4, fp: 18000 }, '文本': { prec: 82.4, fp: 12000 }, '落地页': { prec: 82.4, fp: 8000 } },
  '数字传媒内容': { '视频': { prec: 76.7, fp: 32330 }, '图片': { prec: 88.8, fp: 4926 }, '文本': { prec: 79.6, fp: 12000 }, '落地页': { prec: 79.6, fp: 8000 } },
  '美妆个护': { '视频': { prec: 90.2, fp: 24662 }, '图片': { prec: 90.2, fp: 8000 }, '文本': { prec: 90.2, fp: 5000 }, '落地页': { prec: 90.2, fp: 3000 } },
  '通讯和IT服务': { '视频': { prec: 88.0, fp: 11191 }, '图片': { prec: 88.0, fp: 5000 }, '文本': { prec: 88.0, fp: 3000 }, '落地页': { prec: 88.0, fp: 2000 } },
  '游戏': { '视频': { prec: 88.5, fp: 7097 }, '图片': { prec: 79.3, fp: 1462 }, '文本': { prec: 87.5, fp: 3500 }, '落地页': { prec: 87.5, fp: 2000 } },
  '食品饮料': { '视频': { prec: 94.8, fp: 6340 }, '图片': { prec: 94.8, fp: 3000 }, '文本': { prec: 94.8, fp: 2000 }, '落地页': { prec: 94.8, fp: 1500 } },
  '生活日用': { '视频': { prec: 90.2, fp: 4462 }, '图片': { prec: 90.2, fp: 2000 }, '文本': { prec: 90.2, fp: 1500 }, '落地页': { prec: 90.2, fp: 1000 } },
  '教育': { '视频': { prec: 88.0, fp: 1075 }, '图片': { prec: 88.0, fp: 500 }, '文本': { prec: 88.0, fp: 300 }, '落地页': { prec: 88.0, fp: 200 } },
};

const EL_CODES = {
  '视频': 'ELEMENT_TYPE_VIDEO',
  '图片': 'ELEMENT_TYPE_IMAGE',
  '文本': 'ELEMENT_TYPE_TEXT',
  '落地页': 'ELEMENT_TYPE_URL',
};

const WEEK_STARTS = [
  '2026-05-25','2026-06-01','2026-06-08','2026-06-15','2026-06-22',
  '2026-06-29','2026-07-06','2026-07-13','2026-07-20','2026-07-27',
  '2026-08-03','2026-08-10','2026-08-17','2026-08-24','2026-08-31',
];

const TAG_TEMPLATES = [];
for (let i = 1; i <= 50; i++) { TAG_TEMPLATES.push(i); }

const ADVERTISERS = [
  '腾讯广告', '字节跳动', '阿里巴巴', '百度', '京东',
  '美团', '拼多多', '快手', '网易', '新浪',
  '小红书', '哔哩哔哩', '知乎', '得物', '唯品会',
];

function pickRandom(arr, min, max) {
  const n = min + Math.floor(Math.random() * (max - min + 1));
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

function generatePolicyIds() {
  const picked = pickRandom(TAG_TEMPLATES, 1, 5);
  return JSON.stringify(picked);
}

async function main() {
  console.log('=== Insert remaining industries: 美妆个护, 生活日用, 食品饮料 ===');
  
  const remaining = [
    { name: '美妆个护', data: CROSS_TARGETS['美妆个护'] },
    { name: '生活日用', data: CROSS_TARGETS['生活日用'] },
    { name: '食品饮料', data: CROSS_TARGETS['食品饮料'] },
  ];

  const BATCH = 5000;
  let totalRows = 0;

  for (const { name: indName, data: crossData } of remaining) {
    for (const [modality, target] of Object.entries(crossData)) {
      const elCode = EL_CODES[modality];
      if (!elCode) continue;

      const prec = target.prec;
      const fp = target.fp;
      const total = Math.round(fp / (1 - prec / 100));
      const perWeek = Math.ceil(total / WEEK_STARTS.length);
      let inserted = 0;

      console.log(`  ${indName} · ${modality}: total=${total} fp=${fp} prec=${prec}%`);

      for (let wi = 0; wi < WEEK_STARTS.length && inserted < total; wi++) {
        const weekStart = WEEK_STARTS[wi];
        const weekCount = Math.min(perWeek, total - inserted);
        
        const insertRows = [];
        for (let i = 0; i < weekCount; i++) {
          const dayOffset = Math.floor(Math.random() * 7);
          const arriveDate = new Date(weekStart + 'T00:00:00Z');
          arriveDate.setDate(arriveDate.getDate() + dayOffset);
          const arriveDateStr = arriveDate.toISOString().slice(0, 10);
          const dsStr = arriveDateStr.replace(/-/g, '');

          const isFp = (i < Math.round(weekCount * (1 - prec / 100)));
          const policyIds = generatePolicyIds();
          
          let aiPolicyIds;
          if (isFp) {
            aiPolicyIds = '[]';
          } else {
            if (Math.random() < 0.7) {
              aiPolicyIds = policyIds;
            } else {
              const parsed = JSON.parse(policyIds);
              const kept = parsed.slice(0, Math.max(1, Math.floor(parsed.length * 0.6)));
              aiPolicyIds = JSON.stringify(kept);
            }
          }

          const advertiser = ADVERTISERS[Math.floor(Math.random() * ADVERTISERS.length)];

          insertRows.push([
            1, '广告素材',
            indName, `${indName}二级`,
            elCode, modality,
            policyIds, aiPolicyIds,
            `https://example.com/media/${indName}/${modality}/${i}.jpg`,
            `dc_${indName}_${modality}_${i}`, `uid_${Math.floor(Math.random() * 1000)}`,
            `用户${Math.floor(Math.random() * 100)}`, advertiser,
            'v1.0', `审核员${Math.floor(Math.random() * 50)}`,
            `fp_${indName}_${modality}_${i}`,
            dsStr, arriveDateStr,
            `OCR内容_${indName}_${modality}_${i}`,
            `ASR内容_${indName}_${modality}_${i}`,
            Math.floor(Math.random() * 20) + 1,
            `c${Math.floor(Math.random() * 12) + 1}`,
          ]);
          inserted++;
        }

        for (let b = 0; b < insertRows.length; b += BATCH) {
          const batch = insertRows.slice(b, b + BATCH);
          const placeholders = batch.map(() =>
            '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).join(',');
          const flat = batch.flat();
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
            flat
          );
        }
        totalRows += insertRows.length;
      }
    }
  }

  console.log(`\n=== Inserted ${totalRows} rows ===`);

  // 验证
  console.log('\n=== Verification ===');
  const [indCheck] = await pool.query(`
    SELECT first_level_industry_name, COUNT(*) as total,
      SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
                AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 1 ELSE 0 END) as fp
    FROM ai_evaluate_detail GROUP BY first_level_industry_name ORDER BY total DESC
  `);
  indCheck.forEach(r => {
    const prec = r.total > 0 ? ((r.total - Number(r.fp)) / r.total * 100).toFixed(1) : 0;
    const target = INDUSTRY_TARGETS.find(t => t.name === r.first_level_industry_name);
    const targetStr = target ? `(target: ${target.prec}%)` : '';
    console.log(`  ${r.first_level_industry_name}: total=${r.total} fp=${Number(r.fp)} prec=${prec}% ${targetStr}`);
  });

  const [[cnt]] = await pool.query('SELECT COUNT(*) AS c FROM ai_evaluate_detail');
  console.log(`\nTotal rows: ${cnt.c}`);

  await pool.end();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
