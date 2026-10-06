export type Role = "导播" | "主编" | "字幕" | "演播室";
export type ItemType = "新闻片" | "连线" | "嘉宾" | "口播" | "广告";
export type ItemStatus = "待播" | "已播出" | "已跳过" | "草稿";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number;
  hardStart?: string;
  status: ItemStatus;
  presenter: string;
  source: string;
  /** 修改版本号，每次变更递增，用于合并时检测主链路是否改过同一条目 */
  version: number;
  /** 合并冲突挂起确认 */
  pendingConfirm?: boolean;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

export type QueueOpKind = "新增条目" | "调整顺序" | "调整时长" | "取消条目" | "播出状态" | "突发插播";

/** 断网期间进入应急队列的结构化操作：带岗位、修改前版本和时间 */
export interface QueuedOperation {
  /** 操作ID，重复提交同一操作只算一次 */
  id: string;
  kind: QueueOpKind;
  role: Role;
  queuedAt: string;
  detail: string;
  itemId?: string;
  /** 条目操作的修改前版本 */
  baseVersion?: number;
  /** 顺序调整时全单各条目的修改前版本 */
  baseVersions?: Record<string, number>;
  /** 修改前快照，冲突时用于还原离线版本 */
  before?: RundownItem;
  payload: {
    delta?: number;
    order?: string[];
    status?: ItemStatus;
    item?: Omit<RundownItem, "status" | "version">;
    breaking?: { headline: string; duration: number; insertAfter: string; reason: string };
  };
}

/** 主链路也改过同一条目时，两边版本都保留并挂为待确认 */
export type MergeConflict =
  | { id: string; opId: string; kind: "item"; opKind: QueueOpKind; role: Role; queuedAt: string; itemId: string; itemTitle: string; offline: RundownItem; main: RundownItem; status: "待确认" }
  | { id: string; opId: string; kind: "order"; opKind: "调整顺序"; role: Role; queuedAt: string; offline: string[]; main: string[]; status: "待确认" };

/** 硬时间条目被挤动后重算的风险提示 */
export interface HardTimeRisk {
  itemId: string;
  title: string;
  hardStart: string;
  expectedStart: string;
  slipMinutes: number;
}

export interface MergeResult {
  at: string;
  applied: number;
  conflicts: number;
  risks: HardTimeRisk[];
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}
