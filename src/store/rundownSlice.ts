import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ConflictRecord, HistoryEntry, OpType, QueuedOp, Role, RundownItem } from "../types";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控", version: 1 },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚", version: 1 },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A", version: 1 },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串", version: 1 }
];

/** 可进行结构性修改（顺序 / 时长 / 新增 / 插播）的岗位：导播、主编 */
export function canStructuralEdit(role: Role): boolean {
  return role === "导播" || role === "主编";
}

/** 深拷贝：数据均为可序列化的普通对象，JSON 克隆对 Immer 草稿安全 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** 稳定序列化（key 排序），用于幂等键 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `"${k}":${stableStringify(obj[k])}`).join(",")}}`;
}

/** FNV-1a 哈希，生成确定性幂等键 */
function hashKey(parts: (string | number | undefined)[]): string {
  const str = parts.map((p) => String(p ?? "")).join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function opId(type: OpType, itemId: string | undefined, baseVersion: number, payload: unknown): string {
  return hashKey([type, itemId, baseVersion, stableStringify(payload)]);
}

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: clone(items) };
}

/** 纯函数：在主链路条目上按顺序重放应急队列，得到本地播出用的有效串联单 */
export function replayOps(base: RundownItem[], ops: QueuedOp[]): RundownItem[] {
  let items = clone(base);
  for (const op of ops) {
    if (op.status !== "pending") continue;
    switch (op.type) {
      case "addItem": {
        const data = op.payload.data as Omit<RundownItem, "id" | "status" | "version" | "pending">;
        items.push({ ...data, id: `local-${op.id}`, status: "草稿", version: 1 });
        break;
      }
      case "updateStatus": {
        const { id, status } = op.payload as { id: string; status: RundownItem["status"] };
        const item = items.find((entry) => entry.id === id);
        if (item) item.status = status;
        break;
      }
      case "reorder": {
        const { orderedIds } = op.payload as { orderedIds: string[] };
        items = orderedIds.map((id) => items.find((entry) => entry.id === id)).filter((entry): entry is RundownItem => Boolean(entry));
        break;
      }
      case "adjustDuration": {
        const { id, delta } = op.payload as { id: string; delta: number };
        const item = items.find((entry) => entry.id === id);
        if (item) item.duration = Math.max(1, item.duration + delta);
        break;
      }
      case "insertBreaking": {
        const change = op.payload.change as { headline: string; duration: number; insertAfter: string; reason: string };
        const index = items.findIndex((entry) => entry.id === change.insertAfter);
        if (index < 0) break;
        items.splice(index + 1, 0, {
          id: `local-${op.id}`,
          title: change.headline,
          type: "新闻片",
          duration: change.duration,
          status: "待播",
          presenter: "值班主播",
          source: `插播：${change.reason}`,
          version: 1
        });
        break;
      }
      case "skipItem": {
        const { id } = op.payload as { id: string };
        const item = items.find((entry) => entry.id === id);
        if (item) item.status = "已跳过";
        break;
      }
    }
  }
  return items;
}

/** 硬时间风险：被挤动后实际播出时间晚于 hardStart 的条目 */
export interface RiskWarning {
  id: string;
  title: string;
  hardStart: string;
  actualAt: string;
  delay: number;
}

export function computeRisks(items: RundownItem[], start = "2026-10-08T08:00:00"): RiskWarning[] {
  const cursor = new Date(start);
  const risks: RiskWarning[] = [];
  for (const item of items) {
    const at = new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + item.duration);
    if (item.hardStart) {
      const [hh, mm] = item.hardStart.split(":").map(Number);
      const hard = new Date(at);
      hard.setHours(hh, mm, 0, 0);
      if (at > hard) {
        risks.push({
          id: item.id,
          title: item.title,
          hardStart: item.hardStart,
          actualAt: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`,
          delay: Math.round((at.getTime() - hard.getTime()) / 60000)
        });
      }
    }
  }
  return risks;
}

interface State {
  initialized: boolean;
  items: RundownItem[];
  /** 顺序版本：新增 / 插播 / 调整顺序时自增 */
  orderVersion: number;
  history: HistoryEntry[];
  queue: QueuedOp[];
  conflicts: ConflictRecord[];
  /** 已合并操作的幂等键 */
  mergedKeys: string[];
  changes: { id: string; headline: string; duration: number; insertAfter: string; reason: string; createdAt: string }[];
  role: Role;
  online: boolean;
  listPending: boolean;
  lastError: string | null;
  batchId: string | null;
}

const initialState: State = {
  initialized: false,
  items: seed,
  orderVersion: 1,
  history: [],
  queue: [],
  conflicts: [],
  mergedKeys: [],
  changes: [],
  role: "导播",
  online: true,
  listPending: false,
  lastError: null,
  batchId: null
};

/** 在草稿上应用单条操作，返回应用 / 冲突 / 校验失败 */
function applyOp(
  draft: { items: RundownItem[]; orderVersion: number },
  op: QueuedOp
): { status: "applied" } | { status: "conflict"; conflict: ConflictRecord } | { status: "error"; reason: string } {
  const now = new Date().toISOString();
  if (op.type === "adjustDuration" || op.type === "updateStatus" || op.type === "skipItem") {
    const { id } = op.payload as { id: string };
    const item = draft.items.find((entry) => entry.id === id);
    if (!item) return { status: "error", reason: `条目 ${id} 不存在或已被删除` };
    if (item.version !== op.baseVersion) {
      return {
        status: "conflict",
        conflict: {
          id: crypto.randomUUID(),
          opId: op.id,
          type: op.type,
          itemId: id,
          primarySnapshot: clone(item),
          backupSnapshot: clone(op.after as RundownItem),
          status: "待确认",
          time: now
        }
      };
    }
    if (op.type === "adjustDuration") {
      const { delta } = op.payload as { delta: number };
      item.duration = Math.max(1, item.duration + delta);
    } else if (op.type === "updateStatus") {
      const { status } = op.payload as { status: RundownItem["status"] };
      item.status = status;
    } else {
      item.status = "已跳过";
    }
    item.version += 1;
    return { status: "applied" };
  }
  if (op.type === "reorder") {
    if (draft.orderVersion !== op.baseVersion) {
      return {
        status: "conflict",
        conflict: {
          id: crypto.randomUUID(),
          opId: op.id,
          type: op.type,
          primarySnapshot: draft.items.map((entry) => entry.id),
          backupSnapshot: clone(op.after as string[]),
          status: "待确认",
          time: now
        }
      };
    }
    const { orderedIds } = op.payload as { orderedIds: string[] };
    draft.items = orderedIds.map((id) => draft.items.find((entry) => entry.id === id)).filter((entry): entry is RundownItem => Boolean(entry));
    draft.orderVersion += 1;
    return { status: "applied" };
  }
  if (op.type === "insertBreaking") {
    const change = op.payload.change as { headline: string; duration: number; insertAfter: string; reason: string };
    const index = draft.items.findIndex((entry) => entry.id === change.insertAfter);
    if (index < 0) return { status: "error", reason: `插播目标条目 ${change.insertAfter} 不存在` };
    draft.items.splice(index + 1, 0, {
      id: crypto.randomUUID(),
      title: change.headline,
      type: "新闻片",
      duration: change.duration,
      status: "待播",
      presenter: "值班主播",
      source: `插播：${change.reason}`,
      version: 1
    });
    draft.orderVersion += 1;
    return { status: "applied" };
  }
  // addItem
  const data = op.payload.data as Omit<RundownItem, "id" | "status" | "version" | "pending">;
  draft.items.push({ ...data, id: crypto.randomUUID(), status: "草稿", version: 1 });
  draft.orderVersion += 1;
  return { status: "applied" };
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<RundownItem[]>) {
      if (!state.initialized) {
        const incoming = action.payload.length ? action.payload : seed;
        state.items = incoming.map((item) => ({ ...item, version: item.version ?? 1 }));
        state.initialized = true;
      }
    },
    hydrateQueue(state, action: PayloadAction<QueuedOp[]>) {
      if (!state.queue.length && action.payload.length) state.queue = action.payload;
    },
    setRole(state, action: PayloadAction<Role>) {
      state.role = action.payload;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    clearLastError(state) {
      state.lastError = null;
    },
    addItem(state, action: PayloadAction<Omit<RundownItem, "id" | "status" | "version" | "pending">>) {
      if (!canStructuralEdit(state.role)) {
        state.lastError = `岗位「${state.role}」越权新增条目，已挡住`;
        return;
      }
      if (state.online) {
        state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
        state.items.push({ ...action.payload, id: crypto.randomUUID(), status: "草稿", version: 1 });
        state.orderVersion += 1;
        return;
      }
      const id = opId("addItem", undefined, state.orderVersion, action.payload);
      const after: RundownItem = { ...action.payload, id: `local-${id}`, status: "草稿", version: 1 };
      state.history.unshift(snapshot(replayOps(state.items, state.queue), "新增条目", action.payload.title));
      state.queue.unshift({
        id,
        type: "addItem",
        role: state.role,
        time: new Date().toISOString(),
        baseVersion: state.orderVersion,
        before: null,
        after,
        payload: { data: action.payload },
        status: "pending"
      });
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: RundownItem["status"] }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      if (state.online) {
        state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
        item.status = action.payload.status;
        item.version += 1;
        return;
      }
      const id = opId("updateStatus", item.id, item.version, action.payload.status);
      state.history.unshift(snapshot(replayOps(state.items, state.queue), "播出状态", `${item.title} → ${action.payload.status}`));
      state.queue.unshift({
        id,
        type: "updateStatus",
        role: state.role,
        time: new Date().toISOString(),
        baseVersion: item.version,
        before: clone(item),
        after: { ...clone(item), status: action.payload.status },
        payload: { id: item.id, status: action.payload.status },
        status: "pending"
      });
    },
    reorder(state, action: PayloadAction<{ orderedIds: string[] }>) {
      if (!canStructuralEdit(state.role)) {
        state.lastError = `岗位「${state.role}」越权调整顺序，已挡住`;
        return;
      }
      const beforeIds = state.items.map((entry) => entry.id);
      if (state.online) {
        state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
        state.items = action.payload.orderedIds
          .map((id) => state.items.find((entry) => entry.id === id))
          .filter((entry): entry is RundownItem => Boolean(entry));
        state.orderVersion += 1;
        return;
      }
      const id = opId("reorder", undefined, state.orderVersion, action.payload.orderedIds);
      state.history.unshift(snapshot(replayOps(state.items, state.queue), "调整顺序", "直播串联单顺序变化"));
      state.queue.unshift({
        id,
        type: "reorder",
        role: state.role,
        time: new Date().toISOString(),
        baseVersion: state.orderVersion,
        before: beforeIds,
        after: action.payload.orderedIds,
        payload: { orderedIds: action.payload.orderedIds },
        status: "pending"
      });
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      if (!canStructuralEdit(state.role)) {
        state.lastError = `岗位「${state.role}」越权调整时长，已挡住`;
        return;
      }
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      if (state.online) {
        state.history.unshift(snapshot(state.items, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
        item.duration = Math.max(1, item.duration + action.payload.delta);
        item.version += 1;
        return;
      }
      const id = opId("adjustDuration", item.id, item.version, action.payload.delta);
      state.history.unshift(snapshot(replayOps(state.items, state.queue), "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      state.queue.unshift({
        id,
        type: "adjustDuration",
        role: state.role,
        time: new Date().toISOString(),
        baseVersion: item.version,
        before: clone(item),
        after: { ...clone(item), duration: Math.max(1, item.duration + action.payload.delta) },
        payload: { id: item.id, delta: action.payload.delta },
        status: "pending"
      });
    },
    insertBreaking(state, action: PayloadAction<Omit<{ headline: string; duration: number; insertAfter: string; reason: string; id: string; createdAt: string }, "id" | "createdAt">>) {
      if (!canStructuralEdit(state.role)) {
        state.lastError = `岗位「${state.role}」越权插播，已挡住`;
        return;
      }
      const change = { ...action.payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      state.changes.unshift(change);
      if (state.online) {
        const index = state.items.findIndex((entry) => entry.id === change.insertAfter);
        state.history.unshift(snapshot(state.items, "突发插播", change.headline));
        state.items.splice(index + 1, 0, {
          id: crypto.randomUUID(),
          title: change.headline,
          type: "新闻片",
          duration: change.duration,
          status: "待播",
          presenter: "值班主播",
          source: `插播：${change.reason}`,
          version: 1
        });
        state.orderVersion += 1;
        return;
      }
      const id = opId("insertBreaking", change.insertAfter, state.orderVersion, change);
      const after: RundownItem = {
        id: `local-${id}`,
        title: change.headline,
        type: "新闻片",
        duration: change.duration,
        status: "待播",
        presenter: "值班主播",
        source: `插播：${change.reason}`,
        version: 1
      };
      state.history.unshift(snapshot(replayOps(state.items, state.queue), "突发插播", change.headline));
      state.queue.unshift({
        id,
        type: "insertBreaking",
        role: state.role,
        time: new Date().toISOString(),
        baseVersion: state.orderVersion,
        before: null,
        after,
        payload: { change: action.payload },
        status: "pending"
      });
    },
    skipItem(state, action: PayloadAction<string>) {
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      if (state.online) {
        state.history.unshift(snapshot(state.items, "取消条目", item.title));
        item.status = "已跳过";
        item.version += 1;
        return;
      }
      const id = opId("skipItem", item.id, item.version, "skip");
      state.history.unshift(snapshot(replayOps(state.items, state.queue), "取消条目", item.title));
      state.queue.unshift({
        id,
        type: "skipItem",
        role: state.role,
        time: new Date().toISOString(),
        baseVersion: item.version,
        before: clone(item),
        after: { ...clone(item), status: "已跳过" },
        payload: { id: item.id },
        status: "pending"
      });
    },
    undo(state) {
      if (!state.online) {
        // 断网：撤回最近一条未提交操作
        const idx = state.queue.findIndex((op) => op.status === "pending");
        if (idx >= 0) state.queue.splice(idx, 1);
        state.history.shift();
        return;
      }
      const last = state.history.shift();
      if (!last) return;
      state.items = clone(last.snapshot);
    },
    /** 主链路恢复：整批合并。冲突挂待确认；越权/校验失败整批退回可重试 */
    mergeQueue(state) {
      performMerge(state);
    },
    /** 失败后重试：把队列重置为待处理后重新合并 */
    retryMerge(state) {
      if (!state.online || !state.queue.length) return;
      state.queue = state.queue.map((op) => ({ ...op, status: "pending" as const }));
      state.lastError = null;
      performMerge(state);
    },
    /** 冲突裁决：采用主版本 / 备版本 */
    resolveConflict(state, action: PayloadAction<{ conflictId: string; adopt: "primary" | "backup" }>) {
      const conflict = state.conflicts.find((entry) => entry.id === action.payload.conflictId);
      if (!conflict) return;
      if (action.payload.adopt === "primary") {
        if (conflict.itemId) {
          const target = state.items.find((entry) => entry.id === conflict.itemId);
          if (target) target.pending = false;
        } else {
          state.listPending = false;
        }
        conflict.status = "已采用主版本";
      } else {
        if (conflict.itemId) {
          const target = state.items.find((entry) => entry.id === conflict.itemId);
          if (target) {
            const backup = clone(conflict.backupSnapshot as unknown as RundownItem);
            state.items = state.items.map((entry) => (entry.id === conflict.itemId ? { ...backup, id: entry.id, pending: false, version: entry.version + 1 } : entry));
          }
        } else {
          const orderedIds = conflict.backupSnapshot as unknown as string[];
          state.items = orderedIds.map((id) => state.items.find((entry) => entry.id === id)).filter((entry): entry is RundownItem => Boolean(entry));
          state.orderVersion += 1;
          state.listPending = false;
        }
        conflict.status = "已采用备版本";
      }
      // 已裁决的冲突从待确认列表移除
      state.conflicts = state.conflicts.filter((entry) => entry.id !== conflict.id);
    },
    /** 演示用：模拟断网期间主链路也并发修改了某条目（制造版本冲突） */
    simulatePrimaryEdit(state, action: PayloadAction<{ itemId?: string }>) {
      const target = state.items.find((entry) => entry.id === action.payload.itemId) ?? state.items.find((entry) => state.queue.some((op) => (op.payload as { id?: string }).id === entry.id)) ?? state.items[0];
      if (!target) return;
      target.duration += 1;
      target.version += 1;
    }
  }
});

/** 选择器：在线返回主链路条目，断网返回重放应急队列后的有效条目 */
export function selectEffectiveItems(state: { rundown: State }): RundownItem[] {
  return state.rundown.online ? state.rundown.items : replayOps(state.rundown.items, state.rundown.queue);
}

type MergeDraft = { items: RundownItem[]; orderVersion: number; mergedKeys: string[]; conflicts: ConflictRecord[]; listPending: boolean };

/** 整批合并：冲突挂待确认（不失败），越权/校验失败则整批退回。返回是否成功 */
function performMerge(state: State): boolean {
  if (!state.online) return false;
  if (!state.queue.length) {
    state.lastError = null;
    state.batchId = null;
    return true;
  }
  const batchId = crypto.randomUUID();
  const draft: MergeDraft = {
    items: clone(state.items),
    orderVersion: state.orderVersion,
    mergedKeys: [...state.mergedKeys],
    conflicts: [...state.conflicts],
    listPending: state.listPending
  };
  const ops = [...state.queue].sort((a, b) => a.time.localeCompare(b.time));
  const processedIds: string[] = [];
  let failReason = "";
  let failed = false;
  for (const op of ops) {
    if (failed) break;
    if (draft.mergedKeys.includes(op.id)) {
      processedIds.push(op.id);
      continue;
    }
    if ((op.type === "reorder" || op.type === "adjustDuration") && !canStructuralEdit(op.role)) {
      failed = true;
      failReason = `岗位「${op.role}」越权${op.type === "reorder" ? "调整顺序" : "调整时长"}，已挡住`;
      break;
    }
    const result = applyOp(draft, op);
    if (result.status === "conflict") {
      draft.conflicts.push(result.conflict);
      if (result.conflict.itemId) {
        const target = draft.items.find((entry) => entry.id === result.conflict.itemId);
        if (target) target.pending = true;
      } else {
        draft.listPending = true;
      }
      draft.mergedKeys.push(op.id);
      processedIds.push(op.id);
    } else if (result.status === "applied") {
      draft.mergedKeys.push(op.id);
      processedIds.push(op.id);
    } else {
      failed = true;
      failReason = result.reason;
      break;
    }
  }
  if (failed) {
    state.lastError = `合并失败，整批退回（可重试）：${failReason}`;
    state.batchId = batchId;
    state.queue = state.queue.map((op) => ({ ...op, status: "pending" as const, batchId }));
    return false;
  }
  state.items = draft.items;
  state.orderVersion = draft.orderVersion;
  state.mergedKeys = draft.mergedKeys;
  state.conflicts = draft.conflicts;
  state.listPending = draft.listPending;
  state.queue = state.queue.filter((op) => !processedIds.includes(op.id));
  state.lastError = null;
  state.batchId = null;
  return true;
}

export const {
  initialize,
  hydrateQueue,
  setRole,
  setOnline,
  clearLastError,
  addItem,
  updateStatus,
  reorder,
  adjustDuration,
  insertBreaking,
  skipItem,
  undo,
  mergeQueue,
  retryMerge,
  resolveConflict,
  simulatePrimaryEdit
} = slice.actions;
export default slice.reducer;
