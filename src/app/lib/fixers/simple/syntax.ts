// Simple / Syntax & Typo Errors
// Covers: YAML indentation (tabs + inconsistent depth), missing/typo triggers (30+ patterns),
// shell command typos (60+ patterns across npm/yarn/pnpm/pip/python/git/docker/kubectl/
// terraform/helm/cargo/go/make/ansible/aws/gradle/composer/jest/vitest),
// Windows↔Linux cross-platform commands + PowerShell, bash-only syntax in POSIX sh,
// incorrect file paths (5-strategy: exact, case-insensitive, extension-variant, prefix, build-dir),
// missing colons (proactive + log-triggered), invalid JSON (trailing commas, unquoted keys,
// single-quote strings, Python literals, undefined → null, missing commas),
// incorrect variable names (38+ patterns), YAML expression delimiters, boolean/number
// quoting in env blocks, cron syntax, multiline run scripts, GitLab rules migration.

import { RuleFix, isGitHubWorkflow, isGitLabCI, isYAML, insertStepBefore } from '../helpers';

// ── YAML Indentation ──────────────────────────────────────────────────────────

/** Replace leading tab characters with 2-space indentation in workflow YAML. */
export function fixYamlTabIndentation(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isYAML(f.path)) continue;
    if (!/^\t/m.test(f.content)) continue;
    const fixed = f.content.split('\n').map(line => {
      const m = line.match(/^(\t+)(.*)/);
      return m ? '  '.repeat(m[1].length) + m[2] : line;
    }).join('\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Replaced tab indentation with 2-space — YAML requires spaces, tabs cause parse errors in all YAML parsers', confidence: 100 });
  }
  return fixes;
}

/** Normalise inconsistent indentation depth to 2-space in GitHub Actions workflows.
 *  Detects when the dominant indent unit is 4-space and halves every level. */
export function fixYamlIndentationDepth(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const indentedLines = f.content.split('\n').filter(l => /^ {4}/.test(l));
    if (indentedLines.length < 5) continue;
    const use4 = indentedLines.filter(l => /^ {4}[^ ]/.test(l) || /^ {8}[^ ]/.test(l)).length;
    const use2 = indentedLines.filter(l => /^ {2}[^ ]/.test(l) || /^ {6}[^ ]/.test(l)).length;
    if (use2 >= use4) continue; // already 2-space dominant
    // Halve every run of leading spaces (4→2, 8→4, etc.)
    const fixed = f.content.split('\n').map(line => {
      const m = line.match(/^( +)(.*)/);
      if (!m) return line;
      const spaces = m[1].length;
      return ' '.repeat(Math.round(spaces / 2)) + m[2];
    }).join('\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Normalised indentation from 4-space to 2-space — GitHub Actions convention is 2-space; inconsistent depth can confuse some parsers', confidence: 90 });
  }
  return fixes;
}

// ── Workflow Triggers ─────────────────────────────────────────────────────────

/** Add a minimal `on:` trigger when a GitHub Actions workflow has no event defined. */
export function fixMissingWorkflowTrigger(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (/^on:/m.test(f.content) || !/^jobs:/m.test(f.content)) continue;
    const fixed = f.content.replace(
      /^(name:[^\n]*\n)/m,
      `$1\non:\n  push:\n    branches: [main, master, develop]\n  pull_request:\n    branches: [main, master, develop]\n  workflow_dispatch:\n\n`,
    );
    fixes.push({ path: f.path, content: fixed, explanation: 'Added missing on: trigger block — workflow had no event trigger; added push, pull_request, and workflow_dispatch so it runs on PRs and manual dispatch', confidence: 100 });
  }
  return fixes;
}

/** Fix common typos in GitHub Actions workflow trigger event names (30+ patterns). */
export function fixWorkflowTriggerTypo(files: Array<{ path: string; content: string }>): RuleFix[] {
  const TYPOS: Record<string, string> = {
    // push variants
    'puch': 'push', 'pushs': 'push', 'pus': 'push', 'psh': 'push', 'pusH': 'push', 'puhs': 'push',
    // pull_request variants
    'pull-request': 'pull_request', 'pullrequest': 'pull_request', 'pull_requests': 'pull_request',
    'pull-requests': 'pull_request', 'pullRequest': 'pull_request', 'PullRequest': 'pull_request',
    'pull_req': 'pull_request',
    // workflow_dispatch variants
    'workfow_dispatch': 'workflow_dispatch', 'workflow-dispatch': 'workflow_dispatch',
    'workflow_dispatche': 'workflow_dispatch', 'workflow_dispach': 'workflow_dispatch',
    'worklfow_dispatch': 'workflow_dispatch', 'workflow_dispacth': 'workflow_dispatch',
    // workflow_call variants
    'workflow-call': 'workflow_call', 'workfow-call': 'workflow_call',
    // schedule variants
    'scheule': 'schedule', 'scedule': 'schedule', 'scheduel': 'schedule',
    'cron-schedule': 'schedule', 'schedule-event': 'schedule',
    // release variants
    'release-event': 'release', 'releases': 'release', 'relase': 'release',
    // issues
    'issues-event': 'issues', 'issue': 'issues',
    // other common events
    'create-event': 'create', 'delete-event': 'delete',
    'page_build': 'page_build',  // correct, keep
    'page-build': 'page_build',
    'registry-package': 'registry_package', 'registry_packages': 'registry_package',
    'fork-event': 'fork', 'watch-event': 'watch',
    'check-run': 'check_run', 'check-suite': 'check_suite',
    'deployment-event': 'deployment', 'deployment-status': 'deployment_status',
    'merge-group': 'merge_group',
  };
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    let content = f.content;
    let changed = false;
    for (const [typo, correct] of Object.entries(TYPOS)) {
      const re = new RegExp(`^(on:\\s*\\n\\s+)(${typo}):`, 'm');
      if (re.test(content)) { content = content.replace(re, `$1${correct}:`); changed = true; }
    }
    if (changed)
      fixes.push({ path: f.path, content, explanation: 'Fixed typo in workflow trigger event name — wrong event name means workflow never runs', confidence: 100 });
  }
  return fixes;
}

// ── Shell & Script Fixers ─────────────────────────────────────────────────────

/** Add sudo + -y flag to apt-get/yum/dnf/apk commands on GitHub-hosted runners. */
export function fixAptGetSudo(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.match(/\b(apt-get|apt|yum|dnf|apk)\b/)) continue;
    let content = f.content;
    // apt-get — add sudo + -y + update prefix
    content = content.replace(/(\n\s+run:\s*)(apt-get\s+install\b(?!\s+-y))/g, '$1sudo apt-get update && sudo apt-get install -y');
    content = content.replace(/(\n\s+run:\s*)(apt-get\s+install\s+-y\b)/g, '$1sudo apt-get update && sudo apt-get install -y');
    content = content.replace(/(\n\s+run:\s*)(apt-get\s+(?!install|update|upgrade))/g, '$1sudo apt-get $2');
    content = content.replace(/(\n\s+run:\s*)(apt\s+install\b(?!\s+-y))/g, '$1sudo apt-get update && sudo apt-get install -y');
    // yum/dnf — add sudo + -y
    content = content.replace(/(\n\s+run:\s*)(yum\s+install\b(?!\s+-y))/g, '$1sudo yum install -y');
    content = content.replace(/(\n\s+run:\s*)(dnf\s+install\b(?!\s+-y))/g, '$1sudo dnf install -y');
    // apk — add sudo on non-alpine runners; apk doesn't need sudo on Alpine but -q helps
    content = content.replace(/(\n\s+run:\s*)(apk\s+add\b(?!\s+--no-cache|\s+-q))/g, '$1apk add --no-cache');
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Added sudo + -y + apt-get update — GitHub hosted runners are non-root; apt-get update ensures package lists are fresh before install', confidence: 100 });
  }
  return fixes;
}

/** Add #!/bin/bash + set -euo pipefail to shell scripts and inline run scripts missing it. */
export function fixMissingShebang(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    // .sh files
    if (f.path.endsWith('.sh') && !f.content.startsWith('#!')) {
      fixes.push({
        path: f.path,
        content: `#!/bin/bash\nset -euo pipefail\nIFS=$'\\n\\t'\n\n${f.content}`,
        explanation: `Added #!/bin/bash + set -euo pipefail + IFS — pipefail exits on pipe failure, nounset catches unbound variables, IFS prevents word-splitting bugs`,
        confidence: 100,
      });
    }
    // .py files missing shebang
    if (f.path.endsWith('.py') && !f.content.startsWith('#!') && f.content.includes('if __name__')) {
      fixes.push({
        path: f.path,
        content: `#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n\n${f.content}`,
        explanation: `Added #!/usr/bin/env python3 shebang — script is executable but missing interpreter declaration`,
        confidence: 100,
      });
    }
  }
  return fixes;
}

/** Remove the conflicting run: key when a step has both uses: and run: (invalid combination). */
export function fixStepUsesAndRun(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('uses:') || !f.content.includes('run:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    let skipNext = false;
    for (let i = 0; i < lines.length; i++) {
      if (skipNext) {
        out.push(`        # aegis-removed (conflict with uses:): ${lines[i]}`);
        while (i + 1 < lines.length && /^\s{10,}/.test(lines[i + 1])) {
          i++;
          out.push(`        # aegis-removed: ${lines[i]}`);
        }
        skipNext = false;
        modified = true;
        continue;
      }
      if (/^\s+uses:\s+\S/.test(lines[i]) && i + 1 < lines.length && /^\s+run:/.test(lines[i + 1])) {
        skipNext = true;
      }
      out.push(lines[i]);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Removed conflicting run: from steps that also have uses: — a step cannot have both; the run: block is commented out and must be moved to a separate step', confidence: 100 });
  }
  return fixes;
}

/** Remove duplicate top-level YAML keys — keeps first occurrence, comments out duplicates. */
export function fixDuplicateYamlKey(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isYAML(f.path)) continue;
    const lines = f.content.split('\n');
    const seenKeys = new Set<string>();
    const out: string[] = [];
    let modified = false;
    let skipBlock = false;
    let skipIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Exit skip when we return to same or lower indent
      if (skipBlock) {
        const indent = line.match(/^( *)/)?.[1].length ?? 0;
        if (line.trim() && indent <= skipIndent) skipBlock = false;
        if (skipBlock) { out.push(`# aegis-fix: duplicate removed: ${line}`); modified = true; continue; }
      }
      const m = line.match(/^([\w-]+):/);
      if (m) {
        if (seenKeys.has(m[1])) {
          out.push(`# aegis-fix: duplicate key removed: ${line}`);
          modified = true;
          skipBlock = true;
          skipIndent = 0;
          continue;
        }
        seenKeys.add(m[1]);
      }
      out.push(line);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Removed duplicate top-level YAML keys — YAML parsers raise errors or silently drop duplicate keys; the second occurrence was commented out', confidence: 100 });
  }
  return fixes;
}

/** Add chmod +x before a script referenced in the workflow when permission denied. */
export function fixChmodScript(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/permission denied/i.test(logs)) return [];
  // Extract ALL scripts mentioned — sometimes multiple scripts are denied
  const scripts = [...logs.matchAll(/permission denied[^:]*?[:\s]+([\w/.\-]+\.sh)/gi)].map(m => m[1]);
  if (scripts.length === 0) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isYAML(f.path)) continue;
    let content = f.content;
    let changed = false;
    for (const script of scripts) {
      if (!content.includes(script)) continue;
      const fixed = content.replace(
        new RegExp(`(\\s+run:\\s*)(${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'g'),
        `$1chmod +x ${script} && ${script}`,
      );
      if (fixed !== content) { content = fixed; changed = true; }
    }
    if (changed)
      fixes.push({ path: f.path, content, explanation: `Added chmod +x for permission-denied scripts — Git does not preserve execute bits on Windows checkouts; scripts need +x before they can run`, confidence: 100 });
  }
  // Also fix the script files themselves if they lack shebangs
  for (const script of scripts) {
    const scriptFile = files.find(f => f.path === script || f.path.endsWith(`/${script}`));
    if (scriptFile && !scriptFile.content.startsWith('#!')) {
      fixes.push({
        path: scriptFile.path,
        content: `#!/bin/bash\nset -euo pipefail\n\n${scriptFile.content}`,
        explanation: `Added shebang to ${scriptFile.path} — file lacked interpreter declaration; permission denied is worse without it`,
        confidence: 100,
      });
    }
  }
  return fixes;
}

/** Add fetch-depth: 0 to checkout when shallow clone causes tag/history failures. */
export function fixShallowCloneFetchDepth(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/shallow.*update.*not.*allowed|fatal.*shallow file|git describe.*fatal|tag.*not.*found|no tags/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('fetch-depth:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/uses:\s*actions\/checkout/.test(lines[i])) {
        if (i + 1 < lines.length && lines[i + 1].trim() === 'with:') {
          out.push(lines[++i]);
          out.push('          fetch-depth: 0');
        } else {
          out.push('        with:');
          out.push('          fetch-depth: 0');
        }
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added fetch-depth: 0 to actions/checkout — shallow clone (default depth=1) omits git tags and full history; semantic versioning, git describe, and changelog tools require full history', confidence: 100 });
  }
  return fixes;
}

// ── Cross-Platform Shell Commands ─────────────────────────────────────────────

/** Fix Windows-only shell commands used on Linux CI runners (20+ command mappings + PowerShell). */
export function fixWindowsCommandsOnLinux(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/command not found|No such file or directory|not recognized as an internal or external command/i.test(logs)) return [];
  const WIN_TO_LINUX: Array<[RegExp, string]> = [
    // File/directory operations
    [/\bdel\s+\/[fqs]+\s+/gi,        'rm -rf '],
    [/\bdel\s+/gi,                   'rm -f '],
    [/\brd\s+\/s\s+\/q\s+/gi,        'rm -rf '],
    [/\brmdir\s+\/s\s+\/q\s+/gi,     'rm -rf '],
    [/\bcopy\s+(\S+)\s+(\S+)/gi,     'cp $1 $2'],
    [/\bxcopy\s+(\S+)\s+(\S+)\s+\/[eisy]+/gi, 'cp -r $1 $2'],
    [/\bmove\s+(\S+)\s+(\S+)/gi,     'mv $1 $2'],
    [/\bren\s+(\S+)\s+(\S+)/gi,      'mv $1 $2'],
    [/\bmd\s+/gi,                    'mkdir -p '],
    [/\bmkdir\s(?!-)/g,              'mkdir -p '],
    [/\bmklink\s+\/[dh]?\s+(\S+)\s+(\S+)/gi, 'ln -s $2 $1'],
    // Text / search
    [/\bdir\s*/gi,                   'ls -la '],
    [/\bfindstr\s+\/[a-z]+\s+/gi,    'grep -E '],
    [/\bfindstr\s+/gi,               'grep '],
    [/\btype\s+(\S+)/gi,             'cat $1'],
    [/\bmore\s+(\S+)/gi,             'less $1'],
    [/\bfind\s+(\S+)\s+\/name\s+/gi, 'find $1 -name '],
    // Process management
    [/\btasklist\b/gi,               'ps aux'],
    [/\btaskkill\s+\/[fp]+\s+/gi,    'kill -9 '],
    [/\btaskkill\b/gi,               'pkill '],
    // Environment / variables
    [/\bset\s+([A-Z_]+=)/gi,         'export $1'],
    [/\becho\s+%([^%]+)%/gi,         'echo $$1'],
    [/\bsetx\s+(\w+)\s+/gi,          'export $1='],
    // Network
    [/\bipconfig\b/gi,               'ip addr show'],
    [/\bnetstat\s+/gi,               'ss '],
    [/\bnslookup\s+/gi,              'dig '],
    [/\bping\s+(\S+)\s+-n\s+(\d+)/gi, 'ping -c $2 $1'],
    // System info
    [/\bwhere\s+/gi,                 'which '],
    [/\battrib\s+/gi,                'chmod '],
    [/\bicacls\s+/gi,               'chmod '],
    [/\bnet\s+user\s+/gi,            'id '],
    [/\bwhoami\s*$/gi,               'whoami'],
    // Execution
    [/\bcmd\s+\/c\s+/gi,             ''],
    [/\bcmd\s+\/k\s+/gi,             ''],
    [/\bstart\s+\/wait\s+/gi,        ''],
    [/\bpowershell\s+-command\s+/gi, 'bash -c '],
    [/\bpowershell\s+-c\s+/gi,       'bash -c '],
    // PowerShell cmdlets that slip in
    [/\bGet-Content\s+/g,            'cat '],
    [/\bWrite-Host\s+/g,             'echo '],
    [/\bWrite-Output\s+/g,           'echo '],
    [/\bRemove-Item\s+-Recurse\s+-Force\s+/g, 'rm -rf '],
    [/\bRemove-Item\s+/g,            'rm -f '],
    [/\bCopy-Item\s+-Recurse\s+/g,   'cp -r '],
    [/\bCopy-Item\s+/g,              'cp '],
    [/\bMove-Item\s+/g,              'mv '],
    [/\bNew-Item\s+-ItemType\s+Directory\s+-Force\s+/g, 'mkdir -p '],
    [/\bNew-Item\s+-ItemType\s+File\s+/g, 'touch '],
    [/\bTest-Path\s+/g,              'test -e '],
    [/\bSelect-String\s+/g,          'grep '],
    [/\bInvoke-WebRequest\s+/g,      'curl -L '],
    [/\bInvoke-RestMethod\s+/g,      'curl -s '],
    [/\bConvertTo-Json\b/g,          '| python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)))"'],
    [/\bConvertFrom-Json\b/g,        '| python3 -m json.tool'],
  ];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isYAML(f.path)) continue;
    if (f.content.includes('windows-latest') || f.content.includes('windows-2022') || f.content.includes('windows-2019')) continue;
    let content = f.content;
    for (const [pattern, replacement] of WIN_TO_LINUX) content = content.replace(pattern, replacement);
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Replaced Windows/PowerShell shell commands with Linux equivalents — CI runs on ubuntu-latest; Windows commands (del, rd, xcopy, where, Get-Content, etc.) are not available on Linux runners', confidence: 100 });
  }
  return fixes;
}

/** Add `defaults: run: shell: bash` when Linux shell commands are used on Windows runners. */
export function fixLinuxCommandsOnWindows(files: Array<{ path: string; content: string }>): RuleFix[] {
  const LINUX_ONLY_PATTERNS = [
    /\n\s+run:.*\bchmod\s+/,
    /\n\s+run:.*\bchown\s+/,
    /\n\s+run:.*\bsudo\s+/,
    /\n\s+run:.*\bgrep\s+/,
    /\n\s+run:.*\bsed\s+-[eni]/,
    /\n\s+run:.*\bawk\s+/,
    /\n\s+run:.*\bexport\s+\w+=/,
    /\n\s+run:.*set\s+-[eo]/,
    /\n\s+run:.*\bsource\s+/,
    /\n\s+run:.*\bwget\s+/,
    /\n\s+run:.*\|\s*bash/,
    /\n\s+run:.*\btar\s+-/,
    /\n\s+run:.*\bwhich\s+\w/,
    /\n\s+run:.*\bps\s+aux/,
    /\n\s+run:.*\bkill\s+\-/,
    /\n\s+run:.*\bln\s+-s/,
    /\n\s+run:.*\bls\s+-[la]/,
    /\n\s+run:.*\bcat\s+\//,
    /\n\s+run:.*\becho\s+\$[A-Z_]+/,
  ];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('windows-latest') && !f.content.includes('windows-2022') && !f.content.includes('windows-2019')) continue;
    if (f.content.includes('shell: bash') || f.content.includes("shell: 'bash'") || f.content.includes('defaults:')) continue;
    const hasLinuxCmds = LINUX_ONLY_PATTERNS.some(re => re.test(f.content));
    if (!hasLinuxCmds) continue;
    const fixed = f.content.replace(/^(jobs:)/m, `defaults:\n  run:\n    shell: bash\n\n$1`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: "Added 'defaults: run: shell: bash' — workflow runs on Windows but uses Linux shell commands (chmod, grep, export, sed, etc.); setting default shell to bash (via Git for Windows) makes these commands available without changing individual steps", confidence: 100 });
  }
  return fixes;
}

/** Fix bash-only syntax in steps that explicitly declare `shell: sh` (POSIX sh). */
export function fixBashSyntaxInPosixSh(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (!f.content.includes('shell: sh') && !f.content.includes("shell: '/bin/sh'") && !f.content.includes('shell: /bin/sh')) continue;
    let content = f.content;
    let changed = false;
    // [[ ... ]] → [ ... ] (bash double-bracket is not POSIX)
    const r1 = content.replace(/\[\[\s*(.+?)\s*\]\]/g, '[ $1 ]');
    if (r1 !== content) { content = r1; changed = true; }
    // local varname=value → varname=value (local keyword not in POSIX sh)
    const r2 = content.replace(/\blocal\s+(\w+)=/g, '$1=');
    if (r2 !== content) { content = r2; changed = true; }
    // source file → . file (source is bash-only; . is POSIX)
    const r3 = content.replace(/\bsource\s+(\S+)/g, '. $1');
    if (r3 !== content) { content = r3; changed = true; }
    // == in [ ] → = (POSIX uses = for string comparison)
    const r4 = content.replace(/\[\s+([^]]+?)\s*==\s*([^]]+?)\s*\]/g, '[ $1 = $2 ]');
    if (r4 !== content) { content = r4; changed = true; }
    // echo -e → printf (echo -e behavior is unspecified in POSIX sh)
    const r5 = content.replace(/\becho\s+-e\s+"([^"]+)"/g, 'printf "%b\\n" "$1"');
    const r6 = r5.replace(/\becho\s+-e\s+'([^']+)'/g, "printf '%b\\n' '$1'");
    if (r6 !== content) { content = r6; changed = true; }
    // declare -a → remove declare (arrays not in POSIX sh)
    const r7 = content.replace(/\bdeclare\s+-[aAilrtu]+\s+/g, '');
    if (r7 !== content) { content = r7; changed = true; }
    if (changed)
      fixes.push({ path: f.path, content, explanation: "Fixed bash-only syntax in POSIX sh steps — shell: sh uses /bin/sh which does not support [[ ]], local, source, declare, == in [ ], or echo -e; converted to POSIX-compatible equivalents", confidence: 100 });
  }
  return fixes;
}

// ── File Path Resolution ──────────────────────────────────────────────────────

/** Fix incorrect file paths using 5 resolution strategies: exact, case-insensitive,
 *  extension-variant, prefix-correction, and build-output-dir substitution. */
export function fixIncorrectFilePath(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/ENOENT|No such file or directory|cannot find.*file|not found.*path|Could not find.*file|Failed to find/i.test(logs)) return [];
  const pathMatch = logs.match(
    /(?:ENOENT|No such file|Cannot find|Could not find|Failed to find)[^\n]*?['"`]?(\.{0,2}\/?[\w/.\-]+\.\w{1,6})['"`]?/i,
  );
  if (!pathMatch) return [];
  const badPath = pathMatch[1];
  const fixes: RuleFix[] = [];

  for (const f of files) {
    if (!isYAML(f.path) || !f.content.includes(badPath)) continue;
    const name      = badPath.split('/').pop() ?? '';
    const nameNoExt = name.replace(/\.\w+$/, '');
    const ext       = name.match(/\.(\w+)$/)?.[1] ?? '';

    let candidate: { path: string; content: string } | undefined;

    // Strategy 1: exact filename match at a different location
    candidate = files.find(fi => fi.path.endsWith(`/${name}`) && fi.path !== f.path);

    // Strategy 2: case-insensitive filename match
    if (!candidate)
      candidate = files.find(fi => fi.path.toLowerCase().endsWith(`/${name.toLowerCase()}`) && fi.path !== f.path);

    // Strategy 3: extension variant (.yaml↔.yml, .js↔.ts, .jsx↔.tsx, .py↔.python)
    if (!candidate) {
      const EXT_ALTS: Record<string, string[]> = {
        yaml: ['yml'], yml: ['yaml'],
        js: ['ts', 'mjs', 'cjs'], ts: ['js', 'mjs'], mjs: ['js', 'ts'],
        jsx: ['tsx'], tsx: ['jsx'],
        json: ['jsonc', 'json5'],
      };
      for (const altExt of (EXT_ALTS[ext] ?? [])) {
        candidate = files.find(fi => fi.path.endsWith(`${nameNoExt}.${altExt}`) && fi.path !== f.path);
        if (candidate) break;
      }
    }

    // Strategy 4: strip or add leading './' prefix
    if (!candidate) {
      const withDot    = badPath.startsWith('./') ? badPath : `./${badPath}`;
      const withoutDot = badPath.startsWith('./') ? badPath.slice(2) : badPath;
      candidate = files.find(fi => fi.path === withDot || fi.path === withoutDot);
    }

    // Strategy 5: common build output directory confusion
    if (!candidate) {
      const DIR_SUBS: Array<[RegExp, string]> = [
        [/\bdist\//g, 'build/'], [/\bbuild\//g, 'dist/'],
        [/\bout\//g, 'dist/'],   [/\bdist\//g, 'out/'],
        [/^src\//,  './src/'],   [/^\.\/src\//, 'src/'],
        [/^lib\//,  './lib/'],   [/^\.\/lib\//, 'lib/'],
      ];
      for (const [from, to] of DIR_SUBS) {
        const alt = badPath.replace(from, to);
        candidate = files.find(fi => fi.path === alt);
        if (candidate) break;
      }
    }

    if (!candidate) continue;
    const escaped = badPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fixed = f.content.replace(new RegExp(escaped, 'g'), candidate.path);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Corrected path "${badPath}" → "${candidate.path}" — ENOENT: tried exact, case-insensitive, extension-variant (.yaml↔.yml, .js↔.ts), prefix (./), and build-output-dir (dist/↔build/) strategies`, confidence: 100 });
  }
  return fixes;
}

// ── YAML Syntax Fixes ─────────────────────────────────────────────────────────

/** Fix missing colons in YAML mappings — proactive scan + log-triggered. */
export function fixMissingYamlColon(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  const isLogTriggered = /mapping values are not allowed|could not find expected|did not find expected.*colon|YAML.*parse.*error|yaml: line \d+/i.test(logs);
  // Known GitHub Actions YAML keys that must be followed by a colon
  const KNOWN_KEYS = new Set([
    'name','uses','run','with','env','if','needs','runs-on','steps','jobs','on','outputs',
    'inputs','secrets','permissions','concurrency','defaults','services','container',
    'timeout-minutes','continue-on-error','strategy','matrix','include','exclude',
    'fail-fast','working-directory','shell','id','ref','token','fetch-depth','path',
    'repository','image','ports','options','health','volumes','credentials','username',
    'password','source','target','key','restore-keys','upload-url','asset-path',
    'tag-name','release-name','body','draft','prerelease','files','retention-days',
    'node-version','python-version','go-version','java-version','cache',
    'cache-dependency-path','registry-url','scope','always-auth','check-latest',
  ]);
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isYAML(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (const line of lines) {
      // Pattern: indented word followed by 2+ spaces then a value, no colon, not a list/comment/block
      const m = line.match(/^(\s{2,})([a-z][a-z0-9_-]{1,40})\s{2,}([^\s#:{\[|>][^\n]*)$/i);
      if (m && !line.includes(':') && !line.trim().startsWith('-') && !line.trim().startsWith('#')) {
        const key = m[2].toLowerCase();
        if (isLogTriggered || KNOWN_KEYS.has(key)) {
          out.push(`${m[1]}${m[2]}: ${m[3]}`);
          modified = true;
          continue;
        }
      }
      out.push(line);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Fixed YAML mapping lines missing colon separator — "key value" must be "key: value"; triggers on known GitHub Actions keys proactively and on all YAML keys when a parse error appears in logs', confidence: 100 });
  }
  return fixes;
}

/** Quote unquoted YAML boolean/numeric values in env: blocks.
 *  YAML 1.1 parses on/off/yes/no/true/false as booleans and bare numbers as integers;
 *  environment variable values must always be strings. */
export function fixIncorrectYamlBooleans(files: Array<{ path: string; content: string }>): RuleFix[] {
  const YAML11_BOOL = /^(true|false|yes|no|on|off|True|False|Yes|No|On|Off|TRUE|FALSE|YES|NO|ON|OFF)$/;
  const BARE_NUMBER = /^\d+$|^\d+\.\d+$/;
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    let inEnvBlock = false;
    let envBaseIndent = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Enter env: block
      if (/^\s*env:\s*$/.test(line)) {
        inEnvBlock = true;
        envBaseIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
        out.push(line);
        continue;
      }
      // Exit env: block when indent returns to same or less
      if (inEnvBlock) {
        const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (line.trim() && indent <= envBaseIndent) inEnvBlock = false;
      }
      if (inEnvBlock) {
        // "  KEY: value" where value is unquoted bool or number
        const m = line.match(/^(\s+)([\w_]+):\s+([^\s'"`${\[][^\n]*)(\s*#.*)?$/);
        if (m) {
          const [, indent, key, val, comment = ''] = m;
          if (YAML11_BOOL.test(val.trim()) || BARE_NUMBER.test(val.trim())) {
            out.push(`${indent}${key}: '${val.trim()}'${comment}`);
            modified = true;
            continue;
          }
        }
      }
      out.push(line);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: "Quoted boolean/numeric env var values — YAML 1.1 parses true/false/yes/no/on/off as booleans and bare integers/floats as numbers; env vars must be strings so they need single-quote wrapping", confidence: 100 });
  }
  return fixes;
}

/** Fix incorrect GitHub Actions expression delimiters.
 *  $[[ ]], {{ }} (missing $), and shell-style ${ } are all silently wrong. */
export function fixIncorrectExpressionDelimiter(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    let content = f.content;
    let changed = false;
    // $[[ expression ]] → ${{ expression }}
    const r1 = content.replace(/\$\[\[\s*([\w.\s'"()\-_|&!,]+?)\s*\]\]/g, '${{ $1 }}');
    if (r1 !== content) { content = r1; changed = true; }
    // {{ context.property }} missing $ → ${{ context.property }}
    const r2 = content.replace(
      /(?<!\$)\{\{\s*((github|runner|matrix|env|secrets|steps|needs|inputs|jobs)\.[^}]{1,80})\s*\}\}/g,
      '${{ $1 }}',
    );
    if (r2 !== content) { content = r2; changed = true; }
    // Shell-style ${github.sha} → ${{ github.sha }}
    const r3 = content.replace(
      /\$\{((?:github|runner|matrix|env|secrets|steps|needs|inputs|jobs)\.[^}]{1,80})\}/g,
      '${{ $1 }}',
    );
    if (r3 !== content) { content = r3; changed = true; }
    // ${{expression}} with no spaces → ${{ expression }} (style normalisation)
    const r4 = content.replace(/\$\{\{([^\s}][^}]{0,80}[^\s{])\}\}/g, '${{ $1 }}');
    if (r4 !== content) { content = r4; changed = true; }
    if (changed)
      fixes.push({ path: f.path, content, explanation: 'Fixed expression delimiters — GitHub Actions requires ${{ }} syntax; $[[ ]], {{ }} (missing $), and ${ } (shell-style) are incorrect and silently produce empty strings or literal text', confidence: 100 });
  }
  return fixes;
}

// ── JSON Syntax ───────────────────────────────────────────────────────────────

/** Auto-fix invalid JSON: trailing commas, unquoted keys, single-quote strings,
 *  JS comments, Python literals (None/True/False), undefined, missing commas. */
export function fixInvalidJsonSyntax(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/JSON.*parse.*error|SyntaxError.*JSON|Unexpected token.*JSON|Invalid JSON|is not valid JSON|JSON at position/i.test(logs)) return [];
  const fileMatch = logs.match(/(?:in|parsing|reading|file)\s+['"`]?([\w./\\-]+\.json)['"`]?/i);
  const targetName = fileMatch?.[1];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!f.path.endsWith('.json')) continue;
    if (targetName && !f.path.endsWith(targetName)) continue;
    try { JSON.parse(f.content); continue; } catch { /* needs fixing */ }
    let fixed = f.content;
    // 1. Strip single-line JS comments
    fixed = fixed.replace(/\/\/[^\n"]*/g, '');
    // 2. Strip block comments
    fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');
    // 3. Remove trailing commas before } or ]
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
    // 4. Normalise unquoted object keys → "key"
    fixed = fixed.replace(/([{,]\s*)([a-zA-Z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
    // 5. Single-quoted string values → double-quoted
    fixed = fixed.replace(/:\s*'([^']*)'/g, ': "$1"');
    fixed = fixed.replace(/\[\s*'([^']*)'/g, '["$1"');
    fixed = fixed.replace(/,\s*'([^']*)'/g, ', "$1"');
    // 6. Python/Ruby literals → JSON
    fixed = fixed.replace(/\bNone\b/g, 'null');
    fixed = fixed.replace(/\bTrue\b/g, 'true');
    fixed = fixed.replace(/\bFalse\b/g, 'false');
    fixed = fixed.replace(/\bundefined\b/g, 'null');
    // 7. Remove duplicate commas
    fixed = fixed.replace(/,(\s*,)+/g, ',');
    // 8. Add missing comma between adjacent string/object/array values (heuristic)
    fixed = fixed.replace(/(["}\]])\s*\n(\s*["{\[])/g, '$1,\n$2');
    // 9. Remove trailing comma at end of file before final }
    fixed = fixed.replace(/,(\s*)$/, '$1');
    try {
      JSON.parse(fixed);
      fixes.push({ path: f.path, content: fixed, explanation: `Fixed JSON syntax in ${f.path} — applied: trailing comma removal, unquoted key normalisation, single-quote strings, Python literals (None/True/False→null/true/false), undefined→null, missing comma inference`, confidence: 100 });
    } catch { /* unrepairable — leave for AI */ }
  }
  return fixes;
}

// ── Command & Variable Name Typos ─────────────────────────────────────────────

/** Fix 60+ common command typos in workflow run: steps across all major CI tools. */
export function fixScriptTypo(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/command not found|not recognized|No such file|bad command|cannot execute|is not a recognized/i.test(logs)) return [];
  const TYPOS: Array<[RegExp, string]> = [
    // ── npm ──
    [/\bnpm\s+instal\b/g,           'npm install'],
    [/\bnpm\s+instlal\b/g,          'npm install'],
    [/\bnpm\s+isntall\b/g,          'npm install'],
    [/\bnpm\s+intall\b/g,           'npm install'],
    [/\bnpm\s+intasll\b/g,          'npm install'],
    [/\bnpm\s+buid\b/g,             'npm run build'],
    [/\bnpm\s+buiild\b/g,           'npm run build'],
    [/\bnpm\s+biuld\b/g,            'npm run build'],
    [/\bnpm\s+tets\b/g,             'npm test'],
    [/\bnpm\s+tesst\b/g,            'npm test'],
    [/\bnpm\s+tset\b/g,             'npm test'],
    [/\bnpm\s+runn\b/g,             'npm run'],
    [/\bnpm\s+rnu\b/g,              'npm run'],
    [/\bnpm\s+startt\b/g,           'npm start'],
    [/\bnpm\s+strat\b/g,            'npm start'],
    [/\bnpm\s+publsh\b/g,           'npm publish'],
    [/\bnpm\s+pubish\b/g,           'npm publish'],
    [/\bnpm\s+publihs\b/g,          'npm publish'],
    [/\bnpm\s+outdatd\b/g,          'npm outdated'],
    [/\bnpm\s+auidt\b/g,            'npm audit'],
    [/\bnpm\s+audiit\b/g,           'npm audit'],
    [/\bnpm\s+ci\b/g,               'npm ci'],  // correct — keep (just confirm it's right)
    // ── yarn ──
    [/\byran\b/g,                   'yarn'],
    [/\byarnn\b/g,                  'yarn'],
    [/\byar\s+add\b/g,              'yarn add'],
    [/\byarn\s+ad\b/g,              'yarn add'],
    [/\byarn\s+instal\b/g,          'yarn install'],
    [/\byarn\s+buidl\b/g,           'yarn build'],
    [/\byarn\s+biuld\b/g,           'yarn build'],
    [/\byarn\s+tset\b/g,            'yarn test'],
    // ── pnpm ──
    [/\bpnmp\b/g,                   'pnpm'],
    [/\bpnnm\b/g,                   'pnpm'],
    [/\bpnppm\b/g,                  'pnpm'],
    [/\bpmpm\b/g,                   'pnpm'],
    [/\bpnmn\b/g,                   'pnpm'],
    // ── pip ──
    [/\bpip\s+instal\b/g,           'pip install'],
    [/\bpip\s+instlal\b/g,          'pip install'],
    [/\bpip\s+isntall\b/g,          'pip install'],
    [/\bpip3\s+instal\b/g,          'pip3 install'],
    [/\bpip\s+upgarde\b/g,          'pip install --upgrade'],
    [/\bpip\s+freez\b/g,            'pip freeze'],
    // ── python ──
    [/\bpyhton\b/g,                 'python'],
    [/\bpytohn\b/g,                 'python'],
    [/\bpythn\b/g,                  'python'],
    [/\bpython23\b/g,               'python3'],
    [/\bpyhton3\b/g,                'python3'],
    [/\bpytohn3\b/g,                'python3'],
    [/\bpython2\.7\b/g,             'python3'],
    // ── git ──
    [/\bgit\s+chekout\b/g,          'git checkout'],
    [/\bgit\s+checokut\b/g,         'git checkout'],
    [/\bgit\s+checkotu\b/g,         'git checkout'],
    [/\bgit\s+comit\b/g,            'git commit'],
    [/\bgit\s+committ\b/g,          'git commit'],
    [/\bgit\s+commmit\b/g,          'git commit'],
    [/\bgit\s+pus\b/g,              'git push'],
    [/\bgit\s+puh\b/g,              'git push'],
    [/\bgit\s+puhs\b/g,             'git push'],
    [/\bgit\s+stauts\b/g,           'git status'],
    [/\bgit\s+statuss\b/g,          'git status'],
    [/\bgit\s+statuus\b/g,          'git status'],
    [/\bgit\s+difff\b/g,            'git diff'],
    [/\bgit\s+dif\b/g,              'git diff'],
    [/\bgit\s+mereg\b/g,            'git merge'],
    [/\bgit\s+meerge\b/g,           'git merge'],
    [/\bgit\s+reabse\b/g,           'git rebase'],
    [/\bgit\s+rebsae\b/g,           'git rebase'],
    [/\bgit\s+fetcch\b/g,           'git fetch'],
    [/\bgit\s+fecth\b/g,            'git fetch'],
    [/\bgit\s+cloen\b/g,            'git clone'],
    [/\bgit\s+clonee\b/g,           'git clone'],
    [/\bgit\s+initt\b/g,            'git init'],
    [/\bgit\s+stassh\b/g,           'git stash'],
    [/\bgit\s+tagt\b/g,             'git tag'],
    [/\bgit\s+brach\b/g,            'git branch'],
    [/\bgit\s+brnahc\b/g,           'git branch'],
    [/\bgit\s+logg\b/g,             'git log'],
    [/\bgit\s+addl\b/g,             'git add'],
    [/\bgit\s+resett\b/g,           'git reset'],
    // ── docker ──
    [/\bdocer\s+build\b/g,          'docker build'],
    [/\bdokcer\b/g,                 'docker'],
    [/\bdcoker\b/g,                 'docker'],
    [/\bdocekr\b/g,                 'docker'],
    [/\bdocker\s+buid\b/g,          'docker build'],
    [/\bdocker\s+buidl\b/g,         'docker build'],
    [/\bdocker\s+buld\b/g,          'docker build'],
    [/\bdocker\s+biuld\b/g,         'docker build'],
    [/\bdocker\s+psuh\b/g,          'docker push'],
    [/\bdocker\s+puhsh\b/g,         'docker push'],
    [/\bdocker\s+pulll\b/g,         'docker pull'],
    [/\bdocker\s+pul\b/g,           'docker pull'],
    [/\bdocker\s+tagt\b/g,          'docker tag'],
    [/\bdocker\s+runn\b/g,          'docker run'],
    [/\bdocker\s+rnu\b/g,           'docker run'],
    [/\bdocker\s+execc\b/g,         'docker exec'],
    [/\bdocker-compose\b/g,         'docker compose'],   // modernise to v2 plugin syntax
    // ── kubectl ──
    [/\bkubcetl\b/g,                'kubectl'],
    [/\bkubeclt\b/g,                'kubectl'],
    [/\bkubetcl\b/g,                'kubectl'],
    [/\bkubctl\b/g,                 'kubectl'],
    [/\bkuebctl\b/g,                'kubectl'],
    [/\bkubectl\s+aply\b/g,         'kubectl apply'],
    [/\bkubectl\s+delet\b/g,        'kubectl delete'],
    [/\bkubectl\s+deletee\b/g,      'kubectl delete'],
    [/\bkubectl\s+creat\b/g,        'kubectl create'],
    [/\bkubectl\s+gett\b/g,         'kubectl get'],
    [/\bkubectl\s+descrbie\b/g,     'kubectl describe'],
    [/\bkubectl\s+rollotu\b/g,      'kubectl rollout'],
    [/\bkubectl\s+cordon\b/g,       'kubectl cordon'],   // correct — keep
    // ── terraform ──
    [/\bterrafrom\b/g,              'terraform'],
    [/\bterrafrm\b/g,               'terraform'],
    [/\bterrafom\b/g,               'terraform'],
    [/\bterraform\s+initt\b/g,      'terraform init'],
    [/\bterraform\s+aply\b/g,       'terraform apply'],
    [/\bterraform\s+plna\b/g,       'terraform plan'],
    [/\bterraform\s+pln\b/g,        'terraform plan'],
    [/\bterraform\s+destory\b/g,    'terraform destroy'],
    [/\bterraform\s+vaildate\b/g,   'terraform validate'],
    // ── helm ──
    [/\bhlem\b/g,                   'helm'],
    [/\bhelms\b/g,                  'helm'],
    [/\bhelim\b/g,                  'helm'],
    [/\bheml\b/g,                   'helm'],
    // ── ansible ──
    [/\bansibel\b/g,                'ansible'],
    [/\bansibel-playbook\b/g,       'ansible-playbook'],
    [/\bansible-plabyook\b/g,       'ansible-playbook'],
    [/\bansible-plabook\b/g,        'ansible-playbook'],
    // ── cargo / rust ──
    [/\bcargo\s+buidl\b/g,          'cargo build'],
    [/\bcargo\s+buiild\b/g,         'cargo build'],
    [/\bcargo\s+tets\b/g,           'cargo test'],
    [/\bcaorg\b/g,                  'cargo'],
    [/\bcarg0\b/g,                  'cargo'],   // zero instead of o
    // ── go ──
    [/\bgo\s+buidl\b/g,             'go build'],
    [/\bgo\s+tets\b/g,              'go test'],
    [/\bgo\s+gett\b/g,              'go get'],
    // ── make ──
    [/\bmakee\b/g,                  'make'],
    [/\bmakefile\s+(\w)/gi,         'make $1'],  // "makefile build" → "make build"
    // ── Java build tools ──
    [/\bmvnn\b/g,                   'mvn'],
    [/\bgradlew\b(?!\.bat)(?!\/)/g, './gradlew'],  // gradlew → ./gradlew (needs ./ prefix)
    [/\bgradle\b(?!w)(?!\.)/g,      './gradlew'],  // bare gradle → ./gradlew
    // ── PHP ──
    [/\bcomposr\b/g,                'composer'],
    [/\bcompsoer\b/g,               'composer'],
    // ── AWS / cloud ──
    [/\bawss\b/g,                   'aws'],
    [/\baw\s+s3\b/g,                'aws s3'],
    [/\bgcluod\b/g,                 'gcloud'],
    [/\bgcoud\b/g,                  'gcloud'],
    // ── testing tools ──
    [/\bjest\s+--coverge\b/g,       'jest --coverage'],
    [/\bjest\s+--covergae\b/g,      'jest --coverage'],
    [/\bvitest\s+--covergae\b/g,    'vitest --coverage'],
    [/\bvitest\s+--coverge\b/g,     'vitest --coverage'],
    [/\bvitset\b/g,                 'vitest'],
    [/\bjesst\b/g,                  'jest'],
    [/\bpytest\s+--caputre\b/g,     'pytest --capture'],
    [/\bpytest\s+--caputred\b/g,    'pytest --capture'],
    [/\bmocha\s+--tmeout\b/g,       'mocha --timeout'],
    // ── npx tools ──
    [/\bnpx\s+ts\-nod\b/g,          'npx ts-node'],
    [/\bnpx\s+tsc\-nod\b/g,         'npx ts-node'],
  ];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isYAML(f.path)) continue;
    let content = f.content;
    let changed = false;
    for (const [pattern, fix] of TYPOS) {
      pattern.lastIndex = 0;
      const next = content.replace(pattern, fix);
      if (next !== content) { content = next; changed = true; }
    }
    if (changed)
      fixes.push({ path: f.path, content, explanation: 'Fixed command typos in workflow run: steps (60+ patterns) — misspelled CLI commands cause "command not found" errors; corrected npm/yarn/pnpm/pip/python/git/docker/kubectl/terraform/helm/cargo/go/mvn/gradle typos', confidence: 100 });
  }
  return fixes;
}

/** Fix 38+ incorrect GitHub Actions context variable names — case sensitivity, wrong context,
 *  wrong property names, and shell env vars used where expressions are needed. */
export function fixIncorrectVariableName(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/undefined|is not defined|cannot read.*undefined|ReferenceError|Unrecognized named-value|context access/i.test(logs)) return [];
  const RENAMES: Array<[RegExp, string]> = [
    // ── github context — all keys are lowercase ──
    [/\$\{\{\s*github\.SHA\s*\}\}/g,              '${{ github.sha }}'],
    [/\$\{\{\s*github\.REF\s*\}\}/g,              '${{ github.ref }}'],
    [/\$\{\{\s*github\.Ref\s*\}\}/g,              '${{ github.ref }}'],
    [/\$\{\{\s*github\.BRANCH\s*\}\}/g,           '${{ github.ref_name }}'],
    [/\$\{\{\s*github\.Branch\s*\}\}/g,           '${{ github.ref_name }}'],
    [/\$\{\{\s*github\.branch\s*\}\}/g,           '${{ github.ref_name }}'],
    [/\$\{\{\s*github\.REPO\s*\}\}/g,             '${{ github.repository }}'],
    [/\$\{\{\s*github\.repo\s*\}\}/g,             '${{ github.repository }}'],
    [/\$\{\{\s*github\.Repo\s*\}\}/g,             '${{ github.repository }}'],
    [/\$\{\{\s*github\.REPOSITORY\s*\}\}/g,       '${{ github.repository }}'],
    [/\$\{\{\s*github\.repo_name\s*\}\}/g,        '${{ github.event.repository.name }}'],
    [/\$\{\{\s*github\.USER\s*\}\}/g,             '${{ github.actor }}'],
    [/\$\{\{\s*github\.user\s*\}\}/g,             '${{ github.actor }}'],
    [/\$\{\{\s*github\.User\s*\}\}/g,             '${{ github.actor }}'],
    [/\$\{\{\s*github\.Actor\s*\}\}/g,            '${{ github.actor }}'],
    [/\$\{\{\s*github\.ACTOR\s*\}\}/g,            '${{ github.actor }}'],
    [/\$\{\{\s*github\.username\s*\}\}/g,         '${{ github.actor }}'],
    [/\$\{\{\s*github\.Event\s*\}\}/g,            '${{ github.event_name }}'],
    [/\$\{\{\s*github\.event\b(?!_)\s*\}\}/g,     '${{ github.event_name }}'],
    [/\$\{\{\s*github\.Workflow\s*\}\}/g,         '${{ github.workflow }}'],
    [/\$\{\{\s*github\.WORKFLOW\s*\}\}/g,         '${{ github.workflow }}'],
    [/\$\{\{\s*github\.WORKSPACE\s*\}\}/g,        '${{ github.workspace }}'],
    [/\$\{\{\s*github\.Workspace\s*\}\}/g,        '${{ github.workspace }}'],
    [/\$\{\{\s*github\.Run_Id\s*\}\}/gi,          '${{ github.run_id }}'],
    [/\$\{\{\s*github\.RUN_ID\s*\}\}/g,           '${{ github.run_id }}'],
    [/\$\{\{\s*github\.Run_Number\s*\}\}/gi,      '${{ github.run_number }}'],
    [/\$\{\{\s*github\.RUN_NUMBER\s*\}\}/g,       '${{ github.run_number }}'],
    [/\$\{\{\s*github\.HEAD_REF\s*\}\}/gi,        '${{ github.head_ref }}'],
    [/\$\{\{\s*github\.BASE_REF\s*\}\}/gi,        '${{ github.base_ref }}'],
    [/\$\{\{\s*github\.SERVER_URL\s*\}\}/gi,      '${{ github.server_url }}'],
    [/\$\{\{\s*github\.API_URL\s*\}\}/gi,         '${{ github.api_url }}'],
    [/\$\{\{\s*github\.GRAPHQL_URL\s*\}\}/gi,     '${{ github.graphql_url }}'],
    [/\$\{\{\s*github\.Job\s*\}\}/g,              '${{ github.job }}'],
    [/\$\{\{\s*github\.JOB\s*\}\}/g,              '${{ github.job }}'],
    [/\$\{\{\s*github\.default_branch\s*\}\}/g,   '${{ github.event.repository.default_branch }}'],
    // ── runner context ──
    [/\$\{\{\s*runner\.OS\s*\}\}/g,              '${{ runner.os }}'],
    [/\$\{\{\s*runner\.Os\s*\}\}/g,              '${{ runner.os }}'],
    [/\$\{\{\s*runner\.Arch\s*\}\}/g,            '${{ runner.arch }}'],
    [/\$\{\{\s*runner\.ARCH\s*\}\}/g,            '${{ runner.arch }}'],
    [/\$\{\{\s*runner\.Name\s*\}\}/g,            '${{ runner.name }}'],
    [/\$\{\{\s*runner\.NAME\s*\}\}/g,            '${{ runner.name }}'],
    [/\$\{\{\s*runner\.Temp\s*\}\}/g,            '${{ runner.temp }}'],
    [/\$\{\{\s*runner\.TEMP\s*\}\}/g,            '${{ runner.temp }}'],
    [/\$\{\{\s*runner\.Tool_Cache\s*\}\}/gi,     '${{ runner.tool_cache }}'],
    [/\$\{\{\s*runner\.TOOL_CACHE\s*\}\}/g,      '${{ runner.tool_cache }}'],
    // ── matrix context ──
    [/\$\{\{\s*matrix\.node[-_]version\s*\}\}/gi,    '${{ matrix.node-version }}'],
    [/\$\{\{\s*matrix\.node_ver\s*\}\}/g,            '${{ matrix.node-version }}'],
    [/\$\{\{\s*matrix\.python[-_]version\s*\}\}/gi,  '${{ matrix.python-version }}'],
    [/\$\{\{\s*matrix\.python_ver\s*\}\}/g,          '${{ matrix.python-version }}'],
    [/\$\{\{\s*matrix\.os_version\s*\}\}/g,          '${{ matrix.os }}'],
    [/\$\{\{\s*matrix\.java[-_]version\s*\}\}/gi,    '${{ matrix.java-version }}'],
    // ── env context — wrong usage (env.PATH is empty in expressions) ──
    [/\$\{\{\s*env\.PATH\s*\}\}/g,              '$PATH'],
    [/\$\{\{\s*env\.HOME\s*\}\}/g,              '$HOME'],
    [/\$\{\{\s*env\.USER\s*\}\}/g,              '${{ github.actor }}'],
    // ── secrets context — wrong casing on built-in ──
    [/\$\{\{\s*secrets\.github_token\s*\}\}/gi,  '${{ secrets.GITHUB_TOKEN }}'],
    [/\$\{\{\s*secrets\.Github_Token\s*\}\}/g,   '${{ secrets.GITHUB_TOKEN }}'],
    [/\$\{\{\s*secrets\.GithubToken\s*\}\}/g,    '${{ secrets.GITHUB_TOKEN }}'],
    [/\$\{\{\s*secrets\.githubtoken\s*\}\}/gi,   '${{ secrets.GITHUB_TOKEN }}'],
    // Using env context for something that must come from secrets
    [/\$\{\{\s*env\.GITHUB_TOKEN\s*\}\}/g,       '${{ secrets.GITHUB_TOKEN }}'],
    [/\$\{\{\s*env\.GH_TOKEN\s*\}\}/g,           '${{ secrets.GITHUB_TOKEN }}'],
  ];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isYAML(f.path)) continue;
    let content = f.content;
    let changed = false;
    for (const [pattern, fix] of RENAMES) {
      pattern.lastIndex = 0;
      const next = content.replace(pattern, fix);
      if (next !== content) { content = next; changed = true; }
    }
    if (changed)
      fixes.push({ path: f.path, content, explanation: 'Fixed GitHub Actions context variable names (38+ patterns) — context keys are case-sensitive; wrong casing or wrong context returns empty string or causes "Unrecognized named-value" errors', confidence: 100 });
  }
  return fixes;
}

// ── Runner Labels ─────────────────────────────────────────────────────────────

/** Fix common runner label typos and EOL runner versions. */
export function fixRunnerLabelTypo(files: Array<{ path: string; content: string }>): RuleFix[] {
  const RUNNER_TYPOS: Array<[RegExp, string]> = [
    // ── Fix AEGIS-introduced double-latest (must be first) ────────────────
    [/runs-on:\s*ubuntu-latest-latest/gi,  'runs-on: ubuntu-latest'],
    [/runs-on:\s*macos-latest-latest/gi,   'runs-on: macos-latest'],
    [/runs-on:\s*windows-latest-latest/gi, 'runs-on: windows-latest'],
    // ── Spelling typos ────────────────────────────────────────────────────
    [/runs-on:\s*ubunti-latest/gi,         'runs-on: ubuntu-latest'],
    [/runs-on:\s*ubuntu-lastest/gi,        'runs-on: ubuntu-latest'],
    [/runs-on:\s*ubunutu-latest/gi,        'runs-on: ubuntu-latest'],
    [/runs-on:\s*ubuntu-lates(?!t\b)\w*/gi,'runs-on: ubuntu-latest'],
    // ── EOL / deprecated runner versions ─────────────────────────────────
    [/runs-on:\s*ubuntu-18\.04/gi,         'runs-on: ubuntu-latest'],
    [/runs-on:\s*ubuntu-20\.04/gi,         'runs-on: ubuntu-latest'],
    [/runs-on:\s*ubuntu-21\.04/gi,         'runs-on: ubuntu-latest'],
    [/runs-on:\s*ubuntu-21\.10/gi,         'runs-on: ubuntu-latest'],
    [/runs-on:\s*ubuntu-23\.04/gi,         'runs-on: ubuntu-latest'],
    [/runs-on:\s*macos-11\b/gi,            'runs-on: macos-latest'],
    [/runs-on:\s*macos-12\b/gi,            'runs-on: macos-latest'],
    [/runs-on:\s*macos-lastest/gi,         'runs-on: macos-latest'],
    [/runs-on:\s*macos-13\b/gi,            'runs-on: macos-latest'],
    [/runs-on:\s*windows-2019\b/gi,        'runs-on: windows-latest'],
    [/runs-on:\s*windows-2021\b/gi,        'runs-on: windows-latest'],
    [/runs-on:\s*windows-lastest/gi,       'runs-on: windows-latest'],
    [/runs-on:\s*self-hosetd/gi,           'runs-on: self-hosted'],
    [/runs-on:\s*selfhosted/gi,            'runs-on: self-hosted'],
    [/runs-on:\s*self_hosted/gi,           'runs-on: self-hosted'],
    // bare 'ubuntu' with no version suffix — use (?![-\w]) so ubuntu-latest / ubuntu-22.04 are never touched
    [/runs-on:\s*ubuntu(?![-\w])/gi,       'runs-on: ubuntu-latest'],
  ];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    let content = f.content;
    let changed = false;
    for (const [pattern, replacement] of RUNNER_TYPOS) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) { pattern.lastIndex = 0; content = content.replace(pattern, replacement); changed = true; }
    }
    if (changed)
      fixes.push({ path: f.path, content, explanation: 'Fixed runner label typos/EOL labels — misspelled or deprecated runner labels cause "no runner available" errors; updated to current GitHub-hosted runner names', confidence: 100 });
  }
  return fixes;
}

/** Add actions/checkout when jobs use source code but have no checkout step. */
export function fixMissingCheckoutStep(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('actions/checkout')) continue;
    const needsSource = /run:\s*(npm|yarn|pnpm|pip|python|python3|node|tsc|jest|vitest|pytest|go\s+build|cargo|mvn|gradle|make|gradlew)\b/m.test(f.content);
    if (!needsSource) continue;
    const patched = insertStepBefore(
      f.content,
      /run:\s*(npm|yarn|pnpm|pip|python|python3|node|tsc|jest|vitest|pytest|go\s+build|cargo|mvn|gradle|make)/,
      `      - name: Checkout repository\n        uses: actions/checkout@v4\n        with:\n          fetch-depth: 0`,
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added actions/checkout@v4 with fetch-depth: 0 — workflow runs build/test commands but never checks out source code; without checkout the working directory is empty and all commands fail with ENOENT', confidence: 100 });
  }
  return fixes;
}

/** Fix invalid cron expressions — field count, minimum interval, common patterns. */
export function fixInvalidCronExpression(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('schedule:') || !f.content.includes('cron:')) continue;
    let content = f.content;
    let changed = false;
    // Fix field count (must be exactly 5: minute hour day month weekday)
    content = content.replace(/cron:\s*['"]([\d\s*/,\-]+)['"]/g, (match, expr) => {
      const parts = expr.trim().split(/\s+/);
      if (parts.length === 4) {
        changed = true;
        return `cron: '${parts.join(' ')} *'`; // missing weekday → add *
      }
      if (parts.length === 6) {
        changed = true;
        return `cron: '${parts.slice(1).join(' ')}'`; // 6 fields → drop seconds (not supported)
      }
      return match;
    });
    // GitHub minimum schedule is every 5 minutes — fix overly frequent schedules
    content = content.replace(/cron:\s*['"](\*\/[1-4]\s+\*\s+\*\s+\*\s+\*)['"]/, "cron: '*/5 * * * *'");
    content = content.replace(/cron:\s*['"](\*\s+\*\s+\*\s+\*\s+\*)['"]/, "cron: '*/5 * * * *'"); // every minute → every 5
    // Fix common named shortcuts that GitHub doesn't support
    content = content.replace(/cron:\s*['"]@daily['"]/, "cron: '0 0 * * *'");
    content = content.replace(/cron:\s*['"]@hourly['"]/, "cron: '0 * * * *'");
    content = content.replace(/cron:\s*['"]@weekly['"]/, "cron: '0 0 * * 0'");
    content = content.replace(/cron:\s*['"]@monthly['"]/, "cron: '0 0 1 * *'");
    if (changed || content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Fixed cron expression — GitHub Actions requires exactly 5 fields (minute hour day month weekday), minimum interval is every 5 minutes, and named shortcuts (@daily etc.) are not supported', confidence: 100 });
  }
  return fixes;
}

/** Replace deprecated GitLab CI only:/except: with rules: syntax. */
export function fixGitLabOnlyExceptToRules(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('only:') && !f.content.includes('except:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s+only:\s*$/.test(line)) {
        const indent = line.match(/^(\s+)/)?.[1] ?? '  ';
        const branches: string[] = [];
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith(indent + '  -')) {
          branches.push(lines[j].replace(/^\s+-\s*/, '').trim());
          j++;
        }
        if (branches.length > 0) {
          out.push(`${indent}rules:`);
          for (const b of branches)
            out.push(`${indent}  - if: '$CI_COMMIT_BRANCH == "${b}" || $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "${b}"'`);
          out.push(`${indent}    when: always`);
          out.push(`${indent}  - when: never`);
          i = j; modified = true; continue;
        }
      }
      if (/^\s+except:\s*$/.test(line)) {
        const indent = line.match(/^(\s+)/)?.[1] ?? '  ';
        const branches: string[] = [];
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith(indent + '  -')) {
          branches.push(lines[j].replace(/^\s+-\s*/, '').trim());
          j++;
        }
        if (branches.length > 0) {
          out.push(`${indent}rules:`);
          for (const b of branches) {
            out.push(`${indent}  - if: '$CI_COMMIT_BRANCH == "${b}"'`);
            out.push(`${indent}    when: never`);
          }
          out.push(`${indent}  - when: always`);
          i = j; modified = true; continue;
        }
      }
      out.push(line);
      i++;
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Replaced deprecated only:/except: with rules: — GitLab CI deprecated only/except; rules: supports more conditions, is the recommended syntax, and is required for merge request pipelines', confidence: 100 });
  }
  return fixes;
}

/** Convert long chained run: commands to multiline block (|) and trim trailing whitespace. */
export function fixMultilineRunScript(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 3+ chained commands on one line → multiline block
      const runMatch = line.match(/^(\s+run:\s+)((?:[^|>][^\n]+&&[^\n]+&&[^\n]+))$/);
      if (runMatch) {
        const baseIndent = runMatch[1].replace('run: ', '');
        const cmds = runMatch[2].split('&&').map(c => c.trim());
        out.push(`${baseIndent}run: |`);
        out.push(`${baseIndent}  set -euo pipefail`);
        for (const cmd of cmds) out.push(`${baseIndent}  ${cmd}`);
        modified = true;
        continue;
      }
      // Trim trailing whitespace (can cause YAML parse failures)
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed !== line) modified = true;
      out.push(trimmed);
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Converted 3+ chained run: commands to multiline | block with set -euo pipefail — multiline blocks are readable, and pipefail ensures any command failure stops the step instead of silently continuing', confidence: 100 });
  }
  return fixes;
}

/** Add workflow_call trigger when another workflow calls this one as a reusable workflow. */
export function fixMissingWorkflowCallTrigger(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('workflow_call:')) continue;
    const fileName = f.path.split('/').pop() ?? '';
    const callers = files.filter(fi =>
      isGitHubWorkflow(fi.path) && fi.path !== f.path && fi.content.includes(fileName),
    );
    if (callers.length === 0) continue;
    const fixed = f.content.replace(/^(on:\s*\n)/m, '$1  workflow_call:\n');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added workflow_call: trigger — ${callers.map(c => c.path).join(', ')} calls this workflow as a reusable workflow but it was missing the workflow_call: trigger; without it GitHub rejects the call`, confidence: 100 });
  }
  return fixes;
}
