// Ecosystem-aware dependency environment attestation.
// Freeze roots before candidate execution, then re-check the SAME roots later.

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, statSync,
} from 'node:fs';
import {
  basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';

export type DependencyEnvironmentStatus = 'none' | 'attested' | 'unattestable';
export type DependencyRootKind = 'node_modules' | 'python-venv';

export interface DependencyRoot {
  kind: DependencyRootKind;
  path: string;
  realPath: string;
}

interface AbsentProbe {
  kind: 'node_modules';
  path: string;
}

export interface DependencyEnvironmentDescriptor {
  status: DependencyEnvironmentStatus;
  command: string;
  roots: DependencyRoot[];
  probes: AbsentProbe[];
  fingerprint?: string;
  reason?: string;
}

export interface DependencyEnvironmentCheck {
  ok: boolean;
  fingerprint?: string;
  reason?: string;
}

class Unattestable extends Error {}

function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

function modeKind(path: string): { kind: string; mode: number } {
  const st = lstatSync(path);
  if (st.isFile()) return { kind: 'file', mode: st.mode };
  if (st.isDirectory()) return { kind: 'dir', mode: st.mode };
  if (st.isSymbolicLink()) return { kind: 'symlink', mode: st.mode };
  return { kind: 'special', mode: st.mode };
}

function fingerprintRoot(
  root: DependencyRoot,
  cwd: string,
  h: ReturnType<typeof createHash>,
): void {
  let rootStat;
  let currentReal: string;
  try {
    rootStat = lstatSync(root.path);
    currentReal = realpathSync(root.path);
  } catch (e) {
    throw new Unattestable(
      root.kind + ' root ' + JSON.stringify(root.path) +
      ' can no longer be resolved (' + (e instanceof Error ? e.message : String(e)) + ')',
    );
  }
  if (currentReal !== root.realPath) {
    throw new Unattestable(
      root.kind + ' root moved from ' + JSON.stringify(root.realPath) +
      ' to ' + JSON.stringify(currentReal),
    );
  }
  if (!statSync(root.path).isDirectory()) {
    throw new Unattestable(root.kind + ' root ' + JSON.stringify(root.path) + ' is not a directory');
  }

  h.update('root\0' + root.kind + '\0' + root.path + '\0' + root.realPath + '\0' + String(rootStat.mode) + '\0');
  if (rootStat.isSymbolicLink()) h.update(readlinkSync(root.path) + '\0');

  const cwdReal = realpathSync(cwd);
  const visited = new Set<string>();

  const hashFile = (path: string, label: string): void => {
    let st;
    try {
      st = statSync(path);
      if (!st.isFile()) throw new Error('not a regular file');
      h.update(label + '\0external-file\0' + path + '\0' + String(st.mode) + '\0');
      h.update(readFileSync(path));
      h.update('\0');
    } catch (e) {
      throw new Unattestable(
        'dependency link target ' + JSON.stringify(path) +
        ' is not attestable (' + (e instanceof Error ? e.message : String(e)) + ')',
      );
    }
  };

  const walk = (dir: string, namespace: string): void => {
    const realDir = realpathSync(dir);
    if (visited.has(realDir)) return;
    visited.add(realDir);

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Unattestable(
        'dependency directory ' + JSON.stringify(dir) +
        ' cannot be read (' + (e instanceof Error ? e.message : String(e)) + ')',
      );
    }

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = namespace ? namespace + '/' + entry.name : entry.name;
      let ident;
      try {
        ident = modeKind(path);
      } catch (e) {
        throw new Unattestable(
          'dependency entry ' + JSON.stringify(path) +
          ' disappeared while attesting (' + (e instanceof Error ? e.message : String(e)) + ')',
        );
      }

      h.update(rel + '\0' + ident.kind + '\0' + String(ident.mode) + '\0');

      if (ident.kind === 'file') {
        try {
          h.update(readFileSync(path));
          h.update('\0');
        } catch (e) {
          throw new Unattestable(
            'dependency file ' + JSON.stringify(path) +
            ' cannot be read (' + (e instanceof Error ? e.message : String(e)) + ')',
          );
        }
        continue;
      }

      if (ident.kind === 'dir') {
        walk(path, rel);
        continue;
      }

      if (ident.kind === 'symlink') {
        let target: string;
        try {
          target = readlinkSync(path);
        } catch (e) {
          throw new Unattestable(
            'dependency symlink ' + JSON.stringify(path) +
            ' cannot be read (' + (e instanceof Error ? e.message : String(e)) + ')',
          );
        }
        h.update(target + '\0');

        let resolved: string;
        try {
          resolved = realpathSync(path);
        } catch {
          continue; // broken link: link text + mode are its complete identity
        }

        const followed = statSync(path);
        if (followed.isFile()) {
          // Normal venv shape: bin/python often points at the system interpreter.
          hashFile(resolved, '@target:' + rel);
          continue;
        }
        if (followed.isDirectory()) {
          // npm workspaces may link back into the candidate tree. External
          // package-store directories are not bounded yet and fail closed.
          if (inside(root.realPath, resolved) || inside(cwdReal, resolved)) {
            walk(resolved, '@target:' + rel);
            continue;
          }
          throw new Unattestable(
            'dependency directory symlink ' + JSON.stringify(path) +
            ' escapes the bounded root to ' + JSON.stringify(resolved),
          );
        }
        throw new Unattestable('dependency symlink ' + JSON.stringify(path) + ' resolves to a special file');
      }

      throw new Unattestable('dependency entry ' + JSON.stringify(path) + ' is a special file');
    }
  };

  walk(root.realPath, '');
}

function snapshot(roots: DependencyRoot[], probes: AbsentProbe[], cwd: string): string {
  const h = createHash('sha256');
  for (const probe of probes) {
    h.update(
      'probe\0' + probe.kind + '\0' + probe.path + '\0' +
      (existsSync(probe.path) ? 'present' : 'absent') + '\0',
    );
  }
  for (const root of roots) fingerprintRoot(root, cwd, h);
  return h.digest('hex');
}

function freezeRoot(kind: DependencyRootKind, path: string): DependencyRoot {
  try {
    if (!statSync(path).isDirectory()) {
      throw new Error('not a directory');
    }
    return { kind, path: resolve(path), realPath: realpathSync(path) };
  } catch (e) {
    throw new Unattestable(
      kind + ' root ' + JSON.stringify(path) +
      ' is not resolvable (' + (e instanceof Error ? e.message : String(e)) + ')',
    );
  }
}

function shellTokens(command: string): string[] {
  const matches = command.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) ?? [];
  return matches.map((token) => {
    if (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"'))
    ) return token.slice(1, -1);
    return token;
  });
}

function firstExecutable(command: string): string | null {
  const tokens = shellTokens(command);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] === 'env') {
    i++;
    while (
      i < tokens.length &&
      (tokens[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))
    ) i++;
  }
  if (tokens[i] === 'command') {
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) i++;
  }
  if (tokens[i] === 'timeout') {
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) i++;
    if (i < tokens.length) i++; // duration
  }
  return tokens[i] ?? null;
}

function resolveExecutable(
  token: string | null,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!token) return null;
  if (token.includes('/') || token.includes('\\')) {
    const path = isAbsolute(token) ? token : resolve(cwd, token);
    try {
      return existsSync(path) ? realpathSync(path) : null;
    } catch {
      return null;
    }
  }
  for (const entry of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = resolve(entry, token);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // try next PATH entry
    }
  }
  return null;
}

function looksPython(command: string, executable: string | null): boolean {
  const exe = executable ? basename(executable).toLowerCase() : '';
  if (/^(?:python(?:\d+(?:\.\d+)*)?|pytest|py\.test|pip(?:\d+(?:\.\d+)*)?)$/.test(exe)) return true;
  return /(?:^|[\s;&|()])(?:python(?:\d+(?:\.\d+)*)?|pytest|py\.test|pip(?:\d+(?:\.\d+)*)?)(?=$|[\s;&|()])/.test(command);
}

function inferredVenv(executable: string | null): string | null {
  if (!executable) return null;
  const parent = dirname(executable);
  const parentName = basename(parent).toLowerCase();
  if (parentName !== 'bin' && parentName !== 'scripts') return null;
  const root = dirname(parent);
  return existsSync(join(root, 'pyvenv.cfg')) ? root : null;
}

function venvProblem(root: string): string | null {
  const cfg = join(root, 'pyvenv.cfg');
  if (!existsSync(cfg)) return 'VIRTUAL_ENV ' + JSON.stringify(root) + ' has no pyvenv.cfg';
  try {
    const body = readFileSync(cfg, 'utf8');
    if (/^\s*include-system-site-packages\s*=\s*true\s*$/im.test(body)) {
      return (
        'Python environment ' + JSON.stringify(root) +
        ' enables system site-packages; those external package roots are not bounded'
      );
    }
  } catch (e) {
    return 'cannot read ' + JSON.stringify(cfg) + ' (' + (e instanceof Error ? e.message : String(e)) + ')';
  }
  return null;
}

export function discoverDependencyEnvironment(
  cwdInput: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): DependencyEnvironmentDescriptor {
  const cwd = resolve(cwdInput);
  const roots: DependencyRoot[] = [];
  const probes: AbsentProbe[] = [];
  const seen = new Set<string>();

  const addRoot = (kind: DependencyRootKind, path: string): void => {
    const root = freezeRoot(kind, path);
    const key = kind + ':' + root.path;
    if (!seen.has(key)) {
      roots.push(root);
      seen.add(key);
    }
  };

  try {
    const nodeModules = join(cwd, 'node_modules');
    if (existsSync(nodeModules)) addRoot('node_modules', nodeModules);
    else probes.push({ kind: 'node_modules', path: nodeModules });

    const token = firstExecutable(command);
    const executable = resolveExecutable(token, cwd, env);

    let venv: string | null = null;
    if (env.VIRTUAL_ENV?.trim()) {
      if (!isAbsolute(env.VIRTUAL_ENV)) {
        throw new Unattestable('VIRTUAL_ENV is relative (' + JSON.stringify(env.VIRTUAL_ENV) + ')');
      }
      venv = resolve(env.VIRTUAL_ENV);
    } else {
      venv = inferredVenv(executable);
      if (
        !venv &&
        /(?:^|\s)uv\s+run(?:\s|$)/.test(command) &&
        existsSync(join(cwd, '.venv', 'pyvenv.cfg'))
      ) {
        venv = join(cwd, '.venv');
      }
    }

    if (venv) {
      const problem = venvProblem(venv);
      if (problem) throw new Unattestable(problem);
      addRoot('python-venv', venv);
    } else if (looksPython(command, executable)) {
      throw new Unattestable(
        'Python verifier selected without an identifiable virtual environment; ' +
        'global/user site-packages are not bounded',
      );
    }

    const status: DependencyEnvironmentStatus = roots.length ? 'attested' : 'none';
    const fingerprint = snapshot(roots, probes, cwd);
    return { status, command, roots, probes, fingerprint };
  } catch (e) {
    return {
      status: 'unattestable',
      command,
      roots,
      probes,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export function checkDependencyEnvironment(
  cwdInput: string,
  descriptor: DependencyEnvironmentDescriptor,
): DependencyEnvironmentCheck {
  if (descriptor.status === 'unattestable') {
    return { ok: false, reason: descriptor.reason ?? 'dependency environment is not attestable' };
  }
  try {
    const fingerprint = snapshot(descriptor.roots, descriptor.probes, resolve(cwdInput));
    if (fingerprint !== descriptor.fingerprint) {
      return { ok: false, fingerprint, reason: 'dependency environment fingerprint changed' };
    }
    return { ok: true, fingerprint };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function dependencyEnvironmentReport(descriptor: DependencyEnvironmentDescriptor): {
  status: DependencyEnvironmentStatus;
  roots: Array<{ kind: DependencyRootKind; path: string }>;
  fingerprint?: string;
  reason?: string;
} {
  return {
    status: descriptor.status,
    roots: descriptor.roots.map((root) => ({ kind: root.kind, path: root.path })),
    ...(descriptor.fingerprint ? { fingerprint: descriptor.fingerprint } : {}),
    ...(descriptor.reason ? { reason: descriptor.reason } : {}),
  };
}

export function dependencyEnvironmentSummary(descriptor: DependencyEnvironmentDescriptor): string {
  if (descriptor.status === 'unattestable') {
    return 'unattestable - ' + (descriptor.reason ?? 'unknown dependency environment');
  }
  if (descriptor.status === 'none') return 'none detected (candidate node_modules remains absent)';
  const kinds = [...new Set(descriptor.roots.map((root) => root.kind))].join(', ');
  return (
    'attested ' + kinds + ' (sha256 ' +
    (descriptor.fingerprint?.slice(0, 12) ?? 'unknown') + '...)'
  );
}
