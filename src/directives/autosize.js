/**
 * v-autosize — textarea 自动撑高指令
 * 用法：<textarea v-autosize v-model="text" />
 * 原理：监听 input 事件 + 初始挂载时，将 textarea 高度设为 scrollHeight
 */
export default {
  mounted(el) {
    if (el.tagName !== 'TEXTAREA') return
    resize(el)
    el.addEventListener('input', () => resize(el))
  },
  updated(el) {
    if (el.tagName !== 'TEXTAREA') return
    resize(el)
  },
}

function resize(el) {
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}
