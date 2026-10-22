import * as React from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { t } from "./i18n";
import { SOURCE, statusLabel, statusTone, type SourceKind, type Task } from "./lib";

const ICONS: Record<string, React.ReactNode> = {
  inbox: <><path d="M4 4h16v16H4z" /><path d="M4 13h5l2 3h2l2-3h5" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  rules: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
  history: <path d="M4 9a8 8 0 1 1 1 9M4 4v5h5M12 8v5l3 2" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
  refresh: <path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3" />,
  send: <path d="m21 3-7 18-4-7-7-4 18-7ZM10 14l11-11" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  arrow: <path d="m9 5 7 7-7 7" />,
  up: <path d="m5 15 7-7 7 7" />,
  down: <path d="m5 9 7 7 7-7" />,
  back: <path d="m14 5-7 7 7 7M7 12h14" />,
  file: <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></>,
  edit: <path d="m15 4 5 5-12 12H3v-5L15 4ZM12 7l5 5" />,
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="m7 4 14 8-14 8z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  done: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  topic: <><path d="M4 19V5M4 19h16" /><path d="m8 14 3-3 3 2 5-6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />,
  undo: <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  shield: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z" />,
  sliders: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  collapse: <path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" />,
  chat: <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM8 10h.01M12 10h.01M16 10h.01" />,
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name] || ICONS.file}</svg>;
}
export function StatusTag({ task, label }: { task: Pick<Task, "status" | "triage" | "draft">; label?: string }) {
  const partial = task.status === "sent" && !!task.draft?.receipt?.rejected?.length;
  return <span className={`bkw-tag ${statusTone(task)}`}>{label || (partial ? t("部分收件人被拒") : statusLabel(task))}</span>;
}
export function Tag({ tone = "muted", children }: { tone?: "warn" | "good" | "danger" | "accent" | "muted"; children: React.ReactNode }) {
  return <span className={`bkw-tag ${tone}`}>{children}</span>;
}
export function SourceTag({ kind }: { kind: SourceKind }) { return <span className="bkw-src">{t(SOURCE[kind])}</span>; }
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="bkw-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Empty({ title, text, children, icon = "inbox" }: { title: string; text: string; children?: React.ReactNode; icon?: string }) {
  return <div className="bkw-empty"><span className="bkw-empty-icon"><Icon name={icon} size={26} /></span><h3>{title}</h3><p>{text}</p>{children}</div>;
}
export function Alert({ tone = "neutral", children, onClose }: { tone?: "neutral" | "danger" | "success" | "warn"; children: React.ReactNode; onClose?: () => void }) {
  return <div className={`bkw-alert ${tone}`} role={tone === "danger" ? "alert" : "status"}><Icon name={tone === "success" ? "check" : "info"} size={16} /><span>{children}</span>{onClose && <button type="button" className="bkw-icon-btn small" aria-label={t("关闭提示")} onClick={onClose}><Icon name="close" size={14} /></button>}</div>;
}
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return <input className="bkw-switch" type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
}
export function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => { element.style.height = "auto"; element.style.height = `${element.scrollHeight + 2}px`; };
    resize();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; resize(); } });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea {...props} ref={ref} style={{ ...props.style, resize: "none", overflow: "hidden" }} />;
}
export function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null), previous = useRef<HTMLElement | null>(null);
  useEffect(() => { previous.current = document.activeElement as HTMLElement; ref.current?.focus(); return () => previous.current?.focus(); }, []);
  return <div className="bkw-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className={`bkw-dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]');
        if (!items?.length) { event.preventDefault(); return; }
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }}>
      <div className="bkw-dialog-header"><h2>{title}</h2><button type="button" className="bkw-icon-btn" aria-label={t("关闭弹窗")} onClick={onClose}><Icon name="close" /></button></div>
      <div className="bkw-dialog-content">{children}</div>
    </div>
  </div>;
}
/** Full-page sub view with a back button in the title, used for item details and workflow editing. */
export function PageHeader({ title, onBack, backLabel, meta, actions, busy }: { title: string; onBack: () => void; backLabel: string; meta?: React.ReactNode; actions?: React.ReactNode; busy?: boolean }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  return <header className="bkw-page-header">
    <div className="bkw-page-heading">
      <h1><button ref={back} type="button" className="bkw-page-back" aria-label={backLabel} title={backLabel} onClick={onBack} disabled={busy}><Icon name="back" size={20} /></button><span>{title}</span></h1>
      {meta && <div className="bkw-page-meta">{meta}</div>}
    </div>
    {actions && <div className="bkw-actions">{actions}</div>}
  </header>;
}
export function Section({ title, aside, children, className = "" }: { title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <section className={`bkw-card ${className}`}><div className="bkw-card-head"><h3>{title}</h3>{aside}</div>{children}</section>;
}
