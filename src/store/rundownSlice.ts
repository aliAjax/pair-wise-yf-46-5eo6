import { createSlice, current, isDraft, type PayloadAction } from "@reduxjs/toolkit";
import type { BreakingChange, HardTimeRisk, HistoryEntry, ItemStatus, MergeConflict, MergeResult, QueuedOperation, QueueOpKind, Role, RundownItem } from "../types";
import { computeHardTimeRisks } from "../app/schedule";

const seed: RundownItem[] = [
  { id: "r1", title: "早间新闻提要", type: "新闻片", duration: 4, hardStart: "08:00", status: "已播出", presenter: "陈默", source: "主控", version: 1 },
  { id: "r2", title: "城市更新现场连线", type: "连线", duration: 8, hardStart: "08:06", status: "待播", presenter: "陈默", source: "记者周岚", version: 1 },
  { id: "r3", title: "政策发布会解读", type: "嘉宾", duration: 12, status: "待播", presenter: "陈默", source: "演播室A", version: 1 },
  { id: "r4", title: "整点广告", type: "广告", duration: 3, hardStart: "08:30", status: "待播", presenter: "系统", source: "广告串", version: 1 }
];

interface State {
  initialized: boolean;
  items: RundownItem[];
  history: HistoryEntry[];
  queue: QueuedOperation[];
  conflicts: MergeConflict[];
  appliedOpIds: string[];
  mergeError: string | null;
  lastMerge: MergeResult | null;
  changes: BreakingChange[];
  role: Role;
  online: boolean;
}

const initialState: State = { initialized: false, items: seed, history: [], queue: [], conflicts: [], appliedOpIds: [], mergeError: null, lastMerge: null, changes: [], role: "导播", online: true };

/** 岗位权限：字幕不得改顺序或时长，演播室不得改顺序 */
const FORBIDDEN: Record<Role, QueueOpKind[]> = {
  导播: [],
  主编: [],
  字幕: ["新增条目", "调整顺序", "调整时长", "突发插播", "取消条目"],
  演播室: ["调整顺序"]
};

export const canPerform = (role: Role, kind: QueueOpKind): boolean => !FORBIDDEN[role].includes(kind);

function snapshot(items: RundownItem[], label: string, detail: string): HistoryEntry {
  const plain = isDraft(items) ? current(items) : items;
  return { id: crypto.randomUUID(), label, detail, time: new Date().toISOString(), snapshot: structuredClone(plain) };
}

/** 断网期间把结构化操作写入应急队列：岗位、修改前版本、时间一并带上 */
function enqueue(state: State, op: Omit<QueuedOperation, "id" | "role" | "queuedAt">) {
  if (state.online) return;
  state.queue.unshift({ ...op, id: crypto.randomUUID(), role: state.role, queuedAt: new Date().toISOString() });
}

function applyItemOp(item: RundownItem, op: QueuedOperation) {
  if (op.kind === "调整时长") item.duration = Math.max(1, item.duration + (op.payload.delta ?? 0));
  if (op.kind === "取消条目") item.status = "已跳过";
  if (op.kind === "播出状态" && op.payload.status) item.status = op.payload.status;
}

function isWellFormed(op: QueuedOperation): boolean {
  switch (op.kind) {
    case "新增条目": return Boolean(op.payload.item?.id && op.payload.item.title);
    case "调整顺序": return Boolean(op.payload.order?.length && op.baseVersions);
    case "突发插播": return Boolean(op.payload.breaking?.headline);
    default: return Boolean(op.itemId && op.baseVersion !== undefined && op.before);
  }
}

const slice = createSlice({
  name: "rundown",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<RundownItem[]>) {
      if (!state.initialized) {
        const items = action.payload.length ? action.payload : seed;
        state.items = items.map((item) => ({ ...item, version: item.version ?? 1 }));
        state.initialized = true;
      }
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },
    addItem: {
      prepare(values: Omit<RundownItem, "id" | "status" | "version">) {
        return { payload: { ...values, id: crypto.randomUUID() } };
      },
      reducer(state, action: PayloadAction<Omit<RundownItem, "status" | "version">>) {
        if (!canPerform(state.role, "新增条目")) return;
        state.history.unshift(snapshot(state.items, "新增条目", action.payload.title));
        state.items.push({ ...action.payload, status: "草稿", version: 1 });
        enqueue(state, { kind: "新增条目", detail: action.payload.title, payload: { item: action.payload } });
      }
    },
    updateStatus(state, action: PayloadAction<{ id: string; status: ItemStatus }>) {
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const before = current(item);
      state.history.unshift(snapshot(state.items, "播出状态", `${item.title} → ${action.payload.status}`));
      item.status = action.payload.status;
      item.version += 1;
      enqueue(state, { kind: "播出状态", detail: `${item.title} → ${action.payload.status}`, itemId: item.id, baseVersion: before.version, before, payload: { status: action.payload.status } });
    },
    reorder(state, action: PayloadAction<RundownItem[]>) {
      if (!canPerform(state.role, "调整顺序")) return;
      const baseVersions = Object.fromEntries(state.items.map((item) => [item.id, item.version]));
      state.history.unshift(snapshot(state.items, "调整顺序", "直播串联单顺序变化"));
      state.items = action.payload.map((item) => ({ ...item }));
      enqueue(state, { kind: "调整顺序", detail: "直播串联单顺序变化", baseVersions, payload: { order: action.payload.map((item) => item.id) } });
    },
    adjustDuration(state, action: PayloadAction<{ id: string; delta: number }>) {
      if (!canPerform(state.role, "调整时长")) return;
      const item = state.items.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const before = current(item);
      state.history.unshift(snapshot(state.items, "调整时长", `${item.title} ${action.payload.delta > 0 ? "增加" : "减少"} ${Math.abs(action.payload.delta)} 分钟`));
      item.duration = Math.max(1, item.duration + action.payload.delta);
      item.version += 1;
      enqueue(state, { kind: "调整时长", detail: `${item.title} 时长 ${action.payload.delta > 0 ? "+" : ""}${action.payload.delta} 分钟`, itemId: item.id, baseVersion: before.version, before, payload: { delta: action.payload.delta } });
    },
    insertBreaking(state, action: PayloadAction<Omit<BreakingChange, "id" | "createdAt">>) {
      if (!canPerform(state.role, "突发插播")) return;
      const change: BreakingChange = { ...action.payload, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const index = state.items.findIndex((item) => item.id === change.insertAfter);
      const anchor = state.items[index];
      state.history.unshift(snapshot(state.items, "突发插播", change.headline));
      state.items.splice(index + 1, 0, { id: crypto.randomUUID(), title: change.headline, type: "新闻片", duration: change.duration, status: "待播", presenter: "值班主播", source: `插播：${change.reason}`, version: 1 });
      state.changes.unshift(change);
      enqueue(state, { kind: "突发插播", detail: change.headline, itemId: change.insertAfter, baseVersion: anchor?.version, payload: { breaking: { ...action.payload } } });
    },
    skipItem(state, action: PayloadAction<string>) {
      const item = state.items.find((entry) => entry.id === action.payload);
      if (!item) return;
      const before = current(item);
      state.history.unshift(snapshot(state.items, "取消条目", item.title));
      item.status = "已跳过";
      item.version += 1;
      enqueue(state, { kind: "取消条目", detail: item.title, itemId: item.id, baseVersion: before.version, before, payload: {} });
    },
    undo(state) {
      const last = state.history.shift();
      if (!last) return;
      state.items = structuredClone(current(last).snapshot);
    },
    discardOp(state, action: PayloadAction<string>) {
      state.queue = state.queue.filter((op) => op.id !== action.payload);
      state.mergeError = null;
    },
    /** 联网恢复：把断网期间的队列操作合并回主串联单。任一校验失败整批退回，可移除问题操作后重试 */
    mergeQueue(state, action: PayloadAction<{ mainItems: RundownItem[] }>) {
      state.mergeError = null;
      if (!state.queue.length) return;
      const offender = state.queue.find((op) => !canPerform(op.role, op.kind));
      if (offender) {
        state.mergeError = `${offender.role} 无权执行「${offender.kind}」，已整批退回，可移除该操作后重试`;
        return;
      }
      const broken = state.queue.find((op) => !isWellFormed(op));
      if (broken) {
        state.mergeError = `操作「${broken.kind}」数据不完整，已整批退回，可移除后重试`;
        return;
      }
      const applied = new Set(state.appliedOpIds);
      const seen = new Set<string>();
      const conflicts: MergeConflict[] = [];
      let merged: RundownItem[] = action.payload.mainItems.map((item) => ({ ...item, version: item.version ?? 1 }));
      for (const draft of [...state.queue].reverse()) {
        const op = current(draft);
        if (applied.has(op.id) || seen.has(op.id)) continue; // 幂等：重复提交同一操作只算一次
        seen.add(op.id);
        if (op.kind === "新增条目") {
          const data = op.payload.item as Omit<RundownItem, "status" | "version">;
          if (!merged.some((item) => item.id === data.id)) merged.push({ ...data, status: "草稿", version: 1 });
        } else if (op.kind === "调整顺序") {
          const baseVersions = op.baseVersions ?? {};
          const diverged = merged.some((item) => baseVersions[item.id] !== item.version) || Object.keys(baseVersions).some((id) => !merged.some((item) => item.id === id));
          if (diverged) {
            conflicts.push({ id: crypto.randomUUID(), opId: op.id, kind: "order", opKind: "调整顺序", role: op.role, queuedAt: op.queuedAt, offline: op.payload.order ?? [], main: merged.map((item) => item.id), status: "待确认" });
          } else {
            const byId = new Map(merged.map((item) => [item.id, item]));
            const ordered = (op.payload.order ?? []).map((id) => byId.get(id)).filter((item): item is RundownItem => Boolean(item));
            merged = [...ordered, ...merged.filter((item) => !(op.payload.order ?? []).includes(item.id))];
          }
        } else if (op.kind === "突发插播") {
          const breaking = op.payload.breaking as NonNullable<QueuedOperation["payload"]["breaking"]>;
          const index = merged.findIndex((item) => item.id === breaking.insertAfter);
          merged.splice(index + 1, 0, { id: crypto.randomUUID(), title: breaking.headline, type: "新闻片", duration: breaking.duration, status: "待播", presenter: "值班主播", source: `插播：${breaking.reason}`, version: 1 });
        } else {
          const item = merged.find((entry) => entry.id === op.itemId);
          if (!item || item.version !== op.baseVersion || item.pendingConfirm) {
            // 主链路也改过同一条目：两边版本都保留，挂成待确认
            const offline = structuredClone(op.before) as RundownItem;
            applyItemOp(offline, op);
            conflicts.push({ id: crypto.randomUUID(), opId: op.id, kind: "item", opKind: op.kind, role: op.role, queuedAt: op.queuedAt, itemId: op.itemId as string, itemTitle: op.before?.title ?? op.detail, offline, main: item ? structuredClone(item) : (structuredClone(op.before) as RundownItem), status: "待确认" });
            if (item) item.pendingConfirm = true;
          } else {
            applyItemOp(item, op);
            item.version += 1;
          }
        }
      }
      const risks: HardTimeRisk[] = computeHardTimeRisks(merged); // 硬时间条目被挤动后重算风险提示
      state.items = merged;
      state.conflicts = [...conflicts, ...state.conflicts];
      state.appliedOpIds = [...state.appliedOpIds, ...seen];
      state.queue = [];
      state.lastMerge = { at: new Date().toISOString(), applied: seen.size, conflicts: conflicts.length, risks };
      state.history.unshift(snapshot(merged, "合并应急队列", `应用 ${seen.size} 条离线操作，${conflicts.length} 条挂起待确认，${risks.length} 个硬时间风险`));
    },
    /** 确认冲突：采用离线版本或保留主链路版本，确认后重算硬时间风险 */
    resolveConflict(state, action: PayloadAction<{ id: string; keep: "offline" | "main" }>) {
      const conflict = state.conflicts.find((entry) => entry.id === action.payload.id);
      if (!conflict) return;
      const data = current(conflict);
      if (data.kind === "item") {
        const item = state.items.find((entry) => entry.id === data.itemId);
        if (item) {
          if (action.payload.keep === "offline") {
            const version = item.version + 1;
            Object.assign(item, data.offline, { id: item.id, version, pendingConfirm: false });
          } else {
            item.pendingConfirm = false;
          }
        }
      } else if (action.payload.keep === "offline") {
        const plain = current(state.items);
        const byId = new Map(plain.map((item) => [item.id, item]));
        const ordered = data.offline.map((id) => byId.get(id)).filter((item): item is RundownItem => Boolean(item));
        state.items = [...ordered, ...plain.filter((item) => !data.offline.includes(item.id))];
      }
      state.conflicts = state.conflicts.filter((entry) => entry.id !== action.payload.id);
      state.history.unshift(snapshot(state.items, "冲突确认", `${data.kind === "item" ? data.itemTitle : "串联单顺序"}：采用${action.payload.keep === "offline" ? "离线" : "主链路"}版本`));
    }
  }
});

export const { initialize, setRole, setOnline, addItem, updateStatus, reorder, adjustDuration, insertBreaking, skipItem, undo, discardOp, mergeQueue, resolveConflict } = slice.actions;
export default slice.reducer;
