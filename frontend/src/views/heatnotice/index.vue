<template>
  <section class="page" data-module="heatnotice">
    <header class="page-head">
      <div>
        <h2>停暖通知管理</h2>
        <p class="page-desc">维护停暖通知单，围绕通知编号、影响片区、停暖原因、计划开始做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记停暖通知单</button>
        <button class="btn" type="button" @click="exportRows">导出停暖通知清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="{ 'stat-alert': item.alert }">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item" :class="{ 'legend-warn': item.warn }">
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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-revoked': isRevoked(row), 'row-suspended': isSuspended(row) }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '影响片区'">
              <span v-if="areaText(row)">{{ areaText(row) }}</span>
              <span v-else class="tag tag-warn">片区缺失</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span :class="['status-tag', statusClass(row)]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <template v-if="editingId === row.id">
              <input
                v-model="areaDraft"
                class="area-input"
                placeholder="补录影响片区，多个用、分隔"
                @keyup.enter="submitArea(row)"
              />
              <button class="link" type="button" @click="submitArea(row)">确认补录</button>
              <button class="link link-muted" type="button" @click="editingId = null">取消</button>
            </template>
            <template v-else>
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
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无停暖通知数据，可先登记停暖通知单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条停暖通知记录（已撤销单留痕但不计入发布口径）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>

    <div v-if="showCreate" class="modal-mask" @click.self="closeCreate">
      <form class="modal" @submit.prevent="submitCreate">
        <h3 class="modal-title">登记停暖通知单</h3>
        <p class="modal-tip">通知编号全局唯一，已撤销的旧单仍占号；片区可先留空，提交时按统一口径核定。</p>
        <label v-for="field in createFields" :key="field" class="form-item">
          <span>{{ field }}<em v-if="field === '通知编号'">*</em></span>
          <input v-model="createForm[field]" :placeholder="field === '影响片区' ? '多个片区用、分隔，可暂不填' : `请输入${field}`" />
        </label>
        <footer class="modal-foot">
          <span v-if="createError" class="error-text">{{ createError }}</span>
          <span class="modal-buttons">
            <button class="btn ghost" type="button" @click="closeCreate">取消</button>
            <button class="btn primary" type="submit">保存拟稿</button>
          </span>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  availableNoticeActions,
  canonicalAreaText,
  createNotice,
  NOTICE_STATUS,
  publishedAreaCount,
  publishedNotices,
} from '@/domain/heatnotice'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('heatnotice')
const columns = ["通知编号", "影响片区", "停暖原因", "计划开始", "计划恢复", "通知方式", "发布人", "通知状态"]
const statuses = ["待拟稿", "待发布", "已挂起", "已发布", "已撤销"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const editingId = ref<number | null>(null)
const areaDraft = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
    warn: status === NOTICE_STATUS.suspended,
  })),
)

// 卡片口径沿用通知口径：已发布只数在发的，影响片区取已发布通知的片区并集，已撤销/已挂起不进数。
const stats = computed(() => {
  const published = publishedNotices(rows.value)
  const pendingStatuses = new Set<string>([NOTICE_STATUS.ready, NOTICE_STATUS.draft])
  const suspended = rows.value.filter((row) => String(row.status) === NOTICE_STATUS.suspended).length
  return [
    {
      label: '待发布通知',
      value: rows.value.filter((row) => pendingStatuses.has(String(row.status))).length,
      alert: false,
    },
    { label: '已发布通知', value: published.length, alert: false },
    { label: '影响片区数', value: publishedAreaCount(rows.value), alert: false },
    { label: '挂起通知（片区缺失）', value: suspended, alert: suspended > 0 },
  ]
})

const createFields = ["通知编号", "影响片区", "停暖原因", "计划开始", "计划恢复", "通知方式", "发布人"] as const
const emptyForm = (): Record<string, string> =>
  Object.fromEntries(createFields.map((field) => [field, '']))
const showCreate = ref(false)
const createForm = reactive<Record<string, string>>(emptyForm())
const createError = ref('')

function areaText(row: EntryRow): string {
  return canonicalAreaText(row)
}

function isRevoked(row: EntryRow): boolean {
  return String(row.status) === NOTICE_STATUS.revoked
}

function isSuspended(row: EntryRow): boolean {
  return String(row.status) === NOTICE_STATUS.suspended
}

function statusClass(row: EntryRow): string {
  if (isRevoked(row)) return 'tag-revoked'
  if (isSuspended(row)) return 'tag-warn'
  if (String(row.status) === NOTICE_STATUS.published) return 'tag-ok'
  return ''
}

function actionsFor(row: EntryRow): string[] {
  return availableNoticeActions(String(row.status))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  Object.assign(createForm, emptyForm())
  createError.value = ''
  showCreate.value = true
}

function closeCreate() {
  showCreate.value = false
}

function submitCreate() {
  const result = createNotice({
    通知编号: createForm['通知编号'] ?? '',
    影响片区: createForm['影响片区'] ?? '',
    停暖原因: createForm['停暖原因'] ?? '',
    计划开始: createForm['计划开始'] ?? '',
    计划恢复: createForm['计划恢复'] ?? '',
    通知方式: createForm['通知方式'] ?? '',
    发布人: createForm['发布人'] ?? '',
  })
  if (!result.ok) {
    createError.value = result.message
    return
  }
  showCreate.value = false
  reload()
  infoMessage.value = result.message
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  if (action === '补录片区') {
    editingId.value = Number(row.id)
    areaDraft.value = areaText(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function submitArea(row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), '补录片区', { area: areaDraft.value })
  editingId.value = null
  areaDraft.value = ''
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
    errorMessage.value = error instanceof Error ? error.message : '停暖通知列表读取失败'
  }
}

onMounted(reload)
</script>
