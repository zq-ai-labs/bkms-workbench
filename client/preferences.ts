export type Attention = { id: string; status: string };
export type Preferences = {
  revision: number;
  stateRevision?: number;
  settings: { enabled: boolean; pollSeconds: number; showWorkbench?: boolean; notifyNewTodo?: boolean };
  attention: Attention[];
};

/** Establish a baseline on connection or enabling; only subsequent arrivals alert. */
export class TodoTracker {
  private previous = new Map<string, string>();
  private enabled = false;
  private initialized = false;
  accept(enabled: boolean, tasks: Attention[]): number {
    const next = new Map(tasks.map(task => [task.id, task.status]));
    const count = enabled && this.enabled && this.initialized
      ? tasks.filter(task => this.previous.get(task.id) !== task.status).length : 0;
    this.previous = next;
    this.enabled = enabled;
    this.initialized = true;
    return count;
  }
}
