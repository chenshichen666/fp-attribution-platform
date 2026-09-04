import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: 3306,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
});

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)) }
function fmtDate(d) { return d.toISOString().slice(0, 10) }
function randDate(start = '2026-07-28', end = '2026-09-01') {
  const s = new Date(start).getTime(), e = new Date(end).getTime();
  return new Date(s + Math.random() * (e - s));
}

const INDUSTRIES = ['电商服务', '数字传媒内容', '美妆个护', '食品饮料', '游戏',
  '通讯和IT服务', '生活日用', '金融', '电器数码', '服饰珠宝', '汽车', '教育', '医疗健康'];
const SEC_IND = ['在线短剧', '游戏研发与发行', '药品', '电商平台', '数字动漫',
  '普通化妆品', '在线阅读', '医疗器械', '通信运营商', '保健食品', '新能源汽车', '在线教育', '快消品'];
const ELEM_TYPES = ['ELEMENT_TYPE_VIDEO', 'ELEMENT_TYPE_IMAGE', 'ELEMENT_TYPE_TEXT', 'ELEMENT_TYPE_URL'];
const ELEM_NAMES = { 'ELEMENT_TYPE_VIDEO': '视频', 'ELEMENT_TYPE_IMAGE': '图片', 'ELEMENT_TYPE_TEXT': '文本', 'ELEMENT_TYPE_URL': '落地页' };
const ADVERTISERS = [
  '北京臻鼎科技有限公司', '广州颂悦信息技术有限公司', '上海七猫文化传媒有限公司',
  '上海格物致品网络科技有限公司', '广西京东晴川电子商务有限公司', '深圳市腾讯计算机系统有限公司',
  '西安思健医药有限公司', '深圳齐乐网络科技有限公司', '重庆京东海嘉电子商务有限公司',
  '上海寻梦信息技术有限公司', '杭州云海创新科技有限公司', '北京快手科技有限公司',
  '成都锐新信息技术有限公司', '武汉稳糖源健医疗器械有限公司', '广州泽铭锦承文化传播有限公司',
];

async function main() {
  // Step 1: 从 publish_backup 获取全部真实标签
  const [pbTags] = await pool.query(
    'SELECT DISTINCT tag_id, tag_name FROM publish_backup_real_data_tag_precision WHERE tag_name != "" ORDER BY tag_id'
  );
  console.log(`共 ${pbTags.length} 个真实标签`);

  // Step 2: 清空并重建 real_data_tags
  console.log('\n=== 重建 real_data_tags ===');
  await pool.query('DELETE FROM real_data_tags');
  const tagRows = pbTags.map(t => {
    const total = randInt(80, 600);
    const fp = Math.round(total * (Math.random() * 0.5 + 0.1)); // 10%~60% FP
    const precVal = ((1 - fp / total) * 100).toFixed(2);
    return [t.tag_id, t.tag_name, total, fp, precVal, 0, '', ''];
  });
  // 分批插入
  for (let i = 0; i < tagRows.length; i += 100) {
    const batch = tagRows.slice(i, i + 100);
    await pool.query(
      'INSERT INTO real_data_tags (tag_id, tag_name, total, fp, precision_val, rank_no, remark, fp_reason) VALUES ?',
      [batch]
    );
  }
  console.log(`插入 real_data_tags: ${tagRows.length} 行`);

  // Step 3: 重建 real_data_tag_precision (每标签 × 行业 × 元素类型 维度明细)
  console.log('\n=== 重建 real_data_tag_precision ===');
  await pool.query('DELETE FROM real_data_tag_precision');
  const tpRows = [];
  const weekStarts = [];
  for (let d = new Date('2026-05-25'); d <= new Date('2026-08-31'); d.setDate(d.getDate() + 7)) {
    weekStarts.push(fmtDate(new Date(d)));
  }

  for (const tag of pbTags) {
    // 每个标签 15 条精度数据（每周一条 × 部分行业元素组合）
    for (const ws of weekStarts) {
      const ind = rand(INDUSTRIES);
      const et = rand(ELEM_TYPES);
      const total = randInt(10, 80);
      const fp = Math.round(total * (Math.random() * 0.5 + 0.1));
      const tp = total - fp;
      const precVal = ((tp / total) * 100).toFixed(2);
      const fpConf = randInt(0, fp);
      const arrDate = ws;
      const rpm = (Math.random() * 30 + 50).toFixed(2); // review_model_precision_prime 50~80

      tpRows.push([
        tag.tag_id, tag.tag_name, total, fp, precVal,
        total, ind, rand(SEC_IND), et, ELEM_NAMES[et],
        arrDate, ws, 'v3.2', '', '', '',
        tp, fpConf, randInt(0, 10), randInt(0, 5), rpm,
      ]);
    }
  }

  console.log(`准备插入 real_data_tag_precision: ${tpRows.length} 行`);
  for (let i = 0; i < tpRows.length; i += 500) {
    const batch = tpRows.slice(i, i + 500);
    await pool.query(
      `INSERT INTO real_data_tag_precision
       (tag_id, tag_name, total, fp, precision_val,
        sample_count, first_level_industry_name, second_level_industry_name,
        element_type, element_type_name, arrive_time, ds, model_version,
        element_fingerprint, remark, fp_reason,
        tp, fp_conf, tn, fn, review_model_precision_prime)
       VALUES ?`,
      [batch]
    );
  }
  console.log(`插入 real_data_tag_precision: ${tpRows.length} 行`);

  // Step 4: 扩充 real_data_samples（为新标签添加样本，每标签 ~15 条样本 × 分散到多个 class_id）
  console.log('\n=== 扩充 real_data_samples ===');
  // 先看已有多少
  const [[{ c: existRs }]] = await pool.query('SELECT COUNT(*) as c FROM real_data_samples');
  console.log(`当前 real_data_samples: ${existRs} 行`);

  // 只为尚未存在的标签添加
  const [existTagIds] = await pool.query('SELECT DISTINCT tag_id FROM real_data_samples');
  const existSet = new Set(existTagIds.map(r => r.tag_id));
  const newTags = pbTags.filter(t => !existSet.has(t.tag_id));
  console.log(`需要为 ${newTags.length} 个新标签生成样本`);

  const rsRows = [];
  for (const tag of newTags) {
    const n = randInt(10, 25); // 每标签 10~25 条
    for (let j = 0; j < n; j++) {
      const dt = randDate();
      const et = rand(ELEM_TYPES);
      const isVideo = et.includes('VIDEO') ? 1 : 0;
      const isFp = Math.random() < 0.25 ? 1 : 0;
      const ind = rand(INDUSTRIES);
      const classId = 'c' + randInt(1, 20);
      const hasMachine = Math.random() < 0.7;
      const hasHuman = Math.random() < 0.6;
      const pids = hasMachine ? tag.tag_id.toString() : '';
      const aiPids = hasHuman ? String(randInt(14600, 15700)) : '';

      rsRows.push([
        tag.tag_id, tag.tag_name,
        'S_' + tag.tag_id + '_' + j,
        'efp_rs_' + tag.tag_id + '_' + j,
        et, isVideo,
        tag.tag_name, isFp ? '' : tag.tag_name,
        ind, rand(SEC_IND),
        'https://picsum.photos/seed/sample' + tag.tag_id + '_' + j + '/400/300',
        Math.random() < 0.3 ? 'OCR文本' + randInt(1, 200) : '',
        isVideo && Math.random() < 0.2 ? 'ASR语音' + randInt(1, 100) : '',
        rand(ADVERTISERS),
        fmtDate(dt), fmtDate(dt),
        isFp,
        isFp ? rand(['误判', '边界case', '策略过严', '模型偏差']) : '',
        '',
        randInt(1, 20), classId,
        '审核员' + randInt(1, 10),
        'DC' + randInt(100, 999), rand(ADVERTISERS),
        '评审员' + randInt(1, 8),
        pids ? '[' + pids + ']' : '[]',
        aiPids ? '[' + aiPids + ']' : '[]',
        'UID' + randInt(10000, 99999),
      ]);
    }
  }

  if (rsRows.length > 0) {
    for (let i = 0; i < rsRows.length; i += 500) {
      const batch = rsRows.slice(i, i + 500);
      await pool.query(
        `INSERT INTO real_data_samples
         (tag_id, tag_name, sample_id, element_fingerprint, element_type, is_video,
          machine_tag, human_tag, first_level_industry_name, second_level_industry_name,
          media_url, ocr_content, asr_content, advertiser, arrive_time, ds,
          is_fp, fp_reason, remark, class_num, class_id,
          reviewer_name, dc_id, ops_advertiser_name, ai_evaluate_reviewer_name,
          policy_ids, ai_evaluate_policy_ids, uid)
         VALUES ?`,
        [batch]
      );
    }
    console.log(`插入 real_data_samples: ${rsRows.length} 行`);
  }

  // Step 5: 扩充 real_data_tag_precision_samples（覆盖全部标签）
  console.log('\n=== 扩充 real_data_tag_precision_samples ===');
  const [existTpsTags] = await pool.query('SELECT DISTINCT tag_id FROM real_data_tag_precision_samples');
  const existTpsSet = new Set(existTpsTags.map(r => r.tag_id));
  const newTpsTags = pbTags.filter(t => !existTpsSet.has(t.tag_id));
  console.log(`需要为 ${newTpsTags.length} 个新标签生成 precision_samples`);

  const tpsRows = [];
  for (const tag of newTpsTags) {
    // 每标签 ~10 条样本
    const n = randInt(8, 15);
    for (let j = 0; j < n; j++) {
      const dt = randDate('2026-06-01', '2026-09-01');
      const et = rand(ELEM_TYPES);
      const isVideo = et.includes('VIDEO') ? 1 : 0;
      const isFp = Math.random() < 0.25 ? 1 : 0;
      const ind = rand(INDUSTRIES);

      tpsRows.push([
        tag.tag_id, tag.tag_name,
        'TPS_' + tag.tag_id + '_' + j,
        et, isVideo,
        tag.tag_name, isFp ? '' : tag.tag_name,
        ind, rand(SEC_IND),
        'https://picsum.photos/seed/tps' + tag.tag_id + '_' + j + '/400/300',
        Math.random() < 0.3 ? 'OCR' + randInt(1, 100) : '',
        isVideo && Math.random() < 0.2 ? 'ASR' + randInt(1, 50) : '',
        rand(ADVERTISERS),
        fmtDate(dt), fmtDate(dt),
        isFp,
        isFp ? rand(['误判', '边界case', '策略过严']) : '',
        '',
        randInt(1, 20), 'c' + randInt(1, 20),
        '审核员' + randInt(1, 10),
        'DC' + randInt(100, 999), rand(ADVERTISERS),
        'efp_tps_' + tag.tag_id + '_' + j,
        '评审员' + randInt(1, 8),
        '[' + tag.tag_id + ']',
        Math.random() < 0.7 ? '[' + randInt(14600, 15700) + ']' : '[]',
        'UID' + randInt(10000, 99999),
      ]);
    }
  }

  if (tpsRows.length > 0) {
    for (let i = 0; i < tpsRows.length; i += 500) {
      const batch = tpsRows.slice(i, i + 500);
      await pool.query(
        `INSERT INTO real_data_tag_precision_samples
         (tag_id, tag_name, sample_id, element_type, is_video,
          machine_tag, human_tag, first_level_industry_name, second_level_industry_name,
          media_url, ocr_content, asr_content, advertiser, arrive_time, ds,
          is_fp, fp_reason, remark, class_num, class_id,
          reviewer_name, dc_id, ops_advertiser_name, element_fingerprint,
          ai_evaluate_reviewer_name, policy_ids, ai_evaluate_policy_ids, uid)
         VALUES ?`,
        [batch]
      );
    }
    console.log(`插入 real_data_tag_precision_samples: ${tpsRows.length} 行`);
  }

  // Step 6: 更新 publish_backup_real_data_tags 补充 tag_name
  console.log('\n=== 更新 publish_backup_real_data_tags tag_name ===');
  const tagNameMap = Object.fromEntries(pbTags.map(t => [t.tag_id, t.tag_name]));
  const [pbrt] = await pool.query('SELECT DISTINCT tag_id FROM publish_backup_real_data_tags WHERE tag_name = "" OR tag_name IS NULL');
  let updCnt = 0;
  for (const r of pbrt) {
    const name = tagNameMap[r.tag_id];
    if (name) {
      await pool.query('UPDATE publish_backup_real_data_tags SET tag_name = ? WHERE tag_id = ?', [name, r.tag_id]);
      updCnt++;
    }
  }
  console.log(`更新 publish_backup_real_data_tags tag_name: ${updCnt} 行`);

  // Step 7: 确保 ai_evaluate_detail 中 policy_ids 覆盖更多标签
  // 当前大部分 policy_ids 已有真实标签（14662, 14709 等），再随机给一部分空 policy_ids 分配标签
  console.log('\n=== 丰富 ai_evaluate_detail policy_ids ===');
  const allTagIds = pbTags.map(t => t.tag_id);
  const batchSize = 5000;
  const [emptyPids] = await pool.query(
    "SELECT COUNT(*) as c FROM ai_evaluate_detail WHERE policy_ids = '' OR policy_ids IS NULL OR policy_ids = '[]'"
  );
  console.log(`ai_evaluate_detail 空 policy_ids: ${emptyPids[0].c}`);

  // 给空 policy_ids 行分配 1~3 个随机标签
  let totalUpdated = 0;
  while (totalUpdated < 30000) { // 只更新一部分
    const [rows] = await pool.query(
      "SELECT id FROM ai_evaluate_detail WHERE policy_ids = '' OR policy_ids IS NULL OR policy_ids = '[]' LIMIT ?",
      [batchSize]
    );
    if (rows.length === 0) break;

    const cases = rows.map(r => {
      const nTags = randInt(1, 3);
      const tags = [];
      for (let i = 0; i < nTags; i++) tags.push(rand(allTagIds));
      const pid = [...new Set(tags)].join(',');
      return `WHEN ${r.id} THEN '${pid}'`;
    }).join(' ');
    const ids = rows.map(r => r.id).join(',');

    await pool.query(`UPDATE ai_evaluate_detail SET policy_ids = CASE id ${cases} END WHERE id IN (${ids})`);
    totalUpdated += rows.length;
    if (totalUpdated % 10000 === 0) console.log(`  updated ${totalUpdated}...`);
  }
  console.log(`更新 ai_evaluate_detail policy_ids: ${totalUpdated} 行`);

  // Final summary
  console.log('\n=== 最终数据统计 ===');
  const tables = ['real_data_tags', 'real_data_tag_precision', 'real_data_samples',
    'real_data_tag_precision_samples', 'ai_evaluate_detail', 'publish_backup_real_data_tags'];
  for (const tbl of tables) {
    const [[cnt]] = await pool.query(`SELECT COUNT(*) as c FROM \`${tbl}\``);
    console.log(`${tbl.padEnd(50)} ${String(cnt.c).padStart(8)}`);
  }

  // 标签数验证
  const [[tagCnt]] = await pool.query('SELECT COUNT(DISTINCT tag_id) as c FROM real_data_tags');
  console.log(`\nreal_data_tags 不同标签数: ${tagCnt.c}`);
  const [[rsCnt]] = await pool.query('SELECT COUNT(DISTINCT tag_id) as c FROM real_data_samples');
  console.log(`real_data_samples 不同标签数: ${rsCnt.c}`);
  const [[tpsCnt]] = await pool.query('SELECT COUNT(DISTINCT tag_id) as c FROM real_data_tag_precision_samples');
  console.log(`real_data_tag_precision_samples 不同标签数: ${tpsCnt.c}`);

  await pool.end();
  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
