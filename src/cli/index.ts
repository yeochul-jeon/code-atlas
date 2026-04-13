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
} from '../storage/queries.js';
import { deadCodeAction } from './dead-code.js';

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
  .action((projectPath: string, opts: { name?: string; incremental: boolean; verbose: boolean }) => {
    const absPath = resolve(projectPath);
    if (!existsSync(absPath)) {
      console.error(`Error: path not found: ${absPath}`);
      process.exit(1);
    }
    const name = opts.name ?? basename(absPath);
    const db = getDb();

    console.log(`Indexing ${name} (${absPath})${opts.incremental ? ' [incremental]' : ''}...`);
    const result = indexProject(db, absPath, name, {
      incremental: opts.incremental,
      verbose: opts.verbose,
    });

    console.log(`\nDone in ${result.durationMs}ms`);
    console.log(`  indexed : ${result.indexed}`);
    console.log(`  skipped : ${result.skipped}`);
    console.log(`  errors  : ${result.errors}`);
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

// ─── dead-code ────────────────────────────────────────────────────────────────

program
  .command('dead-code [project]')
  .description('Find potentially dead (unreferenced) symbols')
  .option('-k, --kind <kind>', 'Filter by kind: class|interface|enum|method|field')
  .action((project: string | undefined, opts: { kind?: string }) => {
    const db = getDb();
    const result = deadCodeAction(db, project, opts.kind);
    if (result.exitCode !== 0) {
      console.error(result.output);
      process.exit(result.exitCode);
    }
    console.log(result.output);
  });

program.parse();
