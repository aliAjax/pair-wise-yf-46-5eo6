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
  /** 主链路条目版本号：每次主链路（在线）修改自增，用于断网合并时的冲突判定 */
  version: number;
  /** 该条目是否存在待确认的两边版本冲突 */
  pending?: boolean;
}

export interface BreakingChange {
  id: string;
  headline: string;
  duration: number;
  insertAfter: string;
  reason: string;
  createdAt: string;
}

export type OpType = "addItem" | "updateStatus" | "reorder" | "adjustDuration" | "insertBreaking" | "skipItem";

/** 断网应急队列中的一条操作：携带岗位、修改前版本与时间 */
export interface QueuedOp {
  /** 幂等键：同一操作重复提交只算一次 */
  id: string;
  type: OpType;
  /** 操作岗位 */
  role: Role;
  /** 操作时间 */
  time: string;
  /** 修改前版本：条目操作为条目 version，顺序/新增/插播为 orderVersion */
  baseVersion: number;
  /** 修改前快照：条目操作为条目，顺序操作为 id 列表 */
  before: RundownItem | string[] | null;
  /** 修改后快照（备版本） */
  after: RundownItem | string[] | null;
  /** 重放所需的结构化载荷 */
  payload: Record<string, unknown>;
  status: "pending" | "merged" | "conflict" | "rejected";
  failReason?: string;
  /** 所属批次：整批退回时同批重试 */
  batchId?: string;
}

/** 主链路也改过同一条目时，保留两边版本并挂成待确认 */
export interface ConflictRecord {
  id: string;
  opId: string;
  type: OpType;
  /** 条目级冲突的条目 id；顺序冲突为空 */
  itemId?: string;
  primarySnapshot: RundownItem | string[];
  backupSnapshot: RundownItem | string[];
  status: "待确认" | "已采用主版本" | "已采用备版本";
  time: string;
}

export interface HistoryEntry {
  id: string;
  label: string;
  detail: string;
  time: string;
  snapshot: RundownItem[];
}
