/**
 * codex-bridge — cc-mgr 的 Codex app-server stdio 代理子命令。
 *
 * 用途：远程 Codex Worker（mcpr project-agent）场景下，远端 router host 上的
 * codex app-server 进程由本 bridge 代为 spawn，desktop 经 mcpr WS tunnel 直接
 * 跟 app-server 的 NDJSON stdio 对话。mcp-router 侧保持纯字节中继，不解析任何
 * 协议——spawn 参数（cwd / env / extraArgs）由 desktop 以「首行 header」的
 * 形式随字节流首帧送达：
 *
 *   第一行（必须）：{"$codexBridge":{"version":1,"cwd?":"...","env?":{...},"extraArgs?":[...]}}\n
 *   之后：codex app-server 的 NDJSON JSON-RPC 字节流原样双向中继。
 *
 * 设计约束：
 *   - 缺 CC_MGR_CODEX_BIN → fail closed（exit 2），Claude 路径不受影响。
 *   - 首行不是合法 header → fail closed（exit 2）。绝不把无 header 的流静默
 *     接给 app-server，否则 spawn 配置错误会被掩盖成协议错误，极难排查。
 *   - 读 header 用手动字节缓冲（不用 readline）：readline 会把首个 \n 之后的
 *     字节也吞进内部 buffer，转发时丢帧。
 *   - 远端 host 环境里的残留网关凭证（OPENAI_API_KEY 等）先在 spawn env 里
 *     剥掉，再叠加 desktop header.env——与 daemon 启动时剥离 Anthropic 敏感
 *     键同一纪律：远端只认 desktop 显式递来的凭证。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** 首行 header 的线缆形态。version 目前只有 1。 */
export interface CodexBridgeHeader {
  version: 1;
  /** app-server 进程 cwd（远端路径）；不传则用 bridge 自身 cwd。 */
  cwd?: string;
  /** 叠加到 spawn env 上的键值（网关凭证、base URL 等）。 */
  env?: Record<string, string>;
  /** `app-server` 子命令之后的额外参数（`-c` overrides 等）。 */
  extraArgs?: string[];
}
export const CODEX_BRIDGE_HEADER_KEY = '$codexBridge' as const;

/** header 行体积上限——正常 header 只有几 KB，超限一律视为畸形流。 */
const MAX_HEADER_BYTES = 64 * 1024;

/**
 * spawn 前从继承 env 里剥离的远端残留凭证键。desktop 没显式递的同名词条
 * 不允许从 router host 的 shell 环境漏进 app-server（凭证串号 / 401）。
 * 与 cc-mgr.ts SENSITIVE_ANTHROPIC_ENV_KEYS 同一套纪律，互不同步、各自维护。
 */
const SENSITIVE_CODEX_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
] as const;

export interface CodexBridgeDeps {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** bridge 进程自身 env（含 CC_MGR_CODEX_BIN、CODEX_HOME 等 mcp-router 注入项）。 */
  env: NodeJS.ProcessEnv;
  /** 测试注入用；默认 node:child_process.spawn。 */
  spawnFn?: typeof spawn;
}

/**
 * 从 stdin 读出首行 header（手动缓冲，readline 会吞掉后续字节）。
 * 返回 header 与紧随其后的剩余字节（可能是空 Buffer）。
 */
async function readHeaderLine(stdin: Readable): Promise<{ header: CodexBridgeHeader; rest: Buffer }> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise((resolve, reject) => {
    const onData = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      total += buf.length;
      if (total > MAX_HEADER_BYTES) {
        cleanup();
        reject(new Error(`codex-bridge header exceeds ${MAX_HEADER_BYTES} bytes`));
        return;
      }
      const newline = buf.indexOf(0x0a);
      if (newline === -1) {
        chunks.push(buf);
        return;
      }
      chunks.push(buf.subarray(0, newline));
      const rest = buf.subarray(newline + 1);
      cleanup();
      const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        reject(new Error('codex-bridge header is not valid JSON'));
        return;
      }
      const header = (parsed as Record<string, unknown> | null)?.[CODEX_BRIDGE_HEADER_KEY];
      if (typeof header !== 'object' || header === null) {
        reject(new Error(`codex-bridge stream must start with a {"${CODEX_BRIDGE_HEADER_KEY}":{...}} header line`));
        return;
      }
      const h = header as Record<string, unknown>;
      if (h.version !== 1) {
        reject(new Error(`codex-bridge header version must be 1, got ${JSON.stringify(h.version)}`));
        return;
      }
      if (h.cwd !== undefined && typeof h.cwd !== 'string') {
        reject(new Error('codex-bridge header cwd must be a string'));
        return;
      }
      if (h.env !== undefined && (typeof h.env !== 'object' || h.env === null
        || Object.entries(h.env as Record<string, unknown>).some(([k, v]) => typeof k !== 'string' || typeof v !== 'string'))) {
        reject(new Error('codex-bridge header env must be a string map'));
        return;
      }
      if (h.extraArgs !== undefined && (!Array.isArray(h.extraArgs) || h.extraArgs.some((a) => typeof a !== 'string'))) {
        reject(new Error('codex-bridge header extraArgs must be a string array'));
        return;
      }
      resolve({ header: h as unknown as CodexBridgeHeader, rest });
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('codex-bridge stdin ended before header line'));
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('error', onError);
      stdin.off('end', onEnd);
    };
    stdin.on('data', onData);
    stdin.on('error', onError);
    stdin.on('end', onEnd);
  });
}

/**
 * 运行 codex-bridge：读 header → spawn `codex app-server` → 双向字节中继。
 * resolve 的值是进程退出码（0 正常关闭，非 0 异常），调用方（cc-mgr bin）
 * 用它做 process.exit code。返回前保证 stdout/stderr 已 flush。
 */
export async function runCodexBridge(deps: CodexBridgeDeps): Promise<number> {
  const { stdin, stdout, stderr, env } = deps;
  const spawnFn = deps.spawnFn ?? spawn;

  const codexBin = env.CC_MGR_CODEX_BIN;
  if (!codexBin) {
    stderr.write('[cc-mgr codex-bridge] CC_MGR_CODEX_BIN is not set — MCPRouter 未以完整版打包（缺 Codex 二进制）\n');
    return 2;
  }

  let header: CodexBridgeHeader;
  let rest: Buffer;
  try {
    ({ header, rest } = await readHeaderLine(stdin));
  } catch (err) {
    stderr.write(`[cc-mgr codex-bridge] ${(err as Error).message}\n`);
    return 2;
  }

  // 剥掉远端残留网关凭证，再叠 desktop 显式递来的 env（纪律见文件头注释）。
  // Windows 的 env 键大小写不敏感，按小写归一后匹配，防 `OpenAI_API_Key`
  // 这类变体漏过（router host 今天是 Linux,但架构不要求如此）。
  const childEnv: NodeJS.ProcessEnv = { ...env };
  const sensitiveLower = new Set(SENSITIVE_CODEX_ENV_KEYS.map((key) => key.toLowerCase()));
  for (const key of Object.keys(childEnv)) {
    if (sensitiveLower.has(key.toLowerCase())) {
      delete childEnv[key];
    }
  }
  Object.assign(childEnv, header.env);

  const args = ['app-server', ...(header.extraArgs ?? [])];
  stderr.write(`[cc-mgr codex-bridge] spawning ${codexBin} ${args.join(' ')}${header.cwd ? ` (cwd=${header.cwd})` : ''}\n`);

  const child: ChildProcessWithoutNullStreams = spawnFn(codexBin, args, {
    ...(header.cwd ? { cwd: header.cwd } : {}),
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: false,
  }) as ChildProcessWithoutNullStreams;

  child.stderr.on('data', (chunk: Buffer) => {
    stderr.write(chunk);
  });

  return await new Promise<number>((resolve) => {
    let settled = false;
    const flushAndResolve = (code: number): void => {
      if (settled) return;
      settled = true;
      try {
        stdin.unpipe(child.stdin);
      } catch {
        /* 可能从未 pipe 上（spawn 即失败），忽略 */
      }
      // 跟 runBridge 同款 flush barrier：空写 callback 在前面 chunk flush 完才触发。
      stdout.write('', () => {
        stderr.write('', () => {
          resolve(code);
        });
      });
    };

    child.on('error', (err) => {
      stderr.write(`[cc-mgr codex-bridge] spawn error: ${err.message}\n`);
      flushAndResolve(1);
    });
    // app-server 先退、desktop 还在写时 child.stdin 会 EPIPE——吞掉它,
    // 退出语义统一走 child 'exit' → flushAndResolve,不让 stream error
    // 变成 uncaughtException 把 bridge 砸成堆栈(还会丢最后的 stdout)。
    child.stdin.on('error', () => { /* EPIPE after child exit — handled via 'exit' */ });
    child.on('exit', (code, signal) => {
      const reason = signal ? `signal=${signal}` : `exit code=${code ?? 'null'}`;
      stderr.write(`[cc-mgr codex-bridge] app-server exited (${reason})\n`);
      flushAndResolve(code ?? (signal ? 1 : 0));
    });

    // header 之后的剩余字节先进 app-server，再把 stdin 接管过去。
    child.stdout.pipe(stdout);
    if (rest.length > 0) {
      child.stdin.write(rest);
    }
    stdin.pipe(child.stdin);
    // desktop 半关（stdin EOF）→ 转发 EOF 给 app-server，让它自然退出，
    // 不 destroy，避免 in-flight 响应被截断。
    // 注意 EOF 可能发生在 header 读取完成、pipe 挂上之前（同一 tick 内 data+end），
    // 此时 'end' 不会再触发，必须用 readableEnded 兜底。
    if (stdin.readableEnded) {
      try {
        child.stdin.end();
      } catch {
        /* child 可能已退出 */
      }
    } else {
      stdin.on('end', () => {
        try {
          child.stdin.end();
        } catch {
          /* child 可能已退出 */
        }
      });
    }
    stdin.on('error', () => {
      try {
        child.kill();
      } catch {
        /* */
      }
      flushAndResolve(1);
    });
  });
}
