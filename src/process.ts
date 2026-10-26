import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  canceled: boolean;
  truncated: boolean;
}

export function runCommand(command: string, args: string[], cwd: string, options: {
  signal?: AbortSignal; timeoutMs?: number; maxBytes?: number;
} = {}): Promise<CommandResult> {
  if (options.signal?.aborted) return Promise.reject(new Error("操作已取消"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let canceled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const terminate = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs ?? 30_000);
    const abort = () => { canceled = true; terminate(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const append = (chunk: Buffer) => {
      output = Buffer.concat([output, chunk]);
      const limit = options.maxBytes ?? 262_144;
      if (output.length > limit) { output = output.subarray(output.length - limit); truncated = true; }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", exitCode => {
      if (timedOut || canceled) kill("SIGKILL");
      cleanup();
      resolve({ exitCode, output: output.toString("utf8"), timedOut, canceled, truncated });
    });
  });
}

export async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await runCommand("git", ["--no-pager", "--literal-pathspecs", ...args], cwd, { signal, maxBytes: 16 * 1024 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.canceled || result.truncated) {
    throw new Error(`Git 操作未完成：${args[0]}；${result.output}`);
  }
  return result.output;
}
