import { db, config, query } from './pool.js'
import { SCHEMA } from './schema.js'
import {
  MANAGE_FEEDBACK, AUDIT_LOGS, MANAGE_APPROVALS, DEMO_USERS,
} from '../seed/seedData.js'

/**
 * SQLite 版 ensureColumn：使用 PRAGMA table_info 检查列是否存在
 * SQLite 的 ALTER TABLE 仅支持 ADD COLUMN，但足够用
 */
function ensureColumn(table, column, ddl) {
  const cols = db.pragma(`table_info("${table}")`)
  const exists = cols.some(c => c.name === column)
  if (!exists) {
    // ddl 格式举例: "conclusion_images TEXT"
    db.exec(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`)
  }
}

/**
 * 检查索引是否存在
 */
function indexExists(indexName) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(indexName)
  return !!row
}

// 建表 + 列迁移（幂等，服务启动时自动执行）
export async function runMigrations() {
  console.log('==> 建表中（SQLite）...')

  // 执行所有 DDL（CREATE TABLE + CREATE INDEX）
  for (const ddl of SCHEMA) {
    try {
      db.exec(ddl)
    } catch (e) {
      // 忽略 "table already exists" / "index already exists" 等
      if (!e.message?.includes('already exists')) {
        console.warn('[DDL]', ddl.slice(0, 80), '→', e.message)
      }
    }
  }

  // 列迁移：确保所有后续添加的列存在（兼容旧库）
  // 这些 ensureColumn 调用保证了即使是旧版数据库也能正确升级
  ensureColumn('tickets', 'conclusion_images', 'conclusion_images TEXT')
  ensureColumn('tickets', 'is_qualified', 'is_qualified INTEGER NULL')
  ensureColumn('tickets', 'handle_remark', 'handle_remark TEXT')
  ensureColumn('tickets', 'result_type', "result_type TEXT NOT NULL DEFAULT ''")
  ensureColumn('tickets', 'samples_data', 'samples_data TEXT')
  ensureColumn('sediments', 'ticket_id', "ticket_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('sediments', 'industry_l1', "industry_l1 TEXT NOT NULL DEFAULT ''")
  ensureColumn('sediments', 'industry_l2', "industry_l2 TEXT NOT NULL DEFAULT ''")
  ensureColumn('real_data_samples', 'class_num', 'class_num INTEGER NOT NULL DEFAULT 0')
  ensureColumn('real_data_samples', 'dc_id', "dc_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('real_data_samples', 'ops_advertiser_name', "ops_advertiser_name TEXT NOT NULL DEFAULT ''")
  ensureColumn('real_data_samples', 'ai_evaluate_reviewer_name', "ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT ''")
  // 绝对精度口径所需：已复核确认的误杀标记（fp_confirmed ⊆ is_fp）
  ensureColumn('real_data_samples', 'fp_confirmed', 'fp_confirmed INTEGER NOT NULL DEFAULT 0')
  ensureColumn('ai_evaluate_detail', 'class_num', 'class_num INTEGER NOT NULL DEFAULT 0')
  ensureColumn('ai_evaluate_detail', 'class_id', "class_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('ai_evaluate_detail', 'dc_id', "dc_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('ai_evaluate_detail', 'policy_ids', "policy_ids TEXT NOT NULL DEFAULT ''")
  ensureColumn('ai_evaluate_detail', 'ai_evaluate_policy_ids', "ai_evaluate_policy_ids TEXT NOT NULL DEFAULT ''")
  ensureColumn('uploaded_classify_data', 'class_id', "class_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('uploaded_classify_data', 'dc_id', "dc_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('uploaded_classify_data', 'ops_advertiser_name', "ops_advertiser_name TEXT NOT NULL DEFAULT ''")
  ensureColumn('uploaded_classify_data', 'ai_evaluate_reviewer_name', "ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT ''")
  ensureColumn('uploaded_classify_data', 'policy_ids', "policy_ids TEXT NOT NULL DEFAULT ''")
  ensureColumn('uploaded_classify_data', 'ai_evaluate_policy_ids', "ai_evaluate_policy_ids TEXT NOT NULL DEFAULT ''")
  ensureColumn('uploaded_classify_data', 'uid', "uid TEXT NOT NULL DEFAULT ''")

  // 添加索引（如果不存在）
  if (!indexExists('idx_ucd_sample_id')) {
    try { db.exec('CREATE INDEX idx_ucd_sample_id ON uploaded_classify_data(sample_id)') } catch { /* ignore */ }
  }

  ensureColumn('real_data_tag_precision_samples', 'class_num', 'class_num INTEGER NOT NULL DEFAULT 0')
  ensureColumn('real_data_tag_precision_samples', 'class_id', "class_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('real_data_tag_precision_samples', 'policy_ids', "policy_ids TEXT NOT NULL DEFAULT ''")
  ensureColumn('real_data_tag_precision_samples', 'ai_evaluate_policy_ids', "ai_evaluate_policy_ids TEXT NOT NULL DEFAULT ''")
  ensureColumn('real_data_tag_precision', 'tp', 'tp INTEGER NOT NULL DEFAULT 0')
  ensureColumn('real_data_tag_precision', 'fp_conf', 'fp_conf INTEGER NOT NULL DEFAULT 0')
  ensureColumn('real_data_tag_precision', 'tn', 'tn INTEGER NOT NULL DEFAULT 0')
  ensureColumn('real_data_tag_precision', 'fn', 'fn INTEGER NOT NULL DEFAULT 0')
  ensureColumn('real_data_tag_precision', 'ds', "ds TEXT NOT NULL DEFAULT ''")
  ensureColumn('ticket_drafts', 'summary', "summary TEXT NOT NULL DEFAULT ''")
  ensureColumn('ticket_drafts', 'payload', 'payload TEXT')
  ensureColumn('material_category', 'feature_brief', 'feature_brief TEXT')
  ensureColumn('material_category', 'feature_detail', 'feature_detail TEXT')
  ensureColumn('material_category', 'sample_snapshot', 'sample_snapshot TEXT')
  ensureColumn('material_annotations', 'role', "role TEXT NOT NULL DEFAULT ''")
  ensureColumn('data_import_history', 'error_message', 'error_message TEXT')

  // 提需人/处理人互斥迁移（使用 instr 代替 MySQL 的 FIND_IN_SET）
  const dupRoleRows = db.prepare(`
    SELECT id, roles FROM users
    WHERE instr(roles, 'submitter') > 0
      AND instr(roles, 'handler') > 0
      AND instr(roles, 'admin') = 0
  `).all()
  if (dupRoleRows.length) {
    console.log(`==> 提需人/处理人互斥迁移: 修正 ${dupRoleRows.length} 个用户的并列角色`)
    const updateStmt = db.prepare('UPDATE users SET roles=? WHERE id=?')
    for (const row of dupRoleRows) {
      const list = (row.roles || '').split(',').filter(Boolean)
      const keep = list.find((r) => r === 'submitter' || r === 'handler') || list[0] || 'submitter'
      updateStmt.run(keep, row.id)
    }
  }

  ensureColumn('sediments', 'is_demo', 'is_demo INTEGER NOT NULL DEFAULT 0')
  ensureColumn('material_category_relation', 'media_url', 'media_url TEXT')

  // 回填 media_url（从 real_data_samples）
  const backfillRows = db.prepare(`
    SELECT rel.id AS rel_id, s.media_url
    FROM material_category_relation rel
    INNER JOIN real_data_samples s ON s.tag_id = rel.tag_id AND s.sample_id = rel.sample_id
    WHERE rel.media_url IS NULL AND s.media_url IS NOT NULL AND s.media_url != ''
  `).all()
  if (backfillRows.length) {
    console.log(`==> 回填 media_url: 从 real_data_samples 匹配到 ${backfillRows.length} 条`)
    const updateStmt = db.prepare('UPDATE material_category_relation SET media_url=? WHERE id=?')
    for (const row of backfillRows) {
      updateStmt.run(row.media_url, row.rel_id)
    }
  }

  // 回填 media_url（从 real_data_tag_precision_samples）
  const backfillRows2 = db.prepare(`
    SELECT rel.id AS rel_id, s.media_url
    FROM material_category_relation rel
    INNER JOIN real_data_tag_precision_samples s ON s.tag_id = rel.tag_id AND s.sample_id = rel.sample_id
    WHERE rel.media_url IS NULL AND s.media_url IS NOT NULL AND s.media_url != ''
  `).all()
  if (backfillRows2.length) {
    console.log(`==> 回填 media_url: 从 real_data_tag_precision_samples 匹配到 ${backfillRows2.length} 条`)
    const updateStmt = db.prepare('UPDATE material_category_relation SET media_url=? WHERE id=?')
    for (const row of backfillRows2) {
      updateStmt.run(row.media_url, row.rel_id)
    }
  }

  // 回填 media_url（从 uploaded_classify_data）
  const backfillRows3 = db.prepare(`
    SELECT rel.id AS rel_id, s.media_url
    FROM material_category_relation rel
    INNER JOIN uploaded_classify_data s ON s.tag_id = rel.tag_id AND s.sample_id = rel.sample_id
    WHERE rel.media_url IS NULL AND s.media_url IS NOT NULL AND s.media_url != ''
  `).all()
  if (backfillRows3.length) {
    console.log(`==> 回填 media_url: 从 uploaded_classify_data 匹配到 ${backfillRows3.length} 条`)
    const updateStmt = db.prepare('UPDATE material_category_relation SET media_url=? WHERE id=?')
    for (const row of backfillRows3) {
      updateStmt.run(row.media_url, row.rel_id)
    }
  }

  // 发布备份表列迁移
  ensureColumn('publish_backup_real_data_samples', 'class_num', 'class_num INTEGER NOT NULL DEFAULT 0')
  ensureColumn('publish_backup_real_data_samples', 'class_id', "class_id TEXT NOT NULL DEFAULT ''")
  ensureColumn('publish_backup_real_data_tag_precision_samples', 'class_num', 'class_num INTEGER NOT NULL DEFAULT 0')
  ensureColumn('publish_backup_real_data_tag_precision_samples', 'class_id', "class_id TEXT NOT NULL DEFAULT ''")
  for (const tbl of ['real_data_tag_precision_samples', 'publish_backup_real_data_tag_precision_samples']) {
    ensureColumn(tbl, 'uid', "uid TEXT NOT NULL DEFAULT ''")
  }
  ensureColumn('publish_backup_real_data_tag_precision_samples', 'reviewer_name', "reviewer_name TEXT NOT NULL DEFAULT ''")
  for (const tbl of ['real_data_tag_precision_samples', 'publish_backup_real_data_tag_precision_samples']) {
    ensureColumn(tbl, 'dc_id', "dc_id TEXT NOT NULL DEFAULT ''")
    ensureColumn(tbl, 'ops_advertiser_name', "ops_advertiser_name TEXT NOT NULL DEFAULT ''")
    ensureColumn(tbl, 'element_fingerprint', "element_fingerprint TEXT NOT NULL DEFAULT ''")
    ensureColumn(tbl, 'ai_evaluate_reviewer_name', "ai_evaluate_reviewer_name TEXT NOT NULL DEFAULT ''")
  }
  for (const tbl of ['real_data_tag_precision', 'publish_backup_real_data_tag_precision']) {
    ensureColumn(tbl, 'review_model_precision_prime', 'review_model_precision_prime REAL NULL DEFAULT NULL')
  }

  // ===== 发布备份表列对齐迁移 =====
  const backupPairs = [
    { backup: 'publish_backup_real_data_tags', prod: 'real_data_tags' },
    { backup: 'publish_backup_real_data_samples', prod: 'real_data_samples' },
    { backup: 'publish_backup_real_data_tag_precision', prod: 'real_data_tag_precision' },
    { backup: 'publish_backup_real_data_tag_precision_samples', prod: 'real_data_tag_precision_samples' },
    { backup: 'publish_backup_cluster_data', prod: 'cluster_data' },
  ]
  for (const { backup, prod } of backupPairs) {
    try {
      const bCols = db.pragma(`table_info("${backup}")`)
      const pCols = db.pragma(`table_info("${prod}")`)
      const bSet = new Set(bCols.map(c => c.name))
      for (const col of pCols) {
        if (col.name === 'id' || bSet.has(col.name)) continue
        const colType = col.type || 'TEXT'
        const notNull = col.notnull ? ' NOT NULL' : ''
        const dflt = col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : ''
        db.exec(`ALTER TABLE "${backup}" ADD COLUMN "${col.name}" ${colType}${notNull}${dflt}`)
      }
    } catch (e) {
      console.warn(`[迁移] 备份表 ${backup} 列对齐跳过:`, e.message)
    }
  }

  console.log('==> 建表完成（SQLite）')
}

// 种子数据
async function run() {
  await runMigrations()

  // 种子：超级管理员
  console.log('==> 写入用户种子...')
  db.prepare(
    `INSERT OR REPLACE INTO users (eng, name, team, roles, status) VALUES (?,?,?,?,?)`
  ).run(config.superAdmin, '超级管理员', '治理策略组', 'submitter,handler,admin', 'active')

  for (const u of DEMO_USERS) {
    db.prepare(
      `INSERT OR IGNORE INTO users (eng, name, team, roles, status) VALUES (?,?,?,?,?)`
    ).run(u.eng, u.name, u.team, u.roles.join(','), u.status)
  }

  // 种子：权限申请
  console.log('==> 写入权限申请种子...')
  for (const a of MANAGE_APPROVALS) {
    db.prepare(
      `INSERT OR IGNORE INTO permission_requests (id,eng,name,team,apply_roles,reason,status,operator,operated_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(a.id, a.eng, a.name, a.team, a.applyRoles.join(','), a.reason, a.status, a.operator, a.operatedAt || null, a.createdAt)
  }

  // 种子：反馈
  console.log('==> 写入反馈种子...')
  for (const f of MANAGE_FEEDBACK) {
    db.prepare(
      `INSERT OR IGNORE INTO feedback (id,user,eng,team,type,content,shots,status,reply,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(f.id, f.user, f.eng, f.team, f.type, f.content, f.shots, f.status, f.reply, f.createdAt)
  }

  // 种子：审计日志
  console.log('==> 写入审计日志种子...')
  for (const l of AUDIT_LOGS) {
    db.prepare(
      `INSERT INTO audit_logs (user, action, target, ip, t) VALUES (?,?,?,?,?)`
    ).run(l.user, l.action, l.target, l.ip, l.t)
  }

  console.log('==> 初始化完成 ✅')
  process.exit(0)
}

// 仅在直接执行 init.js 脚本时跑种子
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  run().catch((e) => { console.error('初始化失败:', e); process.exit(1) })
}
