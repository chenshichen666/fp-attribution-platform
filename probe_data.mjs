import { chromium } from '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs'

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
await page.route(/\.(png|jpe?g|gif|webp|mp4|avi|mov)(\?.*)?$/i, r => r.abort())
await page.addInitScript(() => {
  localStorage.setItem('fp_user', JSON.stringify({
    eng: 'cookiethu', name: 'cookiethu', team: '研发中心',
    roles: ['submitter', 'handler', 'admin'], status: 'active',
    initial: 'u', color: '#6366f1',
    roleTag: [{ t: '管理员', c: 'green' }],
  }))
})

page.on('response', async (resp) => {
  const url = resp.url()
  if (url.includes('/api/')) {
    let body = ''
    try { body = (await resp.text()).slice(0, 160) } catch {}
    console.log(`[API ${resp.status()}] ${url.replace('http://127.0.0.1:36111', '')} => ${body}`)
  }
})

await page.goto('http://127.0.0.1:36111/#/classify/tag/14803', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => console.log('nav err', e.message))
await sleep(10000)
console.log('\n=== TAG DETAIL PAGE TEXT ===')
const txt = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | ').slice(0, 700))
console.log(txt)
console.log('\ntable rows:', await page.evaluate(() => document.querySelectorAll('tbody tr').length))
console.log('pager:', await page.evaluate(() => !!document.querySelector('.pager, [class*=page]')))
await browser.close()
