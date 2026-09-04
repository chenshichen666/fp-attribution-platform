import http from 'node:http'
import https from 'node:https'
import fetch from 'node-fetch'
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10, timeout: 60000 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10, timeout: 60000 })
const URL = "http://cdn.example.com/ads_svp_video__0b53dmal2aaaveadhdcpfvvbwgyexunqbpka.f20.mp4?dis_k=d11462feb3abc958fda083a935f4339e&dis_t=178359880"

let _cdnSemaphore=null
function _makeSemaphore(max){let current=0;const queue=[];return{acquire(timeout=0){if(current<max){current++;return Promise.resolve(true)}if(!timeout){return new Promise(res=>queue.push(()=>res(true)))}return new Promise(res=>{const t=setTimeout(()=>res(false),timeout);queue.push(()=>{clearTimeout(t);res(true)})})},release(){current--;if(queue.length>0){current++;const n=queue.shift();n()}}}}
const MAX_CONCURRENT_CDN=15
if(!_cdnSemaphore)_cdnSemaphore=_makeSemaphore(MAX_CONCURRENT_CDN)
const REQUEST_DEADLINE=8000
const _deadlineStart=Date.now()
const deadlineExceeded=()=>Date.now()-_deadlineStart>REQUEST_DEADLINE
function adaptiveTimeout(s){return Math.max(2000,Math.min(s,REQUEST_DEADLINE-(Date.now()-_deadlineStart)))}
const fetchHeaders={'User-Agent':'Mozilla/5.0','Accept':'*/*','Accept-Encoding':'identity'}

async function tryFetchLimited(url,timeout){const at=Math.min(3000,Math.max(1000,REQUEST_DEADLINE-(Date.now()-_deadlineStart)));const ac=await _cdnSemaphore.acquire(at);if(!ac)return{ok:false,err:new Error('semaphore timeout')};try{return await tryFetch(url,timeout)}finally{_cdnSemaphore.release()}}
async function tryFetch(url,timeout){const c=new AbortController();const id=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(url,{method:'GET',headers:fetchHeaders,signal:c.signal,redirect:'follow',agent:url.startsWith('https:')?httpsAgent:httpAgent});clearTimeout(id);return{ok:true,response:r}}catch(e){clearTimeout(id);return{ok:false,err:e}}}

const N=30
console.log('并发发起', N, '个 media-proxy 风格请求...')
const tasks=[]
for(let i=0;i<N;i++){
  tasks.push((async()=>{
    if(deadlineExceeded()) return 'deadline-exceeded'
    const {ok,response:r}=await tryFetchLimited(URL, adaptiveTimeout(15000))
    if(ok&&r.ok) return 'ok-'+r.status
    if(ok) return 'http-'+r.status
    return 'fail:'+(r&&r.err&&r.err.name)||'fail'
  })())
}
const res=await Promise.all(tasks)
const ok=res.filter(x=>x.startsWith('ok')).length
const fail=res.filter(x=>!x.startsWith('ok'))
console.log('成功:',ok,'/ 失败:',fail.length)
console.log('失败明细(前10):', fail.slice(0,10))
