import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Atomic-ish replacement: write a sibling temp file, flush it, then rename over
 * the target. A crash mid-write leaves the original file untouched instead of
 * a truncated source file.
 */
export async function atomicWrite(
  filePath: string,
  contents: Buffer,
): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(
    directory,
    `.encoding-guard-${randomBytes(6).toString("hex")}.tmp`,
  );

  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle?.close();
  }

  try {
    await copyPermissions(filePath, tempPath);
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  // Best effort: make the rename durable. A failure here does not invalidate
  // the write, so it must not abort the caller.
  try {
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    /* not supported on every platform (Windows) */
  }
}

async function copyPermissions(source: string, target: string): Promise<void> {
  const stats = await stat(source).catch(() => undefined);
  if (stats) await chmod(target, stats.mode).catch(() => {});
}

export async function readFileSafe(
  filePath: string,
): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return undefined;
  }
}
