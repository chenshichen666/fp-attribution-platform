#!/usr/bin/env bash
# TRAG 检索链路完整冒烟测试（8 种任务 + 导出 + 上传）
BASE="http://127.0.0.1:8787"
NODE=/Users/cookiethy/.workbuddy/binaries/node/versions/22.22.2/bin/node

call_search() {
  local task="$1" query="$2" limit="${3:-3}"
  curl -s -X POST "$BASE/api/trag/search" \
    -H 'Content-Type: application/json' -H 'x-user-eng: admin' \
    -d "{\"task\":\"$task\",\"query\":\"$query\",\"limit\":$limit}" \
  | $NODE -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      try{
        const j=JSON.parse(d);
        if(j.error){console.log('  ❌ '+j.error.slice(0,60));return}
        console.log('  ✅ engine='+j.engine+' 召回='+j.total+' 首条score='+(j.results[0]?j.results[0].score.toFixed(4):'N/A'));
        if(j.results[0]){const r=j.results[0];
          const t=(r.ocr_content||r.asr_content||r.element_value||'').slice(0,30);
          console.log('     首条: ['+r.class_id+'] '+t);}
      }catch(e){console.log('  ❌ 解析失败: '+d.slice(0,80))}
    })"
}

# 从库里取一条真实素材文案作为查询词（避免用例与语料脱节）
Q=$($NODE -e "
const D=require('better-sqlite3');const db=new D('data/fp_attribution.db',{readonly:true});
const r=db.prepare(\"SELECT ocr_content FROM real_data_samples WHERE ocr_content!='' LIMIT 1\").get();
console.log(r ? r.ocr_content : '');")
echo "========== TRAG 8 种检索任务 =========="
echo "查询词: $Q"
for t in text_text image_ocr video_ocr video_asr video_patch_asr; do
  echo "[$t]"
  call_search "$t" "$Q" 3
done

echo "[video_video] (指纹检索)"
FP=$($NODE -e "
const D=require('better-sqlite3');const db=new D('data/fp_attribution.db',{readonly:true});
console.log(db.prepare(\"SELECT element_fingerprint FROM real_data_samples WHERE element_fingerprint!='' LIMIT 1\").get().element_fingerprint);")
echo "  使用指纹: $FP"
call_search "video_video" "$FP" 3

echo "[image_image_shangshu] (视觉检索)"
URL=$($NODE -e "
const D=require('better-sqlite3');const db=new D('data/fp_attribution.db',{readonly:true});
console.log(db.prepare(\"SELECT media_url FROM real_data_samples WHERE media_url!='' LIMIT 1\").get().media_url);")
call_search "image_image_shangshu" "$URL" 3

echo "[video_frame] (风险帧检索)"
call_search "video_frame" "$URL" 3

echo ""
echo "========== CSV 导出 =========="
curl -s -X POST "$BASE/api/trag/export_csv" \
  -H 'Content-Type: application/json' -H 'x-user-eng: admin' \
  -d '{"task":"image_ocr","query":"测试","results":[{"score":0.95,"element_fingerprint":"fp_test_1","ocr_content":"限时特惠 抢完即止","tag_name":"虚假广告"}]}' \
  -o /tmp/trag_export.csv -w "  HTTP=%{http_code}  " 
head -c 200 /tmp/trag_export.csv | sed 's/^/  /'
echo ""

echo ""
echo "========== 图片上传（以图搜图前置） =========="
# 1x1 红色 PNG
PNG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
curl -s -X POST "$BASE/api/trag/upload_image" \
  -H 'Content-Type: application/json' -H 'x-user-eng: admin' \
  -d "{\"filename\":\"test.png\",\"data_url\":\"$PNG\"}" \
| $NODE -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    try{const j=JSON.parse(d);
      if(j.error)return console.log('  ❌ '+j.error);
      console.log('  ✅ 上传成功 url='+j.url+' size='+j.size);
      console.log('     note: '+j.engineNote);
    }catch(e){console.log('  ❌ '+d.slice(0,100))}
  })"

echo ""
echo "========== 沉淀库搜索 =========="
for kw in 阈值 负样本 医疗; do
  enc=$($NODE -e "console.log(encodeURIComponent('$kw'))")
  curl -s "$BASE/api/sediments/search?q=$enc" -H 'x-user-eng: admin' \
  | $NODE -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      try{const j=JSON.parse(d);console.log('  ✅ 「$kw」命中 '+(Array.isArray(j)?j.length:0)+' 条')}
      catch(e){console.log('  ❌ '+'解析失败')}})"
done

echo ""
echo "========== 任务列表 =========="
curl -s "$BASE/api/trag/tasks" -H 'x-user-eng: admin' \
| $NODE -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    try{const j=JSON.parse(d);console.log('  ✅ 任务类型 '+j.length+' 种: '+j.map(t=>t.task).join(', '))}
    catch(e){console.log('  ❌ '+d.slice(0,80))}})"

echo ""
echo "========== 冒烟结束 =========="
