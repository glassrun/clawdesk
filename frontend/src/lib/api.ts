// Use same-origin relative URLs — works in all deployments without config
// Override with FULL absolute URL if frontend and API are on different origins
export const API_BASE = '';

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  console.log('API call:', path);
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  console.log('API response:', res.status, path);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw data;
  return data as T;
}

export interface Agent {
  id: string;
  openclaw_agent_id: string;
  name: string;
  status: string;
  budget_limit: number;
  budget_spent: number;
  heartbeat_enabled: boolean;
  heartbeat_interval: number;
  last_heartbeat?: string;
  tasks_pending?: number;
  tasks_in_progress?: number;
  tasks_done?: number;
  tasks_failed?: number;
}

export interface Project {
  id: number;
  title: string;
  description?: string;
  workspace_path?: string;
  status?: string;
  task_total?: number;
  task_done?: number;
  completion_pct?: number;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description?: string;
  status: string;
  priority: string;
  assigned_agent_id?: string;
  agent_name?: string;
  openclaw_agent_id?: string;
  dependency_id?: number;
  dep_title?: string;
  creates_agent?: string;
  created_by_agent_slug?: string;
  created_at: string;
}

export interface Heartbeat {
  id: string;
  agent_id: string;
  agent_name?: string;
  openclaw_agent_id?: string;
  status: string;
  action_taken: string;
  triggered_at: string;
}

export interface Dashboard {
  total_agents: number;
  active_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  total_spent: number;
  agents: Agent[];
  projects: Project[];
}

export async function getDashboard() {
  return api<Dashboard>('/api/dashboard');
}

export async function getAgents() {
  return api<Agent[]>('/api/agents');
}

export async function getProjects() {
  return api<Project[]>('/api/projects');
}

export async function getProject(id: number) {
  return api<{ project: Project; tasks: Task[] }>(`/api/projects/${id}`);
}

export async function getTasks(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return api<{ data: Task[]; total: number; page: number; pages: number }>(`/api/tasks?${query}`);
}

export async function getHeartbeats(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return api<{ data: Heartbeat[] }>(`/api/heartbeats?${query}`);
}

export async function syncAgents() {
  // Server returns { ok, synced: [...], count } not an array
  return api<{ ok: boolean; synced: string[]; count: number }>('/api/agents/sync', { method: 'POST' });
}

export async function createAgent(data: { job_title: string; job_description?: string }) {
  return api<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(data) });
}

export async function updateAgent(id: number, data: Partial<Agent>) {
  return api<Agent>(`/api/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export async function deleteAgent(id: number) {
  return api<{ success: boolean }>(`/api/agents/${id}?force=1`, { method: 'DELETE' });
}

export async function createProject(data: { title: string; description?: string; workspace_path?: string; status?: string }) {
  return api<Project>('/api/projects', { method: 'POST', body: JSON.stringify(data) });
}

export async function updateProject(id: number, data: Partial<Project>) {
  return api<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export async function deleteProject(id: number) {
  return api<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' });
}

export async function createTask(projectId: number, data: Partial<Task>) {
  return api<Task>(`/api/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(data) });
}

export async function updateTask(id: number, data: Partial<Task>) {
  return api<Task>(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}

export async function deleteTask(id: number) {
  return api<{ success: boolean }>(`/api/tasks/${id}`, { method: 'DELETE' });
}

export async function runTask(id: number) {
  return api<{ action: string; task_title?: string }>(`/api/tasks/${id}/run`, { method: 'POST' });
}

export async function getTaskResults(id: number) {
  return api<{ input: string; output: string; executed_at: string }[]>(`/api/tasks/${id}/results`);
}

export async function tickHeartbeats() {
  return api<{ ticked: number }>('/api/heartbeats/tick', { method: 'POST' });
}

export async function retryTask(id: number) {
  return api<{ retried: boolean; immediate?: boolean; task_id?: number; status?: string; retry_count?: number; message?: string }>(`/api/tasks/${id}/retry`, { method: 'POST' });
}

export async function cancelTask(id: number) {
  return api<{ ok: boolean; task_id: number; title: string; status: string }>(`/api/tasks/${id}/cancel`, { method: 'POST' });
}
