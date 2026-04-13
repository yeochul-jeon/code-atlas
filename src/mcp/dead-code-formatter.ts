import type { DeadSymbol } from '../storage/queries.js';

export function formatDeadCodeResult(dead: DeadSymbol[]): string {
  if (dead.length === 0) {
    return 'No dead code found.';
  }

  const header = `Found ${dead.length} potentially dead symbol(s):\n`;
  const lines = dead.map(s => {
    const sig = s.signature ?? s.name;
    return `[${s.kind}] ${sig}  L${s.start_line}-${s.end_line}\n  file: ${s.root_path}/${s.relative_path}`;
  });
  return header + lines.join('\n\n');
}
