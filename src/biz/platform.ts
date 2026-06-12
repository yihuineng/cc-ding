import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';

const DEFAULT_WINDOWS_PATH_EXT = '.COM;.EXE;.BAT;.CMD';
const WINDOWS_SHELL_SCRIPT_EXTENSIONS = new Set([ '.cmd', '.bat' ]);

interface CommandLookupOptions {
  platform?: NodeJS.Platform;
  envPath?: string;
  pathExt?: string;
}

export function isWindowsPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return isWindowsPlatform(platform) ? ';' : ':';
}

function splitPathEnv(envPath: string | undefined, platform: NodeJS.Platform): string[] {
  return (envPath || '')
    .split(pathDelimiterForPlatform(platform))
    .map(item => item.trim())
    .filter(Boolean);
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function windowsPathExts(pathExt: string | undefined): string[] {
  return (pathExt || DEFAULT_WINDOWS_PATH_EXT)
    .split(';')
    .map(ext => ext.trim().toLowerCase())
    .filter(Boolean)
    .map(ext => {
      return ext.startsWith('.') ? ext : `.${ext}`;
    });
}

export function getExecutableCandidates(command: string, opts: CommandLookupOptions = {}): string[] {
  const platform = opts.platform || process.platform;
  if (!isWindowsPlatform(platform)) return [ command ];

  const ext = path.extname(command).toLowerCase();
  if (ext) return [ command ];

  return windowsPathExts(opts.pathExt || process.env.PATHEXT).map(extName => `${command}${extName}`);
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (isWindowsPlatform(platform)) return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(command: string, opts: CommandLookupOptions = {}): string | null {
  const platform = opts.platform || process.platform;
  const candidates = getExecutableCandidates(command, opts);

  if (path.isAbsolute(command) || hasPathSeparator(command)) {
    for (const candidate of candidates) {
      if (isExecutableFile(candidate, platform)) return candidate;
    }
    return null;
  }

  for (const dir of splitPathEnv(opts.envPath || process.env.PATH, platform)) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (isExecutableFile(fullPath, platform)) return fullPath;
    }
  }
  return null;
}

export function commandExists(command: string): boolean {
  return resolveExecutable(command) !== null;
}

export function quoteWindowsCommandArg(arg: string): string {
  if (arg === '') return '""';

  const needsQuote = /[\s"&|<>^()%!]/.test(arg);
  let result = '';
  let backslashes = 0;
  for (const char of arg.replace(/%/g, '%%')) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes);
    backslashes = 0;
    result += char;
  }
  result += '\\'.repeat(needsQuote ? backslashes * 2 : backslashes);

  return needsQuote ? `"${result}"` : result;
}

export function buildWindowsCommandLineForCmd(command: string, args: string[]): string {
  return [ command, ...args ].map(quoteWindowsCommandArg).join(' ');
}

function isWindowsShellScript(command: string): boolean {
  return WINDOWS_SHELL_SCRIPT_EXTENSIONS.has(path.extname(command).toLowerCase());
}

export function spawnCommand(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  const resolved = resolveExecutable(command) || command;
  if (isWindowsPlatform() && isWindowsShellScript(resolved)) {
    return spawn('cmd.exe', [ '/d', '/s', '/c', buildWindowsCommandLineForCmd(resolved, args) ], options);
  }
  return spawn(resolved, args, options);
}
