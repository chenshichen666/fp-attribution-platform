/**
 * 素材预览公共工具（直连为主 + 代理兜底 方案）
 *
 * 背景与结论（已实测验证）：
 *  - 业务里 element_value 存的是带完整签名参数的 CDN 直链（cdn.example.com 等）。
 *  - 带签名直连返回的是完整可播放的 MP4（curl 实测 .f0.mp4 文件头为 ftypisomiso2avc1mp41，
 *    h264/avc1 标准视频；content-type 虽被 CDN 标为 audio/mp4，但字节流完整，<video> 可正常内嵌）。
 *  - 之前误把 .f0.mp4 当「坏分片」是因为复现时用了「去掉签名」的裸链，CDN 回源才返回 deflate 垃圾；
 *    真实带签名链接不会。故不再做任何分片替换 / 排除，所有媒体直链一律直接内嵌预览。
 *
 * 三层兜底架构（方案 A：直连优先、代理兜底）：
 *  - 主路径：前端 <img>/<video> 直接内嵌 previewSrc(rawUrl) 直连（已含 dis_t 续期 + http→https 升级）。
 *  - 二级兜底：直连失败 → 回退 /api/media-proxy，由服务端（腾讯内网）续期 dis_t 代拉，
 *    覆盖「终端用户网络够不到公网 CDN、但服务端内网可达」的场景。
 *  - 终路径：代理仍失败 → 隐藏破图，显示「↗ 原素材」新标签逃生通道（原始直链存 data-raw-url）。
 *  - 微信视频等必须签名 CDN（video.qq.com）直连即失败，跳过代理，直接走终路径新标签打开。
 */

/**
 * 仅当原始值为合法 http(s) 链接时才处理，避免把纯文本/名称（如广告主名）当相对路径。
 */
function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u)
}

/**
 * 还原可能被 HTML 实体转义的 URL（如 &amp; → &）。
 * 业务里 element_value 存的是带签名参数的 CDN 直链，参数间用 & 分隔；
 * 若数据链路中意外混入了 &amp; 等 HTML 实体，绑到 <img>/<video> 的 src 时
 * CDN 将无法解析签名参数（dis_k/dis_t/ck 等），从而返回 403/坏图并触发
 * "Resource loading error"。在直连入口统一还原，避免各视图各自处理。
 */
// 注意正则加 i 标志（大小写不敏感）：上游数据可能把 & 写成大写 &AMP;，
// 若只匹配小写会漏解，导致签名参数（dis_k/dis_t/ck）仍带 &AMP; 无法被 CDN 解析 → Resource loading error。
const HTML_ENTITY_RE = /&amp;|&#38;|&lt;|&gt;|&quot;|&#39;|&AMP;|&LT;|&GT;|&QUOT;|&apos;|&#\d+;|&#x[0-9a-fA-F]+;/gi
const HTML_ENTITY_MAP = {
  '&amp;': '&', '&#38;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&AMP;': '&', '&LT;': '<', '&GT;': '>', '&QUOT;': '"', '&apos;': "'",
}
function _decodeOne(m) {
  if (HTML_ENTITY_MAP[m]) return HTML_ENTITY_MAP[m]
  // 数字实体 &#NN; / &#xHH; → 对应字符（仅还原 & 相关常见场景，避免引入不可见字符）
  if (/^&#(\d+);$/.test(m)) {
    const c = String.fromCharCode(Number(m.replace(/[^0-9]/g, '')))
    return c === '&' ? '&' : m
  }
  if (/^&#x([0-9a-fA-F]+);$/.test(m)) {
    const c = String.fromCharCode(parseInt(m.replace(/[^0-9a-fA-F]/g, ''), 16))
    return c === '&' ? '&' : m
  }
  return m
}
function decodeHtmlEntities(u) {
  if (!u || typeof u !== 'string') return u
  let out = u
  // 先还原「URL 编码的 &」：部分数据链路会把签名参数先做 encodeURIComponent，
  // 得到 %26amp; 或 %26（& 的百分号编码），再叠加 HTML 实体转义。
  // 若不先还原 %26，下方 HTML 实体正则只能命中字面 &amp;，漏掉 %26amp; 类，
  // 导致 CDN 仍收到含 %26 的签名参数 → 解析失败 → Resource loading error。
  if (out.includes('%26')) {
    try { out = decodeURIComponent(out) } catch { /* 非标准编码时忽略，避免抛错 */ }
  }
  // 递归还原：业务数据里可能出现「双层/多层 HTML 实体转义」（& → &amp; → &amp;amp;），
  // 仅做一次 replace 会把 &amp;amp; 变成 &amp;，CDN 仍无法解析签名参数（dis_k/dis_t/ck），
  // 表现为浏览器报 Resource loading error。故循环解码直到字符串不再变化。
  // 上限提到 20 次：极少数三层以上嵌套也能完全还原（防御异常，理论上很快收敛）。
  let prev = out
  out = out.replace(HTML_ENTITY_RE, _decodeOne)
  let guard = 0
  while (out !== prev && guard < 20) {
    prev = out
    out = out.replace(HTML_ENTITY_RE, _decodeOne)
    guard++
  }
  // 兜底：极端情况下仍残留 %26（嵌套 encodeURIComponent %2526 等），再解一次
  if (out.includes('%26')) {
    try { out = decodeURIComponent(out) } catch { /* ignore */ }
  }
  return out
}

/**
 * 广告素材 CDN（cdn.example.com 等）的签名依赖 dis_t（Unix 时间戳，秒）。
 * 后端 server/src/index.js 的 /api/media-sign 经实测：dis_k 等原签名鉴权有效期极长，
 * 但 dis_t 一旦过期 CDN 会拒绝（典型 403 / 坏图 → 浏览器报 Resource loading error）。
 * 续期方式：仅把 dis_t / _t 刷新为当前时间戳，保留其余原签名参数即可覆盖大部分过期场景。
 * 该函数与后端 /api/media-sign 行为一致，且为纯同步本地操作（不发起请求），
 * 满足 previewSrc 必须同步返回字符串的约束，避免 [object Promise] 二次错误。
 */
const AD_CDN_HOST_RE = /(adsmind|gdtimg\.com|gtiimg\.com|adsmind\.qq\.com|qq\.com)$/i
// 强签名参数：sha256/ck/m/sign/token 等与 dis_t 绑定校验，刷新 dis_t 会导致这些签名失效，
// CDN 校验失败返回 403/坏数据 → 浏览器报 Resource loading error。
// 此类 URL 必须保持原始签名整体不变（原始 dis_t 有效期较长），仅对「只含 dis_k/dis_t」的
// 宽松鉴权链接做 dis_t 刷新。
const STRONG_SIGN_KEYS = ['sha256', 'ck', 'm', 'sign', 'token', 'x-snsvideoflag', 'auth_key', 'expires']
function refreshAdCdnSign(u) {
  if (!u || typeof u !== 'string') return u
  // 关键修复：若 URL 仍含 HTML 实体（如 &amp;dis_t=），new URL() 会把 &amp; 当普通路径字符，
  // 导致下方 dis_t 续期正则 [?.&](dis_t)= 命中不到「&amp;dis_t=」，签名时间戳无法刷新，
  // CDN 仍用过期 dis_t 拒绝请求 → 浏览器报 Resource loading error。
  // 故先递归解码实体，再走 URL 解析与续期，保证带实体签名链接也能正确续期。
  const decoded = decodeHtmlEntities(u)
  let parsed = null
  try {
    parsed = new URL(decoded)
  } catch {
    return u
  }
  const host = parsed.hostname.toLowerCase()
  if (!AD_CDN_HOST_RE.test(host)) return u
  // 带强签名参数的链接：dis_t 与 sha256/ck/m 等强校验绑定，刷新 dis_t 会破坏签名反而导致
  // CDN 拒绝。保持原始签名直链整体不变（sha256 校验可正常通过），交由直连原链/代理兜底处理。
  if (STRONG_SIGN_KEYS.some(k => parsed.searchParams.has(k))) return decoded
  // 基于已解码的 decoded 做续期：dis_t / _t 参数只以标准 & 分隔（实体已在上面解回 &）。
  const hasDisT = /[?&](dis_t)=[^&]+/.test(decoded)
  const has_T = /[?&](_t)=[^&]+/.test(decoded)
  if (!hasDisT && !has_T) return decoded
  const now = String(Math.floor(Date.now() / 1000))
  let out = decoded
  if (hasDisT) out = out.replace(/([?&])(dis_t)=[^&]+/g, `$1$2=${now}`)
  if (has_T) out = out.replace(/([?&])(_t)=[^&]+/g, `$1$2=${now}`)
  return out
}

/**
 * 兼容旧调用：不再做分片替换，原样返回。
 * （历史上曾把 .f0.mp4 → .f20.mp4，实测 .f0 带签名可正常播放，替换反而可能命中 404 分片，故取消。）
 */
export function preferStableShard(rawUrl) {
  return rawUrl
}

/**
 * 兼容旧调用：不再有「坏分片」概念，所有媒体直链都尝试内嵌，永远返回 false。
 */
export function isBadShardUrl() {
  return false
}

/**
 * 将原始素材 URL 归一化为 https（规避混合内容）。
 * 非 http(s) 的纯文本/名称（如广告主名）返回空，避免相对路径解析报错。
 * @param {string} rawUrl 原始素材 URL
 * @returns {string} 内嵌 src / 打开链接
 */
export function rawHttpsUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  // 先还原可能被实体转义的 &amp; 等，否则签名参数（dis_k/dis_t/ck）无法被 CDN 解析
  rawUrl = decodeHtmlEntities(rawUrl)
  // 直连 CDN 预览，纯前端同步续期过期的 dis_t 时间戳（不走后端 /api/media-proxy 代理）。
  // 广告素材 CDN 的 dis_t 是 Unix 秒级时间戳，过期后 CDN 会拒绝并返回坏数据（Resource loading error）。
  // 仅把 dis_t / _t 刷新为当前时间、保留其余原签名（dis_k 鉴权有效期极长）即可正常内嵌；
  // 若个别边缘节点对「新 dis_t + 旧 dis_k」组合异常，加载失败时由 onMediaError 回退到
  // 数据库最原始的签名直链（rawHttpsUrlPlain）再尝试一次，仍失败才「打开原链接」逃生。
  rawUrl = refreshAdCdnSign(rawUrl)
  if (!isHttpUrl(rawUrl)) return ''
  if (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:') {
    if (rawUrl.startsWith('http://')) {
      return rawUrl.replace(/^http:\/\//i, 'https://')
    }
  }
  return rawUrl
}

/**
 * 仅做「实体还原 + http→https 升级」的直连地址，**不做 dis_t 重签**。
 * 用于 onMediaError 兜底重试与「↗ 原素材」逃生链接：
 * －部分 CDN 边缘节点对「dis_t 被刷新 + 原始 dis_k」的组合会返回异常，
 *   此时回退到数据库里最原始的签名直链（dis_t 仍有效，后端实测有效期极长）最稳妥。
 */
export function rawHttpsUrlPlain(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  rawUrl = decodeHtmlEntities(rawUrl)
  if (!isHttpUrl(rawUrl)) return ''
  if (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:') {
    if (rawUrl.startsWith('http://')) {
      return rawUrl.replace(/^http:\/\//i, 'https://')
    }
  }
  return rawUrl
}

/**
 * 返回内嵌用的 src（直连 CDN，仅做 http→https 升级）。
 * 预览默认走直连、不做分片替换；直连失败时由 onMediaError / 各视图错误处理器
 * 回退到 proxyUrl（后端 /api/media-proxy 服务端续期 dis_t 代拉）再兜底，仍失败才「↗ 原素材」。
 * @param {string} rawUrl 原始素材 URL
 * @returns {string} 直连 src
 */
export function previewSrc(rawUrl) {
  if (!rawUrl) return ''
  // 出口幂等保险：rawHttpsUrl 内部已 decode，此处再解一次仅防极端双层实体漏网，
  // 保证落到 <img>/<video> src 的字符串绝不含 &amp; 等 HTML 实体（否则 CDN 解析签名参数失败）。
  return decodeHtmlEntities(rawHttpsUrl(rawUrl))
}

/**
 * 代理兜底地址：当「直连 CDN」失败时，经后端 /api/media-proxy 服务端续期 dis_t 代拉。
 * 仅作二级兜底使用（封面/直连已优先），覆盖「终端用户网络够不到公网 CDN、但服务端内网可达」的场景。
 * 注意：微信视频等必须签名 CDN（video.qq.com）直连即失败，跳过代理（代理也无法恢复 token），直接走原素材。
 * @param {string} rawUrl 原始素材 URL
 * @returns {string} 后端代理地址（/api/media-proxy?url=<encoded>）
 */
export function proxyUrl(rawUrl) {
  if (!rawUrl || !isHttpUrl(rawUrl)) return ''
  const decoded = decodeHtmlEntities(rawUrl)
  const enc = encodeURIComponent(decoded) // 双层实体已还原，单次编码交给后端解析即可，避免双重编码
  return `/api/media-proxy?url=${enc}`
}

/**
 * 是否必须签名 CDN（代理无法恢复，直连失败应直接走「原素材」新标签）。
 * 覆盖微信视频临时链接 findera*.video.qq.com / stodownload。
 */
export function isSignedOnlyCdn(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false
  try {
    const u = new URL(rawUrl)
    const host = u.hostname.toLowerCase()
    const path = u.pathname.toLowerCase()
    return host.endsWith('.video.qq.com') || path.includes('stodownload') || host.startsWith('findera')
  } catch {
    return false
  }
}

/**
 * 顶层导航打开原始直链（新标签）。直连 CDN 可正常播放。
 * @param {string} rawUrl 原始素材 URL
 */
export function openOriginal(rawUrl) {
  if (!rawUrl || !isHttpUrl(rawUrl)) return
  const url = rawHttpsUrl(rawUrl)
  try {
    window.open(url, '_blank', 'noopener')
  } catch {
    window.open(url, '_blank')
  }
}

/**
 * 已知「无扩展名也应尝试内嵌」的媒体 CDN 域名后缀。
 * 覆盖：腾讯广告素材 gdtimg/gtimg、微信社交广告 gtiimg.com（pgdt.gtiimg.com 等，无扩展名 snscosdow 链接）、
 *       qpic/myqcloud 等。注意故意不含裸 qq.com，避免把微信视频 video.qq.com（需 token）误判。
 */
const CDN_MEDIA_HOSTS = ['gtimg.cn', 'gtimg.com', 'qpic.cn', 'myqcloud.com', 'tencent-cloud.com']
export function isCdnMediaHost(url) {
  if (!url || typeof url !== 'string') return false
  try {
    return CDN_MEDIA_HOSTS.some(h => new URL(url).hostname.toLowerCase().endsWith(h))
  } catch {
    return false
  }
}

const MEDIA_EXT_RE = /\.(jpg|jpeg|png|webp|gif|bmp|mp4|mov|avi|webm|mkv|flv|m4v|3gp|ogv|ts)(\?|$)/i

const VIDEO_EXT = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'flv', 'm4v', '3gp', 'ogv', 'ts']
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']

/**
 * 通过 URL 后缀判断是否为视频（兜底逻辑，当 isVideo 字段缺失时使用）。
 * 与各组件（PreviewAnnotate / TicketsView / SedimentView 等）本地实现保持一致。
 */
export function isVideoByUrl(url) {
  if (!url || typeof url !== 'string') return false
  const clean = url.split('?')[0].split('#')[0]
  const m = clean.match(/\.([a-zA-Z0-9]+)$/)
  const ext = m ? m[1].toLowerCase() : ''
  if (VIDEO_EXT.includes(ext)) return true
  if (IMAGE_EXT.includes(ext)) return false
  if (/video/i.test(clean)) return true
  return false
}

/**
 * 权威媒体判定：有媒体扩展名 → true；无扩展名但属已知媒体 CDN（如 gtiimg.com/snscosdow）→ 也应尝试内嵌。
 * 不再排除任何分片（.f0.mp4 等均可内嵌）。各视图统一复用本函数，口径一致。
 */
export function isMediaUrl(url) {
  if (!url || typeof url !== 'string') return false
  if (MEDIA_EXT_RE.test(url)) return true
  if (isCdnMediaHost(url)) return true
  return false
}

/**
 * 兼容旧调用：re-sign 已废弃，直接返回直连 src。
 * @param {string} rawUrl 原始素材 URL
 * @returns {Promise<string>} 直连 src
 */
export async function fetchSignedSrc(rawUrl) {
  return previewSrc(rawUrl)
}

/**
 * 给一个 <img> 元素用「原始直连（不重签）」重试一次。
 * 由各视图的 onErr/onMediaErr 在首次失败时调用：先尝试数据库最原始的签名直链，
 * 成功则不降级；仍失败（第二次 error）才交给降级逻辑。
 * @param {HTMLElement} el 触发 error 的 <img>
 * @returns {boolean} true 表示已发起重试（不应立即降级）
 */
export function retryOriginalSrc(el) {
  if (!el || el.tagName !== 'IMG') return false
  if (el.dataset.__retry) return false
  el.dataset.__retry = '1'
  const raw = el.getAttribute('data-raw-url') || el.src || ''
  const plain = rawHttpsUrlPlain(raw)
  if (plain && plain !== el.src) {
    el.src = plain
    return true
  }
  return false
}

/**
 * 显示「↗ 原素材」终路径逃生链接（新标签打开原始直链）。
 * 用于三层兜底的最末端：直连 + 代理均失败时，绝不卡破图。
 * @param {HTMLElement} parent 父容器
 * @param {string} rawUrl 原始素材 URL
 */
function showOriginalLink(parent, rawUrl) {
  if (!parent || parent.querySelector('.media-err-fallback')) return
  const link = document.createElement('a')
  link.className = 'media-err-fallback'
  link.href = rawHttpsUrlPlain(rawUrl)
  link.target = '_blank'
  link.rel = 'noopener'
  link.textContent = '↗ 原素材'
  link.style.cssText =
    'display:inline-flex;align-items:center;gap:4px;padding:6px 10px;border-radius:8px;' +
    'background:rgba(79,124,255,.12);color:#4f7cff;font-size:12px;text-decoration:none;' +
    'border:1px solid rgba(79,124,255,.3)'
  parent.appendChild(link)
}

/**
 * 二级兜底：直连失败后回退到后端 /api/media-proxy 代理（服务端续期 dis_t 代拉）。
 * 返回 true 表示已切到代理路径（不应立即降级到原素材）。
 * 微信视频等必须签名 CDN 直接返回 false（代理无法恢复 token），交由上层走原素材。
 * @param {HTMLElement} el 触发 error 的 <img>/<video>
 * @returns {boolean}
 */
function fallbackToProxy(el) {
  if (!el) return false
  if (el.dataset.__tier === 'proxy') return false // 已在代理层，避免死循环
  const raw = el.getAttribute('data-raw-url') || el.src || ''
  if (isSignedOnlyCdn(raw)) return false // 必须签名 CDN，代理无意义
  const pu = proxyUrl(raw)
  if (!pu) return false
  el.dataset.__tier = 'proxy'
  el.dataset.__mediaErrRetry = '1'
  if (el.tagName === 'VIDEO') {
    el.src = pu
    try { el.load && el.load() } catch { /* ignore */ }
  } else {
    el.src = pu
  }
  return true
}

/**
 * 素材加载失败的统一兜底（三层链）：
 *   1) 直连失败 → 用「原始直连（仅 https 升级、不重签 dis_t）」重试一次
 *   2) 仍失败 → 回退后端 /api/media-proxy 代理（服务端续期 dis_t 代拉）
 *   3) 仍失败 → 隐藏破图，显示「↗ 原素材」新标签逃生通道
 * 用法：<img :src="previewSrc(u)" :data-raw-url="u" @error="onMediaError" />
 * @param {Event} event 错误事件
 */
export function onMediaError(event) {
  const el = event && event.target
  if (!el) return
  if (el.dataset.__mediaErrHandled) return

  const rawUrl = el.getAttribute('data-raw-url') || el.src || ''

  // 层级 1：直连主路径已对广告 CDN 刷新 dis_t；若个别边缘对「新 dis_t + 原始 dis_k」组合异常，
  // 先回退到数据库最原始签名直链（dis_t 未刷新）再尝试一次。
  if (!el.dataset.__mediaErrRetry) {
    el.dataset.__mediaErrRetry = '1'
    const plain = rawHttpsUrlPlain(rawUrl)
    if (plain && plain !== el.src) {
      el.src = plain
      return
    }
  }

  // 层级 2：直连重试仍失败 → 二级兜底走后端代理（服务端内网代拉，续期 dis_t）。
  if (fallbackToProxy(el)) return

  // 层级 3：代理仍失败 → 隐藏破图，露出「↗ 原素材」逃生链接。
  el.dataset.__mediaErrHandled = '1'
  el.style.display = 'none'
  showOriginalLink(el.parentElement, rawUrl)
}

/**
 * 供各视图自定义错误处理器（onErr / onMediaErr / onResultMediaErr）复用的代理兜底。
 * 在「直连重试一次仍失败」之后调用：尝试切到代理路径，返回是否已切（true 则不再降级）。
 * @param {HTMLElement} el 触发 error 的媒体元素
 * @returns {boolean} true 表示已切到代理路径
 */
export function mediaProxyFallback(el) {
  return fallbackToProxy(el)
}
