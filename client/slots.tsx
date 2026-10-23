import * as React from "react";
import { api, fullDate, statusLabel, time, when, type Task } from "./lib";
import { systemMessage } from "./i18n";
import { Alert, Empty, Icon, Modal, StatusTag, Switch, Tag } from "./ui";

/**
 * Parts of the page an installed channel can fill (docs/DESIGN-CORE-CHANNELS.md §4.4). The workbench declares them as
 * DSH child slots; a channel registers one component per slot, keyed by its kind (`source.kind` of its tasks). Each
 * slot receives what it needs as props, so channel parts never reach into the workbench's own state. Where a channel
 * brings no part, or is not installed, the workbench shows a plain fallback.
 *
 * A channel plugin keeps its own copy of the slot names and prop types below; every part also receives `kit`, the
 * workbench's own components and helpers, so channel parts look like the rest of the page.
 */
export const SLOTS = {
  /** Extra tags in a task's header. Props: {@link TaskPartProps}. */
  tags: "bkms-workbench.task.tags",
  /** Who the task is with, in the header (default: the conversation name). Props: {@link TaskPartProps}. */
  counterpart: "bkms-workbench.task.counterpart",
  /** The item itself, below the AI's result (default: its text). Props: {@link TaskPartProps}. */
  body: "bkms-workbench.task.body",
  /** The “original” tab of the source pane (default: its text). Props: {@link SourcePartProps}. */
  source: "bkms-workbench.task.source",
  /** A conversation view next to the task list. Props: {@link ConversationsProps}. */
  conversations: "bkms-workbench.items.conversations",
  /** The channel's card under “Sources” in the workbench's own settings view. Props: {@link SettingsCardProps}. */
  settings: "bkms-workbench.channel.settings",
} as const;
/** The same settings card on DSH's settings page, which is a separate slot entry; a channel registers its card in both. */
export const SETTINGS_PAGE_SLOT = "bkms-workbench.settings.channel";

/** Workbench components and helpers handed to every channel part. `api` calls the workbench route, which forwards channel actions. */
export const KIT = { Alert, Empty, Icon, Modal, StatusTag, Switch, Tag, api, systemMessage, statusLabel, time, when, fullDate };
export type PartKit = typeof KIT;
export type TaskPartProps = { task: Task };
export type SourcePartProps = { task: Task; tasks: Task[]; open(taskId: string): void };
export type ConversationsProps = { page: unknown; tasks: Task[]; revision: number; open(taskId: string): void; openSettings(): void; saveSettings(value: unknown, message: string): Promise<void> };
export type SettingsCardProps = { value: unknown; disabled: boolean; save(value: unknown, message?: string): Promise<void> };
type PartProps = { tags: TaskPartProps; counterpart: TaskPartProps; body: TaskPartProps; source: SourcePartProps; conversations: ConversationsProps; settings: SettingsCardProps };

const keyed = { kind: "keyed", scope: "root" } as const;
/** Child slots declared by the workbench page (DSH `main`). */
export const PAGE_CHILDREN = Object.fromEntries(Object.values(SLOTS).map(name => [name, keyed]));
/** Child slots declared by the workbench section of DSH's settings page. */
export const SETTINGS_CHILDREN = { [SETTINGS_PAGE_SLOT]: keyed };

/** DSH's `renderSlot`, handed to the entry that declared the slots. */
export type RenderSlot = (name: string, owner: object, options?: { entryKey?: string; fallback?: React.ReactNode }) => React.ReactNode;
const SlotContext = React.createContext<{ render?: RenderSlot; settingsPage?: boolean }>({});
/** Makes the declaring entry's `renderSlot` available to the components below it. */
export function SlotProvider({ render, settingsPage, children }: { render?: RenderSlot; settingsPage?: boolean; children: React.ReactNode }) {
  const value = React.useMemo(() => ({ render, settingsPage }), [render, settingsPage]);
  return <SlotContext.Provider value={value}>{children}</SlotContext.Provider>;
}
/** A channel's part of the page, or the fallback when the channel brings none. Outside DSH only the fallback shows. */
export function ChannelPart<K extends keyof PartProps>({ part, kind, props, fallback = null }: { part: K; kind: string; props: PartProps[K]; fallback?: React.ReactNode }) {
  const { render, settingsPage } = React.useContext(SlotContext);
  if (!render) return <>{fallback}</>;
  const name = part === "settings" && settingsPage ? SETTINGS_PAGE_SLOT : SLOTS[part];
  return <>{render(name, { ...props, kit: KIT }, { entryKey: kind, fallback })}</>;
}
