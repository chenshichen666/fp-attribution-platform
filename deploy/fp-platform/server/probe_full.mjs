import http from 'node:http'
import https from 'node:https'
import fetch from 'node-fetch'
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10, timeout: 60000 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10, timeout: 60000 })
const targetUrl = "http://cdn.example.com/ads_svp_video__0b53dmal2aaaveadhdcpfvvbwgyexunqbpka.f20.mp4?dis_k=d11462feb3abc958fda083a935f4339e&dis_t=178359880"

const REQUEST_DEADLINE = 8000
const _deadlineStart = Date.now()
const deadlineExceeded = () => Date.now() - _deadlineStart > REQUEST_DEADLINE
function adaptiveTimeout(s){ return Math.max(2000, Math.min(s, REQUEST_DEADLINE-(Date.now()-_deadlineStart))) }

const fetchHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Encoding': 'identity',
}
const rangeHeader = undefined

async function tryFetch(url, timeout){
  const controller = new AbortController()
  const timeoutId = setTimeout(()=>controller.abort(), timeout)
  try{
    const headers = {...fetchHeaders}
    if(rangeHeader) headers['Range']=rangeHeader
    const r = await fetch(url,{method:'GET',headers,signal:controller.signal,redirect:'follow',agent:url.startsWith('https:')?httpsAgent:httpAgent})
    clearTimeout(timeoutId)
    return {ok:true, response:r}
  }catch(e){ clearTimeout(timeoutId); return {ok:false,err:e} }
}

function _isValidMediaResponse(r, fetchUrl){
  const rawCt=(r.headers.get('content-type')||'').toLowerCase()
  if(rawCt.includes('text/html')||rawCt.includes('application/json')||rawCt.includes('text/plain')||rawCt.includes('text/xml')||rawCt.includes('application/xml')) return false
  const cl=r.headers.get('content-length')
  if(cl && parseInt(cl,10)<100) return false
  if(rawCt.includes('application/octet-stream')){
    if(fetchUrl){const lowerUrl=fetchUrl.toLowerCase();const urlPath=lowerUrl.split('?')[0];const hasMediaExt=/\.(mp4|mov|avi|webm|mkv|flv|m4v|3gp|ogv|jpg|jpeg|png|gif|webp|bmp|svg)(\/|$)/.test(urlPath);if(!hasMediaExt) return false}
  }
  return true
}

if(!deadlineExceeded()){
  const {ok,response:r}=await tryFetch(targetUrl, adaptiveTimeout(15000))
  console.log('strategy1 ok=',ok,'status=',r&&r.status,'ct=',r&&r.headers.get('content-type'))
  if(ok && r.ok){
    console.log('isValidMedia=', _isValidMediaResponse(r, targetUrl))
    if(_isValidMediaResponse(r,targetUrl)){
      const buf = await r.buffer().catch(()=>null)
      console.log('PIPED bytes=', buf?buf.length:0, '=> 素材应正常显示')
    } else {
      console.log('>> _isValidMediaResponse=false => 返回占位符(unavailable) => 素材黑屏！')
    }
  } else {
    console.log('>> strategy1 失败 err=', ok?('status '+r.status):r)
  }
}
