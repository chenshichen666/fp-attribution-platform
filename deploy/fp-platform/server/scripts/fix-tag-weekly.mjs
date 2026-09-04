/**
 * 补齐「标签下钻」周趋势：让 50 个标签在 15 周内都有样本且精度合理
 * 仅操作 mock 样本数据，不改业务逻辑
 *
 * 目标：
 * 1. 每个 tag 在 15 周（2026-05-25~2026-08-31）内均有样本（消除只覆盖3-4周的问题）
 * 2. 每个 tag 的大盘起点接近 50%，前三周 <=65%
 * 3. 每个 tag 的 15 周聚合精度落在目标档位（异常/低/一般/高齐全），且非0非100
 */
import { rawQuery } from '../src/db/pool.js'

function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296}}
const rnd = mulberry32(20260903)

const WEEKS=[]
{ let d=new Date('2026-08-31T00:00:00'); for(let i=0;i<15;i++){WEEKS.push(d.toISOString().slice(0,10)); d=new Date(d.getTime()-7*86400000)} WEEKS.reverse() }

const TIER_FINAL={abnormal:[40,58],low:[63,73],mid:[77,84],high:[88,96]}
const TIER_START={abnormal:[30,42],low:[50,58],mid:[68,74],high:[82,88]}

async function main(){
  console.log('=== 补齐标签周趋势：50标签 × 15周 ===')
  const tags = await rawQuery(`SELECT DISTINCT tag_id, tag_name FROM real_data_tag_precision ORDER BY tag_id`)
  console.log(`目标标签数 = ${tags.length}`)

  const dist=[...Array(8).fill('abnormal'),...Array(14).fill('low'),...Array(16).fill('mid'),...Array(12).fill('high')]

  for(let i=0;i<tags.length;i++){
    const tag=tags[i]
    const tier=dist[i%dist.length]
    const [flo,fhi]=TIER_FINAL[tier]
    const finalPrec=flo+rnd()*(fhi-flo)
    const [slo,shi]=TIER_START[tier]
    const startPrec=slo+rnd()*(shi-slo)

    // 该 tag 现有样本 id（用于重分配 arrive_time 与 is_fp）
    const rows = await rawQuery(`SELECT id FROM real_data_samples WHERE tag_id=? ORDER BY id`,[tag.tag_id])
    if(!rows.length){ console.log(`  tag=${tag.tag_id} 无样本，跳过`); continue }
    const n=rows.length
    // 每周样本数：尽量均匀，最后一周略少
    const perWeek=Math.max(2,Math.floor(n/15))
    let idx=0
    let totalTp=0,totalFp=0

    for(let w=0;w<15;w++){
      const cnt=(w===14)?(n-idx):Math.min(perWeek,n-idx)
      if(cnt<=0) break
      const t=w/14
      let prec=startPrec+(finalPrec-startPrec)*t
      if(w===0) prec=50.0
      if(w===1) prec=Math.min(prec,56)
      if(w===2) prec=Math.min(prec,62)
      if(w<3)  prec=Math.min(prec,65)
      if(w===14) prec=finalPrec
      prec=Math.max(2.5,Math.min(97.5,prec))
      const wantFp=Math.round(cnt*(1-prec/100))
      for(let k=0;k<cnt;k++){
        const row=rows[idx++]
        if(!row) break
        const isFp = k<wantFp ? 1 : 0
        // 周内随机一天，保证 arrive_time 落在该周
        const wkStart=new Date(WEEKS[w]+'T00:00:00')
        const dayOff=Math.floor(rnd()*7)
        const dt=new Date(wkStart.getTime()+dayOff*86400000)
        const arrive=dt.toISOString().slice(0,10)
        await rawQuery(`UPDATE real_data_samples SET arrive_time=?, ds=?, is_fp=? WHERE id=?`,[arrive,arrive,isFp,row.id])
        if(isFp) totalFp++; else totalTp++
      }
    }
    const agg=totalTp+totalFp>0?(totalTp/(totalTp+totalFp)*100).toFixed(1):0
    console.log(`  tag=${tag.tag_id} ${tag.tag_name} n=${n} 聚合精度=${agg}% (${tier})`)
  }
  console.log('=== 完成 ===')
  process.exit(0)
}
main().catch(e=>{console.error('失败:',e.message);process.exit(1)})
