import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { systemMessage, t, useWorkbenchLocale } from "./i18n";
import { SOURCE, api, dateTime, downloadText, errorMessage, uiLanguage } from "./lib";
import { FolderPicker, localInput } from "./plans";
import { applySaved, refreshPreferences, settingsOf, usePreferences, type Settings } from "./store";
import { Alert, Field, Modal, Switch, Tag } from "./ui";
import { ChannelPart } from "./slots";
import { ProfileCard } from "./variables";
import { MailAccountsCard } from "./mail-accounts";

type MailInfo = { revision: number; accounts: { id: string; label: string; inboxFolder?: string }[]; health: { email: boolean; agent?: boolean; running?: boolean; lastPoll?: string; error?: string }; mail?: { configured: boolean } };
const DAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const SOURCE_NAME: Record<string, string> = { feishu: "飞书", wecom: "企业微信", meeting: "会议与日历" };
const VIEWS: ["today" | "meetings" | "topics", string, string][] = [["today", "今日", "隐藏后打开工作台直接进入“待我决策”。每日简报仍会生成，可在“主题与报告”中查看。"], ["meetings", "会议", "还没有连接日历或会议平台时可以先隐藏。"], ["topics", "主题与报告", "隐藏后不再显示页签；事项上的主题链接仍可打开。"]];
const SECTIONS = [["sources", "信息源"], ["profile", "我的资料"], ["reports", "简报与提醒"], ["safety", "自主与安全"], ["display", "显示"], ["advanced", "高级与恢复"]];

/** Settings shared by DSH's settings page and the workbench's own settings view. */
export function WorkbenchSettings({ embedded }: { embedded?: boolean }) {
  useWorkbenchLocale();
  const data = usePreferences(), s = settingsOf(data.settings);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState("");
  const [mail, setMail] = useState<MailInfo>();
  const [interval, setIntervalValue] = useState(String(data.settings.pollSeconds));
  const [reset, setReset] = useState<{ account: string; folder: string; confirmed: boolean; revision: number; since?: string; includeAnswered?: boolean }>();
  const [window_, setWindow] = useState<{ count: number; answered: number; limit: number; error?: string; loading?: boolean }>();
  // Importing workflows and schemes from a file exported by another workbench.
  const [importing, setImporting] = useState<{ file: { rules: unknown[]; classifiers: unknown[] }; name: string; account: string; folder: string }>();
  const [imported, setImported] = useState<{ rules: number; classifiers: number; renamed: { from: string; to: string }[]; relabeled: string[] }>();
  // How much mail the chosen start time brings back; refreshed whenever the mailbox, folder or time changes.
  const windowKey = reset?.since && reset.account && reset.folder.trim() ? JSON.stringify([reset.account, reset.folder.trim(), reset.since]) : "";
  useEffect(() => {
    setWindow(undefined);
    if (!windowKey || !reset?.since) return;
    let active = true;
    setWindow({ count: 0, answered: 0, limit: 200, loading: true });
    const timer = setTimeout(() => api<{ count: number; answered: number; limit: number }>("baselineWindow", { account: reset.account, folder: reset.folder.trim(), since: new Date(reset.since!).toISOString() })
      .then(result => { if (active) setWindow(result); }).catch(failure => { if (active) setWindow({ count: 0, answered: 0, limit: 200, error: errorMessage(failure) }); }), 400);
    return () => { active = false; clearTimeout(timer); };
  }, [windowKey]);
  const operation = useRef(false), mailController = useRef<AbortController>();
  const refreshMail = () => { const signal = mailController.current?.signal; void api<MailInfo>("mailSettings", {}, signal).then(setMail).catch(failure => { if (!signal?.aborted) setError(errorMessage(failure)); }); };
  useEffect(() => {
    const controller = new AbortController(); mailController.current = controller;
    refreshPreferences(controller.signal).then(() => setLoaded(true)).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    refreshMail();
    const timer = setInterval(refreshMail, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => setIntervalValue(String(data.settings.pollSeconds)), [data.settings.pollSeconds]);
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(""), 4000); return () => clearTimeout(timer); }, [saved]);
  async function save(settings: Partial<Settings>, message = t("设置已保存")) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setSaved("");
    try { const next = await api<Settings>("saveSettings", { revision: data.revision, settings }); applySaved(data.revision + 1, next); await refreshPreferences(); setSaved(message); }
    catch (failure) { setError(errorMessage(failure)); await refreshPreferences().catch(() => {}); }
    finally { operation.current = false; setBusy(false); }
  }
  const accounts = mail?.accounts || [];
  const ready = !!(mail?.health.email && accounts.length && mail.health.agent && mail.health.running);
  // Background processing can also run on an installed channel alone.
  const channelOn = (data.channelInfo ?? []).some(item => item.enabled);
  const label = (value: { zh: string; en: string }) => value[uiLanguage()] || value.zh;
  const disabled = !loaded || busy;
  const hidden = data.settings.hiddenViews ?? [];
  const row = (title: string, hint: string, control: React.ReactNode) => <div className="bkw-set-row"><span><strong>{title}</strong><small>{hint}</small></span><span className="bkw-set-control">{control}</span></div>;
  const clock = (value: string, key: "briefTime" | "weeklyTime", label: string, off?: boolean) => <input type="time" aria-label={label} value={value} disabled={disabled || off} onChange={event => { if (/^\d\d:\d\d$/.test(event.target.value)) void save({ [key]: event.target.value }); }} />;
  return <div className={embedded ? "bkw-settings embedded" : "bkw bkw-settings"}>
    {!embedded && <header className="bkw-settings-head"><h2>{t("工作台设置")}</h2><p>{t("管理信息源、简报提醒和 AI 的自主范围。处理方案和草稿审核在工作台中操作。")}</p></header>}
    {embedded && <nav className="bkw-settings-nav" aria-label={t("设置分区")}>{SECTIONS.map(([id, label]) => <a key={id} href={`#bkw-set-${id}`} onClick={event => { event.preventDefault(); document.getElementById(`bkw-set-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{t(label)}</a>)}</nav>}
    <div className="bkw-settings-body">
      {error && <Alert tone="danger" onClose={() => setError("")}>{systemMessage(error)}</Alert>}
      <section id="bkw-set-sources" className="bkw-set-card"><h3>{t("信息源")}</h3>
        <MailAccountsCard disabled={!loaded} onChanged={refreshMail} tone={ready ? "good" : mail?.health.email ? "warn" : "muted"} label={ready ? t("正常") : mail?.health.email ? t("等待服务") : accounts.length ? t("未连接") : t("未添加")}
          status={!mail ? t("正在加载…") : accounts.length ? t("{0} · 每 {1} 秒检查 · 最近检测 {2}", accounts.map(account => account.label).join("、"), data.settings.pollSeconds, mail.health.lastPoll ? dateTime(mail.health.lastPoll) : t("尚未检测")) : t("添加邮箱账号后，工作台自动接收新邮件、生成回复草稿。")} />
        {(data.channelInfo ?? []).map(item => <ChannelPart key={item.kind} part="settings" kind={item.kind} props={{ value: (data.settings as Settings).channels?.[item.kind], disabled, save: (value, message) => save({ channels: { [item.kind]: value } }, message) }}
          fallback={<div className="bkw-set-row"><span className="bkw-source-icon">{label(item.label).slice(0, 1)}</span><span><strong>{label(item.label)}</strong><small>{t("这个渠道没有提供设置界面。")}</small></span><Tag tone={item.enabled ? "good" : "muted"}>{item.enabled ? t("已开启") : t("未开启")}</Tag></div>} />)}
        {(data.rejectedChannels ?? []).map(item => <div key={item.kind} className="bkw-set-row"><span className="bkw-source-icon">{label(item.label).slice(0, 1)}</span><span><strong>{label(item.label)}</strong><small>{item.upgrade === "channel" ? t("这个渠道插件的版本过旧，请升级渠道插件后使用。") : t("这个渠道插件需要更新版本的工作台，请升级工作台后使用。")}</small></span><Tag tone="warn">{t("需要升级")}</Tag></div>)}
        {["feishu", "wecom", "meeting"].map(kind => <div key={kind} className="bkw-set-row"><span className="bkw-source-icon">{t(SOURCE[kind]).slice(0, 1)}</span><span><strong>{t(SOURCE_NAME[kind])}</strong><small>{t("需要安装对应的接入适配器后才能连接。工作台不会模拟未接入的来源。")}</small></span><Tag>{t("待接入")}</Tag></div>)}
        {mail?.health.error && <Alert tone="danger">{systemMessage(mail.health.error)}</Alert>}
      </section>
      <section id="bkw-set-profile" className="bkw-set-card"><h3>{t("我的资料")}</h3>
        <ProfileCard value={(data.settings as Settings).profile} disabled={disabled} save={profile => void save({ profile }, t("我的资料已保存"))} />
      </section>
      <section id="bkw-set-reports" className="bkw-set-card"><h3>{t("简报与提醒")}</h3>
        {row(t("每日简报"), t("每天生成一次，打开工作台默认显示。需要开启后台自动处理。"), <>{clock(s.briefTime, "briefTime", t("每日简报时间"), !s.briefEnabled)}<Switch label={t("每日简报")} checked={s.briefEnabled} disabled={disabled} onChange={value => void save({ briefEnabled: value })} /></>)}
        {row(t("周报草稿"), t("汇总本周处理的信息与事项，生成后在“主题与报告”中编辑。"), <><select aria-label={t("周报日期")} value={s.weeklyDay} disabled={disabled || !s.weeklyEnabled} onChange={event => void save({ weeklyDay: Number(event.target.value) })}>{DAYS.map((day, index) => <option key={index} value={index}>{t(day)}</option>)}</select>{clock(s.weeklyTime, "weeklyTime", t("周报时间"), !s.weeklyEnabled)}<Switch label={t("周报草稿")} checked={s.weeklyEnabled} disabled={disabled} onChange={value => void save({ weeklyEnabled: value })} /></>)}
        {row(t("需要决策时提醒我"), t("出现新的待决策事项时显示简洁提醒；AI 已代办的事不打扰。开启时不补提醒已有待办。"), <Switch label={t("新待办消息提醒")} checked={data.settings.notifyNewTodo === true} disabled={disabled} onChange={value => void save({ notifyNewTodo: value })} />)}
        {row(t("会前简报"), t("连接日历后，在会议开始前生成。"), <><select aria-label={t("会前简报提前时间")} value={s.meetingBriefMinutes} disabled={disabled} onChange={event => void save({ meetingBriefMinutes: Number(event.target.value) })}>{[15, 30, 60, 120].map(value => <option key={value} value={value}>{t("提前 {0} 分钟", value)}</option>)}</select></>)}
      </section>
      <section id="bkw-set-safety" className="bkw-set-card"><h3>{t("自主与安全")}</h3>
        {row(t("后台自动处理"), t("暂停后不检测新信息、不分拣、不执行；已在运行的任务会完成。"), <Switch label={t("后台自动处理")} checked={data.settings.enabled} disabled={disabled || (!data.settings.enabled && !ready && !(channelOn && mail?.health.agent && mail.health.running))} onChange={value => void save({ enabled: value }, value ? t("已开启后台自动处理") : t("已暂停后台自动处理"))} />)}
        {row(t("AI 分拣"), t("新信息先由 AI 判断类别和适用方案，通知与营销邮件自动归档，可随时恢复。关闭后按字面条件匹配全部方案。"), <Switch label={t("AI 分拣")} checked={s.triage} disabled={disabled} onChange={value => void save({ triage: value })} />)}
        {row(t("撤回窗口"), t("按方案自动发送的回复先等待这段时间，期间可撤回。"), <select aria-label={t("撤回窗口")} value={s.undoMinutes} disabled={disabled} onChange={event => void save({ undoMinutes: Number(event.target.value) })}>{[5, 15, 30, 60, 120].map(value => <option key={value} value={value}>{t("{0} 分钟", value)}</option>)}</select>)}
        {row(t("发送结果不确定时"), t("不会自动重发，转为“发送待核实”交你处理。"), <Tag tone="good">{t("始终开启")}</Tag>)}
      </section>
      <section id="bkw-set-display" className="bkw-set-card"><h3>{t("显示")}</h3>
        {VIEWS.map(([id, label, hint]) => <React.Fragment key={id}>{row(t("显示“{0}”页签", t(label)), t(hint), <Switch label={t("显示“{0}”页签", t(label))} checked={!hidden.includes(id)} disabled={disabled} onChange={value => void save({ hiddenViews: value ? hidden.filter(item => item !== id) : [...hidden, id] })} />)}</React.Fragment>)}
        {row(t("显示 AI 处理过程"), t("开发调试用：在事项的“记录”中显示每次 AI 处理调用的工具、输入输出和用时。普通使用不需要打开。"), <Switch label={t("显示 AI 处理过程")} checked={(data.settings as Settings).showTrace === true} disabled={disabled} onChange={value => void save({ showTrace: value })} />)}
        {row(t("显示工作台入口"), t("在侧栏显示任务工作台。隐藏入口不影响后台处理，可随时在此恢复。"), <Switch label={t("显示工作台入口")} checked={data.settings.showWorkbench !== false} disabled={disabled} onChange={value => void save({ showWorkbench: value })} />)}
      </section>
      <section id="bkw-set-advanced" className="bkw-set-card"><h3>{t("高级与恢复")}</h3>
        {row(t("邮件检查间隔"), t("后台自动处理开启时生效，范围 30–3600 秒。"), <form className="bkw-inline-form" onSubmit={event => { event.preventDefault(); void save({ pollSeconds: Number(interval) }); }}><input aria-label={t("邮件检查间隔")} required type="number" min={30} max={3600} value={interval} disabled={disabled} onChange={event => setIntervalValue(event.target.value)} /><span>{t("秒")}</span><button type="submit" className="bkw-btn small" disabled={disabled || Number(interval) === data.settings.pollSeconds}>{t("保存")}</button></form>)}
        {row(t("导出与导入方案"), t("把处理方案和业务分类方案导出成文件，在别的工作台导入。文件不含邮箱、文件夹和学习例子；导入的方案都是停用状态，请检查后再启用。"), <span className="bkw-actions">
          <button type="button" className="bkw-btn small" disabled={busy || !loaded} onClick={async () => {
            try {
              const result = await api<{ file: unknown; skipped: string[] }>("exportWorkflows");
              downloadText(JSON.stringify(result.file, null, 2), `workbench-workflows-${new Date().toISOString().slice(0, 10)}.json`, "application/json;charset=utf-8");
              setSaved(result.skipped.length ? t("已导出；分派方案不导出：{0}", result.skipped.join("、")) : t("已导出方案文件"));
            } catch (failure) { setError(errorMessage(failure)); }
          }}>{t("导出")}</button>
          <label className={`bkw-btn small ${busy || !loaded ? "disabled" : ""}`}>{t("导入…")}<input type="file" accept="application/json,.json" hidden disabled={busy || !loaded} onChange={async event => {
            const chosen = event.currentTarget.files?.[0]; event.currentTarget.value = "";
            if (!chosen) return;
            try {
              const file = JSON.parse(await chosen.text());
              if (!file || !Array.isArray(file.rules) || !Array.isArray(file.classifiers)) throw new Error(t("这不是工作台导出的方案文件。"));
              setImported(undefined); setImporting({ file, name: chosen.name, account: "", folder: accounts[0]?.inboxFolder || "INBOX" });
            } catch (failure) { setError(failure instanceof SyntaxError ? t("这不是工作台导出的方案文件。") : errorMessage(failure)); }
          }} /></label>
        </span>)}
        {imported && <Alert onClose={() => setImported(undefined)}>{t("已导入 {0} 个处理方案、{1} 个分类方案，均为停用状态。", imported.rules, imported.classifiers)}
          {!!imported.renamed.length && <><br />{t("重名已改名：{0}", imported.renamed.map(item => item.to).join("、"))}</>}
          {!!imported.relabeled.length && <><br />{t("这些分类原来会移动邮件，导入后改为只打标签，请在分类方案中重新选择目标文件夹：{0}", imported.relabeled.join("、"))}</>}
        </Alert>}
        {row(t("重建收件基线"), t("决定从哪里开始处理：从现在开始，或从某天某个时间开始补处理历史邮件（用于快速验证方案）。邮箱 UIDVALIDITY 变化导致检测暂停时，也在这里恢复。"), <button type="button" className="bkw-btn small" disabled={busy || !accounts.length || !mail?.health.email} onClick={() => setReset({ account: "", folder: "INBOX", confirmed: false, revision: mail!.revision })}>{t("重建")}</button>)}
      </section>
      <p className="bkw-settings-foot" role="status">{busy ? t("保存中…") : saved || (!loaded && !error ? t("正在加载…") : t("这些设置保存在当前 DSH 实例中，界面语言跟随 DSH 全局设置。"))}</p>
    </div>
    {importing && <Modal title={t("导入方案")} onClose={() => { if (!busy) setImporting(undefined); }}>
      <p className="bkw-dialog-description">{t("文件“{0}”中有 {1} 个处理方案、{2} 个分类方案。导入后它们读取下面选择的邮箱和文件夹，全部为停用状态，检查后再逐个启用。", importing.name, importing.file.rules.length, importing.file.classifiers.length)}</p>
      <Field label={t("邮箱账号")}><select value={importing.account} onChange={event => setImporting({ ...importing, account: event.target.value, folder: accounts.find(account => account.id === event.target.value)?.inboxFolder || "INBOX" })}><option value="">{t("全部邮箱")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></Field>
      <Field label={t("读取的文件夹")}><FolderPicker account={importing.account || accounts[0]?.id || ""} ready={!!accounts.length} value={importing.folder} defaultFolder={accounts.find(account => account.id === importing.account)?.inboxFolder || "INBOX"} onChange={folder => setImporting({ ...importing, folder })} /></Field>
      <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" disabled={busy} onClick={() => setImporting(undefined)}>{t("取消")}</button>
        <button type="button" className="bkw-btn primary" disabled={busy || !importing.folder.trim()} onClick={async () => {
          if (operation.current) return;
          operation.current = true; setBusy(true); setError("");
          try {
            const result = await api<{ rules: number; classifiers: number; renamed: { from: string; to: string }[]; relabeled: string[] }>("importWorkflows", { revision: data.revision, file: importing.file, account: importing.account, folder: importing.folder.trim() });
            setImporting(undefined); setImported(result); await refreshPreferences();
          } catch (failure) { setError(errorMessage(failure)); } finally { operation.current = false; setBusy(false); }
        }}>{busy ? t("正在导入…") : t("确认导入")}</button></div>
    </Modal>}
    {reset && <Modal title={t("重建收件基线")} onClose={() => { if (!busy) { setReset(undefined); setWindow(undefined); } }}>
      <div className="bkw-seg" role="radiogroup" aria-label={t("开始处理的时间")}>
        <button type="button" role="radio" aria-checked={reset.since === undefined} className={reset.since === undefined ? "on" : ""} onClick={() => { setReset({ ...reset, since: undefined, confirmed: false }); setWindow(undefined); }}>{t("从现在开始")}</button>
        <button type="button" role="radio" aria-checked={reset.since !== undefined} className={reset.since !== undefined ? "on" : ""} onClick={() => setReset({ ...reset, since: "", confirmed: false })}>{t("从指定时间开始")}</button>
      </div>
      <p className="bkw-dialog-description">{reset.since === undefined ? t("重建后，只会处理此刻之后到达的新邮件。当前文件夹内尚未进入工作台的邮件将跳过，已有任务与历史记录保留。请在确认邮箱变化后使用。") : t("从你选择的时间开始，把这段时间收到的邮件当作新邮件重新处理，用来快速验证方案。已经在工作台里的邮件不会重复建事项。")}</p>
      <Field label={t("邮箱账号")}><select required value={reset.account} onChange={event => { setReset({ ...reset, account: event.target.value, folder: accounts.find(account => account.id === event.target.value)?.inboxFolder || "INBOX", confirmed: false }); }}><option value="">{t("请选择邮箱账号")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></Field>
      <Field label={t("邮件文件夹")}><FolderPicker account={reset.account} ready={!!reset.account} value={reset.folder} defaultFolder={accounts.find(account => account.id === reset.account)?.inboxFolder || "INBOX"} onChange={folder => setReset({ ...reset, folder, confirmed: false })} /></Field>
      {reset.since !== undefined && <>
        <Field label={t("从这个时间开始")}><input type="datetime-local" required value={reset.since} max={localInput(new Date())} onChange={event => setReset({ ...reset, since: event.target.value, confirmed: false })} /></Field>
        {window_?.loading && <p className="bkw-muted">{t("正在统计这段时间的邮件…")}</p>}
        {window_?.error && <Alert tone="danger">{systemMessage(window_.error)}</Alert>}
        {window_ && !window_.loading && !window_.error && <Alert {...(window_.count > window_.limit ? { tone: "danger" as const } : {})}>{window_.count > window_.limit ? t("这段时间有 {0} 封邮件，一次最多处理 {1} 封；请把开始时间往后调。", window_.count, window_.limit) : t("这段时间有 {0} 封邮件，其中 {1} 封已回复。", window_.count, window_.answered)}</Alert>}
        {!!window_?.answered && !window_.loading && <label className="bkw-checkbox"><input type="checkbox" checked={reset.includeAnswered === true} onChange={event => setReset({ ...reset, includeAnswered: event.target.checked })} />{t("也处理已回复的邮件（默认跳过，它们多半已处理过）")}</label>}
        <Alert tone="warn">{t("补处理的邮件只生成草稿，不会自动发送。如果这个文件夹有分派方案，邮件会被真的移到对应文件夹，用这个邮箱的人都会看到变化。")}</Alert>
      </>}
      <label className="bkw-checkbox"><input type="checkbox" checked={reset.confirmed} onChange={event => setReset({ ...reset, confirmed: event.target.checked })} />{reset.since === undefined ? t("我已核对邮箱，确认跳过当前文件夹的已有邮件") : t("我确认从这个时间开始重新处理这些邮件")}</label>
      <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" disabled={busy} onClick={() => { setReset(undefined); setWindow(undefined); }}>{t("取消")}</button>
        <button type="button" className="bkw-btn primary" disabled={busy || !reset.confirmed || !reset.account || !reset.folder.trim() || (reset.since !== undefined && (!reset.since || !window_ || !!window_.loading || !!window_.error || window_.count > window_.limit))} onClick={async () => {
          if (operation.current) return;
          operation.current = true; setBusy(true); setError("");
          try {
            await api("resetBaseline", { account: reset.account, folder: reset.folder.trim(), confirmed: true, revision: reset.revision, ...(reset.since ? { since: new Date(reset.since).toISOString(), includeAnswered: reset.includeAnswered === true } : {}) });
            setSaved(reset.since ? t("将从 {0} 开始补处理，进度可在“全部事项”中查看", reset.since.replace("T", " ")) : t("收件基线已重建，后续新邮件将按方案处理"));
            setReset(undefined); setWindow(undefined);
          }
          catch (failure) { setError(errorMessage(failure)); } finally { operation.current = false; setBusy(false); }
        }}>{busy ? t("正在重建…") : reset.since !== undefined ? t("确认并开始补处理") : t("确认重建基线")}</button></div>
    </Modal>}
  </div>;
}

