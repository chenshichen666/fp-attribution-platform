import http from 'node:http'
import https from 'node:https'
import fetch from 'node-fetch'
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10, timeout: 60000 })
const URL = "http://cdn.example.com/ads_svp_video__0b53dmal2aaaveadhdcpfvvbwgyexunqbpka.f20.mp4?dis_k=d11462feb3abc958fda083a935f4339e&dis_t=178359880"
async function tryFetch(url,timeout){const c=new AbortController();const id=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(url,{method:'GET',headers:{'User-Agent':'Mozilla/5.0','Accept':'*/*','Accept-Encoding':'identity'},signal:c.signal,redirect:'follow',agent:url.startsWith('https:')?httpsAgent:httpAgent});clearTimeout(id);return{ok:true,response:r}}catch(e){clearTimeout(id);return{ok:false,err:e}}}
const N=30
const tasks=[]
for(let i=0;i<N;i++){ tasks.push(tryFetch(URL,15000)) }
const res=await Promise.all(tasks)
const fails=res.filter(x=>!x.ok)
console.log('总=',N,'失败=',fails.length)
const names={}
for(const f of fails){ const k=f.err&&f.err.name||'unknown'; names[k]=(names[k]||0)+1 }
console.log('失败错误类型:', JSON.stringify(names))
console.log('示例错误:', fails[0] && fails[0].err && (fails[0].err.name+': '+fails[0].err.message))
