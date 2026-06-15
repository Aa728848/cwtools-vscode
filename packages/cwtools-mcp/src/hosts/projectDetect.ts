import * as fs from 'fs';
import * as path from 'path';

export interface ProjectSupport {
  supported: boolean;
  reason: string;
  markers: string[];
  // Directory where the mod markers were found (root, an ancestor, or a child).
  matchedAt?: string;
}

// Strong, unambiguous "this directory is a mod root" signals.
const ROOT_FILE_MARKERS = ['descriptor.mod'];
const ROOT_NESTED_FILE_MARKERS = [path.join('.metadata', 'metadata.json')];
const ROOT_DIR_MARKERS = ['.cwtools-ai'];
// PDX content dirs — specific enough at a mod root, but too generic to trust in a
// far-off ancestor. Generic graphics dirs (gfx/, interface/) are excluded.
const CONTENT_DIR_MARKERS = ['common', 'events', 'localisation', 'localization'];

const MAX_ANCESTORS = 6;   // how far up to look for a mod root above the cwd
const MAX_CHILDREN = 64;   // how many immediate subdirs to probe when cwd is a parent

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// Markers present directly in `dir`. `includeContent` adds the PDX content dirs,
// which we only trust at the workspace root / immediate children, not ancestors.
function markersAt(dir: string, includeContent: boolean): string[] {
  const found: string[] = [];
  for (const f of ROOT_FILE_MARKERS) {
    if (isFile(path.join(dir, f))) found.push(f);
  }
  for (const f of ROOT_NESTED_FILE_MARKERS) {
    if (isFile(path.join(dir, f))) found.push(f.replace(/\\/g, '/'));
  }
  for (const d of ROOT_DIR_MARKERS) {
    if (isDir(path.join(dir, d))) found.push(`${d}/`);
  }
  if (includeContent) {
    for (const d of CONTENT_DIR_MARKERS) {
      if (isDir(path.join(dir, d))) found.push(`${d}/`);
    }
  }
  return found;
}

// Decide whether `workspaceRoot` is (or contains, or sits inside) a Paradox mod the
// CWTools tools can serve. Cheap synchronous stat checks only — run once at startup
// before anything heavy (the language server) is spawned. Codex usually launches
// the MCP without --workspace, so the cwd may be the mod root, an ancestor, or a
// parent holding the mod in a subfolder; all three are accepted.
export function detectProjectSupport(workspaceRoot: string): ProjectSupport {
  // 1. The workspace root itself (the common, correct case).
  const atRoot = markersAt(workspaceRoot, true);
  if (atRoot.length > 0) {
    return {
      supported: true,
      markers: atRoot,
      matchedAt: workspaceRoot,
      reason: `Detected Paradox mod markers at the workspace root: ${atRoot.join(', ')}.`,
    };
  }

  // 2. An ancestor mod root (cwd is a subfolder of the mod). Strong markers only.
  let dir = workspaceRoot;
  for (let i = 0; i < MAX_ANCESTORS; i++) {
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
    const atAncestor = markersAt(dir, false);
    if (atAncestor.length > 0) {
      return {
        supported: true,
        markers: atAncestor,
        matchedAt: dir,
        reason: `Detected a Paradox mod root above the workspace (${dir}): ${atAncestor.join(', ')}.`,
      };
    }
  }

  // 3. An immediate child that is a mod root (cwd is a parent holding the mod).
  let children: fs.Dirent[] = [];
  try {
    children = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    children = [];
  }
  let probed = 0;
  for (const child of children) {
    if (!child.isDirectory() || child.name === 'node_modules') continue;
    if (probed++ >= MAX_CHILDREN) break;
    const childDir = path.join(workspaceRoot, child.name);
    const atChild = markersAt(childDir, true);
    if (atChild.length > 0) {
      return {
        supported: true,
        markers: atChild.map(m => `${child.name}/${m}`),
        matchedAt: childDir,
        reason: `Detected a Paradox mod in a subfolder (${child.name}/): ${atChild.join(', ')}.`,
      };
    }
  }

  return {
    supported: false,
    markers: [],
    reason: `No Paradox mod markers (descriptor.mod, common/, events/, localisation/, .cwtools-ai/) at, above, or directly under '${workspaceRoot}'.`,
  };
}
