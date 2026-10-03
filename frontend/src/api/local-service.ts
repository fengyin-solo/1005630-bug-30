import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  NoticeScopeResult,
  NoticeStat,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 停暖通知 / 入户台账之间的固定口径，页面只负责渲染，不做业务判断。
const HEAT_NOTICE_KEY = 'heatnotice'
const HOUSEHOLD_KEY = 'householdservice'
const NOTICE_DRAFT = '待拟稿'
const NOTICE_READY = '待发布'
const NOTICE_PUBLISHED = '已发布'
const NOTICE_SUSPENDED = '已挂起'
const NOTICE_REVOKED = '已撤销'
const RESEND_STATUS = '待补发'
const DISTRICT_FIELD = '影响片区'
const NOTICE_CODE_FIELD = '通知编号'
const RESEND_CODE_FIELD = '来源通知编号'
// 既有通知口径里影响片区的分隔写法：逗号、顿号、斜杠、分号、空白都算分隔，核定后去空白、去重。
const DISTRICT_SPLITTERS = /[,，、/;；\s]+/

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 影响片区唯一核定入口：通知列表、通知详情、发布口径、入户台账回写都走这里，
 * 保证两处看到的片区永远是同一套，不再各算各的。
 */
export function resolveNoticeDistricts(row: EntryRow): string[] {
  const raw = String(row[DISTRICT_FIELD] ?? '').trim()
  if (!raw) {
    return []
  }
  return [...new Set(raw.split(DISTRICT_SPLITTERS).map((item) => item.trim()).filter(Boolean))]
}

// 列表与详情统一用它展示影响片区；缺失时显式提示，避免悄悄算进口径。
export function formatNoticeDistricts(row: EntryRow): string {
  return resolveNoticeDistricts(row).join('、') || '片区缺失·待挂起'
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------------------------------------------------------------------
// 停暖通知：撤销 / 发布 / 挂起 / 重新拟稿 与发布口径核定。
// 既有 runAction 仍保留给其他模块，通知的状态流转统一走下面这一组，避免
// 「已撤销还按已发布统计」「连点两次多记异常」之类的问题。
// ---------------------------------------------------------------------------

function findNotice(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function saveNotices(rows: EntryRow[]): void {
  saveRows(HEAT_NOTICE_KEY, rows)
}

// 入户台账里由撤销通知回写的待补发记录：同一条通知永远只落一条。
function findResendRow(rows: EntryRow[], noticeCode: string): EntryRow | undefined {
  return rows.find((row) => String(row[RESEND_CODE_FIELD] ?? '') === noticeCode)
}

// 撤销结果回写入户台账的待补发清单：已存在则只更新不新增，保证重复撤销不产生重复单。
function upsertResendEntry(notice: EntryRow): void {
  const rows = listRows(HOUSEHOLD_KEY)
  const districts = resolveNoticeDistricts(notice)
  const noticeCode = String(notice[NOTICE_CODE_FIELD] ?? '')
  const existing = findResendRow(rows, noticeCode)
  const base: EntryRow = existing
    ? { ...existing }
    : {
        id: nextId(rows),
        status: RESEND_STATUS,
        pending: true,
        abnormal: false,
        服务单号: `RESEND-${String(nextId(rows)).padStart(4, '0')}`,
        [RESEND_CODE_FIELD]: noticeCode,
      }
  const updated: EntryRow = {
    ...base,
    报修用户: `${districts.join('、') || '影响片区'}片区住户`,
    服务内容: `停暖通知 ${noticeCode} 已撤销，需安排停暖通知补发/入户告知`,
    受理人: '待片区值班安排',
    上门时间: '',
    处理结果: '',
    回访日期: '',
    [DISTRICT_FIELD]: districts.join('、'),
    status: RESEND_STATUS,
    pending: true,
    abnormal: false,
  }
  const next = existing
    ? rows.map((row) => (String(row[RESEND_CODE_FIELD] ?? '') === noticeCode ? updated : row))
    : [...rows, updated]
  saveRows(HOUSEHOLD_KEY, next)
}

// 通知重新发布后，对应待补发记录关闭（少发的几条已补发完成）。
function closeResendEntry(noticeCode: string): void {
  const rows = listRows(HOUSEHOLD_KEY)
  if (!findResendRow(rows, noticeCode)) {
    return
  }
  const next = rows.map((row) =>
    String(row[RESEND_CODE_FIELD] ?? '') === noticeCode
      ? { ...row, status: '已处理', pending: false, abnormal: false, 处理结果: `通知 ${noticeCode} 已重新发布，补发完成`, 回访日期: today() }
      : row,
  )
  saveRows(HOUSEHOLD_KEY, next)
}

export function pendingResendNotices(): EntryRow[] {
  return listRows(HOUSEHOLD_KEY).filter((row) => String(row.status) === RESEND_STATUS)
}

// 状态允许的动作在这里统一核定，页面只渲染返回的按钮。
export function availableActions(status: string): string[] {
  switch (status) {
    case NOTICE_DRAFT:
      return ['提交拟稿', '撤销通知']
    case NOTICE_READY:
      return ['发布通知', '撤销通知']
    case NOTICE_PUBLISHED:
      return ['撤销通知']
    case NOTICE_SUSPENDED:
      return ['补全片区', '撤销通知']
    case NOTICE_REVOKED:
      return ['重新拟稿']
    default:
      return []
  }
}

// 提交拟稿：待拟稿 → 待发布。
export function submitNoticeDraft(id: number): ActionResult {
  const rows = listRows(HEAT_NOTICE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的停暖通知单` }
  }
  const current = String(rows[index].status)
  if (current !== NOTICE_DRAFT) {
    return { ok: false, message: `当前状态「${current}」不能提交拟稿` }
  }
  const next = [...rows]
  next[index] = { ...rows[index], status: NOTICE_READY, pending: true, abnormal: false }
  saveNotices(next)
  return { ok: true, message: `停暖通知单已提交拟稿，当前状态「${NOTICE_READY}」` }
}

/**
 * 发布通知：影响片区按既有通知口径核定，片区缺失的先挂起，不进发布口径。
 */
export function publishNotice(id: number): ActionResult {
  const rows = listRows(HEAT_NOTICE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的停暖通知单` }
  }
  const target = rows[index]
  const current = String(target.status)
  if (current === NOTICE_PUBLISHED) {
    return { ok: false, message: '停暖通知单已经发布，不用重复发布' }
  }
  if (current !== NOTICE_READY) {
    return { ok: false, message: `当前状态「${current}」不能发布` }
  }
  const districts = resolveNoticeDistricts(target)
  const next = [...rows]
  if (districts.length === 0) {
    next[index] = { ...target, status: NOTICE_SUSPENDED, pending: true, abnormal: false }
    saveNotices(next)
    return { ok: true, message: '影响片区缺失，通知已挂起，补全片区后才能发布' }
  }
  next[index] = { ...target, status: NOTICE_PUBLISHED, pending: false, abnormal: false }
  saveNotices(next)
  closeResendEntry(String(target[NOTICE_CODE_FIELD] ?? ''))
  return { ok: true, message: `停暖通知单已发布，影响片区：${districts.join('、')}` }
}

// 挂起通知补全片区后回到待发布，不直接发布，仍需走发布核定。
export function resumeNotice(id: number, districtText: string): ActionResult {
  const districts = [...new Set(districtText.split(DISTRICT_SPLITTERS).map((item) => item.trim()).filter(Boolean))]
  if (districts.length === 0) {
    return { ok: false, message: '影响片区不能为空，通知保持挂起' }
  }
  const rows = listRows(HEAT_NOTICE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的停暖通知单` }
  }
  const target = rows[index]
  if (String(target.status) !== NOTICE_SUSPENDED) {
    return { ok: false, message: `当前状态「${target.status}」无需补全片区` }
  }
  const next = [...rows]
  next[index] = { ...target, [DISTRICT_FIELD]: districts.join('、'), status: NOTICE_READY, pending: true, abnormal: false }
  saveNotices(next)
  return { ok: true, message: `已补全影响片区（${districts.join('、')}），通知回到待发布` }
}

/**
 * 撤销通知：
 * - 重复提交撤销只落一条（已撤销直接返回，不再改状态、不再回写台账、不再记异常）；
 * - 撤销后真实状态为「已撤销」，立刻退出发布口径；
 * - 撤销结果回写入户台账的待补发清单（同一通知 upsert 一条）。
 */
export function revokeNotice(id: number): ActionResult {
  const rows = listRows(HEAT_NOTICE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的停暖通知单` }
  }
  const target = rows[index]
  const current = String(target.status)
  if (current === NOTICE_REVOKED) {
    return { ok: false, message: '停暖通知单已经撤销，待补发清单里已有一条，不用重复撤销' }
  }
  const next = [...rows]
  next[index] = { ...target, status: NOTICE_REVOKED, pending: false, abnormal: true }
  saveNotices(next)
  upsertResendEntry(next[index])
  return { ok: true, message: '停暖通知单已撤销，已从发布口径剔除，并回写入户台账待补发清单' }
}

/**
 * 重新拟稿：同通知编号复用原单（原单回到待拟稿），不新建记录，避免一条重复单。
 */
export function redraftNotice(id: number, patch: Partial<EntryRow> = {}): ActionResult {
  const rows = listRows(HEAT_NOTICE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的停暖通知单` }
  }
  const target = rows[index]
  if (String(target.status) !== NOTICE_REVOKED) {
    return { ok: false, message: `当前状态「${target.status}」不能重新拟稿` }
  }
  const nextCode = String(patch[NOTICE_CODE_FIELD] ?? target[NOTICE_CODE_FIELD] ?? '').trim()
  if (!nextCode) {
    return { ok: false, message: '通知编号不能为空' }
  }
  const duplicated = rows.some(
    (row) => Number(row.id) !== id && String(row[NOTICE_CODE_FIELD] ?? '') === nextCode,
  )
  if (duplicated) {
    return { ok: false, message: `通知编号 ${nextCode} 已有在途单据，请复用原单，不要再拟一条` }
  }
  const next = [...rows]
  next[index] = { ...target, ...patch, [NOTICE_CODE_FIELD]: nextCode, status: NOTICE_DRAFT, pending: true, abnormal: false }
  saveNotices(next)
  return { ok: true, message: `已在原单 ${nextCode} 上重新拟稿，未生成重复单` }
}

/**
 * 登记新通知：编号查重，新增的一律先进待拟稿。
 */
export function createNotice(input: Partial<EntryRow>): ActionResult {
  const code = String(input[NOTICE_CODE_FIELD] ?? '').trim()
  if (!code) {
    return { ok: false, message: '通知编号不能为空' }
  }
  const rows = listRows(HEAT_NOTICE_KEY)
  if (rows.some((row) => String(row[NOTICE_CODE_FIELD] ?? '') === code)) {
    return { ok: false, message: `通知编号 ${code} 已存在，请在清单里找到原单处理，不要重复登记` }
  }
  const row: EntryRow = {
    id: nextId(rows),
    status: NOTICE_DRAFT,
    pending: true,
    abnormal: false,
    [NOTICE_CODE_FIELD]: code,
    [DISTRICT_FIELD]: String(input[DISTRICT_FIELD] ?? ''),
    停暖原因: String(input['停暖原因'] ?? ''),
    计划开始: String(input['计划开始'] ?? ''),
    计划恢复: String(input['计划恢复'] ?? ''),
    通知方式: String(input['通知方式'] ?? ''),
    发布人: String(input['发布人'] ?? ''),
    通知状态: NOTICE_DRAFT,
  }
  saveNotices([...rows, row])
  return { ok: true, message: `停暖通知单 ${code} 已登记，进入待拟稿` }
}

/**
 * 通知列表 + 发布口径核定：详情页和列表页共用，统计与影响片区只算一次。
 * scope: active（默认，生效中，不含已撤销/已挂起）/ suspended / revoked / all。
 */
export function listNotices(
  filters: Record<string, string> = {},
  scope: 'active' | 'suspended' | 'revoked' | 'all' = 'active',
): NoticeScopeResult {
  const matched = filterRows(listRows(HEAT_NOTICE_KEY), filters)
  const scoped = matched.filter((row) => {
    const status = String(row.status)
    if (scope === 'all') {
      return true
    }
    if (scope === 'suspended') {
      return status === NOTICE_SUSPENDED
    }
    if (scope === 'revoked') {
      return status === NOTICE_REVOKED
    }
    return status !== NOTICE_REVOKED && status !== NOTICE_SUSPENDED
  })

  // 发布口径：只有仍发布、且片区核定通过的通知才计入，撤销/挂起的一律剔除。
  const published = matched.filter(
    (row) => String(row.status) === NOTICE_PUBLISHED && resolveNoticeDistricts(row).length > 0,
  )
  const affectedDistricts = [...new Set(published.flatMap((row) => resolveNoticeDistricts(row)))]
  const pendingResendCount = pendingResendNotices().length
  const stats: NoticeStat[] = [
    { label: '待发布通知', value: matched.filter((row) => String(row.status) === NOTICE_READY).length },
    { label: '已发布通知', value: published.length },
    { label: '已挂起通知', value: matched.filter((row) => String(row.status) === NOTICE_SUSPENDED).length },
    { label: '影响片区数', value: affectedDistricts.length },
    { label: '待补发（少发）', value: pendingResendCount },
  ]

  return {
    items: scoped,
    total: scoped.length,
    stats,
    publishedCount: published.length,
    suspendedCount: matched.filter((row) => String(row.status) === NOTICE_SUSPENDED).length,
    revokedCount: matched.filter((row) => String(row.status) === NOTICE_REVOKED).length,
    affectedDistricts,
    pendingResendCount,
  }
}

// ---------------------------------------------------------------------------
// 入户台账：待补发清单与补发完成。撤销回写的记录在这里给片区值班人一眼看清。
// ---------------------------------------------------------------------------

export function listResendQueue(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(pendingResendNotices(), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 入户台账除待补发外的常规清单（待补发由独立清单呈现，避免和常规服务单混在一起）。
export function listHouseholdEntries(filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(
    listRows(HOUSEHOLD_KEY).filter((row) => String(row.status) !== RESEND_STATUS),
    filters,
  )
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 页面统计用的全量只读入口（含待补发）。
export function listRowsOfHousehold(): EntryRow[] {
  return listRows(HOUSEHOLD_KEY)
}

export function completeResend(id: number): ActionResult {
  const rows = listRows(HOUSEHOLD_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的入户服务单` }
  }
  if (String(rows[index].status) !== RESEND_STATUS) {
    return { ok: false, message: `当前状态「${rows[index].status}」不是待补发` }
  }
  const next = [...rows]
  next[index] = {
    ...rows[index],
    status: '已处理',
    pending: false,
    abnormal: false,
    处理结果: `通知 ${String(rows[index][RESEND_CODE_FIELD] ?? '')} 的补发已完成`,
    回访日期: today(),
  }
  saveRows(HOUSEHOLD_KEY, next)
  return { ok: true, message: '补发已完成，该条已从待补发清单移除' }
}
