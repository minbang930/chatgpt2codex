import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";
import {
  assignWorkerWorkspace,
  getWorker,
  markWorkerWorkspaceRemoved,
  type WorkerRecord,
  type WorkerWorkspace,
} from "./store.js";

const execFileAsync = promisify(execFile);
const WORKER_ID_RE = /^wrk_[0-9a-fA-F-]{36}$/;
const DIR_MODE = 0o700;
const EXEC_OPTS = {
  windowsHide: true,
  maxBuffer: 10 * 1024 * 1024,
} as const;

interface GitWorktreeEntry {
  worktreePath: string;
  head?: string;
  branch?: string;
}

function gitFailureText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string } | undefined;
  return `${e?.stderr ?? ""} ${e?.stdout ?? ""} ${e?.message ?? String(err)}`.trim();
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { ...EXEC_OPTS, cwd });
  } catch (err) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `git ${args.join(" ")} failed: ${gitFailureText(err)}`,
    );
  }
}

function ensureWorkerId(workerId: string): void {
  if (!WORKER_ID_RE.test(workerId) || workerId !== path.basename(workerId)) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Invalid worker id: ${workerId}`);
  }
}

function comparisonPath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function comparableExistingPath(value: string): Promise<string> {
  try {
    const real = await fs.realpath(value);
    return comparisonPath(real);
  } catch {
    return comparisonPath(value);
  }
}

async function sameManagedPath(a: string, b: string): Promise<boolean> {
  return (await comparableExistingPath(a)) === (await comparableExistingPath(b));
}

async function canonicalExistingPath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch (err) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Path is not available: ${value}: ${(err as Error).message}`,
    );
  }
}

async function assertRepositoryRoot(projectRoot: string): Promise<string> {
  const root = await canonicalExistingPath(projectRoot);
  const top = (await runGit(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const canonicalTop = await canonicalExistingPath(top);
  if (!(await sameManagedPath(root, canonicalTop))) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker project root must be the Git repository root: ${projectRoot}`,
    );
  }
  return root;
}

function projectKey(projectId: string, canonicalRoot: string): string {
  return createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(canonicalRoot)
    .digest("hex")
    .slice(0, 16);
}

export function workerBranch(workerId: string): string {
  ensureWorkerId(workerId);
  return `agent/${workerId}`;
}

export function workerWorktreePath(
  stateDir: string,
  projectId: string,
  canonicalProjectRoot: string,
  workerId: string,
): string {
  ensureWorkerId(workerId);
  const key = projectKey(projectId, canonicalProjectRoot);
  return path.join(stateDir, "agents", "worktrees", key, workerId);
}

function parseWorktreeList(stdout: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: Partial<GitWorktreeEntry> = {};

  const flush = () => {
    if (current.worktreePath) {
      entries.push(current as GitWorktreeEntry);
    }
    current = {};
  };

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) current.worktreePath = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (line.startsWith("branch refs/heads/")) current.branch = line.slice("branch refs/heads/".length);
  }
  flush();
  return entries;
}

async function listWorktrees(projectRoot: string): Promise<GitWorktreeEntry[]> {
  const out = await runGit(projectRoot, ["worktree", "list", "--porcelain"]);
  return parseWorktreeList(out.stdout);
}

async function findWorktreeByPath(entries: GitWorktreeEntry[], expectedPath: string): Promise<GitWorktreeEntry | undefined> {
  for (const entry of entries) {
    if (await sameManagedPath(entry.worktreePath, expectedPath)) return entry;
  }
  return undefined;
}

async function branchExists(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      ...EXEC_OPTS,
      cwd: projectRoot,
    });
    return true;
  } catch (err) {
    const e = err as { code?: number | string };
    if (e.code === 1) return false;
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Could not check worker branch ${branch}: ${gitFailureText(err)}`,
    );
  }
}

async function verifyExpectedWorktree(
  projectRoot: string,
  expectedPath: string,
  expectedBranch: string,
): Promise<{ head: string }> {
  const registered = await findWorktreeByPath(await listWorktrees(projectRoot), expectedPath);
  if (!registered) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker worktree is not registered with the project: ${expectedPath}`,
    );
  }
  if (registered.branch !== expectedBranch) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker worktree branch mismatch: expected ${expectedBranch}, got ${registered.branch ?? "detached"}`,
    );
  }

  const canonicalWorktree = await canonicalExistingPath(expectedPath);
  const top = (await runGit(canonicalWorktree, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const canonicalTop = await canonicalExistingPath(top);
  if (!(await sameManagedPath(canonicalWorktree, canonicalTop))) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker worktree top-level mismatch: ${expectedPath}`,
    );
  }

  const branch = (await runGit(canonicalWorktree, ["branch", "--show-current"])).stdout.trim();
  if (branch !== expectedBranch) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker worktree is on ${branch || "detached HEAD"}, expected ${expectedBranch}`,
    );
  }

  const head = (await runGit(canonicalWorktree, ["rev-parse", "HEAD"])).stdout.trim();
  return { head };
}

export async function verifyWorkerWorktree(
  stateDir: string,
  projectRoot: string,
  worker: Pick<WorkerRecord, "workerId" | "projectId" | "workspace">,
): Promise<{ worktreePath: string; branch: string; head: string }> {
  ensureWorkerId(worker.workerId);
  if (!worker.workspace) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Worker ${worker.workerId} has no workspace assignment`);
  }
  if (worker.workspace.removedAt !== undefined) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Worker ${worker.workerId} workspace was removed`);
  }

  const root = await assertRepositoryRoot(projectRoot);
  const expectedPath = workerWorktreePath(stateDir, worker.projectId, root, worker.workerId);
  const expectedBranch = workerBranch(worker.workerId);
  if (!(await sameManagedPath(worker.workspace.worktreePath, expectedPath)) || worker.workspace.branch !== expectedBranch) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker ${worker.workerId} workspace assignment does not match the managed path/branch`,
    );
  }

  const verified = await verifyExpectedWorktree(root, expectedPath, expectedBranch);
  return { worktreePath: expectedPath, branch: expectedBranch, head: verified.head };
}

export async function provisionWorkerWorktree(
  stateDir: string,
  projectRoot: string,
  workerId: string,
  baseRef = "HEAD",
): Promise<WorkerRecord> {
  ensureWorkerId(workerId);
  const worker = await getWorker(stateDir, workerId);
  if (!worker) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Worker not found: ${workerId}`);
  }

  if (worker.workspace) {
    await verifyWorkerWorktree(stateDir, projectRoot, worker);
    return worker;
  }

  const root = await assertRepositoryRoot(projectRoot);
  const branch = workerBranch(workerId);
  const worktreePath = workerWorktreePath(stateDir, worker.projectId, root, workerId);
  const baseCommit = (await runGit(root, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();

  const existing = await findWorktreeByPath(await listWorktrees(root), worktreePath);
  if (existing) {
    if (existing.branch !== branch) {
      throw new DomainError(
        ErrorCode.WORKSPACE_NOT_READY,
        `Managed worker path is already registered to ${existing.branch ?? "detached HEAD"}`,
      );
    }
    await verifyExpectedWorktree(root, worktreePath, branch);
    const recoveredWorkspace: WorkerWorkspace = {
      branch,
      worktreePath,
      baseCommit,
      createdAt: Date.now(),
    };
    return assignWorkerWorkspace(stateDir, workerId, recoveredWorkspace);
  }

  if (await branchExists(root, branch)) {
    throw new DomainError(
      ErrorCode.WORKSPACE_NOT_READY,
      `Worker branch already exists without its managed worktree: ${branch}`,
    );
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true, mode: DIR_MODE });
  try {
    await fs.chmod(path.dirname(worktreePath), DIR_MODE);
  } catch {
    // Non-fatal on filesystems without POSIX permission bits.
  }

  await runGit(root, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
  try {
    const verified = await verifyExpectedWorktree(root, worktreePath, branch);
    if (verified.head !== baseCommit) {
      throw new DomainError(
        ErrorCode.WORKSPACE_NOT_READY,
        `New worker worktree HEAD mismatch: expected ${baseCommit}, got ${verified.head}`,
      );
    }
    return await assignWorkerWorkspace(stateDir, workerId, {
      branch,
      worktreePath,
      baseCommit,
      createdAt: Date.now(),
    });
  } catch (err) {
    // Never delete the branch/worktree on an uncertain failure. A later retry
    // can recover an already-created managed worktree without losing work.
    throw err;
  }
}

export async function removeWorkerWorktree(
  stateDir: string,
  projectRoot: string,
  workerId: string,
): Promise<{ removed: boolean; branchPreserved: boolean; worktreePath: string }> {
  ensureWorkerId(workerId);
  const worker = await getWorker(stateDir, workerId);
  if (!worker?.workspace) {
    throw new DomainError(ErrorCode.WORKSPACE_NOT_READY, `Worker ${workerId} has no workspace assignment`);
  }
  if (worker.workspace.removedAt !== undefined) {
    return {
      removed: false,
      branchPreserved: true,
      worktreePath: worker.workspace.worktreePath,
    };
  }

  const root = await assertRepositoryRoot(projectRoot);
  await verifyWorkerWorktree(stateDir, root, worker);

  // Deliberately omit --force: Git refuses dirty/untracked worker trees, so
  // cleanup cannot silently destroy unfinished work. The worker branch is
  // deliberately preserved even after a clean worktree is removed.
  await runGit(root, ["worktree", "remove", worker.workspace.worktreePath]);
  await markWorkerWorkspaceRemoved(stateDir, workerId);

  return {
    removed: true,
    branchPreserved: await branchExists(root, worker.workspace.branch),
    worktreePath: worker.workspace.worktreePath,
  };
}
