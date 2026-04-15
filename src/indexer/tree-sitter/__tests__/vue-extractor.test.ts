import { describe, it, expect } from 'vitest';
import { extractFromVue } from '../vue-extractor.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function names(result: ReturnType<typeof extractFromVue>): string[] {
  return result.symbols.map(s => s.name);
}

// ─── basic script extraction ─────────────────────────────────────────────────

describe('extractFromVue', () => {
  describe('basic script extraction', () => {
    it('extracts function from <script lang="ts">', () => {
      const src = '<script lang="ts">\nexport function greet() {}\n</script>';
      const result = extractFromVue(src);
      expect(names(result)).toContain('greet');
      const greet = result.symbols.find(s => s.name === 'greet');
      expect(greet?.kind).toBe('function');
    });

    it('extracts function when no lang attribute (defaults to javascript)', () => {
      const src = '<script>\nfunction hello() {}\n</script>';
      const result = extractFromVue(src);
      expect(names(result)).toContain('hello');
    });

    it('handles explicit lang="javascript"', () => {
      const src = '<script lang="javascript">\nfunction jsFunc() {}\n</script>';
      const result = extractFromVue(src);
      expect(names(result)).toContain('jsFunc');
    });

    it('handles lang="typescript" (full name, not just "ts")', () => {
      const src = '<script lang="typescript">\nexport function tsFunc() {}\n</script>';
      const result = extractFromVue(src);
      expect(names(result)).toContain('tsFunc');
    });

    it('extracts class and method', () => {
      const src = [
        '<script lang="ts">',
        'class MyService {',
        '  doWork() {}',
        '}',
        '</script>',
      ].join('\n');
      const result = extractFromVue(src);
      expect(names(result)).toContain('MyService');
      expect(names(result)).toContain('doWork');
    });
  });

  // ─── line offset ───────────────────────────────────────────────────────────

  describe('line number offset correction', () => {
    it('corrects start_line when <template> precedes <script>', () => {
      const src = [
        '<template>',       // line 1
        '  <div/>',         // line 2
        '</template>',      // line 3
        '<script lang="ts">', // line 4 — opening tag
        'export function greet() {}', // line 5 — body
        '</script>',        // line 6
      ].join('\n');
      const result = extractFromVue(src);
      const greet = result.symbols.find(s => s.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet?.start_line).toBe(5);
    });

    it('start_line is 2 when <script> is on line 1 (body starts line 2)', () => {
      const src = [
        '<script lang="ts">', // line 1
        'export function init() {}', // line 2
        '</script>',
      ].join('\n');
      const result = extractFromVue(src);
      const init = result.symbols.find(s => s.name === 'init');
      expect(init?.start_line).toBe(2);
    });
  });

  // ─── Vue 3 dual script blocks ──────────────────────────────────────────────

  describe('Vue 3 dual script blocks', () => {
    it('merges symbols from <script> and <script setup>', () => {
      const src = [
        '<script lang="ts">',
        'export interface Props { msg: string }',
        '</script>',
        '<script setup lang="ts">',
        'const count = 0;',
        '</script>',
      ].join('\n');
      const result = extractFromVue(src);
      expect(names(result)).toContain('Props');
      expect(names(result)).toContain('count');
    });

    it('dependencies are merged from both blocks', () => {
      const src = [
        '<script lang="ts">',
        "import { ref } from 'vue';",
        '</script>',
        '<script setup lang="ts">',
        "import { computed } from 'vue';",
        '</script>',
      ].join('\n');
      const result = extractFromVue(src);
      const vueDeps = result.dependencies.filter(d => d.targetFqn === 'vue');
      expect(vueDeps.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty result when no script block', () => {
      const src = '<template><div/></template><style>.x{}</style>';
      const result = extractFromVue(src);
      expect(result.symbols).toHaveLength(0);
      expect(result.dependencies).toHaveLength(0);
      expect(result.refs).toHaveLength(0);
    });

    it('returns empty result for empty string', () => {
      const result = extractFromVue('');
      expect(result.symbols).toHaveLength(0);
    });

    it('returns empty result when <script> block is empty', () => {
      const src = '<script lang="ts"></script>';
      const result = extractFromVue(src);
      expect(result.symbols).toHaveLength(0);
    });

    it('returns empty result when <script> block is whitespace only', () => {
      const src = '<script lang="ts">   \n   </script>';
      const result = extractFromVue(src);
      expect(result.symbols).toHaveLength(0);
    });

    it('extracts import as dependency', () => {
      const src = [
        '<script lang="ts">',
        "import { ref } from 'vue';",
        '</script>',
      ].join('\n');
      const result = extractFromVue(src);
      expect(result.dependencies).toContainEqual({ targetFqn: 'vue', kind: 'import' });
    });

    it('handles <script setup> without lang attribute', () => {
      const src = '<script setup>\nconst x = 1;\n</script>';
      const result = extractFromVue(src);
      expect(names(result)).toContain('x');
    });
  });
});
