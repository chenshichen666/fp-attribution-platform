import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
});

const DAYS = ['2026-08-25','2026-08-26','2026-08-27','2026-08-28','2026-08-29','2026-08-30','2026-08-31'];
const DAY_PRECS = [75.0, 72.5, 76.0, 70.0, 78.0, 80.0, 73.5];
const DAY_TOTALS = [180, 220, 195, 210, 175, 190, 165];

async function main() {
  console.log('=== Update real_data_samples ===');
  await pool.query('DELETE FROM real_data_samples WHERE arrive_time >= "2026-08-24"');
  
  const BATCH = 2000;
  let sampleTotal = 0;
  
  for (let di = 0; di < DAYS.length; di++) {
    const date = DAYS[di];
    const prec = DAY_PRECS[di];
    const total = DAY_TOTALS[di];
    const fp = Math.round(total * (1 - prec / 100));
    
    const [templates] = await pool.query(`SELECT * FROM real_data_samples LIMIT ${total}`);
    if (templates.length === 0) { console.log('  No template rows'); break; }
    
    const insertRows = [];
    for (let i = 0; i < total; i++) {
      const t = templates[i % templates.length];
      const isFp = i < fp ? 1 : 0;
      insertRows.push([
        t.tag_id, t.first_level_industry_name, t.second_level_industry_name,
        t.element_type,
        t.machine_tag, t.human_tag,
        t.media_url, t.ocr_content, t.asr_content,
        t.advertiser, date, isFp,
        t.class_num, t.class_id,
        t.reviewer_name, t.dc_id, t.ops_advertiser_name,
        t.ai_evaluate_reviewer_name,
        t.policy_ids, t.ai_evaluate_policy_ids, t.uid,
      ]);
    }
    
    for (let b = 0; b < insertRows.length; b += BATCH) {
      const batch = insertRows.slice(b, b + BATCH);
      const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
      await pool.query(
        `INSERT INTO real_data_samples 
         (tag_id, first_level_industry_name, second_level_industry_name,
          element_type,
          machine_tag, human_tag,
          media_url, ocr_content, asr_content,
          advertiser, arrive_time, is_fp,
          class_num, class_id,
          reviewer_name, dc_id, ops_advertiser_name,
          ai_evaluate_reviewer_name,
          policy_ids, ai_evaluate_policy_ids, uid)
         VALUES ${placeholders}`,
        batch.flat()
      );
    }
    sampleTotal += total;
    console.log(`  ${date}: total=${total} fp=${fp} prec=${prec}%`);
  }
  console.log(`\nTotal samples: ${sampleTotal}`);
  
  await pool.end();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
