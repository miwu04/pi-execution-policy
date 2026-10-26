import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${randomUUID()}.pending`;
  try {
    writeFileSync(staging, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(staging, path);
  } finally { rmSync(staging, { force: true }); }
}

export class WriteLease {
  readonly path: string;
  readonly owner: string;
  constructor(root: string, cwd: string, owner: string) {
    this.path = join(root, "locks", digest(cwd));
    this.owner = owner;
  }
  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(this.path, { mode: 0o700 });
      saveJson(join(this.path, "owner.json"), { owner: this.owner, pid: process.pid });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = readJson<{ owner: string }>(join(this.path, "owner.json"));
      if (record?.owner !== this.owner) throw new Error("该工作目录已有写入者；需要显式交接，不能抢占过期记录");
    }
  }
  release(): void {
    const record = readJson<{ owner: string }>(join(this.path, "owner.json"));
    if (record?.owner === this.owner) rmSync(this.path, { recursive: true });
  }
}
