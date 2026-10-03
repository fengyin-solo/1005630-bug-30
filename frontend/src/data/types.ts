/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

// 停暖通知的列表与详情共用同一份口径：统计、片区核定都从这里出，避免两处各算各的。
export type NoticeStat = {
  label: string
  value: number
}

export type NoticeScopeResult = {
  items: EntryRow[]
  total: number
  stats: NoticeStat[]
  // 影响片区数：只统计仍处于发布口径、且片区核定通过的通知，撤销/挂起的一律不算。
  publishedCount: number
  suspendedCount: number
  revokedCount: number
  affectedDistricts: string[]
  // 待补发（少发）条数：撤销后回写到入户台账、尚未补发完成的通知数。
  pendingResendCount: number
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
