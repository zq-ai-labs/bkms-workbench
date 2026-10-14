import * as React from "react";
import { connectLocale, language, systemMessage, t, useWorkbenchLocale, type LocaleService } from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
// @ts-ignore CSS is bundled as a text module by scripts/build-client.mjs.
import stylesheet from "./styles.css";

type Status =
  | "queued"
  | "running"
  | "review"
  | "needs_info"
  | "failed"
  | "sending"
  | "sent"
  | "uncertain"
  | "ignored"
  | "unmatched"
  | "completed";
type Draft = {
  id: string;
  revision: number;
  account: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  attachments: { id: string; filename: string }[];
  state: string;
  receipt?: {
    accepted: string[];
    rejected: string[];
    response: string;
    messageId?: string;
  };
};
type Task = {
  id: string;
  title: string;
  account: string;
  status: Status;
  from: string;
  replyTo?: string;
  subject: string;
  body: string;
  receivedAt: string;
  updatedAt: string;
  ruleId?: string;
  ruleName?: string;
  summary?: string;
  error?: string;
  draftId?: string;
  draft?: Draft;
  revision: number;
  history: { at: string; message: string }[];
  attachments?: { filename: string; size: number }[];
  hasAttachments?: boolean;
  mailLoaded?: boolean;
  sessionId?: string;
};
type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  account: string;
  folder: string;
  match: {
    from: string;
    subject: string;
    hasAttachments: boolean;
    mode: "all" | "any";
  };
  instructions: string;
  tools: string[];
  skills?: string[];
  output: "reply" | "report";
  maxRetries: number;
  revision?: number;
};
type Capabilities = {
  tools: { name: string; description: string }[];
  skills: { id: string; name: string; description: string }[];
};
type Log = {
  id?: string;
  at?: string;
  time?: string;
  level?: string;
  message?: string;
  taskId?: string;
  [key: string]: unknown;
};
type Snapshot = {
  revision: number;
  tasks: Task[];
  rules: Rule[];
  accounts: { id: string; label: string; inboxFolder?: string }[];
  logs: Log[];
  capabilities?: Capabilities;
  settings: { enabled: boolean; pollSeconds: number };
  health: {
    email: boolean;
    model?: boolean;
    worker?: boolean;
    agent?: boolean;
    running?: boolean;
    lastPoll?: string;
    error?: string;
  };
};
type EditDraft = Pick<Draft, "to" | "cc" | "subject" | "text"> & {
  attachments: string[];
};
type Tab = "inbox" | "all" | "rules" | "logs";
type SendPlan = {
  bodyHtml?: string;
  bodyFormat?: string;
  id?: string;
  planId?: string;
  taskRevision?: number;
  draftRevision?: number;
  draft?: Draft;
  from?: { address: string; name?: string };
  matching?: {
    blocked: boolean;
    rows: {
      field: string;
      address: string;
      matched: boolean;
      blocked: boolean;
      value?: string;
    }[];
  };
  attachments?: {
    id: string;
    filename: string;
    size: number;
    sha256?: string;
  }[];
  expiresAt?: number;
  [key: string]: unknown;
};
const LABELS: Record<Status, string> = {
  queued: "等待处理",
  running: "正在处理",
  review: "待审核",
  needs_info: "待补充",
  failed: "处理失败",
  sending: "正在发送",
  sent: "已发送",
  uncertain: "发送待核实",
  ignored: "已忽略",
  unmatched: "未匹配",
  completed: "已完成",
};
const NEEDS_ACTION = new Set<Status>([
  "review",
  "needs_info",
  "failed",
  "uncertain",
]);
const EMPTY: Snapshot = {
  revision: 1,
  tasks: [],
  rules: [],
  accounts: [],
  logs: [],
  settings: { enabled: false, pollSeconds: 30 },
  health: { email: false, model: false, worker: false },
};
const draftValue = (draft: Draft): EditDraft => ({
  to: draft.to || "",
  cc: draft.cc || "",
  subject: draft.subject || "",
  text: draft.text || "",
  attachments: draft.attachments?.map((file) => file.id) || [],
});
const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString(language() === "zh" ? "zh-CN" : language(), {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "—";
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
let cachedDraft:
  | {
      id: string;
      revision: number;
      draftRevision: number;
      form: EditDraft;
      original: string;
    }
  | undefined;

function hostFetch(input: string, init: RequestInit): Promise<Response> {
  const transport = (
    globalThis as unknown as { __DSH_TRANSPORT__?: { fetch?: typeof fetch } }
  ).__DSH_TRANSPORT__?.fetch;
  return (transport || globalThis.fetch)(input, init);
}
async function downloadPreview(
  plan: string,
  file: { id: string; filename: string },
): Promise<void> {
  const response = await hostFetch(
    `api/dsh-email/drafts?preview=${encodeURIComponent(plan)}&attachment=${encodeURIComponent(file.id)}`,
    { credentials: "same-origin" },
  );
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      result.error?.message || t("附件预览已失效，请重新审核发送。"),
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function downloadOriginal(
  task: Task,
  index: number,
  filename: string,
): Promise<void> {
  const response = await hostFetch("api/bkms-workbench/attachment", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "x-bkms-workbench": "1" },
    body: JSON.stringify({ id: task.id, revision: task.revision, index }),
  });
  if (
    !response.ok ||
    response.headers.get("content-type")?.includes("application/json")
  ) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : result.error?.message || t("无法下载原邮件附件，请重新读取邮件后重试。"),
    );
  }
  const encodedName = response.headers
    .get("content-disposition")
    ?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let name = filename;
  if (encodedName)
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      /* Keep the verified displayed filename. */
    }
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function uploadDraftAttachment(draft: Draft, file: File): Promise<Draft> {
  const response = await hostFetch("api/dsh-email/drafts/upload", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-dsh-email-draft": "1",
      "x-dsh-draft-id": draft.id,
      "x-dsh-draft-revision": String(draft.revision),
      "x-dsh-draft-filename": encodeURIComponent(file.name),
    },
    body: file,
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : result.error?.message || t("附件上传失败，请刷新草稿后重试。"),
    );
  return result.value as Draft;
}
async function api<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  // Native hosts may own the authenticated HTTP carrier. Keep the route relative
  // so it resolves against that Host's base rather than the desktop page origin.
  const response = await hostFetch("api/bkms-workbench", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "x-bkms-workbench": "1" },
    body: JSON.stringify({ ...payload, action }),
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true)
    throw new Error(
      body.error?.message ||
        (typeof body.error === "string"
          ? body.error
          : t("操作失败 ({0})", response.status)),
    );
  return body.value as T;
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    inbox: (
      <>
        <path d="M4 4h16v16H4z" />
        <path d="M4 13h5l2 3h2l2-3h5" />
      </>
    ),
    grid: (
      <>
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </>
    ),
    rules: (
      <>
        <path d="M4 6h16M4 12h16M4 18h16" />
        <circle cx="9" cy="6" r="2" />
        <circle cx="15" cy="12" r="2" />
        <circle cx="8" cy="18" r="2" />
      </>
    ),
    history: (
      <>
        <path d="M4 9a8 8 0 1 1 1 9M4 4v5h5M12 8v5l3 2" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3" />
      </>
    ),
    send: (
      <>
        <path d="m21 3-7 18-4-7-7-4 18-7ZM10 14l11-11" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 6 9 7 9-7" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <path d="m9 5 7 7-7 7" />,
    file: (
      <>
        <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7v1" />
      </>
    ),
    edit: (
      <>
        <path d="m15 4 5 5-12 12H3v-5L15 4ZM12 7l5 5" />
      </>
    ),
    pause: (
      <>
        <path d="M8 5v14M16 5v14" />
      </>
    ),
    play: <path d="m7 4 14 8-14 8z" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.file}
    </svg>
  );
}
function Badge({ status, partial }: { status: Status; partial?: boolean }) {
  return (
    <span className={`bkw-badge bkw-${partial ? "uncertain" : status}`}>
      <i />
      {partial ? t("部分收件人被拒") : t(LABELS[status] || status)}
    </span>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="bkw-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Empty({
  title,
  text,
  children,
  icon = "inbox",
}: {
  title: string;
  text: string;
  children?: React.ReactNode;
  icon?: string;
}) {
  return (
    <div className="bkw-empty">
      <span className="bkw-empty-icon">
        <Icon name={icon} size={27} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

export function Workbench() {
  useWorkbenchLocale();
  const [data, setData] = useState<Snapshot>(EMPTY),
    [loaded, setLoaded] = useState(false),
    [tab, setTab] = useState<Tab>("inbox");
  const [selected, setSelected] = useState<string | undefined>(cachedDraft?.id),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [ruleEditor, setRuleEditor] = useState<Rule | null>(null);
  const [form, setForm] = useState<EditDraft | undefined>(cachedDraft?.form),
    [original, setOriginal] = useState(cachedDraft?.original || ""),
    [formRevision, setFormRevision] = useState(cachedDraft?.draftRevision);
  const [taskRevision, setTaskRevision] = useState(cachedDraft?.revision),
    [detailTab, setDetailTab] = useState("result"),
    [preview, setPreview] = useState<SendPlan | null>(null);
  const [assignment, setAssignment] = useState(""),
    [confirmIgnore, setConfirmIgnore] = useState(false),
    [supplement, setSupplement] = useState("");
  const [resetOpen, setResetOpen] = useState(false),
    [resetAccount, setResetAccount] = useState(""),
    [resetFolder, setResetFolder] = useState("INBOX"),
    [resetConfirmed, setResetConfirmed] = useState(false);
  const op = useRef(false),
    sequence = useRef(0),
    mounted = useRef(true);
  const dirty = !!form && JSON.stringify(form) !== original;
  const task = data.tasks.find((item) => item.id === selected);
  const reviewForm = preview?.draft ? draftValue(preview.draft) : form;
  const previewChanged =
    !!preview &&
    !!task &&
    (preview.taskRevision !== task.revision ||
      preview.draftRevision !== task.draft?.revision);
  const previewExpired =
    !!preview?.expiresAt && preview.expiresAt <= Date.now();
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const snapshot = await api<Snapshot>("snapshot");
    snapshot.health.model ??= snapshot.health.agent ?? false;
    snapshot.health.worker ??= snapshot.health.running ?? false;
    if (mounted.current && request === sequence.current) {
      setData(snapshot);
      setLoaded(true);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh().catch((e) => setError(errorMessage(e)));
    const timer = setInterval(() => {
      refresh().catch((e) => setError(errorMessage(e)));
    }, 8000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => {
    if (!task?.draft) {
      if (!dirty) {
        setForm(undefined);
        setOriginal("");
        setFormRevision(undefined);
        setTaskRevision(task?.revision);
      }
      return;
    }
    if (!dirty) {
      const next = draftValue(task.draft);
      setForm(next);
      setOriginal(JSON.stringify(next));
      setFormRevision(task.draft.revision);
      setTaskRevision(task.revision);
    }
  }, [task?.id, task?.revision, task?.draft?.revision]);
  useEffect(() => {
    cachedDraft =
      dirty &&
      selected &&
      form &&
      taskRevision !== undefined &&
      formRevision !== undefined
        ? {
            id: selected,
            form,
            revision: taskRevision,
            draftRevision: formRevision,
            original,
          }
        : undefined;
  }, [dirty, selected, form, original, taskRevision, formRevision]);
  async function perform(key: string, work: () => Promise<void>) {
    if (op.current) return;
    op.current = true;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
      await refresh().catch(() => {});
    } finally {
      op.current = false;
      setBusy("");
    }
  }
  function choose(id: string) {
    if (op.current) return;
    if (selected === id) return;
    if (dirty && !window.confirm(t("草稿有尚未保存的修改。放弃修改并切换任务？")))
      return;
    setForm(undefined);
    setOriginal("");
    cachedDraft = undefined;
    setSelected(id);
    setPreview(null);
    setAssignment("");
    setConfirmIgnore(false);
    setDetailTab("result");
    setSupplement("");
  }
  async function saveDraft() {
    if (!task || !form) return;
    await api("saveDraft", {
      id: task.id,
      revision: taskRevision,
      draftRevision: formRevision,
      draft: form,
    });
    cachedDraft = undefined;
    setOriginal(JSON.stringify(form));
    await refresh();
    setNotice(t("草稿已保存"));
  }
  const pending = data.tasks.filter((item) =>
    NEEDS_ACTION.has(item.status),
  ).length;
  const active = data.tasks.filter((item) =>
    ["queued", "running", "sending"].includes(item.status),
  ).length;
  const sent = data.tasks.filter((item) => item.status === "sent").length;
  const tasks = data.tasks
    .filter(
      (item) =>
        (tab !== "inbox" || NEEDS_ACTION.has(item.status)) &&
        (filter === "all" || item.status === filter) &&
        `${item.title} ${item.subject} ${item.from} ${item.ruleName || ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const accounts = data.accounts;
  const mailReady = data.health.email && accounts.length > 0;
  const servicesReady = mailReady && data.health.model && data.health.worker;
  const newRule = (): Rule => ({
    id: "",
    name: "",
    enabled: true,
    priority: 100,
    account: accounts[0]?.id || "",
    folder: accounts[0]?.inboxFolder || "INBOX",
    match: { from: "", subject: "", hasAttachments: false, mode: "all" },
    instructions: "",
    tools: [],
    output: "reply",
    maxRetries: 1,
  });
  const openRule = (rule: Rule) => {
    setError("");
    setRuleEditor({ ...rule, revision: data.revision });
  };
  const title = {
    inbox: t("待我处理"),
    all: t("全部任务"),
    rules: t("邮件处理方案"),
    logs: t("运行记录"),
  }[tab];
  const captions = {
    inbox: t("把时间留给判断，其余交给自动处理。"),
    all: t("每封邮件的处理进度，都清晰可追溯。"),
    rules: t("定义处理方式，让每一次自动执行都有章可循。"),
    logs: t("查看后台检测、任务执行与发送结果。"),
  };
  const editingLocked =
    !!busy ||
    !task ||
    task.status !== "review" ||
    (!!task.draft && task.draft.state !== "draft");
  return (
    <div className="bkw" data-testid="bkms-workbench">
      <div className="bkw-top">
        <div>
          <span className="bkw-eyebrow">BKMS WORKBENCH</span>
          <h1>{t("任务工作台")}</h1>
        </div>
        <div className="bkw-top-actions">
          <span className={`bkw-live ${data.settings.enabled ? "on" : ""}`}>
            <i />
            {data.settings.enabled ? t("自动处理已开启") : t("自动处理已暂停")}
          </span>
          <button
            className="bkw-btn"
            disabled={
              !!busy ||
              !loaded ||
              (!data.settings.enabled && (!mailReady || !data.health.worker))
            }
            onClick={() =>
              void perform("toggle", async () => {
                await api("saveSettings", {
                  revision: data.revision,
                  settings: {
                    ...data.settings,
                    enabled: !data.settings.enabled,
                  },
                });
                await refresh();
              })
            }
          >
            <Icon name={data.settings.enabled ? "pause" : "play"} />
            {data.settings.enabled ? t("暂停") : t("开启")}
          </button>
        </div>
      </div>
      <div className="bkw-summary">
        <div>
          <span>{t("需要你处理")}</span>
          <strong>
            {pending}
            <small>{t("项待办")}</small>
          </strong>
        </div>
        <div>
          <span>{t("后台处理中")}</span>
          <strong>
            {active}
            <small>{t(active === 1 ? "unit.task.one" : "项任务")}</small>
          </strong>
        </div>
        <div>
          <span>{t("已完成发送")}</span>
          <strong>
            {sent}
            <small>{t(sent === 1 ? "unit.message.one" : "封邮件")}</small>
          </strong>
        </div>
        <div className="bkw-summary-status">
          <span className={`bkw-dot ${servicesReady ? "good" : ""}`} />{" "}
          <div>
            <strong>{servicesReady ? t("服务已就绪") : t("等待服务连接")}</strong>
            <span>
              {data.health.lastPoll
                ? t("最近检测 {0}", date(data.health.lastPoll))
                : t("配置邮箱与方案后，即可开始")}
            </span>
          </div>
        </div>
      </div>
      <nav className="bkw-nav" aria-label={t("工作台导航")}>
        {(["inbox", "all", "rules", "logs"] as Tab[]).map((id) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setFilter("all");
              setSearch("");
            }}
            className={tab === id ? "active" : ""}
            aria-current={tab === id ? "page" : undefined}
          >
            <Icon
              name={
                {
                  inbox: "inbox",
                  all: "grid",
                  rules: "rules",
                  logs: "history",
                }[id]
              }
            />
            {
              {
                inbox: t("待我处理"),
                all: t("全部任务"),
                rules: t("邮件处理方案"),
                logs: t("运行记录"),
              }[id]
            }
            {id === "inbox" && pending > 0 && (
              <span className="bkw-count">{pending}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="bkw-heading">
        <div>
          <h2>{title}</h2>
          <p>{captions[tab]}</p>
        </div>
        <div className="bkw-actions">
          {tab === "rules" ? (
            <button
              className="bkw-btn primary"
              onClick={() => openRule(newRule())}
            >
              <Icon name="plus" />
              {t("新建方案")}</button>
          ) : (
            <>
              <button
                className="bkw-icon-btn"
                aria-label={t("刷新工作台")}
                title={t("刷新")}
                disabled={!!busy}
                onClick={() => void perform("refresh", refresh)}
              >
                <Icon name="refresh" />
              </button>
              <button
                className="bkw-btn"
                disabled={!!busy || !mailReady || !data.health.worker}
                onClick={() =>
                  void perform("poll", async () => {
                    const result = await api<{
                      checked: boolean;
                      added: number;
                    }>("poll");
                    await refresh();
                    setNotice(
                      result.checked
                        ? t("检测完成，新增 {0} 项任务", result.added)
                        : t("后台正在检测邮箱，请稍后查看结果"),
                    );
                  })
                }
              >
                <Icon name="mail" />
                {busy === "poll" ? t("检测中…") : t("立即检测")}
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="bkw-alert danger" role="alert">
          <Icon name="info" />
          <span>{systemMessage(error)}</span>
          <button aria-label={t("关闭错误提示")} onClick={() => setError("")}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="bkw-alert success" role="status">
          <Icon name="check" />
          <span>{systemMessage(notice)}</span>
        </div>
      )}
      {loaded && (!servicesReady || data.health.error) && (
        <div className="bkw-alert neutral">
          <Icon name="info" />
          <span>
            {(data.health.error && systemMessage(data.health.error)) ||
              (!mailReady
                ? t("邮件服务尚未就绪，请先在邮件插件中配置邮箱账号。")
                : !data.health.worker
                  ? t("后台任务服务尚未就绪；已有任务和方案仍可查看，请检查实例运行状态。")
                  : t("DSH 执行服务尚未就绪；方案和待办可查看，自动生成将等待服务恢复。"))}
          </span>
        </div>
      )}
      {!loaded ? (
        <div className="bkw-panel">
          <Empty
            title={error ? t("暂时无法加载工作台") : t("正在加载工作台")}
            text={
              error ? t("请检查服务连接后刷新重试。") : t("正在获取你的任务与方案。")
            }
          >
            <button
              className="bkw-btn"
              onClick={() => void perform("refresh", refresh)}
            >
              {t("重新加载")}</button>
          </Empty>
        </div>
      ) : (
        <>
          {(tab === "inbox" || tab === "all") && (
            <div className="bkw-workspace">
              <section className="bkw-task-list" aria-label={t("任务列表")}>
                <div className="bkw-list-controls">
                  <div className="bkw-search">
                    <Icon name="search" size={16} />
                    <input
                      placeholder={t("搜索主题、发件人或方案")}
                      aria-label={t("搜索任务")}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <div className="bkw-list-filter">
                    <span>{tasks.length} {t(tasks.length === 1 ? "unit.task.one" : "项任务")}</span>
                    <select
                      aria-label={t("按状态筛选")}
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                    >
                      <option value="all">{t("全部状态")}</option>
                      {Object.entries(LABELS)
                        .filter(
                          ([id]) =>
                            tab !== "inbox" || NEEDS_ACTION.has(id as Status),
                        )
                        .map(([id, label]) => (
                          <option value={id} key={id}>
                            {t(label)}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
                <div className="bkw-rows">
                  {tasks.length ? (
                    tasks.map((item) => (
                      <button
                        key={item.id}
                        className={`bkw-task-row ${selected === item.id ? "selected" : ""}`}
                        onClick={() => choose(item.id)}
                        aria-pressed={selected === item.id}
                      >
                        <div className="bkw-row-top">
                          <Badge
                            status={item.status}
                            partial={
                              item.status === "sent" &&
                              !!item.draft?.receipt?.rejected?.length
                            }
                          />
                          <time>{date(item.receivedAt)}</time>
                        </div>
                        <h3>{item.subject || (item.title === "无主题邮件" ? t("无主题邮件") : item.title) || t("无主题邮件")}</h3>
                        <div className="bkw-sender">{item.from}</div>
                        <p>{item.summary || (item.error && systemMessage(item.error)) || t("等待方案处理")}</p>
                        <div className="bkw-row-bottom">
                          <span>{item.ruleName || t("未匹配方案")}</span>
                          <Icon name="arrow" size={14} />
                        </div>
                      </button>
                    ))
                  ) : (
                    <Empty
                      title={
                        search || filter !== "all"
                          ? t("没有符合条件的任务")
                          : tab === "inbox"
                            ? t("暂时没有需要处理的任务")
                            : t("从第一封邮件开始")
                      }
                      text={
                        search || filter !== "all"
                          ? t("试试其他关键词或状态。")
                          : data.rules.length
                            ? t("后台会按方案处理新邮件，需要你审核时会出现在这里。")
                            : t("创建一个方案，自动整理邮件并准备回复草稿。")
                      }
                    >
                      {!data.rules.length && (
                        <button
                          className="bkw-btn primary"
                          onClick={() => {
                            setTab("rules");
                            openRule(newRule());
                          }}
                        >
                          {t("创建第一个方案")}</button>
                      )}
                    </Empty>
                  )}
                </div>
              </section>
              <section className="bkw-detail" aria-label={t("任务详情")}>
                {task ? (
                  <>
                    <div className="bkw-detail-header">
                      <div className="bkw-row-top">
                        <Badge
                          status={task.status}
                          partial={
                            task.status === "sent" &&
                            !!task.draft?.receipt?.rejected?.length
                          }
                        />
                        <span className="bkw-muted">
                          {task.ruleName || t("尚未匹配方案")}
                        </span>
                      </div>
                      <h2>{task.subject || (task.title === "无主题邮件" ? t("无主题邮件") : task.title) || t("无主题邮件")}</h2>
                      <div className="bkw-meta">
                        <span>{t("来自")}{task.from}</span>
                        <span>{date(task.receivedAt)}</span>
                      </div>
                    </div>
                    <div
                      className="bkw-detail-tabs"
                      role="tablist"
                      aria-label={t("任务详情内容")}
                    >
                      {[
                        ["result", t("处理结果")],
                        ["source", t("原邮件与附件")],
                        ["history", t("处理记录")],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          role="tab"
                          aria-selected={detailTab === id}
                          className={detailTab === id ? "active" : ""}
                          onClick={() => setDetailTab(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="bkw-detail-content">
                      {detailTab === "source" && (
                        <>
                          <div className="bkw-editor-title">
                            <span className="bkw-section-label">{t("原邮件")}</span>
                            <button
                              className="bkw-btn"
                              disabled={
                                !!busy ||
                                dirty ||
                                !mailReady ||
                                ["running", "sending"].includes(task.status)
                              }
                              title={
                                dirty
                                  ? t("请先保存草稿修改，再读取原邮件")
                                  : undefined
                              }
                              onClick={() =>
                                void perform("loadMail", async () => {
                                  await api("loadMail", {
                                    id: task.id,
                                    revision: task.revision,
                                  });
                                  await refresh();
                                  setNotice(t("原邮件与附件信息已更新"));
                                })
                              }
                            >
                              <Icon name="refresh" size={14} />
                              {busy === "loadMail"
                                ? t("读取中…")
                                : task.body
                                  ? t("重新读取原邮件")
                                  : t("读取原邮件")}
                            </button>
                          </div>
                          <dl className="bkw-source-meta">
                            <dt>{t("发件人")}</dt>
                            <dd>{task.from}</dd>
                            {task.replyTo && (
                              <>
                                <dt>{t("回复地址")}</dt>
                                <dd>{task.replyTo}</dd>
                              </>
                            )}
                            <dt>{t("收件账号")}</dt>
                            <dd>
                              {accounts.find((a) => a.id === task.account)
                                ?.label || task.account}
                            </dd>
                            <dt>{t("主题")}</dt>
                            <dd>{task.subject}</dd>
                          </dl>
                          <pre className="bkw-original">
                            {task.body ||
                              (task.status === "unmatched" ||
                              task.status === "queued"
                                ? t("点击“读取原邮件”查看正文，无需启动自动处理。")
                                : t("邮件正文为空"))}
                          </pre>
                          {!!task.attachments?.length && (
                            <div className="bkw-attachment-list">
                              {task.attachments.map((item, index) => (
                                <span key={index}>
                                  <Icon name="file" size={16} />
                                  {item.filename}
                                  <small>
                                    {Math.ceil(item.size / 1024)} KB
                                  </small>
                                  <button
                                    className="bkw-inline-link"
                                    disabled={!!busy || !mailReady}
                                    onClick={() =>
                                      void perform(
                                        `download-original-${index}`,
                                        async () => {
                                          await downloadOriginal(
                                            task,
                                            index,
                                            item.filename,
                                          );
                                        },
                                      )
                                    }
                                  >
                                    {busy === `download-original-${index}`
                                      ? t("下载中…")
                                      : t("下载检查")}
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                          {task.hasAttachments &&
                            !task.mailLoaded &&
                            !task.attachments?.length && (
                              <p className="bkw-preview-note">
                                {t("这封邮件包含附件，读取原邮件后可查看附件列表。")}</p>
                            )}
                        </>
                      )}
                      {detailTab === "history" && (
                        <div className="bkw-timeline">
                          {task.history?.length ? (
                            task.history.map((event, i) => (
                              <div key={i}>
                                <i />
                                <time>{date(event.at)}</time>
                                <p>{systemMessage(event.message)}</p>
                              </div>
                            ))
                          ) : (
                            <p className="bkw-muted">{t("尚无处理记录")}</p>
                          )}
                        </div>
                      )}
                      {detailTab === "result" && (
                        <>
                          {task.summary && (
                            <div className="bkw-result">
                              <span className="bkw-section-label">
                                {t("处理摘要")}</span>
                              <p>{task.summary}</p>
                            </div>
                          )}
                          {task.error && (
                            <div className="bkw-alert danger">
                              <Icon name="info" />
                              <span>{systemMessage(task.error)}</span>
                            </div>
                          )}
                          {task.status === "uncertain" && (
                            <div className="bkw-alert neutral">
                              <Icon name="info" />
                              <span>
                                {t("发送结果尚未确定。请核对邮箱中的已发送邮件，避免重复发送。")}</span>
                            </div>
                          )}
                          {["sent", "uncertain"].includes(task.status) && (
                            <ReceiptPanel draft={task.draft} />
                          )}
                          {task.status === "needs_info" && (
                            <div className="bkw-supplement">
                              <Field
                                label={t("补充信息")}
                                hint={t("补充缺少的资料，工作台将结合原邮件继续处理。")}
                              >
                                <textarea
                                  maxLength={16000}
                                  value={supplement}
                                  onChange={(e) =>
                                    setSupplement(e.target.value)
                                  }
                                  disabled={!!busy}
                                  placeholder={t("例如：本次报价为…，交付日期为…")}
                                />
                              </Field>
                              <button
                                className="bkw-btn primary"
                                disabled={
                                  !!busy ||
                                  !supplement.trim() ||
                                  !data.health.model
                                }
                                onClick={() =>
                                  void perform("supplement", async () => {
                                    await api("supplement", {
                                      id: task.id,
                                      revision: task.revision,
                                      text: supplement,
                                    });
                                    setSupplement("");
                                    await refresh();
                                    setNotice(t("补充信息已保存，任务继续处理"));
                                  })
                                }
                              >
                                {t("提交并继续处理")}</button>
                            </div>
                          )}
                          {task.status === "unmatched" && (
                            <div className="bkw-assignment">
                              <h3>{t("为这封邮件选择处理方案")}</h3>
                              <p>
                                {t("没有自动命中方案，可以指定一个已配置的方案开始处理。")}</p>
                              <select
                                aria-label={t("选择处理方案")}
                                value={assignment}
                                onChange={(e) => setAssignment(e.target.value)}
                              >
                                <option value="">{t("请选择方案")}</option>
                                {data.rules.map((rule) => (
                                  <option key={rule.id} value={rule.id}>
                                    {rule.name}
                                  </option>
                                ))}
                              </select>
                              <button
                                className="bkw-btn primary"
                                disabled={
                                  !assignment || !!busy || !data.health.model
                                }
                                onClick={() =>
                                  void perform("runRule", async () => {
                                    await api("runRule", {
                                      id: task.id,
                                      ruleId: assignment,
                                      revision: task.revision,
                                    });
                                    await refresh();
                                    setNotice(t("已加入处理队列"));
                                  })
                                }
                              >
                                {t("开始处理")}</button>
                            </div>
                          )}
                          {["queued", "running"].includes(task.status) && (
                            <Empty
                              title={
                                task.status === "running"
                                  ? t("正在准备处理结果")
                                  : t("任务已加入队列")
                              }
                              text={t("你可以继续处理其他任务，结果会自动更新。")}
                              icon="rules"
                            />
                          )}
                          {form && task.draft && (
                            <div className="bkw-draft-editor">
                              <div className="bkw-editor-title">
                                <h3>{t("回复草稿")}</h3>
                                <span className="bkw-muted">
                                  {dirty
                                    ? t("有未保存的修改")
                                    : task.status === "sent"
                                      ? task.draft.receipt?.rejected?.length
                                        ? t("存在被拒绝的收件人")
                                        : t("SMTP 已返回回执")
                                      : t("人工审核后发送")}
                                </span>
                              </div>
                              <div className="bkw-draft-account">
                                {t("发件账号")}{" "}
                                <strong>
                                  {accounts.find(
                                    (a) => a.id === task.draft!.account,
                                  )?.label || task.draft.account}
                                </strong>
                              </div>
                              <Field label={t("收件人")}>
                                <input
                                  disabled={editingLocked}
                                  value={form.to}
                                  onChange={(e) => {
                                    setForm({ ...form, to: e.target.value });
                                    setPreview(null);
                                  }}
                                  placeholder="name@example.com"
                                />
                              </Field>
                              <Field label={t("抄送")}>
                                <input
                                  disabled={editingLocked}
                                  value={form.cc}
                                  onChange={(e) => {
                                    setForm({ ...form, cc: e.target.value });
                                    setPreview(null);
                                  }}
                                  placeholder={t("可选，多个地址用逗号分隔")}
                                />
                              </Field>
                              <Field label={t("主题")}>
                                <input
                                  disabled={editingLocked}
                                  value={form.subject}
                                  onChange={(e) => {
                                    setForm({
                                      ...form,
                                      subject: e.target.value,
                                    });
                                    setPreview(null);
                                  }}
                                />
                              </Field>
                              <Field label={t("正文")}>
                                <textarea
                                  disabled={editingLocked}
                                  className="bkw-draft-body"
                                  value={form.text}
                                  onChange={(e) => {
                                    setForm({ ...form, text: e.target.value });
                                    setPreview(null);
                                  }}
                                />
                                <small className="bkw-mail-format-hint">
                                  {t("发送时使用标准邮件排版，可在「预览并发送」中查看。语气、语言和署名可在方案的处理要求中设置。")}</small>
                              </Field>
                              {!!task.draft.attachments?.length && (
                                <div className="bkw-attachment-list">
                                  {task.draft.attachments
                                    .filter((file) =>
                                      form.attachments.includes(file.id),
                                    )
                                    .map((file) => (
                                      <span key={file.id}>
                                        <Icon name="file" size={16} />
                                        {file.filename}
                                        {!editingLocked && (
                                          <button
                                            type="button"
                                            aria-label={t("从草稿移除附件 {0}", file.filename)}
                                            title={t("从草稿移除附件")}
                                            onClick={() => {
                                              setForm({
                                                ...form,
                                                attachments:
                                                  form.attachments.filter(
                                                    (id) => id !== file.id,
                                                  ),
                                              });
                                              setPreview(null);
                                            }}
                                          >
                                            <Icon name="close" size={13} />
                                          </button>
                                        )}
                                      </span>
                                    ))}
                                </div>
                              )}
                              {task.status === "review" &&
                                task.draft.state === "draft" && (
                                  <div className="bkw-upload">
                                    <label
                                      className={`bkw-btn ${editingLocked || dirty ? "disabled" : ""}`}
                                    >
                                      <Icon name="plus" size={14} />
                                      {busy === "uploadDraft"
                                        ? t("正在上传附件…")
                                        : t("添加附件")}
                                      <input
                                        type="file"
                                        multiple
                                        aria-label={t("添加草稿附件")}
                                        disabled={
                                          editingLocked ||
                                          dirty ||
                                          task.draft.attachments.length >= 10
                                        }
                                        onChange={(event) => {
                                          const files = Array.from(
                                            event.currentTarget.files || [],
                                          );
                                          event.currentTarget.value = "";
                                          if (!files.length) return;
                                          void perform(
                                            "uploadDraft",
                                            async () => {
                                              if (dirty)
                                                throw new Error(
                                                  t("请先保存草稿修改，再添加附件。"),
                                                );
                                              if (
                                                task.draft!.attachments.length +
                                                  files.length >
                                                10
                                              )
                                                throw new Error(
                                                  t("每份草稿最多 10 个附件，请减少选择的文件数量。"),
                                                );
                                              if (
                                                files.reduce(
                                                  (size, file) =>
                                                    size + file.size,
                                                  0,
                                                ) >
                                                20 * 1024 * 1024
                                              )
                                                throw new Error(
                                                  t("本次选择的附件合计超过 20 MiB，请减少文件数量。"),
                                                );
                                              setPreview(null);
                                              let current = task.draft!;
                                              for (const file of files) {
                                                current =
                                                  await uploadDraftAttachment(
                                                    current,
                                                    file,
                                                  );
                                                await refresh();
                                              }
                                              setNotice(
                                                t("已添加 {0} 个附件，请在发送预览中下载检查。", files.length),
                                              );
                                            },
                                          );
                                        }}
                                      />
                                    </label>
                                    <small>
                                      {dirty
                                        ? t("先保存草稿修改，再添加附件。")
                                        : t("最多 10 个附件，全部附件合计不超过 20 MiB；邮箱配置可能设置更低上限。")}
                                    </small>
                                  </div>
                                )}
                              {dirty &&
                                (task.revision !== taskRevision ||
                                  task.draft?.revision !== formRevision) && (
                                  <div className="bkw-alert neutral">
                                    <Icon name="info" />
                                    <span>
                                      {t("任务已更新。你的修改已保留，保存时将检查版本；请先核对新资料。")}<button
                                        className="bkw-inline-link"
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              t("放弃当前未保存的修改，并加载最新草稿？"),
                                            ) &&
                                            task.draft
                                          ) {
                                            const current = draftValue(
                                              task.draft,
                                            );
                                            setForm(current);
                                            setOriginal(
                                              JSON.stringify(current),
                                            );
                                            setFormRevision(
                                              task.draft.revision,
                                            );
                                            setTaskRevision(task.revision);
                                            cachedDraft = undefined;
                                            setError("");
                                          }
                                        }}
                                      >
                                        {t("加载最新草稿")}</button>
                                    </span>
                                  </div>
                                )}
                            </div>
                          )}
                          {!task.draft &&
                            !["queued", "running", "unmatched"].includes(
                              task.status,
                            ) &&
                            !task.summary &&
                            !task.error && (
                              <Empty
                                title={t("尚无处理产物")}
                                text={t("处理完成后，摘要和草稿会显示在这里。")}
                                icon="file"
                              />
                            )}
                        </>
                      )}
                    </div>
                    <div className="bkw-detail-footer">
                      <div className="bkw-actions">
                        {![
                          "sent",
                          "sending",
                          "uncertain",
                          "ignored",
                          "running",
                          "completed",
                        ].includes(task.status) && (
                          <button
                            className="bkw-btn quiet"
                            disabled={!!busy || dirty}
                            onClick={() => setConfirmIgnore(true)}
                          >
                            {t("忽略任务")}</button>
                        )}
                        {["failed", "needs_info", "review"].includes(
                          task.status,
                        ) && (
                          <button
                            className="bkw-btn"
                            disabled={!!busy || dirty || !data.health.model}
                            onClick={() =>
                              void perform("retry", async () => {
                                await api("retry", {
                                  id: task.id,
                                  revision: task.revision,
                                });
                                await refresh();
                                setNotice(t("已重新加入处理队列"));
                              })
                            }
                          >
                            <Icon name="refresh" size={15} />
                            {t("重新生成")}</button>
                        )}
                      </div>
                      <div className="bkw-actions">
                        {task.draft && task.status === "review" && (
                          <>
                            <button
                              className="bkw-btn"
                              disabled={editingLocked || !dirty}
                              onClick={() =>
                                void perform("saveDraft", saveDraft)
                              }
                            >
                              {busy === "saveDraft" ? t("保存中…") : t("保存草稿")}
                            </button>
                            <button
                              className="bkw-btn primary"
                              disabled={
                                editingLocked ||
                                dirty ||
                                !form?.to ||
                                !form.subject
                              }
                              title={
                                dirty ? t("请先保存修改再审核发送") : undefined
                              }
                              onClick={() =>
                                void perform("previewSend", async () => {
                                  const plan = await api<SendPlan>(
                                    "previewSend",
                                    {
                                      id: task.id,
                                      revision: task.revision,
                                      draftRevision: task.draft!.revision,
                                    },
                                  );
                                  setPreview({
                                    ...plan,
                                    taskRevision: task.revision,
                                    draftRevision: task.draft!.revision,
                                  });
                                })
                              }
                            >
                              <Icon name="send" size={16} />
                              {t("审核发送")}</button>
                          </>
                        )}
                      </div>
                    </div>
                  </>
                ) : (
                  <Empty
                    title={t("选择一项任务，开始处理")}
                    text={t("在左侧选择任务，查看原邮件、处理结果和回复草稿。")}
                    icon="file"
                  />
                )}
              </section>
            </div>
          )}
          {tab === "rules" && (
            <>
              <div className="bkw-rules-settings">
                <div>
                  <strong>{t("后台检测")}</strong>
                  <p>{t("页面关闭后继续运行，服务恢复后按游标补查新邮件。")}</p>
                </div>
                <label>
                  {t("检测间隔")}{" "}
                  <select
                    aria-label={t("后台检测间隔")}
                    disabled={!!busy}
                    value={data.settings.pollSeconds}
                    onChange={(e) =>
                      void perform("interval", async () => {
                        await api("saveSettings", {
                          revision: data.revision,
                          settings: {
                            ...data.settings,
                            pollSeconds: Number(e.target.value),
                          },
                        });
                        await refresh();
                      })
                    }
                  >
                    {[
                      ...new Set([
                        30,
                        60,
                        120,
                        300,
                        600,
                        1800,
                        3600,
                        data.settings.pollSeconds,
                      ]),
                    ]
                      .sort((a, b) => a - b)
                      .map((n) => (
                        <option value={n} key={n}>
                          {n < 60 ? t("{0} 秒", n) : t("{0} 分钟", n / 60)}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <div className="bkw-rule-grid">
                {data.rules.length ? (
                  [...data.rules]
                    .sort((a, b) => b.priority - a.priority)
                    .map((rule, index) => (
                      <article
                        className={`bkw-rule-card ${!rule.enabled ? "paused" : ""}`}
                        key={rule.id}
                      >
                        <div className="bkw-rule-head">
                          <span className="bkw-rule-number">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <button
                            className={`bkw-switch ${rule.enabled ? "checked" : ""}`}
                            role="switch"
                            aria-checked={rule.enabled}
                            aria-label={`${rule.enabled ? t("停用") : t("启用")}${rule.name}`}
                            disabled={!!busy}
                            onClick={() =>
                              void perform(`rule-${rule.id}`, async () => {
                                await api("saveRule", {
                                  rule: { ...rule, enabled: !rule.enabled },
                                  revision: data.revision,
                                });
                                await refresh();
                              })
                            }
                          >
                            <i />
                          </button>
                        </div>
                        <h3>{rule.name}</h3>
                        <p>{rule.instructions}</p>
                        <div className="bkw-rule-tags">
                          <span>
                            {accounts.find((a) => a.id === rule.account)
                              ?.label ||
                              rule.account ||
                              t("全部邮箱")}
                          </span>
                          <span>
                            {rule.output === "reply" ? t("回复草稿") : t("分析报告")}
                          </span>
                          <span>{t("优先级")}{rule.priority}</span>
                        </div>
                        <div className="bkw-rule-criteria">
                          {rule.match.from && (
                            <span>{t("发件人：")}{rule.match.from}</span>
                          )}
                          {rule.match.subject && (
                            <span>{t("主题：")}{rule.match.subject}</span>
                          )}
                          {rule.match.hasAttachments && <span>{t("包含附件")}</span>}
                          {!rule.match.from &&
                            !rule.match.subject &&
                            !rule.match.hasAttachments && (
                              <span>{t("匹配该邮箱的全部新邮件")}</span>
                            )}
                        </div>
                        <button
                          className="bkw-rule-edit"
                          onClick={() =>
                            openRule({
                              ...rule,
                              match: { ...rule.match },
                              tools: [...rule.tools],
                            })
                          }
                        >
                          <Icon name="edit" size={15} />
                          {t("编辑方案")}<Icon name="arrow" size={15} />
                        </button>
                      </article>
                    ))
                ) : (
                  <div className="bkw-panel bkw-rules-empty">
                    <Empty
                      title={t("让邮件自动进入你的工作流程")}
                      text={t("选择邮件范围，写下处理要求。工作台会生成结果，交给你审核。")}
                      icon="rules"
                    >
                      <button
                        className="bkw-btn primary"
                        onClick={() => openRule(newRule())}
                      >
                        <Icon name="plus" />
                        {t("创建第一个方案")}</button>
                    </Empty>
                  </div>
                )}
              </div>
              <div className="bkw-footnote">
                <Icon name="info" size={15} />
                {t("多个方案命中时按优先级执行首个。方案更新仅用于后续执行，邮件发送始终需要你确认。")}</div>
              <details className="bkw-recovery">
                <summary>{t("高级与恢复")}</summary>
                <div>
                  <p>
                    {t("首次检测会建立当前收件基线，仅处理之后到达的新邮件。若邮箱 UIDVALIDITY 发生变化，可核对邮箱后重建基线。")}</p>
                  <button
                    className="bkw-btn"
                    disabled={!!busy || !accounts.length || !data.health.email}
                    onClick={() => {
                      setResetAccount("");
                      setResetFolder("INBOX");
                      setResetConfirmed(false);
                      setResetOpen(true);
                      setError("");
                    }}
                  >
                    {t("重建收件基线")}</button>
                </div>
              </details>
            </>
          )}
          {tab === "logs" && (
            <div className="bkw-panel">
              {data.logs.length ? (
                <div className="bkw-log-table">
                  <div className="bkw-log-row heading">
                    <span>{t("时间")}</span>
                    <span>{t("级别")}</span>
                    <span>{t("事件")}</span>
                  </div>
                  {data.logs.map((log, index) => (
                    <div className="bkw-log-row" key={log.id || index}>
                      <time>{date(String(log.at || log.time || ""))}</time>
                      <span className={`bkw-log-level ${log.level || "info"}`}>
                        {(
                          {
                            error: t("错误"),
                            warn: t("注意"),
                            info: t("信息"),
                            success: t("完成"),
                          } as Record<string, string>
                        )[log.level || "info"] || log.level}
                      </span>
                      <div>
                        {systemMessage(String(log.message || ""))}
                        {log.taskId && (
                          <button
                            onClick={() => {
                              setTab("all");
                              choose(log.taskId!);
                            }}
                          >
                            {t("查看任务")}<Icon name="arrow" size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  title={t("运行记录会保存在这里")}
                  text={t("开启自动处理后，可在此查看收件检测、任务执行和发送结果。")}
                  icon="history"
                />
              )}
            </div>
          )}
        </>
      )}
      {ruleEditor && (
        <RuleDialog
          rule={ruleEditor}
          accounts={accounts}
          tasks={data.tasks}
          capabilities={data.capabilities}
          aiReady={!!data.health.model}
          error={systemMessage(error)}
          busy={!!busy}
          onClose={() => setRuleEditor(null)}
          onSave={(rule) =>
            void perform("saveRule", async () => {
              await api("saveRule", { rule, revision: rule.revision });
              await refresh();
              setRuleEditor(null);
              setNotice(t("方案已保存"));
            })
          }
          onDelete={(rule) =>
            void perform("deleteRule", async () => {
              await api("deleteRule", { id: rule.id, revision: rule.revision });
              await refresh();
              setRuleEditor(null);
              setNotice(t("方案已删除"));
            })
          }
          onTest={async (rule, taskId) => api("testRule", { rule, taskId })}
        />
      )}
      {preview && task?.draft && reviewForm && (
        <Modal
          title={t("确认发送邮件")}
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <p className="bkw-dialog-description">
            {t("请核对以下内容。点击“确认发送”后，邮件将提交至发件服务器。")}</p>
          <dl className="bkw-source-meta">
            <dt>{t("发件人")}</dt>
            <dd>
              {preview.from?.address
                ? `${preview.from.name ? preview.from.name + " " : ""}<${preview.from.address}>`
                : accounts.find((a) => a.id === task.draft!.account)?.label ||
                  task.draft.account}
            </dd>
            <dt>{t("收件人")}</dt>
            <dd>{reviewForm.to}</dd>
            {reviewForm.cc && (
              <>
                <dt>{t("抄送")}</dt>
                <dd>{reviewForm.cc}</dd>
              </>
            )}
            <dt>{t("主题")}</dt>
            <dd>{reviewForm.subject}</dd>
          </dl>
          {preview.matching?.blocked && (
            <div className="bkw-alert danger" role="alert">
              <Icon name="info" />
              <span>
                {t("有收件人命中禁止发送规则。请返回修改收件人，或在邮件插件中检查收件人策略。")}</span>
            </div>
          )}
          {!!preview.matching?.rows?.length && (
            <div className="bkw-recipient-checks">
              {preview.matching.rows.map((row, index) => (
                <div key={index}>
                  <span>
                    {row.field === "cc" ? t("抄送") : t("收件人")} · {row.address}
                  </span>
                  <strong
                    className={
                      row.blocked ? "blocked" : row.matched ? "trusted" : ""
                    }
                  >
                    {row.blocked
                      ? t("禁止发送{0}", row.value ? " · " + row.value : "")
                      : row.matched
                        ? t("可信收件人")
                        : t("人工确认")}
                  </strong>
                </div>
              ))}
            </div>
          )}
          {preview.bodyHtml ? (
            <iframe
              className="bkw-mail-preview"
              title={t("邮件正文预览")}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={preview.bodyHtml}
            />
          ) : (
            <pre className="bkw-send-body">{reviewForm.text}</pre>
          )}
          {!!preview.attachments?.length ? (
            <div className="bkw-attachment-list">
              {preview.attachments.map((file) => (
                <span key={file.id}>
                  <Icon name="file" size={15} />
                  <span>
                    {file.filename} · {Math.ceil(file.size / 1024)} KB
                  </span>
                  <button
                    className="bkw-inline-link"
                    disabled={!!busy}
                    onClick={() =>
                      void perform("download", async () => {
                        const id = preview.id || preview.planId;
                        if (!id) throw new Error(t("预览已失效，请重新审核。"));
                        await downloadPreview(id, file);
                      })
                    }
                  >
                    {t("下载检查")}</button>
                </span>
              ))}
            </div>
          ) : (
            <p className="bkw-preview-note">{t("本次发送不包含附件。")}</p>
          )}
          {error && (
            <div className="bkw-alert danger" role="alert">
              <Icon name="info" />
              <span>{systemMessage(error)}</span>
            </div>
          )}
          {(previewChanged || previewExpired) && (
            <div className="bkw-alert neutral">
              <Icon name="info" />
              <span>
                {previewChanged
                  ? t("任务或草稿已更新，请返回并重新审核最新内容。")
                  : t("发送预览已过期，请返回并重新审核。")}
              </span>
            </div>
          )}
          <p className="bkw-preview-note">
            {t("附件已固定为本次预览快照。预览有效期为 10 分钟，修改草稿后需重新审核。")}</p>
          <div className="bkw-dialog-actions">
            <button
              className="bkw-btn"
              disabled={!!busy}
              onClick={() => setPreview(null)}
            >
              {t("返回修改")}</button>
            <button
              className="bkw-btn primary"
              disabled={
                !!busy ||
                previewChanged ||
                previewExpired ||
                preview.matching?.blocked === true
              }
              onClick={() =>
                void perform("send", async () => {
                  const planId = preview.planId || preview.id;
                  if (!planId)
                    throw new Error(t("发送预览缺少确认标识，请重新审核。"));
                  try {
                    const result = await api<{ draft?: Draft }>("send", {
                      id: task.id,
                      revision: preview.taskRevision,
                      draftRevision: preview.draftRevision,
                      planId,
                      confirmed: true,
                    });
                    if (result.draft?.state !== "sent")
                      setError(
                        t("发送结果待核实，请先核对邮箱中的已发送邮件。工作台不会自动重发，请不要重复发送。"),
                      );
                    else if (result.draft.receipt?.rejected?.length)
                      setError(
                        t("SMTP 返回部分收件人被拒绝，请查看任务中的发送回执并核对邮箱。工作台不会自动重发。"),
                      );
                    else setNotice(t("邮件已提交，SMTP 已返回接受回执"));
                  } finally {
                    setPreview(null);
                    await refresh();
                  }
                })
              }
            >
              <Icon name="send" size={16} />
              {busy === "send" ? t("正在发送…") : t("确认发送")}
            </button>
          </div>
        </Modal>
      )}
      {resetOpen && (
        <Modal
          title={t("重建收件基线")}
          onClose={() => {
            if (!busy) setResetOpen(false);
          }}
        >
          <p className="bkw-dialog-description">
            {t("重建后，只会处理此刻之后到达的新邮件。当前文件夹内尚未进入工作台的邮件将跳过，已有任务与历史记录保留。请在确认邮箱变化后使用。")}</p>
          <Field label={t("邮箱账号")}>
            <select
              required
              value={resetAccount}
              onChange={(e) => {
                setResetAccount(e.target.value);
                setResetFolder(accounts.find(account => account.id === e.target.value)?.inboxFolder || "INBOX");
                setResetConfirmed(false);
              }}
            >
              <option value="">{t("请选择邮箱账号")}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("邮件文件夹")}>
            <FolderPicker
              account={resetAccount}
              ready={!!resetAccount}
              value={resetFolder}
              defaultFolder={accounts.find(account => account.id === resetAccount)?.inboxFolder || "INBOX"}
              onChange={(folder) => {
                setResetFolder(folder);
                setResetConfirmed(false);
              }}
            />
          </Field>
          <label className="bkw-checkbox">
            <input
              type="checkbox"
              checked={resetConfirmed}
              onChange={(e) => setResetConfirmed(e.target.checked)}
            />
            {t("我已核对邮箱，确认跳过当前文件夹的已有邮件")}</label>
          {error && (
            <div className="bkw-alert danger" role="alert">
              <Icon name="info" />
              <span>{systemMessage(error)}</span>
            </div>
          )}
          <div className="bkw-dialog-actions">
            <button
              className="bkw-btn"
              disabled={!!busy}
              onClick={() => setResetOpen(false)}
            >
              {t("取消")}</button>
            <button
              className="bkw-btn primary"
              disabled={
                !!busy ||
                !resetConfirmed ||
                !resetAccount ||
                !resetFolder.trim()
              }
              onClick={() =>
                void perform("resetBaseline", async () => {
                  await api("resetBaseline", {
                    account: resetAccount,
                    folder: resetFolder.trim(),
                    confirmed: true,
                  });
                  await refresh();
                  setResetOpen(false);
                  setNotice(t("收件基线已重建，后续新邮件将按方案处理"));
                })
              }
            >
              {busy === "resetBaseline" ? t("正在重建…") : t("确认重建基线")}
            </button>
          </div>
        </Modal>
      )}
      {confirmIgnore && task && (
        <Modal title={t("忽略这项任务？")} onClose={() => setConfirmIgnore(false)}>
          <p className="bkw-dialog-description">
            {t("任务和处理记录会保留在“全部任务”中，不会删除原邮件。")}</p>
          <div className="bkw-dialog-actions">
            <button className="bkw-btn" onClick={() => setConfirmIgnore(false)}>
              {t("取消")}</button>
            <button
              className="bkw-btn primary"
              disabled={!!busy}
              onClick={() =>
                void perform("ignore", async () => {
                  await api("ignore", { id: task.id, revision: task.revision });
                  await refresh();
                  setConfirmIgnore(false);
                  setNotice(t("任务已忽略"));
                })
              }
            >
              {t("确认忽略")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ReceiptPanel({ draft }: { draft?: Draft }) {
  const receipt = draft?.receipt;
  if (!receipt)
    return (
      <div className="bkw-alert neutral">
        <Icon name="info" />
        <span>
          {t("未读取到 SMTP 回执详情。请核对邮箱记录，工作台不会自动重发。")}</span>
      </div>
    );
  return (
    <section className="bkw-receipt" aria-label={t("发送回执")}>
      <div className="bkw-editor-title">
        <h3>{t("发送回执")}</h3>
        <span className="bkw-muted">{t("SMTP 服务器结果")}</span>
      </div>
      {!!receipt.rejected?.length && (
        <div className="bkw-alert danger" role="alert">
          <Icon name="info" />
          <span>
            {t("存在被服务器拒绝的收件人。已接受的地址可能已收到邮件，请核对下方名单及邮箱后单独处理，工作台不会自动重发。")}</span>
        </div>
      )}
      <dl className="bkw-source-meta">
        <dt>{t("服务器已接受")}</dt>
        <dd>
          {receipt.accepted?.length
            ? receipt.accepted.join(t("，"))
            : t("回执中没有已接受的地址")}
        </dd>
        <dt>{t("服务器已拒绝")}</dt>
        <dd
          className={receipt.rejected?.length ? "bkw-rejected-addresses" : ""}
        >
          {receipt.rejected?.length ? receipt.rejected.join(t("，")) : t("无")}
        </dd>
        {receipt.messageId && (
          <>
            <dt>Message-ID</dt>
            <dd>{receipt.messageId}</dd>
          </>
        )}
      </dl>
      <span className="bkw-section-label">{t("SMTP 响应")}</span>
      <pre>{receipt.response || t("回执未提供响应文本")}</pre>
      <p>{t("服务器接受表示已提交发送，最终送达情况以收件方和邮箱投递记录为准。")}</p>
    </section>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement;
    ref.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  return (
    <div
      className="bkw-modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`bkw-dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const items = ref.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
            );
            if (!items?.length) {
              e.preventDefault();
              return;
            }
            const first = items[0],
              last = items[items.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === ref.current)
            ) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="bkw-dialog-header">
          <h2>{title}</h2>
          <button
            className="bkw-icon-btn"
            aria-label={t("关闭弹窗")}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="bkw-dialog-content">{children}</div>
      </div>
    </div>
  );
}
type MailFolder = { path: string; name: string; specialUse?: string };
function FolderPicker({ account, value, defaultFolder = "INBOX", onChange, ready = true }: {
  account: string; value: string; defaultFolder?: string; onChange: (folder: string) => void; ready?: boolean;
}) {
  const [folders, setFolders] = useState<MailFolder[]>([]),
    [loading, setLoading] = useState(false),
    [failure, setFailure] = useState(""),
    [common, setCommon] = useState(false),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setFolders([]); setFailure(""); setCommon(false);
    if (!ready) { setLoading(false); return; }
    setLoading(true);
    api<{ folders: MailFolder[]; common: boolean }>("folders", { account })
      .then(result => { if (active) { setFolders(result.folders); setCommon(result.common); } })
      .catch(error => { if (active) setFailure(errorMessage(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account, ready, reload]);
  const options = [...folders];
  if (!options.some(folder => folder.path === value) && value) options.unshift({ path: value, name: value === defaultFolder ? t("默认收件箱") : t("当前已保存的文件夹") });
  if (!folders.length && !options.some(folder => folder.path === defaultFolder)) options.push({ path: defaultFolder, name: t("默认收件箱") });
  return <div className="bkw-folder-picker">
    <div className="bkw-folder-control">
      <select aria-label={t("邮件文件夹")} required value={value} disabled={!ready || loading} onChange={event => onChange(event.target.value)}>
        {options.map(folder => <option key={folder.path} value={folder.path}>{folder.path.toUpperCase() === "INBOX" ? t("收件箱") : folder.name}{folder.name !== folder.path && folder.path.toUpperCase() !== "INBOX" ? ` · ${folder.path}` : ""}</option>)}
      </select>
      <button type="button" className="bkw-icon-btn" aria-label={t("重新读取邮件文件夹")} disabled={!ready || loading} onClick={() => setReload(reload + 1)}><Icon name="refresh" size={16} /></button>
    </div>
    <small aria-live="polite">{loading ? t("正在读取邮箱文件夹…") : (failure && systemMessage(failure)) || (common ? t("显示所有邮箱共有的文件夹。") : t("从邮箱读取，默认使用收件箱，无需手工填写。"))}</small>
  </div>;
}

function RuleDialog({ rule, accounts, tasks, capabilities, aiReady, error, busy, onClose, onSave, onDelete, onTest }: {
  capabilities?: Capabilities; aiReady: boolean; error: string; rule: Rule; accounts: Snapshot["accounts"]; tasks: Task[]; busy: boolean;
  onClose: () => void; onSave: (rule: Rule) => void; onDelete: (rule: Rule) => void; onTest: (rule: Rule, taskId: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(rule),
    [description, setDescription] = useState(""),
    [showEditor, setShowEditor] = useState(!!rule.id),
    [aiOpen, setAiOpen] = useState(!rule.id),
    [generating, setGenerating] = useState(false),
    [aiError, setAiError] = useState(""),
    [warnings, setWarnings] = useState<string[]>([]),
    [generated, setGenerated] = useState(false),
    [testTask, setTestTask] = useState(""),
    [testResult, setTestResult] = useState(""),
    [testOutcome, setTestOutcome] = useState<{ matched: boolean; note?: string }>(),
    [testing, setTesting] = useState(false),
    [deleteConfirm, setDeleteConfirm] = useState(false),
    [toolsText, setToolsText] = useState(rule.tools.join(", "));
  const changed = JSON.stringify(value) !== JSON.stringify(rule) || !!description;
  const locked = busy || testing || generating;
  useEffect(() => {
    if (!changed) return;
    const before = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [changed]);
  const close = () => { if (!locked && (!changed || window.confirm(t("方案有尚未保存的修改，确认放弃？")))) onClose(); };
  const patch = (partial: Partial<Rule>) => { setValue({ ...value, ...partial }); setTestResult(""); setTestOutcome(undefined); };
  const match = (partial: Partial<Rule["match"]>) => patch({ match: { ...value.match, ...partial } });
  const generate = async () => {
    if (locked || !description.trim()) return;
    setGenerating(true); setAiError(""); setTestResult(""); setTestOutcome(undefined);
    try {
      const result = await api<{ rule: Rule; warnings: string[] }>("generateRule", { description, account: value.account, folder: value.folder, uiLanguage: t("任务工作台") === "Task workbench" ? "en" : "zh" });
      setValue({ ...result.rule, id: rule.id, revision: rule.revision, enabled: value.enabled, priority: value.priority, maxRetries: value.maxRetries });
      setToolsText(result.rule.tools.join(", "));
      setWarnings(result.warnings); setGenerated(true); setShowEditor(true); setAiOpen(false);
    } catch (error) { setAiError(errorMessage(error)); }
    finally { setGenerating(false); }
  };
  const broad = !value.match.from && !value.match.subject && !value.match.hasAttachments;
  return <Modal title={rule.id ? t("编辑邮件处理方案") : t("新建邮件处理方案")} onClose={close} wide>
    <form onSubmit={event => { event.preventDefault(); if (!locked && showEditor) onSave(value); }}>
      <fieldset disabled={locked}>
        <div className="bkw-rule-editor">
          {error && <div className="bkw-alert danger" role="alert"><Icon name="info" /><span>{systemMessage(error)}</span></div>}
          <div className="bkw-scope-fields">
            <div className="bkw-form-grid">
              <Field label={t("适用邮箱")}>
                <select value={value.account} onChange={event => patch({ account: event.target.value, folder: accounts.find(account => account.id === event.target.value)?.inboxFolder || "INBOX" })}>
                  {accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
                  <option value="">{t("全部邮箱")}</option>
                </select>
              </Field>
              <Field label={t("邮件文件夹")}>
                <FolderPicker account={value.account} value={value.folder} ready={!!accounts.length} defaultFolder={accounts.find(account => account.id === value.account)?.inboxFolder || "INBOX"} onChange={folder => patch({ folder })} />
              </Field>
            </div>
          </div>
          <section className="bkw-ai-builder">
            <div className="bkw-ai-heading"><span className="bkw-ai-badge">AI</span><div><h3>{t("一句话创建方案")}</h3><p>{t("说清楚哪些邮件、如何处理，AI 帮你整理成可核对的方案。")}</p></div>
              {(rule.id || generated) && <button type="button" className="bkw-inline-link" onClick={() => setAiOpen(!aiOpen)}>{aiOpen ? t("收起") : t("修改描述")}</button>}
            </div>
            {aiOpen && <>
              <textarea aria-label={t("用一句话描述邮件处理需求")} maxLength={8000} value={description} onChange={event => setDescription(event.target.value)} placeholder={t("例如：收到主题包含“询价”的邮件，整理客户需求，生成礼貌的中文回复草稿，缺少价格和交期时列出待确认事项。")} />
              {!description && <div className="bkw-ai-examples">
                {[
                  [t("询价回复"), t("收到主题包含询价的邮件，整理客户需求并生成中文回复草稿，价格和交期缺少依据时交给我补充。")],
                  [t("附件核对"), t("收到带附件的邮件，阅读附件并整理关键信息，生成分析报告，缺少必要资料时列出待确认事项。")],
                  [t("邮件摘要"), t("整理收件箱所有新邮件的事项和待办，只生成分析报告，不需要回复草稿。")],
                ].map(([label, text]) => <button type="button" key={label} onClick={() => setDescription(text)}>{label}<Icon name="arrow" size={12} /></button>)}
              </div>}
              {aiError && <div className="bkw-alert danger" role="alert"><span>{systemMessage(aiError)}</span></div>}
              <div className="bkw-ai-actions">
                <small>{aiReady ? t("使用 DSH 已配置的模型。生成后核对并保存，才会启用。") : t("配置 DSH 默认模型后可使用 AI，也可直接手动填写。")}</small>
                <button type="button" className="bkw-btn primary" disabled={!description.trim() || !accounts.length || !aiReady} onClick={() => void generate()}>{generating ? t("正在生成方案…") : generated ? t("重新生成") : t("AI 生成方案")}</button>
              </div>
            </>}
          </section>
          {!showEditor && <button type="button" className="bkw-inline-link bkw-manual-entry" onClick={() => setShowEditor(true)}>{t("手动填写方案")}<Icon name="arrow" size={14} /></button>}
          {showEditor && <>
            {generated && <div className="bkw-suggestion-status" role="status"><Icon name="check" size={17} /><span>{t("方案草稿已生成，请核对邮件范围与处理要求后保存。")}</span></div>}
            {!!warnings.length && <div className="bkw-suggestion-warnings"><strong>{t("需要你核对")}</strong><ul>{warnings.map((warning, index) => <li key={index}>{systemMessage(warning)}</li>)}</ul></div>}
            <div>
              <span className="bkw-step-label">{t("方案内容")}</span>
              <div className="bkw-form-grid">
                <Field label={t("方案名称")}><input required maxLength={100} value={value.name} onChange={event => patch({ name: event.target.value })} placeholder={t("例如：客户询价回复")} /></Field>
                <Field label={t("生成内容")}><select value={value.output} onChange={event => patch({ output: event.target.value as Rule["output"] })}><option value="reply">{t("处理摘要 + 回复草稿")}</option><option value="report">{t("分析报告")}</option></select></Field>
              </div>
              <Field label={t("处理要求")} hint={t("可调整处理步骤、语言、语气与署名。")}><textarea required minLength={5} maxLength={16000} className="bkw-instructions" value={value.instructions} onChange={event => patch({ instructions: event.target.value })} placeholder={t("说明收到邮件后需要做什么，以及缺少信息时如何处理。")} /></Field>
              <div className="bkw-scope-summary"><Icon name="mail" size={16} /><span>{t("匹配范围：")}{broad ? t("此文件夹中的全部新邮件") : [value.match.from && t("发件人包含 {0}", value.match.from), value.match.subject && t("主题包含 {0}", value.match.subject), value.match.hasAttachments && t("带附件")].filter(Boolean).join(value.match.mode === "all" ? t("，且 ") : t("，或 "))}{t("。")}{value.output === "reply" ? t("生成后由你审核并发送。") : t("生成后在任务中查看报告。")}</span></div>
              <div className="bkw-plan-capability-summary">
                <span>{t("处理能力")}</span>
                {!(value.skills?.length || value.tools.length) ? <strong>{t("邮件正文分析")}</strong> : <>
                  {value.skills?.map(name => <strong key={`skill-${name}`}>{name}</strong>)}
                  {value.tools.map(name => <strong key={`tool-${name}`}>{name === "read_document" ? t("附件文档读取") : name === "str_replace_editor" ? t("附件文本读取") : name}</strong>)}
                </>}
                <small>{t("可在高级设置中调整")}</small>
              </div>
              <label className="bkw-checkbox"><input type="checkbox" checked={value.enabled} onChange={event => patch({ enabled: event.target.checked })} />{t("保存后启用方案")}</label>
            </div>
            <details className="bkw-advanced bkw-plan-advanced">
              <summary>{t("高级设置 · 筛选条件、能力与执行选项")}</summary>
              <div className="bkw-form-grid">
                <Field label={t("发件人或域名")} hint={t("字符串包含，留空不限")}><input maxLength={1000} value={value.match.from} onChange={event => match({ from: event.target.value })} placeholder={t("例如：@example.com")} /></Field>
                <Field label={t("主题包含")} hint={t("单个关键词，留空不限")}><input maxLength={1000} value={value.match.subject} onChange={event => match({ subject: event.target.value })} placeholder={t("例如：询价")} /></Field>
                <Field label={t("条件关系")}><select value={value.match.mode} onChange={event => match({ mode: event.target.value as "all" | "any" })}><option value="all">{t("全部条件满足")}</option><option value="any">{t("任一条件满足")}</option></select></Field>
                <label className="bkw-checkbox"><input type="checkbox" checked={value.match.hasAttachments} onChange={event => match({ hasAttachments: event.target.checked })} />{t("要求包含附件")}</label>
                <Field label={t("优先级")} hint={t("默认 100；数值越高越先匹配")}><input required type="number" min={-10000} max={10000} value={value.priority} onChange={event => patch({ priority: Number(event.target.value) })} /></Field>
                <Field label={t("失败重试次数")} hint={t("默认 1 次")}><input type="number" min={0} max={3} value={value.maxRetries} onChange={event => patch({ maxRetries: Number(event.target.value) })} /></Field>
              </div>
              <CapabilityPicker capabilities={capabilities} value={value} onChange={partial => { patch(partial); if (partial.tools) setToolsText(partial.tools.join(", ")); }} />
              <details className="bkw-advanced"><summary>{t("填写准确工具名称")}</summary><Field label={t("允许调用的工具")} hint={t("逗号分隔，仅允许已安装的读取与查询工具。")}><input value={toolsText} onChange={event => { setToolsText(event.target.value); patch({ tools: event.target.value.split(",").map(item => item.trim()).filter(Boolean) }); }} placeholder={t("例如：read_document")} /></Field></details>
              <div className="bkw-test-panel"><h3>{t("测试匹配")}</h3><p>{t("选择已有邮件检查范围，不执行处理或发送邮件。")}</p><div className="bkw-actions"><select aria-label={t("选择用于测试的邮件")} value={testTask} onChange={event => setTestTask(event.target.value)}><option value="">{tasks.length ? t("选择一封邮件") : t("检测到邮件后即可测试")}</option>{tasks.slice(0, 100).map(task => <option key={task.id} value={task.id}>{task.subject || task.title}</option>)}</select><button type="button" className="bkw-btn" disabled={!testTask} onClick={async () => { setTesting(true); setTestResult(""); setTestOutcome(undefined); try { const result = await onTest(value, testTask) as { matched: boolean; note?: string }; setTestOutcome(result); } catch (error) { setTestResult(errorMessage(error)); } finally { setTesting(false); } }}>{testing ? t("测试中…") : t("测试匹配")}</button></div>{testOutcome && <div className="bkw-test-result" role="status">{t("{0}。{1}", testOutcome.matched ? t("匹配成功") : t("未命中当前方案"), systemMessage(testOutcome.note || ""))}</div>}{testResult && <div className="bkw-test-result" role="status">{systemMessage(testResult)}</div>}</div>
            </details>
          </>}
        </div>
        <div className="bkw-dialog-actions">
          {rule.id && <button type="button" className="bkw-btn danger" onClick={() => { if (deleteConfirm) onDelete(rule); else setDeleteConfirm(true); }}>{deleteConfirm ? t("再次点击确认删除") : t("删除方案")}</button>}
          <span className="bkw-spacer" /><button type="button" className="bkw-btn" onClick={close}>{t("取消")}</button>
          {showEditor && <button className="bkw-btn primary" type="submit">{busy ? t("保存中…") : t("保存方案")}</button>}
        </div>
      </fieldset>
    </form>
  </Modal>;
}


function CapabilityPicker({
  capabilities,
  value,
  onChange,
}: {
  capabilities?: Capabilities;
  value: Rule;
  onChange: (partial: Partial<Rule>) => void;
}) {
  const toggle = (items: string[], key: string) =>
    items.includes(key)
      ? items.filter((item) => item !== key)
      : [...items, key];
  return (
    <div className="bkw-capabilities">
      <div className="bkw-capability-section">
        <h4>{t("可用技能")}</h4>
        <p>{t("选择本次任务使用的技能，技能只能调用下方已允许的工具。")}</p>
        {capabilities?.skills.length ? (
          <div className="bkw-capability-list">
            {capabilities.skills.map((skill) => (
              <label key={skill.id} className="bkw-capability">
                <input
                  type="checkbox"
                  checked={(value.skills || []).includes(skill.id)}
                  onChange={() =>
                    onChange({ skills: toggle(value.skills || [], skill.id) })
                  }
                />
                <span>
                  <strong>{skill.name}</strong>
                  <small>{skill.description}</small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="bkw-capability-empty">
            {t("当前没有可供后台调用的技能，可直接使用处理要求。")}</div>
        )}
      </div>
      <div className="bkw-capability-section">
        <h4>{t("允许调用的工具")}</h4>
        <p>{t("只开放当前任务需要的读取与查询能力；留空时仅分析已有资料。")}</p>
        {capabilities?.tools.length ? (
          <div className="bkw-capability-list">
            {capabilities.tools.map((tool) => (
              <label key={tool.name} className="bkw-capability">
                <input
                  type="checkbox"
                  checked={value.tools.includes(tool.name)}
                  onChange={() =>
                    onChange({ tools: toggle(value.tools, tool.name) })
                  }
                />
                <span>
                  <strong>{tool.name}</strong>
                  <small>{tool.description}</small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="bkw-capability-empty">
            {t("当前没有可用的读取工具。请检查 DSH 工具配置。")}</div>
        )}
      </div>
    </div>
  );
}

interface ClientContext {
  locale?: LocaleService;
  get?(name: string): unknown;
  effect(fn: () => void | (() => void), name?: string): unknown;
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(
      meta: Record<string, unknown>,
      component: React.ComponentType<any>,
    ): unknown;
  };
}
export const inject = ["slots", "locale"];
export function apply(ctx: ClientContext) {
  ctx.effect(() => connectLocale((ctx.get?.("locale") || ctx.locale) as LocaleService | undefined), "bkms-workbench: locale");
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = "bkms-workbench";
    style.textContent = stylesheet;
    document.head.appendChild(style);
    return () => style.remove();
  }, "bkms-workbench: styles");
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      { name: "main", key: "bkms-workbench", inject: () => ({}) },
      Workbench,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: "bkms-workbench",
        order: -10,
        label: () => t("任务工作台"),
      },
      ({ size = 20 }: { size?: number }) => <Icon name="grid" size={size} />,
    ),
  );
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "bkms-workbench",
        order: 44,
        label: () => t("任务工作台"),
        inject: () => ({}),
      },
      Workbench,
    ),
  );
}
