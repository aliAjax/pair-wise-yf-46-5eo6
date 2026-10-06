import { useEffect, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Alert, Button, Card, Form, Input, InputNumber, Select, Switch, Tag, Timeline, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { SortableItem } from "./components/SortableItem";
import { loadMainRundown, useGetRundownQuery, useSaveRundownMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { addItem, adjustDuration, canPerform, discardOp, initialize, insertBreaking, mergeQueue, reorder, resolveConflict, setOnline, setRole, skipItem, undo, updateStatus } from "./store/rundownSlice";
import { computeHardTimeRisks, computeTimeline } from "./app/schedule";
import type { Role } from "./types";

const schema = z.object({ title: z.string().min(2), type: z.enum(["新闻片", "连线", "嘉宾", "口播", "广告"]), duration: z.number().min(1).max(120), presenter: z.string().min(1), source: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

function RundownPage() {
  const dispatch = useAppDispatch();
  const { items, role, online } = useAppSelector((state) => state.rundown);
  const saveMutation = useSaveRundownMutation()[0];
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const timeline = computeTimeline(items);
  const total = items.reduce((sum, item) => sum + item.duration, 0);
  const risks = computeHardTimeRisks(items);
  const { control, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { title: "", type: "新闻片", duration: 5, presenter: "陈默", source: "主控" } });

  // 断网期间不回写主链路，避免旧值盖掉主链路上已改的内容；恢复后由合并流程统一提交
  useEffect(() => {
    if (!online) return;
    const timer = setTimeout(() => { void saveMutation(items); }, 250);
    return () => clearTimeout(timer);
  }, [items, online, saveMutation]);

  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id || !canPerform(role, "调整顺序")) return;
    const oldIndex = items.findIndex((item) => item.id === event.active.id);
    const newIndex = items.findIndex((item) => item.id === event.over!.id);
    dispatch(reorder(arrayMove(items, oldIndex, newIndex)));
  };

  const submit = (values: FormValues) => {
    dispatch(addItem(values));
    reset();
  };

  return <div className="page-grid">
    <Card className="main-card">
      <div className="card-heading"><div><small>2026-10-08 · 08:00 开播</small><h2>直播串联单</h2></div><div className="head-actions"><Tag color={online ? "green" : "red"}>{online ? "主备链路正常" : "本地应急模式"}</Tag><Button onClick={() => dispatch(undo())} disabled={!role || role === "字幕"}>撤回上一步</Button></div></div>
      <div className="summary"><span><b>{items.length}</b> 条内容</span><span><b>{total}</b> 分钟总时长</span><span className={risks.length ? "danger-text" : ""}><b>{risks.length}</b> 个硬时间风险</span><span><b>{timeline.at(-1)?.label ?? "--:--"}</b> 预计收播</span></div>
      {risks.length ? <Alert className="risk-alert" type="warning" showIcon message="硬时间风险（已按当前顺序与时长重算）" description={risks.map((risk) => `「${risk.title}」硬时间 ${risk.hardStart}，预计 ${risk.expectedStart} 才能播出，滑移 ${risk.slipMinutes} 分钟`).join("；")} /> : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
          <div className="rundown-list">{timeline.map(({ item, label }) => <SortableItem key={item.id} item={item} cumulative={label} canAdjust={canPerform(role, "调整时长")} onDuration={(delta) => dispatch(adjustDuration({ id: item.id, delta }))} onStatus={() => dispatch(updateStatus({ id: item.id, status: "已播出" }))} onSkip={() => dispatch(skipItem(item.id))} />)}</div>
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
          <Button htmlType="submit" type="primary" block disabled={!canPerform(role, "新增条目")}>加入串联单</Button>
        </Form>
      </Card>
      <BreakingForm />
    </aside>
  </div>;
}

function BreakingForm() {
  const dispatch = useAppDispatch();
  const { items, online, role } = useAppSelector((state) => state.rundown);
  const [values, setValues] = useState({ headline: "", duration: 5, insertAfter: items[0]?.id ?? "", reason: "突发新闻" });
  return <Card title="突发插播" className="breaking-card">
    <Input value={values.headline} onChange={(event) => setValues({ ...values, headline: event.target.value })} placeholder="插播标题" />
    <div className="two-cols"><InputNumber value={values.duration} onChange={(value) => setValues({ ...values, duration: Number(value ?? 5) })} addonAfter="分钟" /><Select value={values.insertAfter} onChange={(value) => setValues({ ...values, insertAfter: value })} options={items.map((item) => ({ value: item.id, label: `插在「${item.title}」后` }))} /></div>
    <Input value={values.reason} onChange={(event) => setValues({ ...values, reason: event.target.value })} placeholder="插播原因" />
    <Button type="primary" danger block disabled={values.headline.length < 2 || !canPerform(role, "突发插播")} onClick={() => { dispatch(insertBreaking(values)); if (!online) message.warning("已进入本地应急队列"); setValues({ ...values, headline: "" }); }}>立即插入并重算时长</Button>
    {!online && <small>离线操作带岗位与版本号进入应急队列，主链路恢复后按版本合并，当前顺序仍可用于本地播出。</small>}
  </Card>;
}

function QueuePage() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const doMerge = () => {
    try {
      dispatch(mergeQueue({ mainItems: loadMainRundown() }));
    } catch {
      message.error("合并失败，整批已退回，可重试");
    }
  };
  return <div className="side-stack">
    <Card title="本地应急队列">
      <div className="side-stack">
        {state.mergeError ? <Alert type="error" showIcon message="合并失败，整批已退回" description={state.mergeError} action={<Button size="small" disabled={!state.online} onClick={doMerge}>重试</Button>} /> : null}
        {state.lastMerge ? <Alert type={state.lastMerge.conflicts ? "warning" : "success"} showIcon message={`上次合并：${state.lastMerge.applied} 条操作生效，${state.lastMerge.conflicts} 条挂起待确认，${state.lastMerge.risks.length} 个硬时间风险`} description={state.lastMerge.risks.length ? state.lastMerge.risks.map((risk) => `「${risk.title}」滑移 ${risk.slipMinutes} 分钟（${risk.hardStart} → ${risk.expectedStart}）`).join("；") : undefined} /> : null}
        <div className="queue-list">{state.queue.length ? state.queue.map((op) => <article key={op.id}>
          <Tag color="red">{op.kind}</Tag>
          <div><b>{op.detail}</b><small>{op.role} · 修改前版本 {op.baseVersion ?? "全单"} · {format(new Date(op.queuedAt), "HH:mm:ss")}</small></div>
          <Button size="small" onClick={() => dispatch(discardOp(op.id))}>移除</Button>
        </article>) : <p>当前没有待同步操作。</p>}</div>
        <Button type="primary" disabled={!state.online || !state.queue.length} onClick={doMerge}>合并回主串联单</Button>
        {!state.online && <small className="queue-hint">离线中：恢复主链路后按版本合并，主链路改过的条目会保留两边版本并挂待确认。</small>}
      </div>
    </Card>
    <ConflictCard />
  </div>;
}

function ConflictCard() {
  const dispatch = useAppDispatch();
  const { conflicts, items } = useAppSelector((root) => root.rundown);
  if (!conflicts.length) return null;
  const titleOf = (id: string) => items.find((item) => item.id === id)?.title ?? id;
  return <Card title={`待确认冲突（${conflicts.length}）`} className="conflict-card">
    {conflicts.map((conflict) => <article key={conflict.id} className="conflict-row">
      <div className="conflict-head"><Tag color="orange">待确认</Tag><b>{conflict.kind === "item" ? conflict.itemTitle : "串联单顺序"}</b><small>{conflict.role} · {conflict.opKind} · {format(new Date(conflict.queuedAt), "HH:mm:ss")}</small></div>
      {conflict.kind === "item" ? <div className="conflict-versions">
        <div><small>离线版本 v{conflict.offline.version}</small><p>{conflict.offline.duration} 分钟 · {conflict.offline.status}</p></div>
        <div><small>主链路版本 v{conflict.main.version}</small><p>{conflict.main.duration} 分钟 · {conflict.main.status}</p></div>
      </div> : <div className="conflict-versions">
        <div><small>离线顺序</small><p>{conflict.offline.map(titleOf).join(" → ")}</p></div>
        <div><small>主链路顺序</small><p>{conflict.main.map(titleOf).join(" → ")}</p></div>
      </div>}
      <div className="conflict-actions">
        <Button size="small" type="primary" onClick={() => dispatch(resolveConflict({ id: conflict.id, keep: "offline" }))}>采用离线版本</Button>
        <Button size="small" onClick={() => dispatch(resolveConflict({ id: conflict.id, keep: "main" }))}>保留主链路</Button>
      </div>
    </article>)}
  </Card>;
}

function ChainPage({ mode }: { mode: "changes" | "queue" | "history" }) {
  const state = useAppSelector((root) => root.rundown);
  if (mode === "queue") return <QueuePage />;
  if (mode === "changes") return <Card title="突发变更记录"><Timeline items={state.changes.map((item) => ({ children: <div><b>{item.headline}</b><p>{item.reason} · 插播 {item.duration} 分钟</p><small>{format(new Date(item.createdAt), "HH:mm:ss")}</small></div> }))} /></Card>;
  return <Card title="操作历史"><Timeline items={state.history.map((entry) => ({ color: "blue", children: <div><b>{entry.label}</b><p>{entry.detail}</p><small>{format(new Date(entry.time), "HH:mm:ss")}</small></div> }))} /></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.rundown);
  const { data = [] } = useGetRundownQuery();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);
  // 联网恢复：自动把应急队列合并回主串联单（失败时整批保留，可在应急队列页重试）
  useEffect(() => {
    if (!state.online || !state.queue.length) return;
    try { dispatch(mergeQueue({ mainItems: loadMainRundown() })); } catch { /* 队列整批保留，可手动重试 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.online, dispatch]);
  useEffect(() => {
    if (!state.lastMerge) return;
    const { applied, conflicts, risks } = state.lastMerge;
    const text = `应急队列已合并：${applied} 条操作生效，${conflicts} 条待确认，${risks.length} 个硬时间风险`;
    if (conflicts || risks.length) message.warning(text); else message.success(text);
  }, [state.lastMerge]);
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span>LIVE</span><div><b>{t("title")}</b><small>Control room</small></div></div><nav><NavLink to="/">{t("rundown")}</NavLink><NavLink to="/changes">{t("changes")}</NavLink><NavLink to="/queue">{t("queue")} {state.queue.length ? <em>{state.queue.length}</em> : null}</NavLink></nav><Button ghost onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header className="topbar"><div><small>直播运行中 · 紧急操作均保留审计记录</small><h1>{t("title")}</h1></div><div className="top-actions"><label>在线模式 <Switch checked={state.online} onChange={(value) => dispatch(setOnline(value))} /></label><label>当前岗位 <Select<Role> value={state.role} onChange={(value) => dispatch(setRole(value))} options={[{value:"导播"},{value:"主编"},{value:"字幕"},{value:"演播室"}]} /></label></div></header><Routes><Route path="/" element={<RundownPage />} /><Route path="/changes" element={<ChainPage mode="changes" />} /><Route path="/queue" element={<ChainPage mode="queue" />} /><Route path="/history" element={<ChainPage mode="history" />} /></Routes></main>
  </div>;
}
