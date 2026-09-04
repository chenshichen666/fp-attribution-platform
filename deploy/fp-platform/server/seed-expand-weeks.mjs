import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
});

const WEEK_STARTS = [
  '2026-05-25','2026-06-01','2026-06-08','2026-06-15','2026-06-22',
  '2026-06-29','2026-07-06','2026-07-13','2026-07-20','2026-07-27',
  '2026-08-03','2026-08-10','2026-08-17','2026-08-24','2026-08-31',
];

const TARGET_PAN_PREC = [
  50.0, 52.5, 55.0, 57.5, 60.0, 62.5, 65.0, 67.5, 70.0, 72.5,
  75.0, 77.5, 80.0, 78.5, 76.0,
];

async function main() {
  console.log('Step 1: Read existing rows (source pool from weeks 2026-06-15 ~ 2026-06-27)...');
  const [existing] = await pool.query(
    `SELECT evaluation_target_type, evaluation_target_type_name,
            first_level_industry_name, second_level_industry_name,
            element_type, element_type_name,
            policy_ids, ai_evaluate_policy_ids,
            element_value, dc_id, uid, uid_name, ops_advertiser_name,
            model_version, ai_evaluate_reviewer_name, element_fingerprint,
            ocr_content, asr_content, class_num, class_id
     FROM ai_evaluate_detail ORDER BY id`
  );
  console.log(`  Source rows: ${existing.length}`);

  console.log('\nStep 2: Clear existing data...');
  await pool.query('DELETE FROM ai_evaluate_detail');
  await pool.query('ALTER TABLE ai_evaluate_detail AUTO_INCREMENT = 1');
  console.log('  Cleared.');

  console.log('\nStep 3: Generate data for each of 15 weeks...');

  const BATCH = 2000;

  for (let wi = 0; wi < WEEK_STARTS.length; wi++) {
    const weekStart = WEEK_STARTS[wi];
    const targetPrec = TARGET_PAN_PREC[wi] / 100;

    const weekBase = new Date(weekStart + 'T00:00:00Z');
    const weekEnd = new Date(weekBase);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const perWeek = Math.round(existing.length * (0.85 + Math.random() * 0.3));
    const sampled = [];
    for (let i = 0; i < perWeek; i++) {
      sampled.push(existing[i % existing.length]);
    }

    const insertRows = [];
    for (let i = 0; i < sampled.length; i++) {
      const src = sampled[i];
      const dayOffset = Math.floor(Math.random() * 7);
      const arriveDate = new Date(weekBase);
      arriveDate.setDate(arriveDate.getDate() + dayOffset);
      const arriveDateStr = arriveDate.toISOString().slice(0, 10);
      const dsStr = arriveDateStr.replace(/-/g, '');

      let policyIds = src.policy_ids;
      let aiPolicyIds = src.ai_evaluate_policy_ids;
      const hasMachineHit = policyIds && policyIds !== '' && policyIds !== '[]';
      const hasHumanHit = aiPolicyIds && aiPolicyIds !== '' && aiPolicyIds !== '[]';

      const isFpOrig = hasMachineHit && !hasHumanHit;
      const rand = Math.random();

      if (isFpOrig) {
        if (rand < targetPrec) {
          aiPolicyIds = policyIds;
        }
      } else if (hasMachineHit && hasHumanHit) {
        if (rand > targetPrec) {
          aiPolicyIds = '[]';
        }
      }

      insertRows.push([
        src.evaluation_target_type, src.evaluation_target_type_name,
        src.first_level_industry_name, src.second_level_industry_name,
        src.element_type, src.element_type_name,
        policyIds, aiPolicyIds,
        src.element_value, src.dc_id, src.uid, src.uid_name, src.ops_advertiser_name,
        src.model_version, src.ai_evaluate_reviewer_name, src.element_fingerprint,
        dsStr, arriveDateStr,
        src.ocr_content, src.asr_content, src.class_num, src.class_id,
      ]);
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

    const [[verify]] = await pool.query(`
      SELECT COUNT(*) as cnt,
        SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
                  AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 1 ELSE 0 END) as fp,
        COUNT(*) as total
      FROM ai_evaluate_detail WHERE arrive_time >= ? AND arrive_time <= ?
    `, [weekStart, weekEnd.toISOString().slice(0, 10)]);

    const actualPrec = verify.total > 0 ? ((verify.total - Number(verify.fp)) / verify.total * 100).toFixed(1) : 0;
    console.log(`  ${weekStart} (W${wi + 1}): ${insertRows.length} rows, precision=${actualPrec}% (target=${(targetPrec * 100).toFixed(1)}%)`);
  }

  const [[finalCnt]] = await pool.query('SELECT COUNT(*) as cnt FROM ai_evaluate_detail');
  console.log(`\nTotal rows: ${finalCnt.cnt}`);

  const [indCheck] = await pool.query(`
    SELECT first_level_industry_name, COUNT(*) as c,
      ROUND(SUM(CASE WHEN (policy_ids IS NOT NULL AND policy_ids != '' AND policy_ids != '[]')
                AND (ai_evaluate_policy_ids IS NULL OR ai_evaluate_policy_ids = '' OR ai_evaluate_policy_ids = '[]') THEN 0 ELSE 1 END) / COUNT(*) * 100, 1) as prec
    FROM ai_evaluate_detail GROUP BY first_level_industry_name ORDER BY prec
  `);
  console.log('\n=== Industry precision ===');
  console.table(indCheck);

  await pool.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
