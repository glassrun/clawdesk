/**
 * project-brain.js
 *
 * Manages PROJECT_BRAIN.md in each project workspace.
 * This file tracks:
 *   - Active agents and their current focus
 *   - Key findings / discoveries from past tasks
 *   - Project state (phase, milestone, blockers)
 *
 * The executor reads this file at the start of each task and includes
 * relevant context in the agent prompt. After a task completes, the
 * executor updates the brain with what was learned.
 */

const fs = require('fs');
const path = require('path');

// ── path helpers ───────────────────────────────────────────────────────────

function getBrainPath(projectWorkspacePath) {
  return path.join(projectWorkspacePath, 'PROJECT_BRAIN.md');
}

function ensureBrainExists(brainPath) {
  if (!fs.existsSync(brainPath)) {
    const defaultContent = [
      '# Project Brain',
      '',
      '> Managed by ClawDesk intelligence layer. Do not edit manually while agents are running.',
      '',
      '## Active Agents & Focus',
      '',
      '_No active agents yet._',
      '',
      '## Key Findings & Discoveries',
      '',
      '_None yet._',
      '',
      '## Project State',
      '',
      '- **Phase:** discovery',
      '- **Milestone:** _none set_',
      '- **Blockers:** _none_',
      '',
      '## Session Memory',
      '',
      '_No sessions recorded yet._',
      '',
    ].join('\n');
    fs.writeFileSync(brainPath, defaultContent, 'utf8');
  }
}

// ── read / write ──────────────────────────────────────────────────────────

/**
 * Read the project brain for a given project workspace.
 * Returns null if the project has no workspace_path set.
 */
function readBrain(project) {
  if (!project || !project.workspace_path) return null;
  const brainPath = getBrainPath(project.workspace_path);
  if (!fs.existsSync(brainPath)) return null;
  try {
    return fs.readFileSync(brainPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write the entire brain content for a project.
 */
function writeBrain(project, content) {
  if (!project || !project.workspace_path) return;
  const brainPath = getBrainPath(project.workspace_path);
  ensureBrainExists(brainPath);
  fs.writeFileSync(brainPath, content, 'utf8');
}

/**
 * Append a session-memory entry to the brain.
 * Format: "### Session YYYY-MM-DD HH:mm\n\nDid X. Found Y. Left Z for next agent.\n"
 */
function appendSessionMemory(project, summary) {
  if (!project || !project.workspace_path) return;
  const brainPath = getBrainPath(project.workspace_path);
  ensureBrainExists(brainPath);

  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').substring(0, 16);
  const entry = `\n### Session ${timestamp}\n\n${summary}\n`;

  // Append before the final "## Session Memory" trailing marker if present
  let content = fs.readFileSync(brainPath, 'utf8');
  const marker = '## Session Memory';
  const idx = content.lastIndexOf(marker);
  if (idx !== -1) {
    content = content.slice(0, idx) + entry + '\n' + content.slice(idx);
  } else {
    content += '\n' + entry;
  }
  fs.writeFileSync(brainPath, content, 'utf8');
}

/**
 * Update the "Active Agents & Focus" section.
 * agents: Array of { agentId, name, focus } objects
 */
function updateActiveAgents(project, agents) {
  if (!project || !project.workspace_path) return;
  const brainPath = getBrainPath(project.workspace_path);
  ensureBrainExists(brainPath);

  let content = fs.readFileSync(brainPath, 'utf8');

  const lines = agents.map(a => `- **${a.name}** (${a.agentId}): ${a.focus}`).join('\n');
  const block = lines || '_No active agents yet._';

  content = content.replace(
    /## Active Agents & Focus[\s\S]*?(?=## |$)/,
    `## Active Agents & Focus\n\n${block}\n`
  );

  fs.writeFileSync(brainPath, content, 'utf8');
}

/**
 * Append a finding to the "Key Findings & Discoveries" section.
 * finding: string
 */
function appendFinding(project, finding) {
  if (!project || !project.workspace_path) return;
  const brainPath = getBrainPath(project.workspace_path);
  ensureBrainExists(brainPath);

  let content = fs.readFileSync(brainPath, 'utf8');
  const entry = `- ${finding}\n`;
  content = content.replace(
    /## Key Findings & Discoveries\s*\n\n[\s\S]*?(?=## |$)/,
    (match) => match.replace(/(_None yet\._)/, entry) + (match.includes('_None yet._') ? '' : entry)
  );
  // Simpler approach: just replace the placeholder or append
  if (content.includes('_None yet._')) {
    content = content.replace('_None yet._', entry.trim());
  } else {
    // Find the section and append
    const sectionStart = content.indexOf('## Key Findings & Discoveries');
    if (sectionStart !== -1) {
      const afterHeader = content.indexOf('\n\n', sectionStart);
      if (afterHeader !== -1) {
        const rest = content.slice(afterHeader + 2);
        const nextSection = rest.indexOf('## ');
        const sectionEnd = nextSection !== -1 ? afterHeader + 2 + nextSection : content.length;
        content = content.slice(0, sectionEnd) + entry + content.slice(sectionEnd);
      }
    }
  }
  fs.writeFileSync(brainPath, content, 'utf8');
}

/**
 * Update project state fields.
 * updates: { phase?, milestone?, blockers? }
 */
function updateProjectState(project, updates) {
  if (!project || !project.workspace_path) return;
  const brainPath = getBrainPath(project.workspace_path);
  ensureBrainExists(brainPath);

  let content = fs.readFileSync(brainPath, 'utf8');
  if (updates.phase) {
    content = content.replace(/\*\*Phase:\*\* .*/, `**Phase:** ${updates.phase}`);
  }
  if (updates.milestone) {
    content = content.replace(/\*\*Milestone:\*\* .*/, `**Milestone:** ${updates.milestone}`);
  }
  if (updates.blockers !== undefined) {
    const blockerText = updates.blockers
      ? updates.blockers.split('\n').map(b => `- ${b}`).join('\n')
      : '_none_';
    content = content.replace(/\*\*Blockers:\*\*[\s\S]*?(?=## |$)/, `**Blockers:** ${blockerText}`);
  }
  fs.writeFileSync(brainPath, content, 'utf8');
}

/**
 * Get a task-relevant context snippet from the brain.
 * Returns a short string with active agents, recent findings, and project state.
 */
function getContextForTask(project, taskTitle) {
  const brain = readBrain(project);
  if (!brain) return '';

  const lines = brain.split('\n');
  const relevant = [];

  let capture = false;
  let depth = 0;

  for (const line of lines) {
    if (line.startsWith('#')) {
      capture = false;
      depth = line.split('#').length - 1;
      if (line.includes('Active Agents') || line.includes('Key Findings') || line.includes('Project State') || line.includes('Session Memory')) {
        capture = depth <= 3;
      }
    }
    if (capture) relevant.push(line);
  }

  return relevant.join('\n').trim();
}

module.exports = {
  readBrain,
  writeBrain,
  appendSessionMemory,
  updateActiveAgents,
  appendFinding,
  updateProjectState,
  getContextForTask,
};