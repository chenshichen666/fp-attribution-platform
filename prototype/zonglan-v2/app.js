/* ============ v9 配色规范（§0） ============ */
// 七类人机分歧
const CAT = {
  'left-up':   { c:'#ef4444', n:'人机不一致·左上（人审>60 & 机审<40）' },
  'right-down':{ c:'#f97316', n:'人机不一致·右下（机审>60 & 人审<40）' },
  'h-human':   { c:'#a855f7', n:'横条·人审分歧（40≤人审≤60）' },
  'h-machine': { c:'#0ea5e9', n:'横条·机审分歧（40≤机审≤60）' },
  'center':    { c:'#3b82f6', n:'中心·双分歧（人机均40–60）' },
  'dual-high': { c:'#22c55e', n:'双高·一致（机审>60 & 人审>60）' },
  'dual-low':  { c:'#94a3b8', n:'双低·弱（机审<40 & 人审<40）' },
};
// 标签精度五档颜色（§0 第5条）
function prec(v){ if(v==null||isNaN(v))return null;
  if(v<50)return{c:'#ef4444',l:'严重偏低'}; if(v<70)return{c:'#f97316',l:'偏低'};
  if(v<80)return{c:'#eab308',l:'一般'}; if(v<90)return{c:'#86efac',l:'良好'}; return{c:'#22c55e',l:'优秀'}; }
function catOf(h,m){
  if(h>60&&m<40)return'left-up'; if(m>60&&h<40)return'right-down';
  if(h>=40&&h<=60&&(m>60||m<40))return'h-human'; if(m>=40&&m<=60&&(h>60||h<40))return'h-machine';
  if(h>=40&&h<=60&&m>=40&&m<=60)return'center'; if(m>60&&h>60)return'dual-high'; return'dual-low';
}
// 复刻平台 tagStatus 红/橙/绿三档（标签跟踪状态角标用）
function tagStatusCls(p){ if(p==null)return'gray'; if(p<=60)return'red'; if(p<80)return'orange'; return'green'; }
const STATUS_LABEL={red:'精度异常',orange:'精度关注',green:'精度正常',gray:'无数据'};

/* ============ 标签 Tab 数据 ============ */
const NAMES=['内容低质','设计不适二级','误导性内容','虚假宣传','低俗暗示','夸大宣传','标题党','诱导点击','素材违规','版权风险','落地页异常','表单误导'];
const TAGS=Array.from({length:26},(_,i)=>{
  const p=[12,38,55,67,73,81,88,93,96,99,44,28][i%12]+(i%4);
  const fp=Math.round((100-p)/100*(60+i*5));
  return { id:14000+i*13, name:NAMES[i%12], precision:Math.min(p,99), fp, sample:60+i*5 };
});
let watched=JSON.parse(localStorage.getItem('zonglanWatched')||'[]');
let trackTab='all';
let searchTag='';

// 严重偏低（红档，精度<50%）：异常状态的唯一判定依据，是"全部"的子集
function isSevere(t){ return (t.precision??null)<50; }

function renderKpi(){
  const tot=TAGS.reduce((s,t)=>s+t.sample,0), fp=TAGS.reduce((s,t)=>s+t.fp,0);
  const cards=[
    {icon:'target',label:'大盘精度',v:'88.81%',c:getComputedStyle(document.documentElement).getPropertyValue('--green'),tag:'近7天',delta:'+2.3%',up:true},
    {icon:'target',label:'绝对精度',v:'83.16%',c:'#1fb574',tag:'近7天',delta:'+0.8%',up:true},
    {icon:'database',label:'总样本',v:tot.toLocaleString(),c:'#4f7cff',tag:'近7天'},
    {icon:'alert-triangle',label:'FP 数',v:fp.toLocaleString(),c:'#f5a000',tag:'近7天',delta:'-12',up:false},
    {icon:'tag',label:'标签数',v:TAGS.length,c:'#7c6df0'},
    {icon:'box',label:'聚类簇数',v:'318',c:'#4f7cff'},
  ];
  document.getElementById('kpiRow').innerHTML=cards.map(k=>`
    <div class="kpi card">
      <div class="kpi-top">
        <span class="kpi-ic" style="background:${k.c}1a;color:${k.c}"><i data-lucide="${k.icon}" style="width:18px;height:18px"></i></span>
        <span class="kpi-label">${k.label}</span>
        ${k.tag?`<span class="kpi-tag">${k.tag}</span>`:''}
      </div>
      <div class="kpi-val" style="color:${k.c}">${k.v}</div>
      ${k.delta?`<span class="kpi-delta ${k.up?'up':'down'}">${k.up?'▲':'▼'} ${k.delta} <span style="color:var(--text-4);font-weight:400">周环比</span></span>`:'<span style="display:block;height:18px"></span>'}
      <span class="kpi-blob" style="background:${k.c}14"></span>
    </div>`).join('');
  lucide.createIcons();
}
function renderTagList(){
  const kw=searchTag.trim().toLowerCase();
  const matched=TAGS.filter(t=>!kw||String(t.id).includes(kw)||(t.name||'').toLowerCase().includes(kw));
  let arr=matched.filter(t=>{
    if(trackTab==='abn')return isSevere(t);
    if(trackTab==='watch')return watched.includes(t.id); return true;
  });
  document.getElementById('cAll').textContent=matched.length;
  document.getElementById('cAbn').textContent=matched.filter(isSevere).length;
  document.getElementById('cWatch').textContent=matched.filter(t=>watched.includes(t.id)).length;
  const box=document.getElementById('tagList');
  if(!arr.length){ box.innerHTML=`<div class="empty" style="padding:40px"><div class="empty-ic"><i data-lucide="star" style="width:40px;height:40px"></i></div><div class="empty-title">${trackTab==='watch'?'暂无关注的标签':'无匹配标签'}</div><div class="empty-desc">${trackTab==='watch'?'点击标签行右侧 ★ 关注常用标签':'试试切换其他分档'}</div></div>`; lucide.createIcons(); return; }
  box.innerHTML=arr.map(t=>{
    const pc=prec(t.precision), isW=watched.includes(t.id);
    // 精度排序：按 precision 降序排列后的排名
    const sorted=TAGS.slice().sort((a,b)=>b.precision-a.precision);
    const rank=sorted.findIndex(x=>x.id===t.id)+1;
    return `<div class="tt-row" data-id="${t.id}">
      <span class="tid-val" style="justify-content:flex-start;gap:6px"><i data-lucide="star" class="star ${isW?'on':''}" data-star="${t.id}" style="width:16px;height:16px"></i>${t.id}</span>
      <span class="name-val">${t.name}</span>
      <span class="prec-cell"><span class="bar-track"><i style="width:${t.precision}%;background:${pc.c}"></i></span><b class="bar-val" style="color:${pc.c}">${t.precision}%</b></span>
      <span><span class="badge" style="background:${pc.c}1a;color:${pc.c}">${pc.l}</span></span>
      <span><b class="bar-val" style="color:var(--text-1)">${t.fp}</b></span>
      <span><b class="bar-val" style="color:var(--text-3);font-size:13px">#${rank}</b></span>
      <span><button class="btn btn-ghost btn-sm" style="height:28px;padding:0 10px;font-size:12px;color:var(--brand);border-color:var(--brand);background:transparent" onclick="event.stopPropagation();toast('跳转误杀归因页面（原型演示）')">填写误杀归因...</button></span>
    </div>`;
  }).join('');
  box.querySelectorAll('.tt-row').forEach(r=>r.addEventListener('click',e=>{
    if(e.target.closest('[data-star]'))return;
    toast(`跳转 /classify?tagId=${r.dataset.id}（原型演示）`);
  }));
  box.querySelectorAll('[data-star]').forEach(s=>s.addEventListener('click',e=>{
    e.stopPropagation(); const id=+s.dataset.star;
    if(watched.includes(id))watched=watched.filter(x=>x!==id); else watched.push(id);
    localStorage.setItem('zonglanWatched',JSON.stringify(watched)); renderTagList();
  }));
  lucide.createIcons();
}

/* ============ 趋势图 ============ */
const weekChart=echarts.init(document.getElementById('weekChart'));
weekChart.setOption({
  grid:{left:40,right:24,top:42,bottom:30,containLabel:true},
  tooltip:{trigger:'axis'},
  legend:{data:['大盘精度','绝对精度'],right:8,top:4,icon:'roundRect',itemWidth:14,itemHeight:8,textStyle:{fontSize:11,color:'#5a6478'}},
  xAxis:{type:'category',data:Array.from({length:12},(_,i)=>'W'+(i+1)),axisLabel:{fontSize:11},axisLine:{show:false},axisTick:{show:false},splitLine:{show:false}},
  yAxis:{type:'value',max:100,axisLabel:{formatter:'{value}%'},splitLine:{lineStyle:{color:'#f0f2f6',type:'dashed'}}},
  series:[
    {name:'大盘精度',type:'line',smooth:true,data:[85.1,85.6,86.2,86.8,87,87.4,87.9,88.1,88.3,88.5,88.6,88.81],lineStyle:{color:'#f97316',width:2.4},itemStyle:{color:'#f97316'},symbol:'circle',symbolSize:6,label:{show:true,position:'top',formatter:'{c}%',fontSize:10,color:'#f97316',fontWeight:600}},
    {name:'绝对精度',type:'line',smooth:true,data:[80.2,80.8,81.3,81.9,82.2,82.6,82.9,83,83,83.1,83.1,83.16],lineStyle:{color:'#22c55e',width:2.4},itemStyle:{color:'#22c55e'},symbol:'circle',symbolSize:6,label:{show:true,position:'bottom',formatter:'{c}%',fontSize:10,color:'#22c55e',fontWeight:600}},
  ]
});
const dayChart=echarts.init(document.getElementById('dayChart'));
const days=Array.from({length:14},(_,i)=>{const d=new Date();d.setDate(d.getDate()-13+i);return (d.getMonth()+1)+'/'+d.getDate();});
const dayDa=days.map((_,i)=>+(82.5+i*0.42+Math.sin(i)*0.7).toFixed(2));   // 大盘精度：上行
const dayDp=days.map((_,i)=>+(79.5+i*0.30+Math.cos(i)*0.5).toFixed(2));  // 绝对精度：上行
const dayFp=days.map((_,i)=>Math.round(1500-i*55+(Math.random()*120-60))); // FP量：下行
dayChart.setOption({
  grid:{left:45,right:56,top:42,bottom:30,containLabel:true},
  tooltip:{trigger:'axis'},
  legend:{data:['大盘精度','绝对精度','FP量'],right:8,top:4,icon:'roundRect',itemWidth:14,itemHeight:8,textStyle:{fontSize:11,color:'#5a6478'}},
  xAxis:{type:'category',data:days,axisLabel:{fontSize:11},axisLine:{show:false},axisTick:{show:false},splitLine:{show:false}},
  yAxis:[{type:'value',max:100,axisLabel:{formatter:'{value}%'},splitLine:{lineStyle:{color:'#f0f2f6',type:'dashed'}}},{type:'value',position:'right',max:4000,axisLabel:{formatter:v=>(v/1000)+'k'},splitLine:{show:false}}],
  series:[
    {name:'大盘精度',type:'line',smooth:true,yAxisIndex:0,data:dayDa,lineStyle:{color:'#f97316',width:2.4},itemStyle:{color:'#f97316'},symbol:'circle',symbolSize:6,label:{show:true,position:'top',formatter:'{c}%',fontSize:9,color:'#f97316',fontWeight:600}},
    {name:'绝对精度',type:'line',smooth:true,yAxisIndex:0,data:dayDp,lineStyle:{color:'#22c55e',width:2.4},itemStyle:{color:'#22c55e'},symbol:'circle',symbolSize:6,label:{show:true,position:'bottom',formatter:'{c}%',fontSize:9,color:'#22c55e',fontWeight:600}},
    {name:'FP量',type:'bar',yAxisIndex:1,data:dayFp,barWidth:'42%',itemStyle:{color:'#fecaca',borderRadius:[3,3,0,0]},label:{show:true,position:'top',formatter:p=>p.value,fontSize:9,color:'#c47'}},
  ]
});

/* ============ 聚类簇 · 象限分析（AI评测数据） ============ */
// 真实标签：ID + 名称小字（原型数据）
const LABELS=[
  {id:'全部',name:'全部标签'},
  {id:'15511',name:'擦边暗示性场景与氛围'},
  {id:'15512',name:'低俗擦边文案与诱导话术'},
  {id:'15513',name:'擦边肢体动作与姿势'},
  {id:'15514',name:'软色情符号与隐喻元素'},
  {id:'15515',name:'边界性暴露着装'},
  {id:'15516',name:'暧昧场景与情境营造'},
  {id:'15517',name:'擦边音乐与节奏包装'},
  {id:'15518',name:'性暗示微表情与对视'},
];
let quadLabel='全部', quadSeg='all', hideCat={};
// AI评测：机审占比 / 人审占比 / 规模(记录数)
const clusters=Array.from({length:150},(_,i)=>{
  const m=Math.round(Math.random()*100), h=Math.round(Math.random()*100);
  const L=LABELS[1+Math.floor(Math.random()*(LABELS.length-1))];
  return {cid:'c'+(i+1),m,h,n:Math.round(8+Math.random()*120),et:Math.random()>.5?'image':'video',label:L.id};
});
clusters.forEach(c=>c.cat=catOf(c.h,c.m));
function filteredClusters(){ return clusters.filter(c=>(quadLabel==='全部'||c.label===quadLabel)&&(quadSeg==='all'||c.et===quadSeg)); }
function renderCatStats(){
  const arr=filteredClusters(); const counts={}; arr.forEach(c=>counts[c.cat]=(counts[c.cat]||0)+1);
  document.getElementById('catStats').innerHTML=Object.entries(CAT).map(([k,v])=>`
    <div class="cat-stat"><span class="cs-bar" style="background:${v.c}"></span>
      <div class="cs-name"><span class="pin" style="background:${v.c}"></span>${v.n.split('（')[0]}</div>
      <div class="cs-val" style="color:${v.c}">${counts[k]||0}</div>
      <div class="cs-sub">${arr.length?((counts[k]||0)/arr.length*100).toFixed(0):0}% · ${v.n.includes('（')?v.n.split('（')[1].replace(')',''):''}</div>
    </div>`).join('');
}
function renderQuadLabelBar(){
  document.getElementById('quadLabelBar').innerHTML=LABELS.map(l=>`<button data-l="${l.id}" class="tagbtn ${l.id===quadLabel?'on':''}"><span class="tb-id">${l.id}</span><span class="tb-name">${l.name}</span></button>`).join('');
  document.querySelectorAll('#quadLabelBar button').forEach(b=>b.onclick=()=>{quadLabel=b.dataset.l;renderQuadLabelBar();renderCatStats();renderQuad();renderClusterList();});
}
function renderLegend(){
  document.getElementById('quadLegend').innerHTML=Object.entries(CAT).map(([k,v])=>`<span style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;opacity:${hideCat[k]?.3:1}" data-cat="${k}"><span class="pin" style="background:${v.c}"></span>${v.n.split('（')[0]}</span>`).join('');
  document.querySelectorAll('#quadLegend [data-cat]').forEach(el=>el.onclick=()=>{const k=el.dataset.cat;hideCat[k]=!hideCat[k];renderLegend();renderQuad();});
}
const quadChart=echarts.init(document.getElementById('quadChart'));
function renderQuad(){
  const data=filteredClusters().filter(c=>!hideCat[c.cat]).map(c=>({
    value:[c.m,c.h,c.n],cid:c.cid,cat:c.cat,
    symbolSize:Math.max(7,Math.min(30,Math.sqrt(c.n)*2.6)),
    itemStyle:{color:CAT[c.cat].c,opacity:.82,borderColor:'#fff',borderWidth:1},
  }));
  quadChart.setOption({
    grid:{left:52,right:24,top:18,bottom:48,containLabel:true},
    tooltip:{trigger:'item',formatter:p=>`<b>${p.data.cid}</b> · ${CAT[p.data.cat].n.split('（')[0]}<br>机审占比：${p.data.value[0]}%<br>人审占比：${p.data.value[1]}%<br>记录数：${p.data.value[2]}`},
    xAxis:{name:'机审标签占比(%)',nameLocation:'middle',nameGap:28,min:0,max:100,splitLine:{lineStyle:{color:'#f0f2f6'}},axisLabel:{formatter:'{value}%'},nameTextStyle:{fontSize:12,color:'#8a91a5'}},
    yAxis:{name:'人审标签占比(%)',nameLocation:'middle',nameGap:36,min:0,max:100,splitLine:{lineStyle:{color:'#f0f2f6'}},axisLabel:{formatter:'{value}%'},nameTextStyle:{fontSize:12,color:'#8a91a5'}},
    series:[{type:'scatter',data,markLine:{silent:true,symbol:'none',lineStyle:{type:'dashed',color:'#cbd2e0'},data:[{xAxis:40},{xAxis:60},{yAxis:40},{yAxis:60}]}}]
  });
}
function renderClusterList(){
  const sort=document.getElementById('quadSort').value;
  let arr=[...filteredClusters()];
  arr.sort((a,b)=>sort==='m'?b.m-a.m:sort==='h'?b.h-a.h:b.n-a.n);
  const box=document.getElementById('clusterList');
  if(!arr.length){ box.innerHTML=`<div class="empty" style="padding:30px"><div class="empty-ic"><i data-lucide="box" style="width:36px;height:36px"></i></div><div class="empty-title">该筛选下无聚类簇</div><div class="empty-desc">切换标签 / 图片视频分段试试</div></div>`; lucide.createIcons(); return; }
  box.innerHTML=arr.map(c=>`
    <div class="cl-row" data-cid="${c.cid}">
      <span class="pin" style="background:${CAT[c.cat].c}"></span>
      <span class="cl-id">${c.cid}</span>
      <span class="cl-meta">人${c.h}% · 机${c.m}% · ${c.et==='image'?'图':'视'}</span>
      <span class="cl-n">${c.n}条</span>
    </div>`).join('');
  box.querySelectorAll('.cl-row').forEach(r=>{
    r.addEventListener('mouseenter',()=>hl(r.dataset.cid,true)); r.addEventListener('mouseleave',()=>hl(r.dataset.cid,false));
    r.addEventListener('click',()=>openCluster(r.dataset.cid));
  });
  quadChart.off('mouseover').off('mouseout');
  quadChart.on('mouseover',p=>{if(p.data&&p.data.cid)hl(p.data.cid,true);});
  quadChart.on('mouseout',p=>{if(p.data&&p.data.cid)hl(p.data.cid,false);});
}
function hl(cid,on){document.querySelectorAll('#clusterList .cl-row').forEach(r=>r.classList.toggle('hl',on&&r.dataset.cid===cid));}
function renderMetric(){
  document.getElementById('metricBody').innerHTML=Object.entries(CAT).map(([k,v])=>`
    <div class="metric-item"><span class="pin" style="background:${v.c}"></span><span><b>${v.n.split('（')[0]}</b> · ${v.n.includes('（')?v.n.split('（')[1].replace(')',''):''}</span></div>`).join('');
}
function openCluster(cid){
  const c=clusters.find(x=>x.cid===cid);
  const lab=LABELS.find(l=>l.id===c.label);
  document.getElementById('dTitle').textContent='簇 '+cid+' 明细';
  document.getElementById('dSub').textContent=`${CAT[c.cat].n.split('（')[0]} · 标签 ${(lab?lab.name+' ':'')+c.label} · 机审${c.m}% / 人审${c.h}% · 记录数${c.n}`;
  const elType=c.et==='image'?'图片':'视频'; const col=c.et==='image'?'#4f7cff':'#f5a000';
  document.getElementById('dBody').innerHTML=Array.from({length:Math.min(c.n,8)},(_,i)=>`
    <div class="el-row">
      <div class="el-thumb" style="background:${col}"><i data-lucide="${c.et==='image'?'image':'video'}"></i></div>
      <div class="el-info"><div class="el-val">element_${cid}_${i+1}</div><div class="el-fp">fp:md5_${Math.random().toString(16).slice(2,10)}</div></div>
      <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end">
        <span class="hit m">机审 ${Math.random()>.4?'✓':'✗'}</span>
        <span class="hit h">人审 ${Math.random()>.4?'✓':'✗'}</span>
      </div>
      <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="toast('触发相似检索 / 查结论库 / 预览（原型演示）')">操作</button>
    </div>`).join('');
  document.getElementById('mask').classList.add('show'); document.getElementById('drawer').classList.add('show');
  lucide.createIcons();
}
document.getElementById('drawerClose').onclick=closeDrawer; document.getElementById('mask').onclick=closeDrawer;
function closeDrawer(){document.getElementById('mask').classList.remove('show');document.getElementById('drawer').classList.remove('show');}

/* ============ 精标数据（含空状态） ============ */
let fineUploaded=true;
const FINE_LABELS=['15511','15512','15513','15514'];
let fineLabel='15511', fineSeg='all';
const fineClustersByLabel={
  '15511':Array.from({length:14},(_,i)=>({cid:'c'+(i*2+1),ratio:Math.round(Math.random()*100),n:Math.round(30+Math.random()*200),et:Math.random()>.5?'image':'video'})),
};
function curFineClusters(){ return (fineClustersByLabel[fineLabel]||[]).filter(c=>fineSeg==='all'||c.et===fineSeg); }
function renderFineStats(){
  const cs=curFineClusters();
  const consistent=cs.filter(c=>c.ratio<40||c.ratio>60).length;
  const diverge=cs.length-consistent;
  const consN=cs.filter(c=>c.ratio<40||c.ratio>60).reduce((s,c)=>s+c.n,0);
  const divN=cs.filter(c=>c.ratio>=40&&c.ratio<=60).reduce((s,c)=>s+c.n,0);
  document.getElementById('fineStats').innerHTML=`
    <div class="card" style="padding:18px;border-left:4px solid #1fb574">
      <div style="font-size:13px;color:var(--text-3)">精标结果一致（绿）</div>
      <div style="display:flex;gap:20px;margin-top:8px"><div><b style="font-size:22px;color:#1fb574">${consistent}</b><span style="font-size:12px;color:var(--text-3)"> 簇</span></div><div><b style="font-size:22px;color:#1fb574">${consN}</b><span style="font-size:12px;color:var(--text-3)"> 元素</span></div></div>
      <div style="font-size:11px;color:var(--text-4);margin-top:6px">擦边打标高&gt;60% · 擦边打标低&lt;40%</div>
    </div>
    <div class="card" style="padding:18px;border-left:4px solid #f59e0b">
      <div style="font-size:13px;color:var(--text-3)">精标分歧（琥珀）</div>
      <div style="display:flex;gap:20px;margin-top:8px"><div><b style="font-size:22px;color:#f59e0b">${diverge}</b><span style="font-size:12px;color:var(--text-3)"> 簇</span></div><div><b style="font-size:22px;color:#f59e0b">${divN}</b><span style="font-size:12px;color:var(--text-3)"> 元素</span></div></div>
      <div style="font-size:11px;color:var(--text-4);margin-top:6px">40% ≤ 擦边占比 ≤ 60%</div>
    </div>`;
}
const fineChart=echarts.init(document.getElementById('fineChart'));
function renderFineChart(){
  const cs=curFineClusters();
  const bins=Array.from({length:10},(_,i)=>({x:`${i*10}-${i*10+10}`,v:0,zone:i<4?'low':i<6?'mid':'high'}));
  cs.forEach(c=>{const idx=Math.min(9,Math.floor(c.ratio/10));bins[idx].v++;});
  fineChart.setOption({
    grid:{left:40,right:20,top:20,bottom:30,containLabel:true},
    tooltip:{trigger:'axis'},
    xAxis:{type:'category',data:bins.map(b=>b.x),axisLabel:{fontSize:10,rotate:30}},
    yAxis:{type:'value',name:'簇数'},
    series:[{type:'bar',data:bins.map(b=>({value:b.v,itemStyle:{color:b.zone==='mid'?'#f59e0b':b.zone==='low'?'#86efac':'#4ade80',borderRadius:[4,4,0,0]}})),
      markLine:{silent:true,symbol:'none',lineStyle:{type:'dashed',color:'#cbd2e0'},data:[{xAxis:3},{xAxis:5}]}}]
  });
}
function renderFineLabelBar(){
  document.getElementById('fineLabelBar').innerHTML=FINE_LABELS.map(l=>`<button data-l="${l}" class="${l===fineLabel?'on':''}">${l}</button>`).join('');
  document.querySelectorAll('#fineLabelBar button').forEach(b=>b.onclick=()=>{fineLabel=b.dataset.l;if(!fineClustersByLabel[fineLabel])fineClustersByLabel[fineLabel]=Array.from({length:14},(_,i)=>({cid:'c'+(i*2+1),ratio:Math.round(Math.random()*100),n:Math.round(30+Math.random()*200),et:Math.random()>.5?'image':'video'}));renderFineLabelBar();renderFineStats();renderFineChart();renderFineList();});
}
function renderFineList(){
  const cs=curFineClusters().sort((a,b)=>b.ratio-a.ratio);
  const box=document.getElementById('fineList');
  if(!cs.length){ box.innerHTML=`<div class="empty" style="padding:30px"><div class="empty-ic"><i data-lucide="box" style="width:36px;height:36px"></i></div><div class="empty-title">该筛选下无簇</div></div>`; lucide.createIcons(); return; }
  box.innerHTML=cs.map(c=>`
    <div class="cl-row" data-cid="${c.cid}">
      <span class="cl-id">${c.cid}</span>
      <span class="bar-track" style="flex:1"><i style="width:${c.ratio}%;background:${c.ratio<40||c.ratio>60?'#1fb574':'#f59e0b'}"></i></span>
      <b class="bar-val" style="color:${c.ratio<40||c.ratio>60?'#1fb574':'#f59e0b'}">${c.ratio}%</b>
      <span class="cl-n">${c.n}</span>
    </div>`).join('');
}
function renderFineMp(){
  document.getElementById('fineMp').innerHTML=`<b>修正口径</b>：擦边标签占比 = 簇内命中该标签元素数 ÷ 簇内总元素数 × 100%。一致 = 占比&lt;40% 或 &gt;60%（绿，含擦边打标高&gt;60% / 擦边打标低&lt;40%）；分歧 = 40%≤占比≤60%（琥珀）。左绿区(0-40%) / 中琥珀区(40-60%) / 右绿区(60-100%)，40%、60% 虚线标记。`;
}
function renderFineEmpty(){
  const box=document.getElementById('fineEmpty');
  if(fineUploaded){ box.style.display='none'; document.getElementById('fineContent').style.display='block'; return; }
  document.getElementById('fineContent').style.display='none'; box.style.display='block';
  box.innerHTML=`<div class="empty"><div class="empty-ic"><i data-lucide="upload" style="width:40px;height:40px"></i></div><div class="empty-title">请先在管理模块上传样本库精标数据</div><div class="empty-desc">精标数据为空，无法展示簇明细与擦边占比分布。请前往「管理 → 数据管理」上传 sample_library_fine_label。</div><button class="btn btn-primary btn-sm" style="margin-top:16px" onclick="toast('前往管理模块上传精标数据（原型演示）')"><i data-lucide="upload"></i>前往上传</button></div>`;
  lucide.createIcons();
}
document.getElementById('toggleEmpty').onclick=function(){
  fineUploaded=!fineUploaded;
  this.innerHTML=fineUploaded?'<i data-lucide="eye-off"></i>模拟未上传数据':'<i data-lucide="eye"></i>恢复示例数据';
  lucide.createIcons(); renderFineEmpty();
};

/* ============ Tab 切换 ============ */
document.getElementById('mainTabs').onclick=e=>{const b=e.target.closest('button');if(!b)return;
  document.querySelectorAll('#mainTabs button').forEach(x=>x.classList.toggle('on',x===b));
  const v=b.dataset.v; document.getElementById('tab-tag').style.display=v==='tag'?'block':'none';
  document.getElementById('tab-cluster').style.display=v==='cluster'?'block':'none';
  if(v==='cluster'){renderClusterList();setTimeout(()=>quadChart.resize(),60);}
};
document.getElementById('trackTabs').onclick=e=>{const b=e.target.closest('button');if(!b)return;
  trackTab=b.dataset.v;document.querySelectorAll('#trackTabs button').forEach(x=>x.classList.toggle('on',x===b));renderTagList();};
document.getElementById('tagSearch').addEventListener('input',e=>{searchTag=e.target.value;renderTagList();});
document.getElementById('clusterTabs').onclick=e=>{const b=e.target.closest('button');if(!b)return;
  const v=b.dataset.v;document.querySelectorAll('#clusterTabs button').forEach(x=>x.classList.toggle('on',x===b));
  document.getElementById('sub-quad').style.display=v==='quad'?'block':'none';
  document.getElementById('sub-fine').style.display=v==='fine'?'block':'none';
  if(v==='fine')setTimeout(()=>fineChart.resize(),60);
};
document.getElementById('quadSeg').onclick=e=>{const b=e.target.closest('button');if(!b)return;
  quadSeg=b.dataset.v;document.querySelectorAll('#quadSeg button').forEach(x=>x.classList.toggle('on',x===b));renderCatStats();renderQuad();renderClusterList();};
document.getElementById('fineSeg').onclick=e=>{const b=e.target.closest('button');if(!b)return;
  fineSeg=b.dataset.v;document.querySelectorAll('#fineSeg button').forEach(x=>x.classList.toggle('on',x===b));renderFineStats();renderFineChart();renderFineList();};
document.getElementById('quadSort').onchange=renderClusterList;
document.getElementById('metricToggle').onclick=()=>document.getElementById('metricPanel').querySelector('.metric-head').classList.toggle('collapsed')||(document.getElementById('metricBody').style.display=document.getElementById('metricBody').style.display==='none'?'grid':'none');
document.getElementById('metricBody').style.display='grid';
// 时间筛选（原型：仅视觉联动）
document.querySelectorAll('#drf .drf-btn').forEach(b=>b.onclick=()=>{document.querySelectorAll('#drf .drf-btn').forEach(x=>x.classList.remove('on'));b.classList.add('on');document.getElementById('drfCustom').classList.remove('on');toast('时间窗口已切换：'+b.textContent+'（联动趋势图/聚类簇）');});
document.getElementById('drfCustom').onclick=()=>{document.querySelectorAll('#drf .drf-btn').forEach(x=>x.classList.remove('on'));document.getElementById('drfCustom').classList.add('on');};

/* ============ 初始化 ============ */
renderKpi();renderTagList();renderCatStats();renderQuadLabelBar();renderLegend();renderQuad();renderClusterList();renderMetric();
renderFineStats();renderFineChart();renderFineLabelBar();renderFineList();renderFineMp();renderFineEmpty();
lucide.createIcons();
window.addEventListener('resize',()=>{weekChart.resize();dayChart.resize();quadChart.resize();fineChart.resize();});

function toast(msg){ const t=document.createElement('div'); t.textContent=msg; t.style.cssText='position:fixed;left:50%;top:24px;transform:translateX(-50%);background:rgba(29,36,51,.95);color:#fff;padding:10px 18px;border-radius:10px;font-size:13px;z-index:9999;box-shadow:0 8px 24px rgba(20,30,60,.22)'; document.body.appendChild(t); setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),300);},1800); }
