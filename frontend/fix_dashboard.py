#!/usr/bin/env python3
with open('src/app/dashboard/page.tsx') as f:
    lines = f.readlines()

# Line 435 (0-indexed) = Row 6 comment
# Line 455 (0-indexed) = closing of Row 6 block
# Line 456 = blank
# Line 457 (0-indexed) = <div className="system-health">
# Line 433 (0-indexed) = </div> closing Row 5 grid

new_lines = []
i = 0
while i < len(lines):
    # Change Row 5 to 3-column
    if i == 370:
        new_lines.append('      {/* ── Row 5: Agent Throughput | Project Completion | Agents (3 columns) ── */}\n')
        i += 1
        continue
    if i == 371:
        new_lines.append('      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, marginBottom: 20 }}>\n')
        i += 1
        continue

    # After Agent Throughput chart-card closes (line 399, 0-indexed), insert Project Completion + new Agents
    if i == 399:
        new_lines.append(lines[i])  # </div> (closes Agent Throughput chart-card)
        new_lines.append('\n')
        new_lines.append('        {/* Project Completion */}\n')
        new_lines.append('        {(dash?.projects ?? []).length > 0 ? (\n')
        new_lines.append('          <div className="chart-card">\n')
        new_lines.append('            <div className="chart-title">Project Completion</div>\n')
        new_lines.append('            <div className="completion-bars">\n')
        new_lines.append('              {dash?.projects?.map((p: any) => {\n')
        new_lines.append('                const pct = p.completion_pct ?? 0;\n')
        new_lines.append('                const color = pct >= 80 ? \'var(--success)\' : pct >= 50 ? \'var(--warning)\' : \'var(--danger)\';\n')
        new_lines.append('                return (\n')
        new_lines.append('                  <div key={p.id} className="completion-row">\n')
        new_lines.append('                    <div className="completion-label" title={p.title}>{p.title}</div>\n')
        new_lines.append('                    <div className="completion-track">\n')
        new_lines.append('                      <div className="completion-fill" style={{ width: `${pct}%`, background: color }} />\n')
        new_lines.append('                    </div>\n')
        new_lines.append('                    <div className="completion-pct" style={{ color }}>{pct}%</div>\n')
        new_lines.append('                  </div>\n')
        new_lines.append('                );\n')
        new_lines.append('              })}\n')
        new_lines.append('            </div>\n')
        new_lines.append('          </div>\n')
        new_lines.append('        ) : (\n')
        new_lines.append('          <div className="chart-card">\n')
        new_lines.append('            <div className="chart-title">Project Completion</div>\n')
        new_lines.append('            <div className="empty-state text-sm">No projects yet</div>\n')
        new_lines.append('          </div>\n')
        new_lines.append('        )}\n')
        new_lines.append('\n')
        new_lines.append('        {/* Agents */}\n')
        new_lines.append('        <div className="panel">\n')
        new_lines.append('          <div className="panel-header">\n')
        new_lines.append('            <h2>🤖 Agents <span className="text-muted text-sm font-normal">({dash?.agents?.length ?? 0})</span></h2>\n')
        new_lines.append('          </div>\n')
        new_lines.append('          <div className="table-wrap" style={{ maxHeight: 280, overflowY: \'auto\' }}>\n')
        new_lines.append('            <table>\n')
        new_lines.append('              <thead>\n')
        new_lines.append('                <tr>\n')
        new_lines.append('                  <th>Name</th>\n')
        new_lines.append('                  <th>Status</th>\n')
        new_lines.append('                  <th>Done</th>\n')
        new_lines.append('                  <th>Fail</th>\n')
        new_lines.append('                </tr>\n')
        new_lines.append('              </thead>\n')
        new_lines.append('              <tbody>\n')
        new_lines.append('                {dash?.agents?.length === 0 && (\n')
        new_lines.append('                  <tr><td colSpan={4} className="empty-state">No agents yet</td></tr>\n')
        new_lines.append('                )}\n')
        new_lines.append('                {dash?.agents?.map((a: any) => (\n')
        new_lines.append('                  <tr key={a.id}>\n')
        new_lines.append('                    <td className="font-medium">{a.name}</td>\n')
        new_lines.append('                    <td><span className={`badge status-${a.status}`}>{a.status}</span></td>\n')
        new_lines.append('                    <td className="text-center text-green text-sm">{a.tasks_done ?? 0}</td>\n')
        new_lines.append('                    <td className="text-center text-red text-sm">{a.tasks_failed ?? 0}</td>\n')
        new_lines.append('                  </tr>\n')
        new_lines.append('                ))}\n')
        new_lines.append('              </tbody>\n')
        new_lines.append('            </table>\n')
        new_lines.append('          </div>\n')
        new_lines.append('        </div>\n')
        new_lines.append('\n')
        # Jump past original Agents panel (lines 401-428, 0-indexed) AND Row 6 (lines 435-455, 0-indexed)
        i = 456  # jump to line 456 (0-indexed), which is blank before system-health
        continue

    # Skip Row 6 entirely (lines 435-455, 0-indexed = 435 through 455)
    if 435 <= i <= 455:
        i += 1
        continue

    new_lines.append(lines[i])
    i += 1

with open('src/app/dashboard/page.tsx', 'w') as f:
    f.writelines(new_lines)
print(f"Done, total lines: {len(new_lines)}")