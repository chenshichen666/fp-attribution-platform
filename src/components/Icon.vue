<script setup>
defineProps({ name: { type: String, required: true }, size: { type: [Number, String], default: 18 } })
const P = {
  target: '<circle cx="12" cy="12" r="9"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="2.5"/>',
  analysis: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M7 21h10M12 17v4M8 13l2.5-3 2.5 2 3-4"/>',
  classify: '<path d="M3 8.5l8.4-4.7a1 1 0 011 0L21 8.5M3 8.5v7l8.4 4.7a1 1 0 001 0L21 15.5v-7M3 8.5l9 5 9-5"/>',
  ticket: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M8 14h5"/>',
  sediment: '<path d="M4 5h16M4 5v14a2 2 0 002 2h12a2 2 0 002-2V5"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 00-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 00-1.7-1l-.3-2.5h-4l-.3 2.5a7 7 0 00-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 000 2l-2 1.5 2 3.4 2.3-1a7 7 0 001.7 1l.3 2.5h4l.3-2.5a7 7 0 001.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z"/>',
  feedback: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
  doubleLeft: '<path d="M11 6l-6 6 6 6M18 6l-6 6 6 6"/>',
  doubleRight: '<path d="M13 6l6 6-6 6M6 6l6 6-6 6"/>',
  upload: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 9l5-5 5 5M12 4v12"/>',
  refresh: '<path d="M21 12a9 9 0 11-3-6.7M21 3v5h-5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>',
  precision: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  fpcount: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>',
  tagcount: '<path d="M3.6 11.2l7.6-7.6a2 2 0 011.4-.6H19a2 2 0 012 2v6.4a2 2 0 01-.6 1.4l-7.6 7.6a2 2 0 01-2.8 0l-6.4-6.4a2 2 0 010-2.8z"/><circle cx="16" cy="8" r="1.5"/>',
  sample: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M9 21V9" opacity="0.9"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<rect x="3" y="3" width="7.2" height="7.2" rx="1.6"/><rect x="13.8" y="3" width="7.2" height="7.2" rx="1.6"/><rect x="3" y="13.8" width="7.2" height="7.2" rx="1.6"/><rect x="13.8" y="13.8" width="7.2" height="7.2" rx="1.6"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M17 5.5a3.5 3.5 0 010 6.5M22 20a6.5 6.5 0 00-5-6.3"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  chart: '<path d="M4 4v16h16M8 16V9M12 16V5M16 16v-5M20 16v-9"/>',
  robot: '<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01M8 19v2M16 19v2"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 14h4M17 9h4M17 14h4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  link: '<path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1.5 1.5M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1.5-1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  doc: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  newchat: '<path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5"/><path d="M19 4v6M22 7h-6"/>',
  sparkle: '<path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15l-1.8-4.2L5.5 9l4.7-1.3z"/><path d="M19 14l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/><path d="M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  history: '<path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  'layout-dashboard': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  tags: '<path d="M3 7v5.5a2 2 0 00.6 1.4l7 7a2 2 0 002.8 0l5.6-5.6a2 2 0 000-2.8l-7-7A2 2 0 0010.5 5H5a2 2 0 00-2 2z"/><circle cx="7.5" cy="11.5" r="1.3"/><path d="M14 4l5.4 5.4a2 2 0 010 2.8l-3 3"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  'scatter-chart': '<circle cx="6" cy="18" r="2"/><circle cx="10" cy="10" r="2"/><circle cx="14" cy="14" r="2"/><circle cx="18" cy="6" r="2"/><path d="M3 3v18h18" opacity="0.4"/>',
  'bar-chart-3': '<path d="M3 3v18h18M8 17v-5M13 17V8M18 17v-9"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M9.9 4.24A9.12 9.12 0 0112 4c6.5 0 10 8 10 8a13.16 13.16 0 01-1.67 2.68M6.61 6.61A13.526 13.526 0 002 12s3.5 8 10 8a9.12 9.12 0 005.39-1.61M1 1l22 22M9.5 9.5a3 3 0 004.24 4.24"/>',
  alertTriangle: '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  save: '<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  loading: '<path d="M12 3a9 9 0 109 9" opacity=".9"/>',
}
</script>
<template>
  <svg class="icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" v-html="P[name] || ''" />
</template>
<style scoped>
.icon {
  flex-shrink: 0;
  vertical-align: middle;
  transition: transform .2s cubic-bezier(.4, 0, .2, 1), opacity .2s ease;
  overflow: visible;
}
</style>