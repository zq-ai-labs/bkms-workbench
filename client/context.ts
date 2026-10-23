import * as React from "react";
import { EMPTY, type Snapshot } from "./lib";

export type View = "today" | "decide" | "done" | "items" | "meetings" | "topics" | "plans" | "settings" | "logs";
export type Route = { view: View; task?: string; rule?: string; topic?: string; report?: string; channel?: string };
export type WorkbenchContext = {
  data: Snapshot; loaded: boolean; busy: string;
  refresh(): Promise<Snapshot>;
  /** Run one user operation at a time; errors are shown in the shared alert area. */
  perform(key: string, work: () => Promise<unknown>): Promise<void>;
  notify(message: string): void;
  fail(message: string): void;
  go(route: Route): void;
  /** Registered by editors with unsaved changes; returns false to block navigation. */
  leave: React.MutableRefObject<(() => boolean) | undefined>;
};
export const Context = React.createContext<WorkbenchContext>({
  data: EMPTY, loaded: false, busy: "", refresh: async () => EMPTY, perform: async () => {}, notify() {}, fail() {}, go() {}, leave: { current: undefined },
});
export const useWorkbench = () => React.useContext(Context);
