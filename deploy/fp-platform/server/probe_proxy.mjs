import http from 'node:http'
import https from 'node:https'
import fetch from 'node-fetch'
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10, timeout: 60000 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10, timeout: 60000 })
const url = "http://cdn.example.com/ads_svp_video__0b53dmal2aaaveadhdcpfvvbwgyexunqbpka.f20.mp4?dis_k=d11462feb3abc958fda083a935f4339e&dis_t=178359880"
const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Encoding': 'identity',
}
const t=Date.now()
try{
  const r = await fetch(url, { method:'GET', headers, redirect:'follow', agent: url.startsWith('https:')?httpsAgent:httpAgent })
  console.log('status', r.status, 'ct', r.headers.get('content-type'), 'cl', r.headers.get('content-length'), 'elapsed', Date.now()-t)
  // 尝试读一点 body
  const buf = await r.buffer()
  console.log('body bytes', buf.length)
}catch(e){
  console.log('FETCH ERROR after', Date.now()-t, 'ms:', e.name, e.message)
}
