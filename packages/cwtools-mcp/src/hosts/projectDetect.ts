import * as fs from 'fs';
import * as path from 'path';

export interface ProjectSupport {
  supported: boolean;
  reason: string;
  markers: string[];
}

const FILE_MARKERS = ['descriptor.mod'];
const NESTED_FILE_MARKERS = [path.join('.metadata', 'metadata.json')];
const DIR_MARKERS = ['common', 'events', 'localisation', 'localization', '.cwtools-ai'];

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function detectProjectSupport(workspaceRoot: string): ProjectSupport {
  const markers: string[] = [];
  for (const f of FILE_MARKERS) {
    if (isFile(path.join(workspaceRoot, f))) markers.push(f);
  }
  for (const f of NESTED_FILE_MARKERS) {
    if (isFile(path.join(workspaceRoot, f))) markers.push(f.replace(/\\/g, '/'));
  }
  for (const d of DIR_MARKERS) {
    if (isDir(path.join(workspaceRoot, d))) markers.push(`${d}/`);
  }
  const supported = markers.length > 0;
  return {
    supported,
    markers,
    reason: supported
      ? `Detected Paradox mod markers: ${markers.join(', ')}.`
      : 'No Paradox mod markers (descriptor.mod, common/, events/, localisation/, .cwtools-ai/) in the workspace root.',
  };
}
