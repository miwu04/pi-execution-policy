import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { git } from "./process.ts";
import { digest } from "./storage.ts";

export function inside(root: string, path: string): boolean {
  const name = relative(root, path);
  return name === "" || (!name.startsWith(`..${sep}`) && name !== ".." && !isAbsolute(name));
}

export function canonical(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(canonical(parent), relative(parent, path));
  }
}

export function permitted(cwd: string, target: string, paths: string[], protectedPaths: string[]): string {
  const path = canonical(resolve(cwd, target));
  if (!inside(cwd, path) || protectedPaths.some(root => inside(root, path))) throw new Error("目标位于授权目录之外或受保护目录内");
  const relativeName = relative(cwd, path);
  if (relativeName.split(sep).some(part => part === ".git")) throw new Error("不能直接修改 Git 元数据");
  if (!paths.some(name => inside(canonical(resolve(cwd, name)), path))) throw new Error("目标不在本次允许的路径中");
  return relativeName;
}

export async function changedFiles(cwd: string): Promise<string[]> {
  const tracked = await git(cwd, ["diff", "--no-renames", "--name-only", "-z", "HEAD"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean))].sort();
}

export async function revision(cwd: string, config: Config): Promise<string> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (realpathSync(root) !== cwd) throw new Error("请在仓库根目录使用执行约束插件");
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const patch = await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "HEAD"]);
  const files = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).sort();
  const contents: unknown[] = [];
  for (const name of files) {
    const path = resolve(cwd, name);
    const stat = lstatSync(path);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`未跟踪对象类型不受支持：${name}`);
    contents.push([name, stat.mode, stat.isSymbolicLink() ? readlinkSync(path) : digest(readFileSync(path))]);
  }
  const environment = config.environmentKeys.map(key => [key, process.env[key] ?? null]);
  const inputs = config.environmentFiles.map(name => {
    const path = resolve(cwd, name);
    try { return [name, digest(readFileSync(path))]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, null];
      throw error;
    }
  });
  return digest(JSON.stringify({ head, patch, contents, config, environment, inputs, platform: process.platform, arch: process.arch, node: process.version }));
}
