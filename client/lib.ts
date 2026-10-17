import { language, t } from "./i18n";
import type { Preferences } from "./preferences";

export type Status = "queued" | "running" | "review" | "needs_info" | "failed" | "sending" | "sent" | "uncertain" | "ignored" | "unmatched" | "completed";
export type Autonomy = "draft" | "low_risk" | "auto";
export type SourceKind = "email" | "feishu" | "wecom" | "wechat" | "meeting";
export type Category = "request" | "reply_needed" | "fyi" | "notification" | "marketing" | "other";
export type Draft = {
  id: string; revision: number; account: string; to: string; cc: string; subject: string; text: string;
  attachments: { id: string; filename: string }[]; state: string;
  sendChecks?: { at: string; outcome: "sent" | "not_sent" }[];
  receipt?: { accepted: string[]; rejected: string[]; response: string; messageId?: string };
};
export type Task = {
  id: string; title: string; account: string; status: Status; from: string; replyTo?: string; subject: string; body: string;
  bodyHtml?: string; to?: string; cc?: string; mailDate?: string; mailSize?: number; receivedAt: string; updatedAt: string;
  ruleId?: string; ruleName?: string; summary?: string; informationGaps?: string; needsInfoKind?: "information" | "attachments";
  outputKind?: "reply" | "report"; ruleUpdated?: boolean; canResolveSend?: boolean; error?: string; draftId?: string; draft?: Draft;
  revision: number; history: { at: string; message: string }[]; attachments?: { filename: string; size: number }[];
  hasAttachments?: boolean; mailLoaded?: boolean; sessionId?: string;
  triage?: { state: "pending" | "done"; category?: Category; urgency?: "high" | "normal" | "low"; reason?: string; nextStep?: string; by?: string; archived?: boolean };
  checks?: { item: string; quote?: string }[];
  autoSend?: { at: string; scheduledAt: string; autonomy: Autonomy; canceledAt?: string; reason?: string };
  relatedIds?: string[]; possibleIds?: string[]; topicIds?: string[]; attention?: boolean;
};
export type Rule = {
  id: string; name: string; enabled: boolean; priority: number; account: string; folder: string;
  match: { from: string; subject: string; hasAttachments: boolean; mode: "all" | "any" };
  instructions: string; tools: string[]; skills?: string[]; output: "reply" | "report"; maxRetries: number;
  semantic?: string; exclude?: Category[]; autonomy?: Autonomy; sources?: SourceKind[]; revision?: number;
};
export type Capabilities = { tools: { name: string; description: string }[]; skills: { id: string; name: string; description: string }[] };
export type Activity = { id: string; at: string; kind: string; title: string; detail?: string; taskId?: string; ruleName?: string; autonomy?: Autonomy; undoUntil?: string; undoneAt?: string };
export type Topic = { id: string; name: string; kind: "customer" | "project" | "other"; keywords: string[]; senders: string[]; schedule: "none" | "weekly"; createdAt: string; updatedAt: string; count?: number; open?: number; lastAt?: string; summary?: { text: string; level: "good" | "attention" | "risk"; risks: string[]; todos: string[]; at: string; by: string } };
export type Report = { id: string; kind: "weekly" | "topic"; title: string; text: string; periodStart: string; periodEnd: string; generatedAt: string; updatedAt: string; topicId?: string; by: string };
export type Log = { id?: string; at?: string; level?: string; message?: string; taskId?: string };
export type Defaults = { triage: boolean; undoMinutes: number; briefEnabled: boolean; briefTime: string; weeklyEnabled: boolean; weeklyDay: number; weeklyTime: string; meetingBriefMinutes: number };
export type Snapshot = {
  revision: number; tasks: Task[]; rules: Rule[]; accounts: { id: string; label: string; inboxFolder?: string }[]; logs: Log[];
  capabilities?: Capabilities; settings: Preferences["settings"] & Partial<Defaults>; defaults: Defaults;
  health: { email: boolean; agent?: boolean; running?: boolean; lastPoll?: string; error?: string; triage?: boolean; writer?: boolean };
  activity: Activity[]; topics: Topic[]; reports: Report[]; brief?: { date: string; text: string; generatedAt: string; by: string }; today: string;
  sources: { kind: SourceKind; connected: boolean; detail: string }[]; meetings: unknown[];
};
export type EditDraft = Pick<Draft, "to" | "cc" | "subject" | "text"> & { attachments: string[] };
export type SendPlan = {
  bodyHtml?: string; id?: string; planId?: string; taskRevision?: number; draftRevision?: number; draft?: Draft;
  from?: { address: string; name?: string };
  matching?: { blocked: boolean; rows: { field: string; address: string; matched: boolean; blocked: boolean; value?: string }[] };
  attachments?: { id: string; filename: string; size: number }[]; expiresAt?: number;
};

export const EMPTY: Snapshot = {
  revision: 1, tasks: [], rules: [], accounts: [], logs: [], settings: { enabled: false, pollSeconds: 60 },
  defaults: { triage: true, undoMinutes: 30, briefEnabled: true, briefTime: "08:00", weeklyEnabled: true, weeklyDay: 5, weeklyTime: "17:00", meetingBriefMinutes: 30 },
  health: { email: false }, activity: [], topics: [], reports: [], today: "", sources: [], meetings: [],
};

export const LABELS: Record<Status, string> = {
  queued: "等待处理", running: "正在处理", review: "待审核", needs_info: "待补充", failed: "处理失败", sending: "正在发送",
  sent: "已发送", uncertain: "发送待核实", ignored: "已忽略", unmatched: "未匹配", completed: "已完成",
};
export const statusLabel = (task: Pick<Task, "status" | "triage">): string =>
  task.status === "ignored" && task.triage?.archived ? t("已归档") : task.status === "queued" && task.triage?.state === "pending" ? t("等待分拣") : t(LABELS[task.status] || task.status);
export const statusTone = (task: Pick<Task, "status" | "triage" | "draft">): "warn" | "good" | "danger" | "accent" | "muted" => {
  if (task.status === "sent" && task.draft?.receipt?.rejected?.length) return "danger";
  if (["review", "needs_info"].includes(task.status) || (task.status === "unmatched" && ["request", "reply_needed"].includes(task.triage?.category || ""))) return "warn";
  if (["failed", "uncertain"].includes(task.status)) return "danger";
  if (["sent", "completed"].includes(task.status)) return "good";
  if (["queued", "running", "sending"].includes(task.status)) return "accent";
  return "muted";
};
export const CATEGORY: Record<Category, string> = { request: "请求", reply_needed: "需回复", fyi: "值得关注", notification: "通知", marketing: "营销", other: "其他" };
export const SOURCE: Record<SourceKind, string> = { email: "邮件", feishu: "飞书", wecom: "企微", wechat: "微信", meeting: "会议" };
export const AUTONOMY_LABEL: Record<Autonomy, string> = { draft: "仅起草", low_risk: "低风险自动", auto: "全自动" };

/** The next step in words: the AI's specific step when known, otherwise the state's generic step. */
export function nextStep(task: Task): string {
  if (task.autoSend && !task.autoSend.canceledAt && task.status === "review") return t("将于 {0} 自动发送，可撤回", time(task.autoSend.at));
  if (task.status === "needs_info" && task.error) return firstLine(task.error);
  if (task.triage?.nextStep && ["review", "unmatched", "needs_info"].includes(task.status)) return task.triage.nextStep;
  switch (task.status) {
    case "review": return task.checks?.length ? t("核对 {0} 处后发送", task.checks.length) : t("核对处理结果与回复草稿");
    case "needs_info": return t("补充必要信息后继续处理");
    case "failed": return t("查看失败原因并重新处理");
    case "uncertain": return t("先核对发送记录，避免重复发送");
    case "unmatched": return t("选择处理方案或忽略任务");
    case "queued": return task.triage?.state === "pending" ? t("等待 AI 分拣") : t("等待后台处理");
    case "running": return t("正在准备处理结果");
    case "sending": return t("正在等待发送结果");
    case "sent": return t("查看发送回执");
    case "completed": return t("查看已生成的处理结果");
    case "ignored": return task.triage?.archived ? t("AI 已归档，可恢复") : t("此任务已忽略");
  }
}
export const firstLine = (value: string) => value.split(/\n/).map(line => line.trim()).find(Boolean)?.slice(0, 80) || value.slice(0, 80);
export const senderName = (from: string) => (from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] || from.replace(/<.*>/, "") || from).trim() || from;
export const senderAddress = (from: string) => (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();

const locale = () => (language() === "en" ? "en-US" : "zh-CN");
export const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
export const dateTime = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale(), { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
export const fullDate = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
/** Compact list time: today shows the time, yesterday says so, older shows the date. */
export function when(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  const date = new Date(value), today = new Date(), yesterday = new Date(Date.now() - 864e5);
  if (dayKey(date) === dayKey(today)) return time(value);
  if (dayKey(date) === dayKey(yesterday)) return t("昨天");
  return date.toLocaleDateString(locale(), { month: "2-digit", day: "2-digit" });
}
export function dayLabel(value: string): string {
  const date = new Date(value), today = new Date(), yesterday = new Date(Date.now() - 864e5);
  const label = date.toLocaleDateString(locale(), { month: "long", day: "numeric", weekday: "short" });
  if (dayKey(date) === dayKey(today)) return t("今天 · {0}", label);
  if (dayKey(date) === dayKey(yesterday)) return t("昨天 · {0}", label);
  return label;
}
export const longDate = (date = new Date()) => date.toLocaleDateString(locale(), { month: "long", day: "numeric", weekday: "long" });
export const minutesLeft = (value?: string) => value ? Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 60000)) : 0;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export const uiLanguage = (): "zh" | "en" => (language() === "en" ? "en" : "zh");
export const draftValue = (draft: Draft): EditDraft => ({ to: draft.to || "", cc: draft.cc || "", subject: draft.subject || "", text: draft.text || "", attachments: draft.attachments?.map(file => file.id) || [] });
export const urgencyRank = (task: Task) => task.triage?.urgency === "high" ? 0 : ["failed", "uncertain"].includes(task.status) ? 1 : 2;

export function hostFetch(input: string, init: RequestInit): Promise<Response> {
  const transport = (globalThis as unknown as { __DSH_TRANSPORT__?: { fetch?: typeof fetch } }).__DSH_TRANSPORT__?.fetch;
  return (transport || globalThis.fetch)(input, init);
}
export async function api<T = unknown>(action: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  // Native hosts may own the authenticated HTTP carrier. Keep the route relative
  // so it resolves against that Host's base rather than the desktop page origin.
  const response = await hostFetch("api/bkms-workbench", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-bkms-workbench": "1" },
    body: JSON.stringify({ uiLanguage: uiLanguage(), ...payload, action }), signal,
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error(body.error?.message || (typeof body.error === "string" ? body.error : t("操作失败 ({0})", response.status)));
  return body.value as T;
}
function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export const downloadText = (text: string, filename: string) => save(new Blob([text], { type: "text/markdown;charset=utf-8" }), filename);
export async function downloadPreview(plan: string, file: { id: string; filename: string }): Promise<void> {
  const response = await hostFetch(`api/dsh-email/drafts?preview=${encodeURIComponent(plan)}&attachment=${encodeURIComponent(file.id)}`, { credentials: "same-origin" });
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error?.message || t("附件预览已失效，请重新审核发送。")); }
  save(await response.blob(), file.filename);
}
export async function downloadOriginal(task: Task, index: number, filename: string): Promise<void> {
  const response = await hostFetch("api/bkms-workbench/attachment", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-bkms-workbench": "1" }, body: JSON.stringify({ id: task.id, revision: task.revision, index }) });
  if (!response.ok || response.headers.get("content-type")?.includes("application/json")) {
    const result = await response.json().catch(() => ({}));
    throw new Error(typeof result.error === "string" ? result.error : result.error?.message || t("无法下载原邮件附件，请重新读取邮件后重试。"));
  }
  const encoded = response.headers.get("content-disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name = filename;
  if (encoded) try { name = decodeURIComponent(encoded); } catch { /* Keep the verified displayed filename. */ }
  save(await response.blob(), name);
}
export async function uploadDraftAttachment(draft: Draft, file: File): Promise<Draft> {
  const response = await hostFetch("api/dsh-email/drafts/upload", {
    method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream", "x-dsh-email-draft": "1", "x-dsh-draft-id": draft.id, "x-dsh-draft-revision": String(draft.revision), "x-dsh-draft-filename": encodeURIComponent(file.name) },
    body: file,
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : result.error?.message || t("附件上传失败，请刷新草稿后重试。"));
  return result.value as Draft;
}
