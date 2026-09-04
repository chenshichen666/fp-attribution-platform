import { chromium } from 'playwright';
const url = process.env.PAGE_URL || 'http://127.0.0.1:36111/#/classify/tag/14803';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => console.log('goto err', e.message));
await page.waitForTimeout(2500);
// 截图整个页面
await page.screenshot({ path: 'shot_detail.png', fullPage: false });
// 尝试找到含误杀角标的缩略图并单独截图
const thumb = page.locator('.mp-thumb').first();
if (await thumb.count()) {
  await thumb.screenshot({ path: 'shot_thumb.png' });
}
console.log('thumb count:', await page.locator('.mp-thumb').count());
console.log('fp badge count:', await page.locator('.mp-fp-badge').count());
console.log('errors:', errors.join(' | '));
await browser.close();
