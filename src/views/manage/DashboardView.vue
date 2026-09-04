<script setup>
import { computed, ref, onMounted } from 'vue'
import Icon from '../../components/Icon.vue'
import KpiCard from '../../components/KpiCard.vue'
import EChart from '../../components/EChart.vue'
import { useToastStore } from '../../stores/toast'
import { dashboardApi } from '../../api'

const toast = useToastStore()
const d = ref({
  totalTickets: 0, adoptedCount: 0, avgHandleHours: 0, activeHandlers: 0,
  byStatus: [], weeklyTickets: [], topFpTags: [],
})

async function loadDashboard() {
  try {
    d.value = await dashboardApi.get()
  } catch (e) {
    toast.warn(e.message || '加载数据大盘失败')
  }
}
onMounted(loadDashboard)

const pieOption = computed(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
  legend: { bottom: 0, icon: 'circle', textStyle: { color: '#5a6478', fontSize: 12 } },
  series: [{
    type: 'pie', radius: ['48%', '70%'], center: ['50%', '42%'],
    itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 3 },
    label: { show: false },
    data: d.value.byStatus.map((s, i) => ({
      ...s,
      itemStyle: { color: ['#4f7cff', '#f5a000', '#1fb574', '#8b94a8'][i] }
    }))
  }]
}))

const barOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 8, right: 20, top: 20, bottom: 8, containLabel: true },
  xAxis: {
    type: 'category', data: d.value.weeklyTickets.map(t => t.day),
    axisLine: { lineStyle: { color: '#e0e4ec' } },
    axisTick: { show: false },
    axisLabel: { color: '#8b94a8' }
  },
  yAxis: {
    type: 'value', axisLine: { show: false }, axisTick: { show: false },
    splitLine: { lineStyle: { color: '#f0f2f6' } },
    axisLabel: { color: '#8b94a8' }
  },
  series: [{
    type: 'bar', barWidth: '40%', borderRadius: [6, 6, 0, 0],
    data: d.value.weeklyTickets.map(t => t.value),
    itemStyle: { color: '#4f7cff' }
  }]
}))

const topTags = computed(() => [...d.value.topFpTags].sort((a, b) => b.fp - a.fp))
</script>

<template>
  <div class="page-wrap">
    <div class="ph">
      <h1 class="page-title"><Icon name="chart" :size="22" />数据大盘</h1>
      <p class="page-sub">工单总量 · 误杀标签排行 · 处理效率 · 行业分布</p>
    </div>

    <!-- KPI -->
    <div class="kpi-row">
      <KpiCard icon="ticket" label="工单总量" :value="d.totalTickets" color="blue" />
      <KpiCard icon="checkCircle" label="已采纳" :value="d.adoptedCount" color="green" />
      <KpiCard icon="clock" label="平均处理时长" :value="d.avgHandleHours" unit="h" color="orange" />
      <KpiCard icon="users" label="活跃处理人" :value="d.activeHandlers" color="purple" />
    </div>

    <!-- 图表 -->
    <div class="charts">
      <div class="card ch rise">
        <h3><Icon name="list" :size="16" />工单状态分布</h3>
        <EChart :option="pieOption" height="260px" />
      </div>
      <div class="card ch rise wide">
        <h3><Icon name="chart" :size="16" />近 7 日工单提交趋势</h3>
        <EChart :option="barOption" height="260px" />
      </div>
    </div>

    <!-- 误杀标签排行 -->
    <div class="card rise" style="margin-top: 18px; padding: 20px 24px;">
      <h3 class="sec-title"><Icon name="tagcount" :size="16" />误杀标签排行（Top 10）</h3>
      <table class="tbl">
        <thead>
          <tr>
            <th>#</th>
            <th>标签名称</th>
            <th>标签 ID</th>
            <th>误杀数</th>
            <th>工单数</th>
            <th>采纳率</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(t, i) in topTags" :key="t.id">
            <td class="rank">{{ i + 1 }}</td>
            <td><span class="tag-name">{{ t.name }}</span></td>
            <td class="mono dim">{{ t.id }}</td>
            <td><b class="num">{{ t.fp }}</b></td>
            <td>{{ t.ticketCount }}</td>
            <td>
              <span class="badge" :class="t.adoptRate >= 80 ? 'badge-green' : t.adoptRate >= 50 ? 'badge-orange' : 'badge-gray'">
                {{ t.adoptRate }}%
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.ph { margin-bottom: 20px; }
.kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; margin-bottom: 18px; }
.charts { display: grid; grid-template-columns: 360px 1fr; gap: 18px; }
.ch { padding: 20px 24px; }
.ch h3 { font-size: 14px; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
.sec-title { font-size: 15px; font-weight: 700; margin-bottom: 14px; display: flex; align-items: center; gap: 6px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; padding: 10px 12px; color: var(--text-3); font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border); }
.tbl td { padding: 12px; border-bottom: 1px solid var(--border); }
.rank { font-weight: 700; color: var(--text-3); font-size: 14px; width: 36px; }
.tag-name { font-weight: 600; }
.mono { font-family: monospace; font-size: 12px; }
.dim { color: var(--text-4); }
.num { font-size: 15px; color: var(--red); }
@media (max-width: 1000px) { .kpi-row { grid-template-columns: repeat(2, 1fr); } .charts { grid-template-columns: 1fr; } }
</style>
