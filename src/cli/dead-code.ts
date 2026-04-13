import { resolve } from 'path';
import type { Db } from '../storage/database.js';
import { listProjects, findDeadCode } from '../storage/queries.js';
import { formatDeadCodeResult } from '../mcp/dead-code-formatter.js';

export function deadCodeAction(
  db: Db,
  project?: string,
  kind?: string,
): { output: string; exitCode: number } {
  const projects = listProjects(db);

  if (project !== undefined) {
    const p = projects.find(x => x.name === project || x.root_path === resolve(project));
    if (!p) {
      return {
        output: `Project not found: "${project}". Use: codeatlas list`,
        exitCode: 1,
      };
    }
    return { output: formatDeadCodeResult(findDeadCode(db, p.id, kind)), exitCode: 0 };
  }

  const allDead = projects.flatMap(p => findDeadCode(db, p.id, kind));
  return { output: formatDeadCodeResult(allDead), exitCode: 0 };
}
