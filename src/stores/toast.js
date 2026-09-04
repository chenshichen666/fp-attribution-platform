import { defineStore } from 'pinia'

let seed = 0
export const useToastStore = defineStore('toast', {
  state: () => ({ list: [] }),
  actions: {
    push(message, type = 'info') {
      const id = ++seed
      this.list.push({ id, message, type })
      setTimeout(() => this.remove(id), 2600)
    },
    success(m) { this.push(m, 'success') },
    warn(m) { this.push(m, 'warn') },
    info(m) { this.push(m, 'info') },
    error(m) { this.push(m, 'error') },
    remove(id) { this.list = this.list.filter((t) => t.id !== id) },
  },
})
