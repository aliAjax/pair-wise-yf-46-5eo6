import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button, Tag, Tooltip } from "antd";
import { WarningOutlined } from "@ant-design/icons";
import type { Role, RundownItem } from "../types";
import { canStructuralEdit } from "../store/rundownSlice";

export function SortableItem({ item, cumulative, role, onStatus, onSkip, onDuration }: { item: RundownItem; cumulative: string; role: Role; onStatus: () => void; onSkip: () => void; onDuration: (delta: number) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: item.id, disabled: item.status === "已播出" || !canStructuralEdit(role) });
  const canEdit = canStructuralEdit(role);
  return (
    <article ref={setNodeRef} className={`rundown-row status-${item.status} ${item.pending ? "is-pending" : ""}`} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button className="drag-handle" {...attributes} {...listeners} aria-label="拖拽调整顺序">⠿</button>
      <time>{cumulative}</time>
      <div className="row-main"><b>{item.title}{item.pending ? <Tag color="orange" icon={<WarningOutlined />} className="pending-tag">待确认</Tag> : null}</b><small>{item.source} · {item.presenter} · v{item.version}</small></div>
      <Tag color={item.type === "广告" ? "gold" : item.type === "连线" ? "blue" : "geekblue"}>{item.type}</Tag>
      <span>{item.duration} 分钟</span>
      <Tag color={item.status === "已播出" ? "green" : item.status === "已跳过" ? "red" : "default"}>{item.status}</Tag>
      <div className="row-actions">
        <Tooltip title={canEdit ? "" : "当前岗位无权调整时长"}><span><Button size="small" disabled={!canEdit} onClick={() => onDuration(-1)}>-1</Button></span></Tooltip>
        <Tooltip title={canEdit ? "" : "当前岗位无权调整时长"}><span><Button size="small" disabled={!canEdit} onClick={() => onDuration(1)}>+1</Button></span></Tooltip>
        <Button size="small" type="primary" disabled={item.status === "已播出"} onClick={onStatus}>播出</Button>
        <Button size="small" danger disabled={item.status === "已播出"} onClick={onSkip}>取消</Button>
      </div>
    </article>
  );
}
