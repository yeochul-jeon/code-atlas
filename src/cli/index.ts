#!/usr/bin/env node
import { Command } from 'commander';
import { join, resolve, basename, dirname } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { openDatabase } from '../storage/database.js';
import { indexProject } from '../indexer/indexer.js';
import {
  listProjects,
  getStats,
  searchSymbolsFts,
  deleteProject,
  listProjectFiles,
} from '../storage/queries.js';
import { deadCodeAction } from './dead-code.js';
import { loadConfig } from '../config/loader.js';
import {
  listMemories,
  readMemory,
  deleteMemory,
} from '../memory/store.js';
import { generateOnboardingMemories, buildProjectData } from '../memory/onboarding.js';

const DB_PATH = join(homedir(), '.codeatlas', 'index.db');

function getDb() {
  return openDatabase(DB_PATH);
}

const program = new Command();

program
  .name('codeatlas')
  .description('Persistent code index and MCP server for Java projects')
  .version('0.1.0');

// ─── index ────────────────────────────────────────────────────────────────────

program
  .command('index <project-path>')
  .description('Index a Java project')
  .option('-n, --name <name>', 'Project name (defaults to directory name)')
  .option('--incremental', 'Only re-index changed files', false)
  .option('-v, --verbose', 'Show per-file progress', false)
  .action(async (projectPath: string, opts: { name?: string; incremental: boolean; verbose: boolean }) => {
    const absPath = resolve(projectPath);
    if (!existsSync(absPath)) {
      console.error(`Error: path not found: ${absPath}`);
      process.exit(1);
    }
    const name = opts.name ?? basename(absPath);
    const db = getDb();

    const config = loadConfig(absPath);
    console.log(`Indexing ${name} (${absPath})${opts.incremental ? ' [incremental]' : ''}...`);
    const result = indexProject(db, absPath, name, {
      incremental: opts.incremental,
      verbose: opts.verbose,
      extensions: config.indexer.extensions,
      skipDirs: config.indexer.skipDirs,
    });

    console.log(`\nDone in ${result.durationMs}ms`);
    console.log(`  indexed : ${result.indexed}`);
    console.log(`  skipped : ${result.skipped}`);
    console.log(`  errors  : ${result.errors}`);
    if (opts.verbose && result.errorPaths.length > 0) {
      const shown = result.errorPaths.slice(0, 20);
      console.log(`\n  Failed files (first ${shown.length}):`);
      shown.forEach(p => console.log(`    ${p}`));
      if (result.errorPaths.length > 20) {
        console.log(`    ... and ${result.errorPaths.length - 20} more`);
      }
    }

    // Auto-onboarding: generate initial memories on first index
    if (config.memory.enabled && config.memory.autoOnboard) {
      const project = listProjects(db).find(p => p.name === name || p.root_path === absPath);
      if (project) {
        const files = listProjectFiles(db, project.id);
        const kindRows = db.prepare(
          'SELECT s.kind, COUNT(*) as cnt FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.project_id = ? GROUP BY s.kind',
        ).all(project.id) as { kind: string; cnt: number }[];
        const symbolsByKind = Object.fromEntries(kindRows.map(r => [r.kind, r.cnt]));
        const projectData = buildProjectData(name, absPath, files, symbolsByKind, []);
        console.log('\nGenerating onboarding memories...');
        const onboardResult = await generateOnboardingMemories(absPath, projectData);
        if (onboardResult.skipped) {
          if (onboardResult.skipReason?.includes('ANTHROPIC_API_KEY')) {
            console.log(`  Tip: ${onboardResult.skipReason}`);
          }
        } else {
          console.log(`  Created ${onboardResult.memoriesCreated.length} memory file(s): ${onboardResult.memoriesCreated.join(', ')}`);
        }
      }
    }
  });

// ─── serve ────────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start the MCP server')
  .option('--port <port>', 'HTTP port (stdio mode if omitted)')
  .action(async (opts: { port?: string }) => {
    const { startMcpServer } = await import('../mcp/server.js');
    await startMcpServer(DB_PATH, opts.port ? parseInt(opts.port) : undefined);
  });

// ─── search ───────────────────────────────────────────────────────────────────

program
  .command('search <query>')
  .description('Search symbols by name')
  .option('-k, --kind <kind>', 'Filter by kind: class|method|field|interface|enum')
  .option('-l, --limit <n>', 'Max results', '20')
  .action((query: string, opts: { kind?: string; limit: string }) => {
    const db = getDb();
    const results = searchSymbolsFts(db, query, opts.kind, undefined, parseInt(opts.limit));
    if (!results.length) {
      console.log('No results.');
      return;
    }
    for (const r of results) {
      const mods = r.modifiers ? JSON.parse(r.modifiers).join(' ') + ' ' : '';
      const sig = r.signature ?? r.name;
      console.log(`[${r.kind}] ${mods}${sig}`);
      console.log(`  ${r.root_path}/${r.relative_path}:${r.start_line}`);
    }
  });

// ─── list ─────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List indexed projects')
  .action(() => {
    const db = getDb();
    const projects = listProjects(db);
    if (!projects.length) {
      console.log('No projects indexed yet. Run: codeatlas index <path>');
      return;
    }
    for (const p of projects) {
      const ts = p.last_indexed_at ? new Date(p.last_indexed_at).toLocaleString() : 'never';
      console.log(`[${p.id}] ${p.name}`);
      console.log(`  path    : ${p.root_path}`);
      console.log(`  indexed : ${ts}`);
    }
  });

// ─── stats ────────────────────────────────────────────────────────────────────

program
  .command('stats')
  .description('Show index statistics')
  .action(() => {
    const db = getDb();
    const s = getStats(db);
    console.log('Index statistics:');
    console.log(`  projects     : ${s.projects}`);
    console.log(`  files        : ${s.files}`);
    console.log(`  symbols      : ${s.symbols}`);
    console.log(`  dependencies : ${s.dependencies}`);
  });

// ─── remove ───────────────────────────────────────────────────────────────────

program
  .command('remove <project-id>')
  .description('Remove a project from the index')
  .action((id: string) => {
    const db = getDb();
    deleteProject(db, parseInt(id));
    console.log(`Project ${id} removed.`);
  });

// ─── embed ────────────────────────────────────────────────────────────────────

program
  .command('embed <project>')
  .description('Generate vector embeddings for semantic search')
  .option('-v, --verbose', 'Show per-file progress', false)
  .action(async (project: string, opts: { verbose: boolean }) => {
    const db = getDb();
    const projects = listProjects(db);
    const p = projects.find(x => x.name === project || x.root_path === resolve(project));
    if (!p) {
      console.error(`Project not found: "${project}". Use: codeatlas list`);
      process.exit(1);
    }

    const { Embedder } = await import('../vectors/embedder.js');
    const { VectorStore } = await import('../vectors/vector-store.js');
    const { embedProject } = await import('../vectors/embed-pipeline.js');

    const embedder = new Embedder();
    const vectorsPath = join(dirname(DB_PATH), 'vectors');
    const vectorStore = await VectorStore.open(vectorsPath);

    console.log(`Embedding "${p.name}" (this may take a moment on first run — model download ~23MB)...`);
    const result = await embedProject(db, p.id, embedder, vectorStore, { verbose: opts.verbose });

    console.log(`\nDone in ${result.durationMs}ms`);
    console.log(`  files   : ${result.filesEmbedded}`);
    console.log(`  symbols : ${result.symbolsEmbedded}`);
    console.log(`\nRestart the MCP server to make semantic_search available.`);
  });

// ─── graph ────────────────────────────────────────────────────────────────────

const graphCmd = program
  .command('graph')
  .description('Kuzu graph database operations');

graphCmd
  .command('build <project>')
  .description('Build the Kuzu graph from the indexed symbols and references')
  .option('-v, --verbose', 'Show detailed progress', false)
  .action(async (project: string, opts: { verbose: boolean }) => {
    const db = getDb();
    const projects = listProjects(db);
    const p = projects.find(x => x.name === project || x.root_path === resolve(project));
    if (!p) {
      console.error(`Project not found: "${project}". Use: codeatlas list`);
      process.exit(1);
    }

    const { GraphStore } = await import('../graph/graph-store.js');
    const { buildGraph } = await import('../graph/graph-pipeline.js');

    const graphPath = join(dirname(DB_PATH), 'graph.kuzu');
    const graphStore = await GraphStore.open(graphPath);

    console.log(`Building graph for "${p.name}"...`);
    const result = await buildGraph(db, p.id, graphStore, { verbose: opts.verbose });

    console.log(`\nDone in ${result.durationMs}ms`);
    console.log(`  nodes : ${result.nodes}`);
    console.log(`  edges : ${result.edges}`);
    console.log(`\nRestart the MCP server to make graph tools available.`);
  });

// ─── memories ─────────────────────────────────────────────────────────────────

const memoriesCmd = program
  .command('memories')
  .description('Manage project knowledge memories (.codeatlas/memories/)');

memoriesCmd
  .command('list <project>')
  .description('List all memory files for a project')
  .option('-t, --tag <tag>', 'Filter by tag')
  .action((project: string, opts: { tag?: string }) => {
    const db = getDb();
    const projects = listProjects(db);
    const p = projects.find(x => x.name === project || x.root_path === resolve(project));
    if (!p) {
      console.error(`Project not found: "${project}". Use: codeatlas list`);
      process.exit(1);
    }
    const mems = listMemories(p.root_path, opts.tag);
    if (mems.length === 0) {
      console.log('No memories found. Use MCP write_memory tool or `codeatlas memories onboard <project>`.');
      return;
    }
    for (const m of mems) {
      const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
      console.log(`${m.slug}${tags}`);
      console.log(`  "${m.title}" — ${m.updated_at}`);
    }
  });

memoriesCmd
  .command('read <project> <slug>')
  .description('Print the content of a memory file')
  .action((project: string, slug: string) => {
    const db = getDb();
    const projects = listProjects(db);
    const p = projects.find(x => x.name === project || x.root_path === resolve(project));
    if (!p) {
      console.error(`Project not found: "${project}". Use: codeatlas list`);
      process.exit(1);
    }
    const mem = readMemory(p.root_path, slug);
    if (!mem) {
      console.error(`Memory not found: "${slug}"`);
      process.exit(1);
    }
    const tags = mem.tags.length > 0 ? ` [${mem.tags.join(', ')}]` : '';
    console.log(`# ${mem.title}${tags}`);
    console.log(`updated: ${mem.updated_at}\n`);
    console.log(mem.content);
  });

memoriesCmd
  .command('delete <project> <slug>')
  .description('Delete a memory file')
  .action((project: string, slug: string) => {
    const db = getDb();
    const projects = listProjects(db);
    const p = projects.find(x => x.name === project || x.root_path === resolve(project));
    if (!p) {
      console.error(`Project not found: "${project}". Use: codeatlas list`);
      process.exit(1);
    }
    const deleted = deleteMemory(p.root_path, slug);
    if (!deleted) {
      console.error(`Memory not found: "${slug}"`);
      process.exit(1);
    }
    console.log(`Deleted: ${slug}.md`);
  });

memoriesCmd
  .command('onboard <project>')
  .description('Trigger AI onboarding memory generation for a project')
  .action(async (project: string) => {
    const db = getDb();
    const projects = listProjects(db);
    const p = projects.find(x => x.name === project || x.root_path === resolve(project));
    if (!p) {
      console.error(`Project not found: "${project}". Use: codeatlas list`);
      process.exit(1);
    }
    const files = listProjectFiles(db, p.id);
    const kindRows = db.prepare(
      'SELECT s.kind, COUNT(*) as cnt FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.project_id = ? GROUP BY s.kind',
    ).all(p.id) as { kind: string; cnt: number }[];
    const symbolsByKind = Object.fromEntries(kindRows.map(r => [r.kind, r.cnt]));
    const projectData = buildProjectData(p.name, p.root_path, files, symbolsByKind, []);
    console.log(`Generating onboarding memories for "${p.name}"...`);
    const result = await generateOnboardingMemories(p.root_path, projectData);
    if (result.skipped) {
      console.log(`Skipped: ${result.skipReason}`);
    } else {
      console.log(`Created: ${result.memoriesCreated.join(', ')}`);
    }
  });

// ─── dead-code ────────────────────────────────────────────────────────────────

program
  .command('dead-code [project]')
  .description('Find potentially dead (unreferenced) symbols')
  .option('-k, --kind <kind>', 'Filter by kind: class|interface|enum|method|field')
  .action((project: string | undefined, opts: { kind?: string }) => {
    const db = getDb();
    // Resolve project root for config loading
    const projectRoot = project
      ? (listProjects(db).find(x => x.name === project || x.root_path === resolve(project))?.root_path)
      : undefined;
    const config = projectRoot ? loadConfig(projectRoot) : undefined;
    const deadCodeOpts = config ? {
      excludeAnnotations: new Set(config.deadCode.excludeAnnotations),
      excludePatterns: config.deadCode.excludePatterns,
    } : undefined;
    const result = deadCodeAction(db, project, opts.kind, deadCodeOpts);
    if (result.exitCode !== 0) {
      console.error(result.output);
      process.exit(result.exitCode);
    }
    console.log(result.output);
  });

program.parse();
