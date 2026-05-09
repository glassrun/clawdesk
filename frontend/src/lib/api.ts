// Use same-origin relative URLs — works in all deployments without config
// Override with FULL absolute URL if frontend and API are on different origins
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

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
  id: number;
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
  total_cost_usd?: number;
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
  created_at?: string;
  is_template?: number | boolean;
  template_source_id?: number | null;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  description?: string;
  status: string;
  priority: string;
  assigned_agent_id?: number;
  agent_name?: string;
  openclaw_agent_id?: string;
  dependency_ids?: string; // JSON array of task ids
  dep_titles?: { id: number; title: string }[];
  dep_title?: string; // first dependency title
  creates_agent?: string;
  created_by_agent_slug?: string;
  scheduled_at?: string;
  requires_approval?: boolean;
  repeat?: boolean;
  created_at: string;
  completed_at?: string;
  run_count?: number;
  retry_count?: number;
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

export interface Task {
  total_agents: number;
  active_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  total_spent: number;
  agents: Agent[];
  projects: Project[];
  recent_heartbeats?: Heartbeat[];
}

export interface Dashboard {
  total_agents: number;
  active_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  total_spent: number;
  agents: Agent[];
  projects: Project[];
  recent_heartbeats?: Heartbeat[];
}

export interface SystemStats {
  tasks: number;
  projects: number;
  agents: number;
  heartbeats: number;
  task_results: number;
  audit_entries: number;
  deleted_tasks: number;
  db_size_bytes: number;
  schema_version: number;
  uptime_seconds?: number;
  node_version?: string;
  timestamp?: string;
}

export async function getDashboard() {
  return api<Dashboard>('/api/dashboard');
}

export async function getSystemStats() {
  return api<SystemStats>('/api/system/stats');
}

export async function getAgents() {
  return api<Agent[]>('/api/agents');
}

export async function getProjects() {
  return api<Project[]>('/api/projects');
}

export async function getProject(id: number) {
  // Backend returns flat project object with tasks embedded as a tasks array
  return api<Project & { tasks: Task[] }>(`/api/projects/${id}`);
}

export async function getTasks(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return api<{ data: Task[]; total: number; page: number; pages: number }>(`/api/tasks?${query}`);
}

export async function getHeartbeats(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return api<{ data: Heartbeat[]; total: number; page: number; limit: number; pages: number }>(`/api/heartbeats?${query}`);
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

export async function createProject(data: { title: string; description?: string; workspace_path?: string; status?: string; is_template?: boolean }) {
  return api<Project>('/api/projects', { method: 'POST', body: JSON.stringify(data) });
}

export async function cloneProject(id: number) {
  return api<Project>(`/api/projects/${id}/clone`, { method: 'POST' });
}

export async function getProjectTemplates() {
  const res = await api<Project[]>('/api/projects?template=1');
  return Array.isArray(res) ? res : [];
}

export async function updateProject(id: number, data: Partial<Project> & { is_template?: boolean }) {
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
  return api<{ task_id: number; input: string; output: string; executed_at: string; status?: string; input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cost?: number }[]>(`/api/tasks/${id}/results`);
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

export async function approveApproval(id: number) {
  return api<{ ok: boolean; id: number; task_id: number; status: string; resolved_at: string }>(
    `/api/approvals/${id}`,
    { method: 'PUT', body: JSON.stringify({ status: 'approved' }) }
  );
}

export async function rejectApproval(id: number) {
  return api<{ ok: boolean; id: number; task_id: number; status: string; resolved_at: string }>(
    `/api/approvals/${id}`,
    { method: 'PUT', body: JSON.stringify({ status: 'rejected' }) }
  );
}

export async function getApprovals(params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return api<any[]>(`/api/approvals?${query}`);
}

export async function getTools() {
  return api<any[]>('/api/tools');
}

export async function patchTool(name: string, data: Partial<{ enabled: boolean; rateLimit: number; description: string; riskLevel: string }>) {
  return api<any>(`/api/tools/${name}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export async function getSystemHealth() {
  return api<any>('/api/system/health');
}

export async function runSystemCleanup() {
  return api<{ ok: boolean; stale_completed_at_cleared: number; hard_deleted_tasks: number; hard_deleted_projects: number }>('/api/system/cleanup', { method: 'POST' });
}

export async function runSystemVacuum() {
  return api<{ ok: boolean }>('/api/system/vacuum', { method: 'POST' });
}

export async function getTaskHistory(id: number) {
  return api<any[]>(`/api/tasks/${id}/history`);
}

export async function getTaskChain(id: number) {
  return api<any[]>(`/api/tasks/${id}/chain`);
}

export async function getTaskDependents(id: number) {
  return api<any[]>(`/api/tasks/${id}/dependents`);
}

export async function duplicateTask(id: number) {
  return api<any>(`/api/tasks/${id}/duplicate`, { method: 'POST' });
}

export async function addTaskNotes(id: number, notes: string) {
  return api<any>(`/api/tasks/${id}/notes`, { method: 'POST', body: JSON.stringify({ notes }) });
}

export async function assignTask(id: number, agentId: number) {
  return api<any>(`/api/tasks/${id}/assign`, { method: 'POST', body: JSON.stringify({ agent_id: agentId }) });
}

export async function reactivateAgent(id: number) {
  return api<any>(`/api/agents/${id}/reactivate`, { method: 'POST' });
}
