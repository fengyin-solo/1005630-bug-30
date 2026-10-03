<template>
  <section class="page" data-module="householdservice">
    <header class="page-head">
      <div>
        <h2>入户服务管理</h2>
        <p class="page-desc">维护入户服务单，围绕服务单号、报修用户、服务内容、受理人做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记入户服务单</button>
        <button class="btn" type="button" @click="exportRows">导出入户服务清单</button>
      </div>
    </header>

    <!-- 片区值班人最关心的一块：撤销通知回写过来、还没补发的那几条 -->
    <section v-if="resendRows.length" class="resend-panel">
      <header class="resend-head">
        <strong>待补发清单</strong>
        <span class="resend-count">{{ resendRows.length }} 条</span>
        <span class="resend-hint">停暖通知撤销后自动回写，向住户补发停暖取消说明后核销</span>
      </header>
      <ul class="resend-list">
        <li v-for="row in resendRows" :key="String(row.id)" class="resend-item">
          <span class="resend-no">{{ row['服务单号'] }}</span>
          <span class="resend-notice">来源通知：{{ row['关联通知编号'] }}</span>
          <span class="resend-user">{{ row['报修用户'] }}</span>
          <span class="resend-time">撤销时间：{{ row['撤销时间'] }}</span>
          <button class="btn btn-small primary" type="button" @click="runAction('完成补发', row)">完成补发</button>
        </li>
      </ul>
    </section>
    <section v-else class="resend-panel resend-empty">
      <strong>待补发清单</strong>
      <span class="resend-hint">暂无少发记录，撤销停暖通知后会自动回写到这里</span>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="{ 'stat-alert': item.alert }">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item" :class="{ 'legend-warn': item.status === '待补发' }">
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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-resend': isResend(row) }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '清单类型'">
              <span :class="['tag', isResend(row) ? 'tag-warn' : 'tag-muted']">{{ row[column] ?? '—' }}</span>
            </template>
            <template v-else>{{ row[column] === '' ? '—' : (row[column] ?? '—') }}</template>
          </td>
          <td><span :class="['status-tag', isResend(row) ? 'tag-warn' : '']">{{ row.status }}</span></td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsFor(row).length" class="text-muted">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无入户服务数据，可先登记入户服务单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条入户服务记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  availableHouseholdActions,
  pendingResendEntries,
} from '@/domain/heatnotice'
import type { ActionResult, EntryRow } from '@/data/types'

const meta = moduleMeta('householdservice')
const columns = ["服务单号", "清单类型", "关联通知编号", "撤销时间", "报修用户", "服务内容", "受理人", "上门时间", "处理结果", "回访日期", "服务状态"]
const statuses = ["待补发", "待受理", "已安排", "已处理", "已回访"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["服务单号", "关联通知编号", "报修用户"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 待补发清单直接从台账筛，撤销回写与值班人看到的是同一份数据。
const resendRows = computed(() => pendingResendEntries(rows.value))

const stats = computed(() => [
  { label: '待补发服务单', value: resendRows.value.length, alert: resendRows.value.length > 0 },
  {
    label: '待受理服务单',
    value: rows.value.filter((row) => String(row.status) === '待受理').length,
    alert: false,
  },
  {
    label: '已处理服务单',
    value: rows.value.filter((row) => String(row.status) === '已处理').length,
    alert: false,
  },
])

function isResend(row: EntryRow): boolean {
  return String(row.status) === '待补发'
}

function actionsFor(row: EntryRow): string[] {
  return availableHouseholdActions(String(row.status))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '入户服务单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result: ActionResult = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  infoMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '入户服务列表读取失败'
  }
}

onMounted(reload)
</script>
