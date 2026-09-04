const URL = "http://cdn.example.com/ads_svp_video__0b53dmal2aaaveadhdcpfvvbwgyexunqbpka.f20.mp4?dis_k=d11462feb3abc958fda083a935f4339e&dis_t=178359880"
async function tryFetchNative(url,timeout){
  const ctrl = new AbortController()
  const id = setTimeout(()=>ctrl.abort(), timeout)
  try{
    const r = await fetch(url, { method:'GET', headers:{'User-Agent':'Mozilla/5.0','Accept':'*/*','Accept-Encoding':'identity'}, signal:ctrl.signal, redirect:'follow' })
    clearTimeout(id)
    return {ok:true, response:r}
  }catch(e){ clearTimeout(id); return {ok:false, err:e} }
}
const N=30
const tasks=[]
for(let i=0;i<N;i++) tasks.push(tryFetchNative(URL,15000))
const res=await Promise.all(tasks)
const ok=res.filter(x=>x.ok&&x.response&&x.response.ok).length
const fails=res.filter(x=>!x.ok)
console.log('Node原生fetch 并发',N,'成功',ok,'失败',fails.length)
const names={}
for(const f of fails) names[f.err&&f.err.name||'unknown']=(names[f.err&&f.err.name||'unknown']||0)+1
console.log('失败类型', JSON.stringify(names))
