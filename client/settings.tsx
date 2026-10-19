import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { systemMessage, t, useWorkbenchLocale } from "./i18n";
import { SOURCE, api, dateTime, errorMessage, type SourceKind } from "./lib";
import { FolderPicker } from "./plans";
import { applySaved, refreshPreferences, settingsOf, usePreferences, type Settings } from "./store";
import { Alert, Field, Modal, Switch, Tag } from "./ui";
import { WechatSettingsCard } from "./wechat";

type MailInfo = { revision: number; accounts: { id: string; label: string; inboxFolder?: string }[]; health: { email: boolean; agent?: boolean; running?: boolean; lastPoll?: string; error?: string } };
const DAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const SOURCE_NAME: Record<string, string> = { feishu: "飞书", wecom: "企业微信", meeting: "会议与日历" };
const SECTIONS = [["sources", "信息源"], ["reports", "简报与提醒"], ["safety", "自主与安全"], ["display", "显示"], ["advanced", "高级与恢复"]];

/** Settings shared by DSH's settings page and the workbench's own settings view. */
export function WorkbenchSettings({ embedded }: { embedded?: boolean }) {
  useWorkbenchLocale();
  const data = usePreferences(), s = settingsOf(data.settings);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState("");
  const [mail, setMail] = useState<MailInfo>();
  const [interval, setIntervalValue] = useState(String(data.settings.pollSeconds));
  const [reset, setReset] = useState<{ account: string; folder: string; confirmed: boolean; revision: number }>();
  const operation = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    refreshPreferences(controller.signal).then(() => setLoaded(true)).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    const refreshMail = () => void api<MailInfo>("mailSettings", {}, controller.signal).then(setMail).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
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
  // Background processing can also run on WeChat alone.
  const wechatOn = (data.settings as Settings).wechat?.enabled === true;
  const disabled = !loaded || busy;
  const row = (title: string, hint: string, control: React.ReactNode) => <div className="bkw-set-row"><span><strong>{title}</strong><small>{hint}</small></span><span className="bkw-set-control">{control}</span></div>;
  const clock = (value: string, key: "briefTime" | "weeklyTime", label: string, off?: boolean) => <input type="time" aria-label={label} value={value} disabled={disabled || off} onChange={event => { if (/^\d\d:\d\d$/.test(event.target.value)) void save({ [key]: event.target.value }); }} />;
  return <div className={embedded ? "bkw-settings embedded" : "bkw bkw-settings"}>
    {!embedded && <header className="bkw-settings-head"><h2>{t("工作台设置")}</h2><p>{t("管理信息源、简报提醒和 AI 的自主范围。处理方案和草稿审核在工作台中操作。")}</p></header>}
    {embedded && <nav className="bkw-settings-nav" aria-label={t("设置分区")}>{SECTIONS.map(([id, label]) => <a key={id} href={`#bkw-set-${id}`} onClick={event => { event.preventDefault(); document.getElementById(`bkw-set-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>{t(label)}</a>)}</nav>}
    <div className="bkw-settings-body">
      {error && <Alert tone="danger" onClose={() => setError("")}>{systemMessage(error)}</Alert>}
      <section id="bkw-set-sources" className="bkw-set-card"><h3>{t("信息源")}</h3>
        <div className="bkw-set-row"><span className="bkw-source-icon">{t("邮")}</span><span><strong>{t("邮箱")}</strong><small>{!mail ? t("正在加载…") : accounts.length ? t("{0} · 每 {1} 秒检查 · 最近检测 {2}", accounts.map(account => account.label).join("、"), data.settings.pollSeconds, mail.health.lastPoll ? dateTime(mail.health.lastPoll) : t("尚未检测")) : t("请先在邮件插件中配置邮箱账号。")}</small></span><Tag tone={ready ? "good" : mail?.health.email ? "warn" : "muted"}>{ready ? t("正常") : mail?.health.email ? t("等待服务") : t("未连接")}</Tag></div>
        <WechatSettingsCard value={(data.settings as Settings).wechat} disabled={disabled} save={(wechat, message) => save({ wechat }, message)} />
        {(["feishu", "wecom", "meeting"] as SourceKind[]).map(kind => <div key={kind} className="bkw-set-row"><span className="bkw-source-icon">{t(SOURCE[kind]).slice(0, 1)}</span><span><strong>{t(SOURCE_NAME[kind])}</strong><small>{t("需要安装对应的接入适配器后才能连接。工作台不会模拟未接入的来源。")}</small></span><Tag>{t("待接入")}</Tag></div>)}
        {mail?.health.error && <Alert tone="danger">{systemMessage(mail.health.error)}</Alert>}
      </section>
      <section id="bkw-set-reports" className="bkw-set-card"><h3>{t("简报与提醒")}</h3>
        {row(t("每日简报"), t("每天生成一次，打开工作台默认显示。需要开启后台自动处理。"), <>{clock(s.briefTime, "briefTime", t("每日简报时间"), !s.briefEnabled)}<Switch label={t("每日简报")} checked={s.briefEnabled} disabled={disabled} onChange={value => void save({ briefEnabled: value })} /></>)}
        {row(t("周报草稿"), t("汇总本周处理的信息与事项，生成后在“主题与报告”中编辑。"), <><select aria-label={t("周报日期")} value={s.weeklyDay} disabled={disabled || !s.weeklyEnabled} onChange={event => void save({ weeklyDay: Number(event.target.value) })}>{DAYS.map((day, index) => <option key={index} value={index}>{t(day)}</option>)}</select>{clock(s.weeklyTime, "weeklyTime", t("周报时间"), !s.weeklyEnabled)}<Switch label={t("周报草稿")} checked={s.weeklyEnabled} disabled={disabled} onChange={value => void save({ weeklyEnabled: value })} /></>)}
        {row(t("需要决策时提醒我"), t("出现新的待决策事项时显示简洁提醒；AI 已代办的事不打扰。开启时不补提醒已有待办。"), <Switch label={t("新待办消息提醒")} checked={data.settings.notifyNewTodo === true} disabled={disabled} onChange={value => void save({ notifyNewTodo: value })} />)}
        {row(t("会前简报"), t("连接日历后，在会议开始前生成。"), <><select aria-label={t("会前简报提前时间")} value={s.meetingBriefMinutes} disabled={disabled} onChange={event => void save({ meetingBriefMinutes: Number(event.target.value) })}>{[15, 30, 60, 120].map(value => <option key={value} value={value}>{t("提前 {0} 分钟", value)}</option>)}</select></>)}
      </section>
      <section id="bkw-set-safety" className="bkw-set-card"><h3>{t("自主与安全")}</h3>
        {row(t("后台自动处理"), t("暂停后不检测新信息、不分拣、不执行；已在运行的任务会完成。"), <Switch label={t("后台自动处理")} checked={data.settings.enabled} disabled={disabled || (!data.settings.enabled && !ready && !(wechatOn && mail?.health.agent && mail.health.running))} onChange={value => void save({ enabled: value }, value ? t("已开启后台自动处理") : t("已暂停后台自动处理"))} />)}
        {row(t("AI 分拣"), t("新信息先由 AI 判断类别和适用方案，通知与营销邮件自动归档，可随时恢复。"), <Switch label={t("AI 分拣")} checked={s.triage} disabled={disabled} onChange={value => void save({ triage: value })} />)}
        {row(t("撤回窗口"), t("按方案自动发送的回复先等待这段时间，期间可撤回。"), <select aria-label={t("撤回窗口")} value={s.undoMinutes} disabled={disabled} onChange={event => void save({ undoMinutes: Number(event.target.value) })}>{[5, 15, 30, 60, 120].map(value => <option key={value} value={value}>{t("{0} 分钟", value)}</option>)}</select>)}
        {row(t("发送结果不确定时"), t("不会自动重发，转为“发送待核实”交你处理。"), <Tag tone="good">{t("始终开启")}</Tag>)}
      </section>
      <section id="bkw-set-display" className="bkw-set-card"><h3>{t("显示")}</h3>
        {row(t("显示工作台入口"), t("在侧栏显示任务工作台。隐藏入口不影响后台处理，可随时在此恢复。"), <Switch label={t("显示工作台入口")} checked={data.settings.showWorkbench !== false} disabled={disabled} onChange={value => void save({ showWorkbench: value })} />)}
      </section>
      <section id="bkw-set-advanced" className="bkw-set-card"><h3>{t("高级与恢复")}</h3>
        {row(t("邮件检查间隔"), t("后台自动处理开启时生效，范围 30–3600 秒。"), <form className="bkw-inline-form" onSubmit={event => { event.preventDefault(); void save({ pollSeconds: Number(interval) }); }}><input aria-label={t("邮件检查间隔")} required type="number" min={30} max={3600} value={interval} disabled={disabled} onChange={event => setIntervalValue(event.target.value)} /><span>{t("秒")}</span><button type="submit" className="bkw-btn small" disabled={disabled || Number(interval) === data.settings.pollSeconds}>{t("保存")}</button></form>)}
        {row(t("重建收件基线"), t("邮箱 UIDVALIDITY 变化时会暂停相应文件夹的增量检测。核对邮箱后重建基线，只处理之后到达的新邮件，不会重新处理历史邮件。"), <button type="button" className="bkw-btn small" disabled={busy || !accounts.length || !mail?.health.email} onClick={() => setReset({ account: "", folder: "INBOX", confirmed: false, revision: mail!.revision })}>{t("重建")}</button>)}
      </section>
      <p className="bkw-settings-foot" role="status">{busy ? t("保存中…") : saved || (!loaded && !error ? t("正在加载…") : t("这些设置保存在当前 DSH 实例中，界面语言跟随 DSH 全局设置。"))}</p>
    </div>
    {reset && <Modal title={t("重建收件基线")} onClose={() => { if (!busy) setReset(undefined); }}>
      <p className="bkw-dialog-description">{t("重建后，只会处理此刻之后到达的新邮件。当前文件夹内尚未进入工作台的邮件将跳过，已有任务与历史记录保留。请在确认邮箱变化后使用。")}</p>
      <Field label={t("邮箱账号")}><select required value={reset.account} onChange={event => setReset({ ...reset, account: event.target.value, folder: accounts.find(account => account.id === event.target.value)?.inboxFolder || "INBOX", confirmed: false })}><option value="">{t("请选择邮箱账号")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></Field>
      <Field label={t("邮件文件夹")}><FolderPicker account={reset.account} ready={!!reset.account} value={reset.folder} defaultFolder={accounts.find(account => account.id === reset.account)?.inboxFolder || "INBOX"} onChange={folder => setReset({ ...reset, folder, confirmed: false })} /></Field>
      <label className="bkw-checkbox"><input type="checkbox" checked={reset.confirmed} onChange={event => setReset({ ...reset, confirmed: event.target.checked })} />{t("我已核对邮箱，确认跳过当前文件夹的已有邮件")}</label>
      <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" disabled={busy} onClick={() => setReset(undefined)}>{t("取消")}</button>
        <button type="button" className="bkw-btn primary" disabled={busy || !reset.confirmed || !reset.account || !reset.folder.trim()} onClick={async () => {
          if (operation.current) return;
          operation.current = true; setBusy(true); setError("");
          try { await api("resetBaseline", { account: reset.account, folder: reset.folder.trim(), confirmed: true, revision: reset.revision }); setReset(undefined); setSaved(t("收件基线已重建，后续新邮件将按方案处理")); }
          catch (failure) { setError(errorMessage(failure)); } finally { operation.current = false; setBusy(false); }
        }}>{busy ? t("正在重建…") : t("确认重建基线")}</button></div>
    </Modal>}
  </div>;
}

