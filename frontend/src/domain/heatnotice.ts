import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 停暖通知 + 入户台账的客服口径都收敛在这里：列表、统计、导出、撤销回写共用同一套判定，
// 页面与 local-service 不再各自解释状态和影响片区。

const NOTICE_KEY = 'heatnotice'
const HOUSEHOLD_KEY = 'householdservice'

export const NOTICE_STATUS = {
  draft: '待拟稿',
  ready: '待发布',
  suspended: '已挂起',
  published: '已发布',
  revoked: '已撤销',
} as const

const HOUSEHOLD_PENDING_RESEND = '待补发'

function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `${date} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// 影响片区可能是「、，,；; /」或顿号混写，详情与列表先过这一道，核定成同一份片区集合。
export function canonicalAreas(value: string | number | boolean | undefined): string[] {
  if (value === undefined || value === null) {
    return []
  }
  const seen = new Set<string>()
  for (const part of String(value).split(/[、，,；;\/\n]+/)) {
    const name = part.trim()
    if (name) {
      seen.add(name)
    }
  }
  return [...seen]
}

export function canonicalAreaText(row: EntryRow): string {
  return canonicalAreas(row['影响片区']).join('、')
}

export function isPublishedNotice(row: EntryRow): boolean {
  return String(row.status) === NOTICE_STATUS.published
}

export function isRevokedNotice(row: EntryRow): boolean {
  return String(row.status) === NOTICE_STATUS.revoked
}

// 发布口径：只有「已发布」进数，已撤销、已挂起、待发布一律不计。
export function publishedNotices(rows: EntryRow[] = listRows(NOTICE_KEY)): EntryRow[] {
  return rows.filter(isPublishedNotice)
}

// 影响片区数：已发布通知的片区并集，撤销单的片区在发布口径里直接剔掉。
export function publishedAreaCount(rows: EntryRow[] = listRows(NOTICE_KEY)): number {
  const areas = new Set<string>()
  for (const row of publishedNotices(rows)) {
    for (const area of canonicalAreas(row['影响片区'])) {
      areas.add(area)
    }
  }
  return areas.size
}

export type NoticeDraft = {
  通知编号: string
  影响片区: string
  停暖原因: string
  计划开始: string
  计划恢复: string
  通知方式: string
  发布人: string
}

function syncRow(row: EntryRow, patch: Partial<EntryRow>): EntryRow {
  const status = String(patch.status ?? row.status)
  return {
    ...row,
    ...patch,
    status,
    pending: status !== NOTICE_STATUS.published && status !== NOTICE_STATUS.revoked,
    通知状态: status,
  }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 登记（重新拟稿）：通知编号全量查重，已撤销的旧单也占号，避免再生成一条重复单。
export function createNotice(draft: NoticeDraft): ActionResult {
  const code = draft.通知编号.trim()
  if (!code) {
    return { ok: false, message: '通知编号不能为空' }
  }
  const rows = listRows(NOTICE_KEY)
  const existing = rows.find((row) => String(row['通知编号'] ?? '').trim() === code)
  if (existing) {
    const label = isRevokedNotice(existing)
      ? `编号 ${code} 的通知此前已撤销，不能重新拟稿，请联系发布人恢复原单或使用新编号`
      : `编号 ${code} 的通知已存在（当前状态「${existing.status}」），不能重复登记`
    return { ok: false, message: label }
  }
  const areaText = canonicalAreas(draft.影响片区).join('、')
  const row: EntryRow = {
    id: nextId(rows),
    通知编号: code,
    影响片区: areaText,
    停暖原因: draft.停暖原因.trim(),
    计划开始: draft.计划开始.trim(),
    计划恢复: draft.计划恢复.trim(),
    通知方式: draft.通知方式.trim(),
    发布人: draft.发布人.trim(),
    // 拟稿允许先不填片区，提交时再按口径核定。
    status: areaText ? NOTICE_STATUS.ready : NOTICE_STATUS.draft,
    pending: true,
    abnormal: false,
  }
  row['通知状态'] = row.status
  saveRows(NOTICE_KEY, [...rows, row])
  return { ok: true, message: `通知 ${code} 已登记，当前状态「${row.status}」` }
}

// 撤销回写：在入户台账的待补发清单里补一条，同一撤销通知只落一条（按关联通知编号去重）。
function appendResendEntry(notice: EntryRow): void {
  const rows = listRows(HOUSEHOLD_KEY)
  const code = String(notice['通知编号'] ?? '')
  const already = rows.some(
    (row) =>
      String(row['清单类型'] ?? '') === HOUSEHOLD_PENDING_RESEND &&
      String(row['关联通知编号'] ?? '') === code,
  )
  if (already) {
    return
  }
  const areas = canonicalAreas(notice['影响片区'])
  const revokedAt = nowText()
  const entry: EntryRow = {
    id: nextId(rows),
    status: HOUSEHOLD_PENDING_RESEND,
    pending: true,
    abnormal: false,
    服务单号: `BF-${code.replace(/[^A-Za-z0-9]/g, '')}`,
    清单类型: HOUSEHOLD_PENDING_RESEND,
    关联通知编号: code,
    撤销时间: revokedAt,
    报修用户: `${areas.length ? areas.join('、') : '影响片区待定'}住户（通知已撤销，需补发停暖取消说明）`,
    服务内容: '撤销通知回写：补发停暖取消口径',
    受理人: '—',
    上门时间: '',
    处理结果: '—',
    回访日期: '',
  }
  entry['服务状态'] = HOUSEHOLD_PENDING_RESEND
  saveRows(HOUSEHOLD_KEY, [...rows, entry])
}

// 停暖通知动作：带状态机校验。撤销通知幂等——对已撤销单再点撤销不重复落数、不重复计异常。
export function runNoticeAction(id: number, action: string, payload?: { area?: string }): ActionResult {
  const rows = listRows(NOTICE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的停暖通知单` }
  }
  const row = rows[index]
  const current = String(row.status)

  if (action === '撤销通知') {
    if (current === NOTICE_STATUS.revoked) {
      // 重复提交撤销：只认第一条，入户待补发清单也不会再加。
      return { ok: true, info: true, message: `通知 ${row['通知编号']} 已撤销，重复提交已忽略，待补发清单只保留一条` }
    }
    if (current !== NOTICE_STATUS.published) {
      return { ok: false, message: `只有「已发布」的通知可以撤销，当前状态「${current}」` }
    }
    const updated = syncRow(row, { status: NOTICE_STATUS.revoked, abnormal: true })
    const next = [...rows]
    next[index] = updated
    saveRows(NOTICE_KEY, next)
    appendResendEntry(updated)
    return { ok: true, message: `通知 ${updated['通知编号']} 已撤销，已从发布口径剔除并回写入户待补发清单` }
  }

  if (action === '发布通知') {
    if (current !== NOTICE_STATUS.ready && current !== NOTICE_STATUS.suspended) {
      return { ok: false, message: `当前状态「${current}」不能发布` }
    }
    const areaText = canonicalAreas(row['影响片区']).join('、')
    if (!areaText) {
      // 影响片区缺失：先挂起，不进发布口径，等补录片区后再发布。
      if (current !== NOTICE_STATUS.suspended) {
        const next = [...rows]
        next[index] = syncRow(row, { status: NOTICE_STATUS.suspended, 影响片区: '' })
        saveRows(NOTICE_KEY, next)
      }
      return { ok: true, info: true, message: '影响片区缺失，已按口径挂起；补录片区后才能发布' }
    }
    const updated = syncRow(row, { status: NOTICE_STATUS.published, 影响片区: areaText, abnormal: false })
    const next = [...rows]
    next[index] = updated
    saveRows(NOTICE_KEY, next)
    return { ok: true, message: `通知 ${updated['通知编号']} 已发布，影响片区核定为：${areaText}` }
  }

  if (action === '提交拟稿') {
    if (current !== NOTICE_STATUS.draft) {
      return { ok: false, message: `只有「待拟稿」可以提交拟稿，当前状态「${current}」` }
    }
    const areaText = canonicalAreas(row['影响片区']).join('、')
    const target = areaText ? NOTICE_STATUS.ready : NOTICE_STATUS.suspended
    const updated = syncRow(row, { status: target, 影响片区: areaText })
    const next = [...rows]
    next[index] = updated
    saveRows(NOTICE_KEY, next)
    if (target === NOTICE_STATUS.suspended) {
      return { ok: true, info: true, message: '拟稿已提交，但影响片区缺失，已按口径挂起' }
    }
    return { ok: true, message: `通知 ${updated['通知编号']} 拟稿已提交，等待发布` }
  }

  if (action === '补录片区') {
    if (current !== NOTICE_STATUS.suspended) {
      return { ok: false, message: `只有「已挂起」的通知需要补录片区，当前状态「${current}」` }
    }
    const areaText = canonicalAreas(payload?.area ?? '').join('、')
    if (!areaText) {
      return { ok: false, message: '补录的影响片区不能为空' }
    }
    const updated = syncRow(row, { status: NOTICE_STATUS.ready, 影响片区: areaText })
    const next = [...rows]
    next[index] = updated
    saveRows(NOTICE_KEY, next)
    return { ok: true, message: `片区已核定为：${areaText}，通知回到待发布` }
  }

  return { ok: false, message: `停暖通知没有登记「${action}」这个动作` }
}

// 按当前状态返回可执行动作，已撤销单不再出现「发布通知」，不会被复活。
export function availableNoticeActions(status: string): string[] {
  switch (status) {
    case NOTICE_STATUS.draft:
      return ['提交拟稿']
    case NOTICE_STATUS.ready:
      return ['发布通知']
    case NOTICE_STATUS.published:
      return ['撤销通知']
    case NOTICE_STATUS.suspended:
      return ['补录片区']
    case NOTICE_STATUS.revoked:
      return []
    default:
      return []
  }
}

// 入户台账动作：待补发清单只能「完成补发」，完成后按常规单流转。
export function runHouseholdAction(id: number, action: string): ActionResult {
  const rows = listRows(HOUSEHOLD_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的入户服务单` }
  }
  const row = rows[index]
  const current = String(row.status)

  if (action === '完成补发') {
    if (current !== HOUSEHOLD_PENDING_RESEND) {
      return { ok: false, message: `只有待补发清单里的单据可以完成补发，当前状态「${current}」` }
    }
    const updated: EntryRow = {
      ...row,
      status: '已处理',
      pending: false,
      abnormal: false,
      处理结果: '已补发停暖取消说明',
      受理人: String(row['受理人'] ?? '') === '—' ? '值班调度' : row['受理人'],
    }
    updated['服务状态'] = '已处理'
    const next = [...rows]
    next[index] = updated
    saveRows(HOUSEHOLD_KEY, next)
    return { ok: true, message: `待补发单 ${updated['服务单号']} 已完成补发并从待补发清单移除` }
  }

  const allowed: Record<string, string[]> = {
    [HOUSEHOLD_PENDING_RESEND]: ['完成补发'],
    待受理: ['受理报修'],
    已安排: ['登记处理'],
    已处理: ['完成回访'],
    已回访: [],
  }
  if (!(allowed[current] ?? []).includes(action)) {
    return { ok: false, message: `当前状态「${current}」不能执行「${action}」` }
  }

  const targets: Record<string, string> = {
    受理报修: '已安排',
    登记处理: '已处理',
    完成回访: '已回访',
  }
  const target = targets[action]
  const updated: EntryRow = { ...row, status: target, pending: target !== '已回访', abnormal: false }
  updated['服务状态'] = target
  const next = [...rows]
  next[index] = updated
  saveRows(HOUSEHOLD_KEY, next)
  return { ok: true, message: `服务单 ${updated['服务单号']} 已${action}，当前状态「${target}」` }
}

export function availableHouseholdActions(status: string): string[] {
  switch (status) {
    case HOUSEHOLD_PENDING_RESEND:
      return ['完成补发']
    case '待受理':
      return ['受理报修']
    case '已安排':
      return ['登记处理']
    case '已处理':
      return ['完成回访']
    default:
      return []
  }
}

export function pendingResendEntries(rows: EntryRow[] = listRows(HOUSEHOLD_KEY)): EntryRow[] {
  return rows.filter((row) => String(row.status) === HOUSEHOLD_PENDING_RESEND)
}
