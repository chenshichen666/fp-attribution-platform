import { Router } from 'express'
import fs from 'node:fs'
import PDFDocument from 'pdfkit'
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } from 'docx'
import { query } from '../db/pool.js'
import { requireLogin, audit } from '../middleware/auth.js'

const router = Router()
function now() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }

/* ============ 分类（category）CRUD ============ */

// 列出某标签下的分类
router.get('/:tagId/categories', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const rows = await query(
      'SELECT id, name, feature, feature_brief AS featureBrief, feature_detail AS featureDetail, sample_snapshot AS sampleSnapshot, source, owner, updated_at AS updatedAt FROM material_category WHERE tag_id=? ORDER BY id',
      [tagId]
    )
    res.json(rows)
  } catch (e) { next(e) }
})

// 新增分类
router.post('/:tagId/categories', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const { name, feature = '', featureBrief = '', featureDetail = '', sampleSnapshot = '', source = 'manual' } = req.body || {}
    if (!name || !String(name).trim()) return res.status(400).json({ error: '分类名称不能为空' })
    const dup = await query('SELECT id FROM material_category WHERE tag_id=? AND name=?', [tagId, name])
    if (dup.length) return res.status(400).json({ error: '该分类已存在' })
    const r = await query(
      'INSERT INTO material_category (tag_id,name,feature,feature_brief,feature_detail,sample_snapshot,source,owner) VALUES (?,?,?,?,?,?,?,?)',
      [tagId, String(name).trim(), feature, featureBrief, featureDetail, sampleSnapshot, source, req.currentUser.name || '']
    )
    await audit(req, '新增素材分类', `tag#${tagId}:${name}`)
    res.json({ id: r.insertId, name: String(name).trim(), feature, featureBrief, featureDetail, sampleSnapshot, source })
  } catch (e) { next(e) }
})

// 更新分类（名称 / 凝练特征）
router.put('/:tagId/categories/:catId', requireLogin, async (req, res, next) => {
  try {
    const { tagId, catId } = req.params
    const { name, feature, featureBrief, featureDetail, sampleSnapshot } = req.body || {}
    const sets = [], args = []
    if (name !== undefined) { sets.push('name=?'); args.push(name) }
    if (feature !== undefined) { sets.push('feature=?'); args.push(feature) }
    if (featureBrief !== undefined) { sets.push('feature_brief=?'); args.push(featureBrief) }
    if (featureDetail !== undefined) { sets.push('feature_detail=?'); args.push(featureDetail) }
    if (sampleSnapshot !== undefined) { sets.push('sample_snapshot=?'); args.push(sampleSnapshot) }
    if (!sets.length) return res.json({ ok: true })
    args.push(tagId, catId)
    await query(`UPDATE material_category SET ${sets.join(',')} WHERE tag_id=? AND id=?`, args)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

// 删除分类（同时解除该分类下的素材归属）
router.delete('/:tagId/categories/:catId', requireLogin, async (req, res, next) => {
  try {
    const { tagId, catId } = req.params
    await query('DELETE FROM material_category WHERE tag_id=? AND id=?', [tagId, catId])
    await query('UPDATE material_category_relation SET category_id=0 WHERE tag_id=? AND category_id=?', [tagId, catId])
    await audit(req, '删除素材分类', `tag#${tagId}:cat#${catId}`)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* ============ 归类 relation（单选归属 + 画面特征/补充说明） ============ */

// 单条 / 批量归类：body { items:[{sampleId,categoryId,featureDesc,supplement,mediaUrl}] }
router.post('/:tagId/assign', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    if (!items.length) return res.status(400).json({ error: '缺少归类数据' })
    for (const it of items) {
      await query(
        `INSERT INTO material_category_relation (tag_id, sample_id, media_url, category_id, feature_desc, supplement, owner)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tag_id, sample_id) DO UPDATE SET media_url=excluded.media_url, category_id=excluded.category_id, feature_desc=excluded.feature_desc, supplement=excluded.supplement, owner=excluded.owner`,
        [tagId, it.sampleId, it.mediaUrl || null, it.categoryId || 0, it.featureDesc || '', it.supplement || '', req.currentUser.name || '']
      )
    }
    res.json({ ok: true, count: items.length })
  } catch (e) { next(e) }
})

/* ============ 素材标注（每次标注记录时间、全部保留、全员可见） ============ */

// 查询某素材（或批量素材）的标注历史，按时间倒序
router.get('/:tagId/annotations', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const ids = String(req.query.sampleIds || '').split(',').map(s => s.trim()).filter(Boolean)
    const one = String(req.query.sampleId || '').trim()
    if (one) ids.push(one)
    if (!ids.length) return res.json([])
    const ph = ids.map(() => '?').join(',')
    const rows = await query(
      `SELECT id, sample_id AS sampleId, media_url AS mediaUrl, content, owner, role, created_at AS createdAt
       FROM material_annotations
       WHERE tag_id=? AND sample_id IN (${ph})
       ORDER BY id ASC`,
      [tagId, ...ids]
    )
    res.json(rows)
  } catch (e) { next(e) }
})

// 新增一条标注（追加保留，不覆盖历史）
router.post('/:tagId/annotations', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const { sampleId, mediaUrl = '', content = '', role = '' } = req.body || {}
    if (!sampleId) return res.status(400).json({ error: '缺少 sampleId' })
    const text = String(content || '').trim()
    if (!text) return res.status(400).json({ error: '标注内容不能为空' })
    const r = await query(
      'INSERT INTO material_annotations (tag_id, sample_id, media_url, content, owner, role) VALUES (?,?,?,?,?,?)',
      [tagId, String(sampleId), mediaUrl || '', text.slice(0, 512), req.currentUser.name || '', String(role || '').slice(0, 16)]
    )
    await audit(req, '新增素材标注', `tag#${tagId}:sample#${sampleId}`)
    res.json({
      ok: true, id: r.insertId, sampleId: String(sampleId),
      content: text, owner: req.currentUser.name || '', role: String(role || '').slice(0, 16), createdAt: now(),
    })
  } catch (e) { next(e) }
})

/* ============ 分类结论（保存 + 导出） ============ */

router.get('/:tagId/conclusion', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const rows = await query(
      'SELECT content, summary, owner, updated_at AS updatedAt FROM material_conclusion WHERE tag_id=? ORDER BY id DESC LIMIT 1',
      [tagId]
    )
    res.json(rows[0] || null)
  } catch (e) { next(e) }
})

router.post('/:tagId/conclusion', requireLogin, async (req, res, next) => {
  try {
    const { tagId } = req.params
    const { tagName = '', content = '', summary = '' } = req.body || {}
    const exist = await query('SELECT id FROM material_conclusion WHERE tag_id=? LIMIT 1', [tagId])
    if (exist.length) {
      await query('UPDATE material_conclusion SET content=?, summary=?, tag_name=?, owner=? WHERE id=?',
        [content, summary, tagName, req.currentUser.name || '', exist[0].id])
    } else {
      await query('INSERT INTO material_conclusion (tag_id, tag_name, content, summary, owner) VALUES (?,?,?,?,?)',
        [tagId, tagName, content, summary, req.currentUser.name || ''])
    }
    await audit(req, '保存素材分类结论', `tag#${tagId}`)
    res.json({ ok: true })
  } catch (e) { next(e) }
})

/* ---- 导出所需：构建结论数据结构（前端可直接传，也可后端兜底） ---- */
function buildDoc(body) {
  const title = body?.title || '素材预分类结论报告'
  const tagName = body?.tagName || ''
  const generatedAt = now()
  const overview = Array.isArray(body?.overview) ? body.overview : []   // [{name,count,pct}]
  const categories = Array.isArray(body?.categories) ? body.categories : [] // [{name,feature,count,samples:[{id,type,industry,featureDesc}]}]
  const summary = body?.summary || ''
  return { title, tagName, generatedAt, overview, categories, summary }
}

// 查找可用中文字体（容器内若存在则嵌入，保证 PDF 中文不乱码）
const CJK_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/truetype/arphic/uming.ttc',
  '/System/Library/Fonts/PingFang.ttc',
]
function findCjkFont() {
  for (const p of CJK_FONT_CANDIDATES) { try { if (fs.existsSync(p)) return p } catch { /* ignore */ } }
  return null
}

// 导出 Word（.docx，原生 UTF-8，中文无字体问题）
router.post('/:tagId/export/word', requireLogin, async (req, res, next) => {
  try {
    const d = buildDoc(req.body)
    const children = []
    children.push(new Paragraph({ text: d.title, heading: HeadingLevel.TITLE }))
    children.push(new Paragraph({ children: [
      new TextRun({ text: `标签：${d.tagName || '—'}`, size: 22 }),
      new TextRun({ text: `    生成时间：${d.generatedAt}`, size: 22, color: '888888' }),
    ] }))

    if (d.overview.length) {
      children.push(new Paragraph({ text: '一、分类概况', heading: HeadingLevel.HEADING_1 }))
      const rows = [new TableRow({ children: ['分类', '素材数', '占比'].map(t =>
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] })) })]
      for (const o of d.overview) {
        rows.push(new TableRow({ children: [o.name, `${o.count}`, `${o.pct}%`].map(t =>
          new TableCell({ children: [new Paragraph(String(t))] })) }))
      }
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }))
    }

    if (d.categories.length) {
      children.push(new Paragraph({ text: '二、各分类详情', heading: HeadingLevel.HEADING_1 }))
      d.categories.forEach((c, i) => {
        children.push(new Paragraph({ text: `${i + 1}. ${c.name}（${c.count || (c.samples || []).length} 条）`, heading: HeadingLevel.HEADING_2 }))
        if (c.feature) children.push(new Paragraph({ children: [new TextRun({ text: `凝练特征：${c.feature}`, italics: true })] }))
        for (const s of (c.samples || [])) {
          const parts = [`· ${s.id}`]
          if (s.type) parts.push(`[${s.type}]`)
          if (s.industry) parts.push(s.industry)
          if (s.featureDesc) parts.push(s.featureDesc)
          children.push(new Paragraph(parts.join(' ')))
        }
      })
    }

    if (d.summary) {
      children.push(new Paragraph({ text: '三、总体结论', heading: HeadingLevel.HEADING_1 }))
      d.summary.split('\n').forEach(line => children.push(new Paragraph(line)))
    }

    const doc = new Document({ sections: [{ children }] })
    const buf = await Packer.toBuffer(doc)
    await audit(req, '导出素材分类Word', `tag#${req.params.tagId}`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="material-classify-${req.params.tagId}.docx"`)
    res.send(buf)
  } catch (e) { next(e) }
})

// 导出 PDF（pdfkit 真实生成；若容器存在中文字体则嵌入）
router.post('/:tagId/export/pdf', requireLogin, async (req, res, next) => {
  try {
    const d = buildDoc(req.body)
    const doc = new PDFDocument({ size: 'A4', margin: 48 })
    const font = findCjkFont()
    if (font) { try { doc.registerFont('cjk', font); doc.font('cjk') } catch { /* fallback */ } }

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="material-classify-${req.params.tagId}.pdf"`)
    doc.pipe(res)

    doc.fontSize(20).text(d.title, { align: 'center' })
    doc.moveDown(0.4)
    doc.fontSize(10).fillColor('#888').text(`标签：${d.tagName || '—'}    生成时间：${d.generatedAt}`, { align: 'center' })
    doc.moveDown(1).fillColor('#000')

    if (d.overview.length) {
      doc.fontSize(14).text('一、分类概况')
      doc.moveDown(0.3).fontSize(11)
      for (const o of d.overview) doc.text(`  · ${o.name}：${o.count} 条（${o.pct}%）`)
      doc.moveDown(0.8)
    }
    if (d.categories.length) {
      doc.fontSize(14).text('二、各分类详情')
      doc.moveDown(0.3)
      d.categories.forEach((c, i) => {
        doc.fontSize(12).fillColor('#2b3a67').text(`${i + 1}. ${c.name}（${c.count || (c.samples || []).length} 条）`)
        doc.fillColor('#000').fontSize(10)
        if (c.feature) doc.fillColor('#666').text(`   凝练特征：${c.feature}`).fillColor('#000')
        for (const s of (c.samples || [])) {
          const parts = [`   · ${s.id}`]
          if (s.type) parts.push(`[${s.type}]`)
          if (s.industry) parts.push(s.industry)
          if (s.featureDesc) parts.push(s.featureDesc)
          doc.text(parts.join(' '))
        }
        doc.moveDown(0.5)
      })
    }
    if (d.summary) {
      doc.fontSize(14).text('三、总体结论')
      doc.moveDown(0.3).fontSize(11).text(d.summary)
    }
    doc.end()
    await audit(req, '导出素材分类PDF', `tag#${req.params.tagId}`)
  } catch (e) { next(e) }
})

export default router
