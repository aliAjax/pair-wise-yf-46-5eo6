import { addMinutes, differenceInMinutes, format, parse } from "date-fns";
import type { HardTimeRisk, RundownItem } from "../types";

export const BROADCAST_START = new Date("2026-10-08T08:00:00");

export function computeTimeline(items: RundownItem[]) {
  let cursor = BROADCAST_START;
  return items.map((item) => {
    const at = cursor;
    cursor = addMinutes(cursor, item.duration);
    return { item, at, label: format(at, "HH:mm") };
  });
}

/** 硬时间条目被挤动后重算风险提示：预计开始晚于硬时间即记一条 */
export function computeHardTimeRisks(items: RundownItem[]): HardTimeRisk[] {
  return computeTimeline(items)
    .filter(({ item, at }) => item.hardStart && format(at, "HH:mm") > item.hardStart)
    .map(({ item, at }) => ({
      itemId: item.id,
      title: item.title,
      hardStart: item.hardStart as string,
      expectedStart: format(at, "HH:mm"),
      slipMinutes: differenceInMinutes(at, parse(item.hardStart as string, "HH:mm", at))
    }));
}
