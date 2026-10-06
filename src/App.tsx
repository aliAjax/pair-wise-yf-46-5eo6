import { useEffect, useMemo, useRef, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline, Alert, message } from "antd";
import { addMinutes, format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { useGetRundownQuery, useSaveRundownMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addItem,
  adjustDuration,
  clearLastError,
  computeRisks,
  hydrateQueue,
  initialize,
  insertBreaking,
  mergeQueue,
  reorder,
  resolveConflict,
  retryMerge,
  selectEffectiveItems,
  setOnline,
  setRole,
  simulatePrimaryEdit,
  skipItem,
  undo,
  updateStatus,
  canStructuralEdit
} from "./store/rundownSlice";
import type { ConflictRecord, OpType, QueuedOp, Role, RundownItem } from "./types";

const QUEUE_KEY = "pair-wise-yf-46/queue";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

const OP_LABELS: Record<OpType, string> = { addItem: "新增条目", updateStatus: "播出状态", reorder: "调整顺序", adjustDuration: "调整时长", insertBreaking: "突发插播", skipItem: "取消条目" };

function useTimeline(items: RundownItem[]) {
  const start = new Date("2026-10-08T08:00:00");
  let cursor = start;
  return items.map((item) => {
    const current = cursor;
    cursor = addMinutes(cursor, item.duration);
    return { item, at: format(current, "HH:mm"), duration: item.duration };
  });
}

function opDetail(op: QueuedOp): string {
  switch (op.type) {
    case "addItem":
    case "insertBreaking":
      return (op.after as RundownItem)?.title ?? "";
    case "updateStatus":
      return `${(op.before as RundownItem)?.title ?? ""} → ${(op.payload as { status: string }).status}`;
    case "reorder":
      return "直播串联单顺序变化";
    case "adjustDuration": {
      const delta = (op.payload as { delta: number }).delta;
      return `${(op.before as RundownItem)?.title ?? ""} ${delta > 0 ? "+" : ""}${delta} 分钟`;
    }
    case "skipItem":
      return (op.before as RundownItem)?.title ?? "";
  }
}

function opBefore(op: QueuedOp): string {
  if (op.type === "reorder") return `顺序 v${op.baseVersion}`;
  if (op.type === "addItem" || op.type === "insertBreaking") return "无旧值（新增）";
  const before = op.before as RundownItem | null;
  return before ? `${before.title} · v${before.version}` : `v${op.baseVersion}`;
}

function RundownPage() {
  const dispatch = useAppDispatch();
  const items = useAppSelector((state) => state.rundown.items);
  const effectiveItems = useAppSelector(selectEffectiveItems);
  const { role, online, lastError } = useAppSelector((state) => state.rundown);
  const saveMutation = useSaveRundownMutation()[0];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const timeline = useTimeline(effectiveItems);
  const risks = computeRisks(effectiveItems);
  const total = effectiveItems.reduce((sum, item) => sum + item.duration, 0);
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  // 仅在线时把主链路条目落盘；断网期间条目保持主链路版本，不覆盖
  useEffect(() => {
    if (!online) return;
    const timer = setTimeout(() => void saveMutation(items), 250);
    return () => clearTimeout(timer);
  }, [items, online, saveMutation]);

  useEffect(() => {
    if (lastError) {
      message.error(lastError);
      dispatch(clearLastError());
    }
  }, [lastError, dispatch]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || !canStructuralEdit(role)) return;
    const oldIndex = effectiveItems.findIndex((item) => item.id === event.active.id);
    const newIndex = effectiveItems.findIndex((item) => item.id === event.over!.id);
    const orderedIds = arrayMove(effectiveItems, oldIndex, newIndex).map((item) => item.id);
    dispatch(reorder({ orderedIds }));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    if (!online) message.info("已进入本地应急队列，联网后统一提交");
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={!role || role === "字幕"}>撤回上一步</Button></div></div>
      <div className="summary"><span><b>{effectiveItems.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={risks.length ? "danger-text" : ""}><b>{risks.length}</b> 个硬时间风险</span><span><b>{timeline.at(-1)?.at ?? "--:--"}</b> 预计收播</span></div>
      {risks.length ? <Alert type="warning" showIcon className="risk-alert" message={`硬时间风险：${risks.map((risk) => `${risk.title} 应 ${risk.hardStart} / 实际 ${risk.actualAt}（延误 ${risk.delay} 分钟）`).join("；")}`} /> : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={effectiveItems.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{timeline.map(({ item, at }) => <SortableItem key={item.id} item={item} cumulative={at} role={role} onDuration={(delta) => dispatch(adjustDuration({ id: item.id, delta }))} onStatus={() => dispatch(updateStatus({ id: item.id, status: "已播出" }))} onSkip={() => dispatch(skipItem(item.id))} />)}</div>
        </SortableContext>
      </DndContext>
    </Card>
    <aside className="side-stack">
      <Card title="新增播出条目">
        <Form layout="vertical" onFinish={handleSubmit(submit)}>
          <Form.Item label="标题"><Controller name="title" control={control} render={({ field, fieldState }) => <><Input {...field} status={fieldState.error ? "error" : ""} /><small className="error">{fieldState.error?.message}</small></>} /></Form.Item>
          <div className="two-cols"><Form.Item label="类型"><Controller name="type" control={control} render={({ field }) => <Select {...field} options={["新闻片","连线","嘉宾","口播","广告"].map((v) => ({ value: v, label: v }))} />} /></Form.Item><Form.Item label="时长"><Controller name="duration" control={control} render={({ field }) => <InputNumber {...field} min={1} max={120} addonAfter="分钟" />} /></Form.Item></div>
          <Form.Item label="主播"><Controller name="presenter" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Form.Item label="来源"><Controller name="source" control={control} render={({ field }) => <Input {...field} />} /></Form.Item>
          <Button htmlType="submit" type="primary" block disabled={!canStructuralEdit(role)}>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const items = useAppSelector((state) => state.rundown.items);
  const effectiveItems = useAppSelector(selectEffectiveItems);
  const { online, role } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: effectiveItems[0]?.id ?? "", reason: "突发新闻" });
  const canEdit = canStructuralEdit(role);
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={effectiveItems.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2 || !canEdit} onClick={() => { dispatch(insertBreaking(values)); if (!online) message.warning("已进入本地应急队列，联网后统一提交"); setValues({ ...values, headline: "" }); }}>立即插入并重算时长</Button>
    {!online && <small>离线操作将在主链路恢复后统一提交，当前顺序仍可用于本地播出。</small>}
    {!canEdit && <small className="error">当前岗位「{role}」无权插播。</small>}
  </Card>;
}

function ConflictsCard() {
  const dispatch = useAppDispatch();
  const conflicts = useAppSelector((state) => state.rundown.conflicts);
  const items = useAppSelector((state) => state.rundown.items);
  if (!conflicts.length) return null;
  const titleOf = (id: string) => items.find((item) => item.id === id)?.title ?? id;
  const describe = (snapshot: RundownItem | string[], type: OpType) => {
    if (type === "reorder") return (snapshot as string[]).map(titleOf).join(" → ");
    const item = snapshot as RundownItem;
    return `${item.title} · 时长 ${item.duration} 分钟 · ${item.status} · v${item.version}`;
  };
  return <Card title={`待确认冲突（${conflicts.length}）`} className="conflicts-card">
    <Alert type="warning" showIcon message="主链路与应急队列都修改了同一条目，已保留两边版本，请裁决采用哪一版。" className="conflicts-alert" />
    <div className="conflict-list">{conflicts.map((conflict) => <article key={conflict.id} className="conflict-row">
      <Tag color="orange">{OP_LABELS[conflict.type]}</Tag>
      <div className="conflict-versions">
        <div className="version version-primary"><b>主链路版本</b><span>{describe(conflict.primarySnapshot, conflict.type)}</span></div>
        <div className="version version-backup"><b>应急版本</b><span>{describe(conflict.backupSnapshot, conflict.type)}</span></div>
      </div>
      <div className="conflict-actions"><Button size="small" onClick={() => dispatch(resolveConflict({ conflictId: conflict.id, adopt: "primary" }))}>采用主版本</Button><Button size="small" type="primary" onClick={() => dispatch(resolveConflict({ conflictId: conflict.id, adopt: "backup" }))}>采用应急版本</Button></div>
    </article>)}</div>
  </Card>;
}

function ChainPage({ mode }: { mode: "changes" | "queue" | "history" }) {
  const state = useAppSelector((root) => root.rundown);
  const dispatch = useAppDispatch();
  const prevQueueLen = useRef(state.queue.length);
  useEffect(() => {
    if (state.online && prevQueueLen.current > 0 && state.queue.length === 0 && !state.lastError) {
      message.success("应急队列已合并到主串联单");
    }
    prevQueueLen.current = state.queue.length;
  }, [state.queue.length, state.online, state.lastError]);

  if (mode === "queue") return <Card title="本地应急队列" extra={<Button type="primary" disabled={!state.online || !state.queue.length} onClick={() => dispatch(mergeQueue())}>主链路恢复后提交</Button>}>
    {state.lastError ? <Alert type="error" showIcon className="queue-error" message={state.lastError} action={<Button size="small" onClick={() => dispatch(retryMerge())}>重试</Button>} /> : null}
    <div className="queue-list">{state.queue.length ? state.queue.map((op) => <article key={op.id} className="queue-op">
      <div className="queue-op-head"><Tag color="red">{OP_LABELS[op.type]}</Tag><b>{opDetail(op)}</b>{op.status === "rejected" ? <Tag color="red">已驳回</Tag> : null}</div>
      <div className="queue-op-meta"><span>岗位：{op.role}</span><span>修改前：{opBefore(op)}</span><span>时间：{format(new Date(op.time), "HH:mm:ss")}</span></div>
    </article>) : <p>当前没有待同步操作。</p>}</div>
    {state.queue.length ? <div className="queue-demo"><small>演示：断网期间若主链路也改了同一条目，可点此模拟主链路并发修改，再提交即可看到待确认冲突。</small><Button size="small" onClick={() => dispatch(simulatePrimaryEdit({}))}>模拟主链路并发修改</Button></div> : null}
  </Card>;
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data = [] } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      if (raw) dispatch(hydrateQueue(JSON.parse(raw) as QueuedOp[]));
    } catch { /* ignore */ }
  }, [dispatch]);
  const firstQueueSave = useRef(true);
  useEffect(() => {
    if (firstQueueSave.current) { firstQueueSave.current = false; return; }
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue)); } catch { /* ignore */ }
  }, [state.queue]);
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {state.queue.length ? <em>{state.queue.length}</em> : null}</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>在线模式 <Switch checked={state.online} onChange={(value) => { dispatch(setOnline(value)); if (value) dispatch(mergeQueue()); }} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label></div></header><Routes><Route path="/" element={<RundownPage />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<ChainPage mode="queue" />} /><Route path="/history" element={<ChainPage mode="history" />} /></Routes><ConflictsCard /></main>
  </div>;
}
