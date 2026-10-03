<template>
  <section class="page" data-module="householdservice">
    <header class="page-head">
      <div>
        <h2>入户服务管理</h2>
        <p class="page-desc">
          停暖通知撤销后会回写顶部「待补发清单」，同一通知只落一条；片区值班人照单补发后点完成补发即销项。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记入户服务单</button>
        <button class="btn" type="button" @click="exportRows">导出入户服务清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="{ alert: item.label.includes('待补发') && item.value > 0 }">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 片区值班人一眼看清少发的那几条 -->
    <section class="resend-panel" :class="{ empty: !resendRows.length }">
      <header class="resend-head">
        <h3>待补发清单（通知撤销后少发的 {{ resendRows.length }} 条）</h3>
        <span class="resend-hint">按来源通知编号去重，重复撤销不会重复落单</span>
      </header>
      <table class="data-table resend-table">
        <thead>
          <tr>
            <th>服务单号</th>
            <th>来源通知编号</th>
            <th>影响片区</th>
            <th>报修用户</th>
            <th>服务内容</th>
            <th>当前状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in resendRows" :key="String(row.id)">
            <td>{{ row['服务单号'] ?? '—' }}</td>
            <td><strong>{{ row['来源通知编号'] ?? '—' }}</strong></td>
            <td>{{ row['影响片区'] || '片区缺失' }}</td>
            <td>{{ row['报修用户'] ?? '—' }}</td>
            <td>{{ row['服务内容'] ?? '—' }}</td>
            <td><span class="status-tag">{{ row.status }}</span></td>
            <td class="row-actions">
              <button class="link" type="button" @click="finishResend(row)">完成补发</button>
            </td>
          </tr>
          <tr v-if="!resendRows.length">
            <td colspan="7" class="empty-state">暂无少发待补发的通知，撤销通知后会自动进入这里</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无常规入户服务数据（待补发记录见上方清单）</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>常规台账共 {{ total }} 条；待补发 {{ resendRows.length }} 条另列在上方</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  completeResend,
  downloadEntries,
  listHouseholdEntries,
  listResendQueue,
  listRowsOfHousehold,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('householdservice')
const columns = ['服务单号', '报修用户', '服务内容', '受理人', '上门时间', '处理结果', '回访日期', '服务状态', '来源通知编号', '影响片区']
const actions = ['受理报修', '登记处理', '完成回访']
const statuses = ['待受理', '已安排', '已处理', '已回访', '待补发']

const rows = ref<EntryRow[]>([])
const resendRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '待受理服务单', value: countByStatus('待受理') },
  { label: '待补发服务单', value: resendRows.value.length },
  { label: '已处理服务单', value: countByStatus('已处理') },
  { label: '待回访服务单', value: countByStatus('已安排') },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: status === '待补发' ? resendRows.value.length : countByStatus(status),
  })),
)

function countByStatus(status: string): number {
  return listRowsOfHousehold().filter((row) => String(row.status) === status).length
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '入户服务单登记入口尚未接入审批流（撤销通知会自动生成待补发记录）'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function finishResend(row: EntryRow) {
  errorMessage.value = ''
  const result = completeResend(Number(row.id))
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listHouseholdEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    resendRows.value = listResendQueue().items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入户服务列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.stat-card.alert {
  border-color: #d92d20;
  background: #fff5f4;
}
.stat-card.alert .stat-value {
  color: #d92d20;
}
.resend-panel {
  border: 2px solid #d92d20;
  border-radius: 10px;
  background: #fff5f4;
  padding: 12px;
  margin-bottom: 14px;
}
.resend-panel.empty {
  border-color: var(--border);
  background: #fafbfc;
}
.resend-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 8px;
}
.resend-head h3 {
  margin: 0;
  font-size: 15px;
  color: #b42318;
}
.resend-panel.empty .resend-head h3 {
  color: var(--muted);
}
.resend-hint {
  font-size: 12px;
  color: var(--muted);
}
.resend-table th,
.resend-table td {
  background: #fff;
}
.status-tag {
  background: #fee4e2;
  color: #b42318;
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 12px;
}
</style>
