// 全局轻量 tooltip 指令：v-tip="'文字'" 或 v-tip.bottom / v-tip.left / v-tip.right
// 在元素 hover/focus 时显示气泡解释，离开时移除，自动避免溢出视口。

let tipEl = null
let hideTimer = null

function ensureEl() {
  if (tipEl) return tipEl
  tipEl = document.createElement('div')
  tipEl.className = 'g-tip'
  tipEl.setAttribute('role', 'tooltip')
  document.body.appendChild(tipEl)
  return tipEl
}

function place(target, text, placement) {
  if (!text) return
  const el = ensureEl()
  clearTimeout(hideTimer)
  el.textContent = text
  el.dataset.place = placement
  el.classList.add('show')

  const r = target.getBoundingClientRect()
  const tr = el.getBoundingClientRect()
  const gap = 8
  let top = 0, left = 0

  switch (placement) {
    case 'bottom': top = r.bottom + gap; left = r.left + r.width / 2 - tr.width / 2; break
    case 'left': top = r.top + r.height / 2 - tr.height / 2; left = r.left - tr.width - gap; break
    case 'right': top = r.top + r.height / 2 - tr.height / 2; left = r.right + gap; break
    default: top = r.top - tr.height - gap; left = r.left + r.width / 2 - tr.width / 2 // top
  }
  // 防止水平溢出
  const margin = 6
  left = Math.max(margin, Math.min(left, window.innerWidth - tr.width - margin))
  top = Math.max(margin, Math.min(top, window.innerHeight - tr.height - margin))
  el.style.top = `${top}px`
  el.style.left = `${left}px`
}

function hide() {
  if (!tipEl) return
  hideTimer = setTimeout(() => { tipEl && tipEl.classList.remove('show') }, 40)
}

function getPlacement(modifiers) {
  if (modifiers.bottom) return 'bottom'
  if (modifiers.left) return 'left'
  if (modifiers.right) return 'right'
  return 'top'
}

export default {
  mounted(el, binding) {
    const placement = getPlacement(binding.modifiers)
    el._tipText = binding.value
    el._tipShow = () => place(el, el._tipText, placement)
    el._tipHide = hide
    el.addEventListener('mouseenter', el._tipShow)
    el.addEventListener('mouseleave', el._tipHide)
    el.addEventListener('focus', el._tipShow)
    el.addEventListener('blur', el._tipHide)
    el.addEventListener('click', el._tipHide)
  },
  updated(el, binding) { el._tipText = binding.value },
  beforeUnmount(el) {
    if (el._tipShow) {
      el.removeEventListener('mouseenter', el._tipShow)
      el.removeEventListener('mouseleave', el._tipHide)
      el.removeEventListener('focus', el._tipShow)
      el.removeEventListener('blur', el._tipHide)
      el.removeEventListener('click', el._tipHide)
    }
    hide()
  },
}
