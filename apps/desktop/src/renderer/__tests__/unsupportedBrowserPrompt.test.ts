import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '..');
const browserGlobals = new Set(['window', 'globalThis', 'self']);

function unsupportedPromptCalls(sourceText: string, fileName: string): number[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const direct = ts.isIdentifier(expression) && expression.text === 'prompt';
      const property =
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'prompt' &&
        ts.isIdentifier(expression.expression) &&
        browserGlobals.has(expression.expression.text);
      const computed =
        ts.isElementAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        browserGlobals.has(expression.expression.text) &&
        ts.isStringLiteralLike(expression.argumentExpression) &&
        expression.argumentExpression.text === 'prompt';
      if (direct || property || computed) {
        lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

async function rendererSourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'vendor') return [];
        return rendererSourceFiles(resolved);
      }
      return /\.[jt]sx?$/.test(entry.name) ? [resolved] : [];
    }),
  );
  return files.flat();
}

describe('unsupported browser prompt guard', () => {
  it('detects direct, qualified, and computed prompt calls', () => {
    const source = `
      prompt('direct');
      window.prompt('window');
      globalThis['prompt']('global');
      self["prompt"]('self');
    `;
    expect(unsupportedPromptCalls(source, 'fixture.ts')).toHaveLength(4);
  });

  // 本用例要遍历整个 renderer 源码树（数千个文件）并逐个解析 AST：在 Linux 上默认
  // testTimeout 只有 5s（见 docs/dev-rules/desktop-unit-test-performance.md 的
  // 「单测超时默认值」一节的实测口径），CI runner 上会稳定超时。自带更高预算，
  // 与仓库里其它遍历型/冷转译型用例同一做法。
  it(
    'keeps renderer product code free of browser prompt calls',
    async () => {
      const violations: string[] = [];
      for (const file of await rendererSourceFiles(rendererRoot)) {
        const source = await fs.readFile(file, 'utf8');
        for (const line of unsupportedPromptCalls(source, file)) {
          violations.push(`${path.relative(rendererRoot, file)}:${line}`);
        }
      }
      expect(violations).toEqual([]);
    },
    60_000,
  );
});
