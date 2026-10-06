import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { RundownItem } from "../types";

const KEY = "pair-wise-yf-46/rundown";

/** 读取主链路当前串联单（合并时以它为准，本地离线改动合并进来） */
export function loadMainRundown(): RundownItem[] {
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as RundownItem[]) : [];
}

export const rundownApi = createApi({
  reducerPath: "rundownApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Rundown"],
  endpoints: (builder) => ({
    getRundown: builder.query<RundownItem[], void>({
      queryFn: async () => ({ data: loadMainRundown() }),
      providesTags: ["Rundown"]
    }),
    saveRundown: builder.mutation<{ ok: true }, RundownItem[]>({
      queryFn: async (items) => {
        localStorage.setItem(KEY, JSON.stringify(items));
        return { data: { ok: true } };
      },
      invalidatesTags: ["Rundown"]
    })
  })
});

export const { useGetRundownQuery, useSaveRundownMutation } = rundownApi;
