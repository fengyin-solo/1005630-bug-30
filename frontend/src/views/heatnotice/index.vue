<template>
  <section class="page" data-module="heatnotice">
    <header class="page-head">
      <div>
        <h2>停暖通知管理</h2>
        <p class="page-desc">
          列表与通知详情共用同一套影响片区核定口径；撤销即退出发布口径并回写入户台账待补发清单，片区缺失的先挂起。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记停暖通知单</button>
        <button class="btn" type="button" @click="exportRows">导出停暖通知清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in scope.stats" :key="item.label" class="stat-card" :class="{ alert: item.label.includes('少发') && item.value > 0 }">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span class="legend-item">发布口径影响片区：{{ scope.affectedDistricts.join('、') || '无' }}</span>
    </p>

    <div class="scope-tabs" role="tablist">
      <button
        v-for="tab in scopeTabs"
        :key="tab.key"
        type="button"
        class="scope-tab"
        :class="{ active: scopeKey === tab.key }"
        @click="switchScope(tab.key)"
      >
        {{ tab.label }}
        <em v-if="tab.count > 0">{{ tab.count }}</em>
      </button>
    </div>

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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ suspended: String(row.status) === '已挂起', revoked: String(row.status) === '已撤销' }">
          <td v-for="column in columns" :key="column">
            <button v-if="column === '通知编号'" class="link" type="button" @click="openDetail(row)">
              {{ row[column] }}
            </button>
            <template v-else-if="column === '影响片区'">
              <span :class="{ missing: resolveDistricts(row).length === 0 }">{{ formatDistricts(row) }}</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span class="status-tag" :class="statusClass(row.status)">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionList(row.status)"
              :key="action"
              class="link"
              type="button"
              @click="handleAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前口径下暂无停暖通知，可切换上方分栏或登记新通知单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>当前分栏共 {{ total }} 条；已撤销/已挂起的通知不计入发布口径与影响片区数</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 通知详情：影响片区与列表同走一套核定 -->
    <div v-if="detailRow" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <header class="modal-head">
          <h3>通知详情 · {{ detailRow['通知编号'] }}</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-list">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd v-if="column === '影响片区'">
              <span :class="{ missing: resolveDistricts(detailRow).length === 0 }">{{ formatDistricts(detailRow) }}</span>
              <small v-if="resolveDistricts(detailRow).length === 0">片区缺失，按口径挂起，不计入发布片区</small>
            </dd>
            <dd v-else>{{ detailRow[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd><span class="status-tag" :class="statusClass(detailRow.status)">{{ detailRow.status }}</span></dd>
          <dt>发布口径</dt>
          <dd>{{ String(detailRow.status) === '已发布' && resolveDistricts(detailRow).length > 0 ? '计入（已发布且片区核定通过）' : '不计入' }}</dd>
        </dl>
        <footer class="modal-foot">
          <button
            v-for="action in actionList(detailRow.status)"
            :key="action"
            class="btn"
            :class="{ primary: action === '发布通知' }"
            type="button"
            @click="handleAction(action, detailRow)"
          >
            {{ action }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 片区缺失：补全片区 -->
    <div v-if="resumeRow" class="modal-mask" @click.self="resumeRow = null">
      <div class="modal">
        <header class="modal-head">
          <h3>补全影响片区 · {{ resumeRow['通知编号'] }}</h3>
          <button class="link" type="button" @click="resumeRow = null">关闭</button>
        </header>
        <p class="page-desc">多个片区可用顿号、逗号或斜杠分隔，核定后自动去重；补全后通知回到待发布。</p>
        <label class="form-field">
          <span>影响片区</span>
          <input v-model="resumeText" placeholder="如：城东片区、滨河片区" />
        </label>
        <footer class="modal-foot">
          <button class="btn" type="button" @click="resumeRow = null">取消</button>
          <button class="btn primary" type="button" @click="submitResume">保存并解除挂起</button>
        </footer>
      </div>
    </div>

    <!-- 重新拟稿：在原单上改，不生成重复单 -->
    <div v-if="redraftRow" class="modal-mask" @click.self="redraftRow = null">
      <div class="modal">
        <header class="modal-head">
          <h3>重新拟稿 · {{ redraftRow['通知编号'] }}</h3>
          <button class="link" type="button" @click="redraftRow = null">关闭</button>
        </header>
        <p class="page-desc">沿用原单编号在原单上重新拟稿，不会新建一条重复单。</p>
        <label class="form-field">
          <span>影响片区</span>
          <input v-model="redraftForm['影响片区']" placeholder="如：城东片区、滨河片区" />
        </label>
        <label class="form-field">
          <span>停暖原因</span>
          <input v-model="redraftForm['停暖原因']" />
        </label>
        <label class="form-field">
          <span>计划开始</span>
          <input v-model="redraftForm['计划开始']" placeholder="2026-10-10 08:00" />
        </label>
        <label class="form-field">
          <span>计划恢复</span>
          <input v-model="redraftForm['计划恢复']" placeholder="2026-10-10 18:00" />
        </label>
        <footer class="modal-foot">
          <button class="btn" type="button" @click="redraftRow = null">取消</button>
          <button class="btn primary" type="button" @click="submitRedraft">在原单上重新拟稿</button>
        </footer>
      </div>
    </div>

    <!-- 登记新通知 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <div class="modal">
        <header class="modal-head">
          <h3>登记停暖通知单</h3>
          <button class="link" type="button" @click="creating = false">关闭</button>
        </header>
        <label class="form-field">
          <span>通知编号</span>
          <input v-model="createForm['通知编号']" placeholder="如：HEAT-2026-006" />
        </label>
        <label class="form-field">
          <span>影响片区</span>
          <input v-model="createForm['影响片区']" placeholder="片区缺失的通知发布时会被挂起" />
        </label>
        <label class="form-field">
          <span>停暖原因</span>
          <input v-model="createForm['停暖原因']" />
        </label>
        <label class="form-field">
          <span>计划开始</span>
          <input v-model="createForm['计划开始']" />
        </label>
        <label class="form-field">
          <span>计划恢复</span>
          <input v-model="createForm['计划恢复']" />
        </label>
        <label class="form-field">
          <span>通知方式</span>
          <input v-model="createForm['通知方式']" placeholder="短信+社区公告" />
        </label>
        <label class="form-field">
          <span>发布人</span>
          <input v-model="createForm['发布人']" />
        </label>
        <footer class="modal-foot">
          <button class="btn" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">登记（进入待拟稿）</button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  createNotice,
  downloadEntries,
  formatNoticeDistricts,
  listNotices,
  moduleMeta,
  publishNotice,
  redraftNotice,
  resolveNoticeDistricts,
  resumeNotice,
  revokeNotice,
  submitNoticeDraft,
} from '@/api/local-service'
import type { ActionResult, EntryRow, NoticeStat } from '@/data/types'

type ScopeKey = 'active' | 'suspended' | 'revoked' | 'all'

const meta = moduleMeta('heatnotice')
const columns = ['通知编号', '影响片区', '停暖原因', '计划开始', '计划恢复', '通知方式', '发布人', '通知状态']
const filterFields = columns.slice(0, 3)

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const scopeKey = ref<ScopeKey>('active')
const scope = ref<{ stats: NoticeStat[]; affectedDistricts: string[] }>({ stats: [], affectedDistricts: [] })

const detailRow = ref<EntryRow | null>(null)
const resumeRow = ref<EntryRow | null>(null)
const resumeText = ref('')
const redraftRow = ref<EntryRow | null>(null)
const redraftForm = ref<Record<string, string>>({})
const creating = ref(false)
const createForm = ref<Record<string, string>>({})

const scopeTabs = computed(() => [
  { key: 'active' as const, label: '生效中（不含撤销/挂起）', count: listNotices(filters.value, 'active').total },
  { key: 'suspended' as const, label: '已挂起（片区缺失）', count: listNotices(filters.value, 'suspended').total },
  { key: 'revoked' as const, label: '已撤销', count: listNotices(filters.value, 'revoked').total },
  { key: 'all' as const, label: '全部', count: listNotices(filters.value, 'all').total },
])

function resolveDistricts(row: EntryRow): string[] {
  return resolveNoticeDistricts(row)
}

function formatDistricts(row: EntryRow): string {
  return formatNoticeDistricts(row)
}

function actionList(status: string): string[] {
  return availableActions(String(status))
}

function statusClass(status: string): string {
  switch (status) {
    case '已发布':
      return 'is-published'
    case '已挂起':
      return 'is-suspended'
    case '已撤销':
      return 'is-revoked'
    default:
      return 'is-other'
  }
}

function switchScope(key: ScopeKey) {
  scopeKey.value = key
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function flash(result: ActionResult) {
  if (!result.ok) {
    errorMessage.value = result.message
    return false
  }
  errorMessage.value = ''
  return true
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listNotices(filters.value, scopeKey.value)
    rows.value = payload.items
    total.value = payload.total
    scope.value = { stats: payload.stats, affectedDistricts: payload.affectedDistricts }
    if (detailRow.value) {
      const latest = payload.items.find((row) => Number(row.id) === Number(detailRow.value?.id))
      detailRow.value = latest ?? detailRow.value
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '停暖通知列表读取失败'
  }
}

function openDetail(row: EntryRow) {
  detailRow.value = row
}

function closeDetail() {
  detailRow.value = null
}

function handleAction(action: string, row: EntryRow) {
  let result: ActionResult
  if (action === '撤销通知') {
    result = revokeNotice(Number(row.id))
  } else if (action === '发布通知') {
    result = publishNotice(Number(row.id))
  } else if (action === '提交拟稿') {
    result = submitNoticeDraft(Number(row.id))
  } else if (action === '补全片区') {
    resumeRow.value = row
    resumeText.value = String(row['影响片区'] ?? '')
    return
  } else if (action === '重新拟稿') {
    redraftRow.value = row
    redraftForm.value = {
      影响片区: String(row['影响片区'] ?? ''),
      停暖原因: String(row['停暖原因'] ?? ''),
      计划开始: String(row['计划开始'] ?? ''),
      计划恢复: String(row['计划恢复'] ?? ''),
    }
    return
  } else {
    result = { ok: false, message: `未登记的动作：${action}` }
  }
  if (flash(result)) {
    detailRow.value = null
    reload()
  }
}

function submitResume() {
  if (!resumeRow.value) {
    return
  }
  const result = resumeNotice(Number(resumeRow.value.id), resumeText.value)
  if (flash(result)) {
    resumeRow.value = null
    detailRow.value = null
    reload()
  }
}

function submitRedraft() {
  if (!redraftRow.value) {
    return
  }
  const result = redraftNotice(Number(redraftRow.value.id), { ...redraftForm.value })
  if (flash(result)) {
    redraftRow.value = null
    detailRow.value = null
    reload()
  }
}

function openCreate() {
  createForm.value = { 通知编号: '', 影响片区: '', 停暖原因: '', 计划开始: '', 计划恢复: '', 通知方式: '', 发布人: '' }
  creating.value = true
}

function submitCreate() {
  const result = createNotice({ ...createForm.value })
  if (flash(result)) {
    creating.value = false
    reload()
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
.scope-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.scope-tab {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 999px;
  padding: 4px 14px;
  font-size: 13px;
  cursor: pointer;
  color: var(--muted);
}
.scope-tab.active {
  border-color: var(--brand);
  color: var(--brand);
  font-weight: 600;
}
.scope-tab em {
  font-style: normal;
  margin-left: 4px;
  background: #eef2f7;
  border-radius: 999px;
  padding: 0 7px;
  font-size: 12px;
}
.scope-tab.active em {
  background: var(--brand);
  color: #fff;
}
tr.suspended {
  background: #fffaeb;
}
tr.revoked {
  color: var(--muted);
}
.missing {
  color: #b54708;
  font-weight: 600;
}
.status-tag {
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 12px;
}
.status-tag.is-published {
  background: #e7f6ec;
  color: #1a7f37;
}
.status-tag.is-suspended {
  background: #fef0c7;
  color: #b54708;
}
.status-tag.is-revoked {
  background: #f2f4f7;
  color: #667085;
}
.status-tag.is-other {
  background: #eef2f7;
  color: #475467;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  width: 560px;
  max-width: calc(100vw - 32px);
  max-height: 86vh;
  overflow: auto;
  padding: 16px 18px;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.modal-head h3 {
  margin: 0;
  font-size: 16px;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.detail-list {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 13px;
}
.detail-list dt {
  color: var(--muted);
}
.detail-list dd {
  margin: 0;
}
.detail-list small {
  display: block;
  color: #b54708;
}
.form-field {
  display: block;
  margin-bottom: 10px;
}
.form-field span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 2px;
}
.form-field input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
</style>
