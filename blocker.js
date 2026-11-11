#!/usr/bin/env node
// Blocker for Chrome (Node.js port). Windows only, run from an administrator terminal.
// Blocks websites and turns off / uninstalls Chrome extensions for ALL Chrome profiles
// by writing Chrome's enterprise policies (HKLM\SOFTWARE\Policies\Google\Chrome).
//
// Usage: node blocker.js <command> [value] [--dry-run]
//   block-site <site>            Block a website and all its subdomains
//   unblock-site <site>          Unblock it
//   turn-off-extension <id|url>  Disable an extension (stays installed)
//   uninstall-extension <id|url> Remove an extension (cannot be reinstalled until allowed)
//   allow-extension <id|url>     Undo turn-off / uninstall for that extension
//   block-all-extensions         Turn off ALL extensions
//   allow-all-extensions         Undo block-all-extensions
//   list                         Show current blocks
//   restart-chrome               Close and reopen Chrome so changes apply now
//   help
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const [cmd, rawValue] = args.filter(a => a !== '--dry-run');

const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome';
const STATE_DIR = process.env.ProgramData
  ? path.join(process.env.ProgramData, 'Blocker')
  : path.join(__dirname, '.blocker-state'); // non-Windows (dry run / testing)
const STATE_FILE = path.join(STATE_DIR, 'blocked.json');

const SITE_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const EXT_ID_RE = /^[a-p]{32}$/;
const EXT_ID_IN_TEXT = /(?<![a-z0-9])([a-p]{32})(?![a-z0-9])/;

function die(msg) { console.error(msg); process.exit(1); }

function parseSite(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch { return null; }
  } else {
    s = s.split(/[/?#]/)[0].replace(/:\d+$/, '');
  }
  s = s.replace(/^www\./, '');
  return SITE_RE.test(s) ? s : null;
}

function parseExtensionId(input) {
  const s = String(input || '').trim().toLowerCase();
  if (EXT_ID_RE.test(s)) return s;
  const m = s.match(EXT_ID_IN_TEXT); // e.g. a Chrome Web Store link
  return m ? m[1] : null;
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      sites: s.sites || [],
      off: s.off || [],
      removed: s.removed || [],
      allOff: !!s.allOff,
    };
  } catch {
    return { sites: [], off: [], removed: [], allOff: false };
  }
}

function saveState(state) {
  if (DRY) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function reg(argv) {
  if (DRY) { console.log('[dry-run] reg ' + argv.join(' ')); return ''; }
  return execFileSync('reg', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function requireAdmin() {
  if (DRY) return;
  if (process.platform !== 'win32') die('This tool only works on Windows (it writes Chrome policies to the registry).');
  try { execFileSync('net', ['session'], { stdio: 'ignore' }); }
  catch { die('Blocker needs administrator permission to change Chrome\'s settings.\nOpen Command Prompt or PowerShell with "Run as administrator" and try again.'); }
}

// Write the policy registry values from the saved state.
function applyPolicies(state) {
  // Blocked websites: URLBlocklist\1, \2, ... (a domain blocks its subdomains too)
  const urlKey = POLICY_KEY + '\\URLBlocklist';
  if (!DRY) { try { reg(['delete', urlKey, '/f']); } catch { /* key may not exist */ } }
  else console.log('[dry-run] reg delete ' + urlKey + ' /f');
  state.sites.forEach((site, i) => reg(['add', urlKey, '/v', String(i + 1), '/t', 'REG_SZ', '/d', site, '/f']));

  // Extensions: one JSON policy value.
  const settings = {};
  if (state.allOff) settings['*'] = { installation_mode: 'blocked' };
  state.off.forEach(id => { settings[id] = { installation_mode: 'blocked' }; });
  state.removed.forEach(id => { settings[id] = { installation_mode: 'removed' }; });
  if (Object.keys(settings).length) {
    reg(['add', POLICY_KEY, '/v', 'ExtensionSettings', '/t', 'REG_SZ', '/d', JSON.stringify(settings), '/f']);
  } else if (DRY) {
    console.log('[dry-run] reg delete ' + POLICY_KEY + ' /v ExtensionSettings /f');
  } else {
    try { reg(['delete', POLICY_KEY, '/v', 'ExtensionSettings', '/f']); } catch { /* not set */ }
  }
}

function findChrome() {
  const candidates = [];
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', '/ve'], { encoding: 'utf8' });
    const m = out.match(/REG_SZ\s+(.+)/);
    if (m) candidates.push(m[1].trim());
  } catch { /* fall through */ }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  return candidates.find(p => fs.existsSync(p)) || null;
}

function restartChrome() {
  if (DRY) { console.log('[dry-run] taskkill /IM chrome.exe /F, then start Chrome'); return; }
  const chrome = findChrome();
  try { execFileSync('taskkill', ['/IM', 'chrome.exe', '/F'], { stdio: 'ignore' }); } catch { /* not running */ }
  if (!chrome) die('Chrome was closed, but I couldn\'t find chrome.exe. Open it yourself and your blocks will be active.');
  spawn(chrome, [], { detached: true, stdio: 'ignore' }).unref();
  console.log('Chrome restarted. Your blocks are now active.');
}

function add(list, v) { if (!list.includes(v)) list.push(v); }
function drop(list, v) { const i = list.indexOf(v); if (i >= 0) list.splice(i, 1); }

function needSite() {
  const site = parseSite(rawValue);
  if (!site) die(`"${rawValue || ''}" isn't a website address. Try something like example.com.`);
  return site;
}
function needExt() {
  const id = parseExtensionId(rawValue);
  if (!id) die('Give the extension ID (32 letters a-p) or its Chrome Web Store link.');
  return id;
}

function help() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
}

function main() {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
  const state = loadState();

  if (cmd === 'list') {
    console.log('Blocked sites:      ' + (state.sites.join(', ') || '(none)'));
    console.log('Turned off:         ' + (state.off.join(', ') || '(none)'));
    console.log('Uninstalled:        ' + (state.removed.join(', ') || '(none)'));
    console.log('All extensions off: ' + (state.allOff ? 'yes' : 'no'));
    return;
  }
  if (cmd === 'restart-chrome') { requireAdmin(); return restartChrome(); }

  requireAdmin();
  let msg;
  switch (cmd) {
    case 'block-site': {
      const s = needSite();
      if (state.sites.includes(s)) return console.log(`${s} is already blocked.`);
      add(state.sites, s); state.sites.sort();
      msg = `Blocked ${s} (and all of its pages) in every Chrome profile.`; break;
    }
    case 'unblock-site': {
      const s = needSite();
      if (!state.sites.includes(s)) return console.log(`${s} isn't blocked.`);
      drop(state.sites, s);
      msg = `Unblocked ${s}.`; break;
    }
    case 'turn-off-extension': {
      const id = needExt(); drop(state.removed, id); add(state.off, id);
      msg = `Turned off ${id} in every profile. It stays installed, but Chrome won't let it run.`; break;
    }
    case 'uninstall-extension': {
      const id = needExt(); drop(state.off, id); add(state.removed, id);
      msg = `Uninstalling ${id} from every profile. It can't be reinstalled until you run allow-extension.`; break;
    }
    case 'allow-extension': case 'unblock-extension': {
      const id = needExt(); drop(state.off, id); drop(state.removed, id);
      msg = `Allowed ${id} again in all profiles.`; break;
    }
    case 'block-all-extensions': state.allOff = true; msg = 'All Chrome extensions are turned off in every profile.'; break;
    case 'allow-all-extensions': state.allOff = false; msg = 'Extensions are no longer all turned off.'; break;
    default: die(`Unknown command "${cmd}". Run: node blocker.js help`);
  }
  try {
    saveState(state);
    applyPolicies(state);
  } catch (e) { die(`Couldn't update Chrome's settings: ${e.message}`); }
  console.log(msg);
  console.log('If Chrome is open, run "node blocker.js restart-chrome" (or restart it yourself) to apply right away.');
}

main();
