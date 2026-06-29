import path from 'node:path';
import fse from 'fs-extra';

export async function ensureDir(dir: string): Promise<void> {
  await fse.ensureDir(dir);
}

export async function pathExists(p: string): Promise<boolean> {
  return fse.pathExists(p);
}

export async function writeText(file: string, content: string): Promise<void> {
  await fse.ensureDir(path.dirname(file));
  await fse.writeFile(file, content, 'utf8');
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fse.ensureDir(path.dirname(file));
  await fse.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

export async function readJson<T = unknown>(file: string): Promise<T> {
  const raw = await fse.readFile(file, 'utf8');
  return JSON.parse(raw) as T;
}

export async function readText(file: string): Promise<string> {
  return fse.readFile(file, 'utf8');
}

export async function remove(p: string): Promise<void> {
  await fse.remove(p);
}
