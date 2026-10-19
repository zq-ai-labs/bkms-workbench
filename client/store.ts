import { useSyncExternalStore } from "react";
import { api, type WechatSettings } from "./lib";
import { TodoTracker, type Preferences } from "./preferences";

/** Lightweight preferences shared by the sidebar entry, reminders and both settings surfaces. */
export type Settings = Preferences["settings"] & { triage?: boolean; undoMinutes?: number; briefEnabled?: boolean; briefTime?: string; weeklyEnabled?: boolean; weeklyDay?: number; weeklyTime?: string; meetingBriefMinutes?: number; wechat?: WechatSettings };
const initial = (): Preferences => ({ revision: 1, settings: { enabled: false, pollSeconds: 60, showWorkbench: true, notifyNewTodo: false }, attention: [] });
export let preferences: Preferences = initial();
export let reminder = { count: 0, sequence: 0 };
let tracker = new TodoTracker();
const listeners = new Set<() => void>();
export const subscribePreferences = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const emit = () => listeners.forEach(listener => listener());
export function acceptPreferences(next: Preferences) {
  if (next.revision < preferences.revision) return;
  if (next.revision === preferences.revision && (next.stateRevision ?? 0) < (preferences.stateRevision ?? 0)) return;
  const count = tracker.accept(next.settings.notifyNewTodo === true, next.attention);
  preferences = next;
  if (!next.settings.notifyNewTodo) reminder = { ...reminder, count: 0 };
  else if (count) reminder = { count: reminder.count + count, sequence: reminder.sequence + 1 };
  emit();
}
export async function refreshPreferences(signal?: AbortSignal) { acceptPreferences(await api<Preferences>("preferences", {}, signal)); }
export const usePreferences = () => useSyncExternalStore(subscribePreferences, () => preferences);
export const useReminder = () => useSyncExternalStore(subscribePreferences, () => reminder);
export function dismissReminder() { reminder = { ...reminder, count: 0 }; emit(); }
export function resetPreferences() { tracker = new TodoTracker(); preferences = initial(); dismissReminder(); }
/** Apply a saved settings object immediately; turning reminders on establishes a fresh silent baseline. */
export function applySaved(revision: number, settings: Settings) {
  if (settings.notifyNewTodo && !preferences.settings.notifyNewTodo) { tracker = new TodoTracker(); preferences = { ...preferences, revision, settings }; emit(); }
  else acceptPreferences({ ...preferences, revision, settings });
}
export const settingsOf = (settings: Settings) => ({
  triage: settings.triage !== false, undoMinutes: settings.undoMinutes ?? 30, briefEnabled: settings.briefEnabled !== false, briefTime: settings.briefTime ?? "08:00",
  weeklyEnabled: settings.weeklyEnabled !== false, weeklyDay: settings.weeklyDay ?? 5, weeklyTime: settings.weeklyTime ?? "17:00", meetingBriefMinutes: settings.meetingBriefMinutes ?? 30,
});
