import { useSyncExternalStore } from "react";

/**
 * Width of the original-message pane. `ratio` is the user's dragged share of the workspace, remembered in this
 * browser (a per-viewer convenience); `expanded` is a temporary wide mode that also collapses the decision list.
 */
type Layout = { ratio?: number; expanded: boolean };
const KEY = "bkms-workbench.sourceRatio";
const read = (): number | undefined => {
  try { const value = Number(localStorage.getItem(KEY)); return value > 0.15 && value < 0.85 ? value : undefined; } catch { return undefined; }
};
let layout: Layout = { ratio: read(), expanded: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const useSourceLayout = () => useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => layout);
export function setSourceRatio(ratio: number | undefined) {
  layout = { ...layout, ratio };
  try { if (ratio === undefined) localStorage.removeItem(KEY); else localStorage.setItem(KEY, ratio.toFixed(3)); } catch { /* storage unavailable: keep for this session */ }
  emit();
}
export function setSourceExpanded(expanded: boolean) { if (layout.expanded !== expanded) { layout = { ...layout, expanded }; emit(); } }

/** Grid column for the source pane: proportional by default, the dragged share, or wide mode; the result pane keeps at least 480px. */
export function sourceColumn(state: Layout): string {
  if (state.expanded) return "clamp(360px, 65%, calc(100% - 360px))";
  if (state.ratio) return `clamp(320px, ${(state.ratio * 100).toFixed(1)}%, max(320px, calc(100% - 480px)))`;
  return "clamp(360px, 40%, min(760px, max(360px, calc(100% - 480px))))";
}
export const MIN_SOURCE = 320, MIN_RESULT = 480;
