import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectLocale, systemMessage, t, useWorkbenchLocale, type LocaleService } from "./i18n";
import { Context, type Route, type View, type WorkbenchContext } from "./context";
import { EMPTY, api, errorMessage, time, type Snapshot } from "./lib";
import { dismissReminder, preferences, refreshPreferences, resetPreferences, subscribePreferences, usePreferences, useReminder } from "./store";
import { Alert, Empty, Icon } from "./ui";
import { DecideView, DoneView, ItemsView, LogsView, MeetingsView, TodayView } from "./views";
import { TopicsView } from "./topics";
import { PlansView } from "./plans";
import { WorkbenchSettings } from "./settings";
// @ts-ignore CSS is bundled as a text module by scripts/build-client.mjs.
import stylesheet from "./styles.css";

export { WorkbenchSettings };
let lastRoute: Route = { view: "today" };
const TABS: [View, string, string][] = [["today", "今日", "sun"], ["decide", "待我决策", "inbox"], ["done", "AI 已代办", "done"], ["items", "全部事项", "grid"], ["meetings", "会议", "calendar"], ["topics", "主题与报告", "topic"], ["plans", "处理方案", "rules"]];

export function Workbench() {
  useWorkbenchLocale();
  const [data, setData] = useState<Snapshot>(EMPTY), [loaded, setLoaded] = useState(false);
  const [route, setRoute] = useState<Route>(lastRoute);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [hiddenStatus, setHiddenStatus] = useState("");
  const op = useRef(false), sequence = useRef(0), mounted = useRef(true), leave = useRef<(() => boolean) | undefined>(undefined);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const snapshot = await api<Snapshot>("snapshot");
    if (mounted.current && request === sequence.current) { setData(snapshot); setLoaded(true); }
    return snapshot;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const load = () => refresh().catch(failure => setError(errorMessage(failure)));
    load();
    const timer = setInterval(load, 8000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => { lastRoute = route; }, [route]);
  const perform = useCallback(async (key: string, work: () => Promise<unknown>) => {
    if (op.current) return;
    op.current = true; setBusy(key); setError(""); setNotice("");
    try { await work(); } catch (failure) { setError(errorMessage(failure)); await refresh().catch(() => {}); }
    finally { op.current = false; setBusy(""); }
  }, [refresh]);
  const routeRef = useRef(route);
  routeRef.current = route;
  const go = useCallback((next: Route) => {
    if (op.current) return;
    const current = routeRef.current;
    if (current.view === next.view && current.task === next.task && current.rule === next.rule && current.topic === next.topic && current.report === next.report && !!current.chats === !!next.chats) return;
    if (leave.current && !leave.current()) return;
    leave.current = undefined;
    setRoute(next);
  }, []);
  const context: WorkbenchContext = useMemo(() => ({ data, loaded, busy, refresh, perform, notify: setNotice, fail: setError, go, leave }), [data, loaded, busy, refresh, perform, go]);
  const decisions = data.tasks.filter(task => task.attention).length;
  const recent = data.activity.filter(item => Date.parse(item.at) >= Date.now() - 864e5 && !item.undoneAt).length;
  const mailReady = data.health.email && data.accounts.length > 0;
  const servicesReady = mailReady && data.health.agent && data.health.running;
  // Closing the status line hides this exact message; a different message shows again.
  const status = !loaded || error || (servicesReady && !data.health.error) ? "" : (data.health.error && systemMessage(data.health.error)) || (!mailReady ? t("还没有添加邮箱账号。请在设置的“信息源”中添加邮箱。") : !data.health.running ? t("后台任务服务尚未就绪；已有任务和方案仍可查看，请检查实例运行状态。") : t("DSH 执行服务尚未就绪；方案和待办可查看，自动生成将等待服务恢复。"));
  const showStatus = !!status && status !== hiddenStatus;
  const connected = data.sources.filter(source => source.connected).length;
  // Preferences update immediately when settings are saved; the snapshot follows on its next refresh.
  const shared = usePreferences();
  const hidden = new Set<string>((shared.stateRevision !== undefined && shared.revision >= data.revision ? shared.settings.hiddenViews : data.settings.hiddenViews) ?? []);
  // Hidden pages leave the tab bar; they stay reachable from links inside the workbench.
  const view = route.view === "today" && hidden.has("today") && loaded ? "decide" : route.view;
  const page = !loaded ? <div className="bkw-pad"><Empty title={error ? t("暂时无法加载工作台") : t("正在加载工作台")} text={error ? t("请检查服务连接后刷新重试。") : t("正在获取你的任务与方案。")}><button type="button" className="bkw-btn" onClick={() => void perform("refresh", refresh)}>{t("重新加载")}</button></Empty></div>
    : view === "today" ? <TodayView /> : view === "decide" ? <DecideView selected={route.task} /> : view === "done" ? <DoneView /> : view === "items" ? <ItemsView selected={route.task} chats={route.chats} />
    : view === "meetings" ? <MeetingsView /> : view === "topics" ? <TopicsView topicId={route.topic} reportId={route.report} /> : view === "plans" ? <PlansView ruleId={route.rule} />
    : view === "logs" ? <LogsView /> : <div className="bkw-pad"><WorkbenchSettings embedded /></div>;
  return <Context.Provider value={context}>
    <div className={`bkw bkw-workbench view-${view}`} data-testid="bkms-workbench">
      <header className="bkw-top">
        <div className="bkw-top-row">
          <h1>{t("任务工作台")}</h1>
          <div className="bkw-top-actions">
            <span className={`bkw-live ${data.settings.enabled ? "on" : ""}`}><i />{data.settings.enabled ? t("自动处理运行中") : t("自动处理已暂停")}{loaded && <small>{t("{0} 个信息源", connected)}{data.health.lastPoll ? ` · ${t("{0} 已同步", time(data.health.lastPoll))}` : ""}</small>}</span>
            <button type="button" className="bkw-btn small" disabled={!!busy || !loaded || (!data.settings.enabled && (!mailReady || !data.health.running))} onClick={() => void perform("toggle", async () => { await api("saveSettings", { revision: data.revision, settings: { enabled: !data.settings.enabled } }); await refresh(); })}>
              <Icon name={data.settings.enabled ? "pause" : "play"} size={14} />{data.settings.enabled ? t("暂停") : t("开启")}
            </button>
            <button type="button" className="bkw-btn small" disabled={!!busy || !mailReady || !data.health.running} onClick={() => void perform("poll", async () => { const result = await api<{ checked: boolean; added: number }>("poll"); await refresh(); setNotice(result.checked ? t("检测完成，新增 {0} 项任务", result.added) : t("后台正在检测邮箱，请稍后查看结果")); })}>
              <Icon name="mail" size={14} />{busy === "poll" ? t("检测中…") : t("立即检测")}
            </button>
            <button type="button" className={`bkw-icon-btn ${view === "settings" ? "on" : ""}`} aria-label={t("工作台设置")} title={t("工作台设置")} onClick={() => go({ view: "settings" })}><Icon name="settings" size={17} /></button>
          </div>
        </div>
        <nav className="bkw-tabs" aria-label={t("工作台导航")}>
          {TABS.filter(([id]) => !hidden.has(id) || view === id).map(([id, label, icon]) => <button type="button" key={id} className={view === id ? "on" : ""} aria-current={view === id ? "page" : undefined} onClick={() => go({ view: id })}>
            <Icon name={icon} size={15} />{t(label)}{id === "decide" && decisions > 0 && <span className="bkw-count strong">{decisions}</span>}{id === "done" && recent > 0 && <span className="bkw-count">{recent}</span>}
          </button>)}
        </nav>
      </header>
      {(error || notice || showStatus) && <div className="bkw-feedback">
        {error && <Alert tone="danger" onClose={() => setError("")}>{systemMessage(error)}</Alert>}
        {notice && <Alert tone="success" onClose={() => setNotice("")}>{systemMessage(notice)}</Alert>}
        {showStatus && <Alert onClose={() => setHiddenStatus(status)}>{status}</Alert>}
      </div>}
      <main className="bkw-content">{page}</main>
    </div>
  </Context.Provider>;
}

function TodoReminder({ open }: { open?: () => void }) {
  useWorkbenchLocale();
  const notice = useReminder();
  useEffect(() => { if (!notice.count) return; const timer = setTimeout(dismissReminder, 8000); return () => clearTimeout(timer); }, [notice.sequence, notice.count]);
  if (!notice.count) return null;
  return <div className="bkw-todo-reminder" role="status"><div><strong>{t("有 {0} 项新待办需要处理", notice.count)}</strong><span>{t("请前往工作台查看处理结果。")}</span></div>{open && <button type="button" onClick={() => { lastRoute = { view: "decide" }; open(); dismissReminder(); }}>{t("查看待办")}</button>}<button type="button" aria-label={t("关闭提醒")} onClick={dismissReminder}><Icon name="close" size={16} /></button></div>;
}

interface ClientContext {
  locale?: LocaleService;
  get?(name: string): unknown;
  effect(fn: () => void | (() => void), name?: string): unknown;
  slots: { inject(name: string, callback: () => unknown): unknown; register(meta: Record<string, unknown>, component: React.ComponentType<any>): () => void };
}
export const inject = ["slots", "locale"];
export function apply(ctx: ClientContext) {
  ctx.effect(() => {
    const controller = new AbortController();
    resetPreferences();
    let pending = false;
    const refresh = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try { await refreshPreferences(controller.signal); } catch { /* Settings show connection failures with retry. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 8000);
    return () => { controller.abort(); clearInterval(timer); dismissReminder(); };
  }, "bkms-workbench: preferences and reminders");
  ctx.effect(() => connectLocale((ctx.get?.("locale") || ctx.locale) as LocaleService | undefined), "bkms-workbench: locale");
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = "bkms-workbench";
    style.textContent = stylesheet;
    document.head.appendChild(style);
    return () => style.remove();
  }, "bkms-workbench: styles");
  ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "bkms-workbench", inject: () => ({}) }, Workbench));
  ctx.slots.inject("sidebar.panellist", () => {
    let remove: (() => void) | undefined;
    const update = () => {
      if (preferences.settings.showWorkbench === false) { remove?.(); remove = undefined; }
      else remove ??= ctx.slots.register({ name: "sidebar.panellist", id: "bkms-workbench", order: -10, label: () => t("任务工作台") }, ({ size = 20 }: { size?: number }) => <Icon name="grid" size={size} />);
    };
    update();
    const unsubscribe = subscribePreferences(update);
    return () => { unsubscribe(); remove?.(); };
  });
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "bkms-workbench.todo-reminder", inject: () => {
    const layout = ctx.get?.("layout") as { selectPanel?: (id: string) => void } | undefined;
    return { open: layout?.selectPanel ? () => layout.selectPanel!("bkms-workbench") : undefined };
  } }, TodoReminder));
  ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "bkms-workbench", order: 44, label: () => t("工作台设置"), inject: () => ({}) }, () => <WorkbenchSettings />));
}
