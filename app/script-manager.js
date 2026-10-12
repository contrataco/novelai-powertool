/**
 * Script Manager — DOM automation for NovelAI's User Scripts modal.
 *
 * NovelAI has no API for script management. All operations (list, import,
 * enable, disable) are done via DOM automation of the "User Scripts" dialog.
 *
 * The dialog is opened via the "Edit User Scripts" button in the Advanced
 * sidebar tab, or via the "User Scripts" item in the left sidebar menu.
 *
 * DOM structure (probed October 2026):
 *   [role=dialog] "User Scripts"
 *     button "Import" (title "Import Script") / button "New"
 *     hidden input[type=file] accept ".naiscript, application/json"
 *     "Account Scripts" section, then "Story Scripts" section
 *     Each script: [draggable] row with div "{name}", div "v{X.X.X} • {author}",
 *     and an icon button with NO text, only title "Enable Script"/"Disable Script"
 *   Import prompts: "Where do you want to add this script?" (To My Account /
 *   To This Story), then for a known script id "Script Already Exists"
 *   (Cancel / Upgrade).
 */

const LOG_PREFIX = '[ScriptMgr]';

// Helper: wait for a condition with polling
function waitFor(wc, checkJs, timeoutMs = 10000, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        const result = await wc.executeJavaScript(checkJs);
        if (result) return resolve(result);
      } catch (e) { /* ignore */ }
      if (Date.now() - start > timeoutMs) return reject(new Error('Timeout waiting for condition'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * Open the User Scripts dialog in the webview.
 * Tries multiple strategies: button text search, sidebar menu.
 */
async function openScriptManager(wc) {
  console.log(`${LOG_PREFIX} Opening Script Manager...`);

  // Check if already open
  const alreadyOpen = await wc.executeJavaScript(`
    !!Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(d =>
      d.textContent.includes('User Scripts') && d.textContent.includes('Account Scripts')
    )
  `).catch(() => false);

  if (alreadyOpen) {
    console.log(`${LOG_PREFIX} Script Manager already open`);
    return true;
  }

  // Strategy 1: Click "Edit User Scripts" button (in Advanced sidebar)
  const clicked = await wc.executeJavaScript(`
    (function() {
      var buttons = document.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent.trim() === 'Edit User Scripts') {
          buttons[i].click();
          return true;
        }
      }
      return false;
    })()
  `).catch(() => false);

  if (clicked) {
    // Wait for dialog to appear
    try {
      await waitFor(wc, `
        !!Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(d =>
          d.textContent.includes('Account Scripts')
        )
      `, 5000);
      console.log(`${LOG_PREFIX} Script Manager opened via Edit User Scripts button`);
      return true;
    } catch (e) { /* fall through */ }
  }

  // Strategy 2: Click "User Scripts" in left sidebar menu
  const clickedMenu = await wc.executeJavaScript(`
    (function() {
      var items = document.querySelectorAll('button, div[role="button"]');
      for (var i = 0; i < items.length; i++) {
        var text = items[i].textContent.trim();
        if (text === 'User Scripts') {
          items[i].click();
          return true;
        }
      }
      return false;
    })()
  `).catch(() => false);

  if (clickedMenu) {
    try {
      await waitFor(wc, `
        !!Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(d =>
          d.textContent.includes('Account Scripts')
        )
      `, 5000);
      console.log(`${LOG_PREFIX} Script Manager opened via sidebar menu`);
      return true;
    } catch (e) { /* fall through */ }
  }

  console.error(`${LOG_PREFIX} Failed to open Script Manager`);
  return false;
}

/**
 * Close the User Scripts dialog.
 */
async function closeScriptManager(wc) {
  return wc.executeJavaScript(`
    (function() {
      var dialogs = document.querySelectorAll('dialog, [role="dialog"]');
      for (var i = 0; i < dialogs.length; i++) {
        if (dialogs[i].textContent.includes('User Scripts') && dialogs[i].textContent.includes('Account Scripts')) {
          // Find close button (usually first button child or button with X)
          var btns = dialogs[i].querySelectorAll('button');
          for (var j = 0; j < btns.length; j++) {
            var text = btns[j].textContent.trim();
            // Close button has no text or has × / X
            if (text === '' || text === '×' || text === 'X' || text === '✕') {
              btns[j].click();
              return true;
            }
          }
          // Fallback: first button that's not Import/New
          for (var k = 0; k < btns.length; k++) {
            var t = btns[k].textContent.trim();
            if (t !== 'Import Script' && t !== 'New' && !t.includes('Script') && !t.includes('Enable') && !t.includes('Disable')) {
              btns[k].click();
              return true;
            }
          }
        }
      }
      return false;
    })()
  `).catch(() => false);
}

// In-page helper: one entry per script row. Each row is a draggable block
// holding the name, "vX.Y.Z • author" and an icon button whose only label is
// its title ("Enable Script" / "Disable Script"); the buttons have no text.
const ROWS_JS = `
  function scriptRows() {
    var dialog = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(function(d) {
      return d.textContent.includes('Account Scripts');
    });
    if (!dialog) return null;
    var storyHeader = Array.from(dialog.querySelectorAll('div')).find(function(d) {
      return !d.children.length && d.textContent.trim() === 'Story Scripts';
    });
    return Array.from(dialog.querySelectorAll('[draggable="true"]')).map(function(row) {
      var leaves = Array.from(row.querySelectorAll('div')).filter(function(d) {
        return !d.children.length && d.textContent.trim();
      });
      var parts = (leaves[1] ? leaves[1].textContent : '').split('•').map(function(s) { return s.trim(); });
      var btn = row.querySelector('button[title="Enable Script"], button[title="Disable Script"]');
      var story = !!(storyHeader && (storyHeader.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING));
      return {
        row: row, button: btn,
        name: leaves[0] ? leaves[0].textContent.trim() : '',
        version: parts[0] || '', author: parts[1] || '',
        enabled: !!btn && btn.title === 'Disable Script',
        section: story ? 'story' : 'account',
      };
    });
  }
`;

/**
 * List all installed scripts from the Script Manager dialog.
 * Returns array of { name, version, author, enabled, section }.
 */
async function listInstalledScripts(wc) {
  const opened = await openScriptManager(wc);
  if (!opened) return [];

  const scripts = await wc.executeJavaScript(`
    (function() {
      ${ROWS_JS}
      var rows = scriptRows() || [];
      return rows.filter(function(r) { return r.name; }).map(function(r) {
        return { name: r.name, version: r.version, author: r.author, enabled: r.enabled, section: r.section };
      });
    })()
  `).catch(() => []);

  console.log(`${LOG_PREFIX} Found ${scripts.length} scripts`);
  return scripts;
}

async function setScriptEnabled(wc, scriptName, enable) {
  const opened = await openScriptManager(wc);
  if (!opened) return { success: false, error: 'Could not open Script Manager' };

  const result = await wc.executeJavaScript(`
    (function() {
      ${ROWS_JS}
      var rows = scriptRows();
      if (!rows) return { success: false, error: 'Dialog not found' };
      var matches = rows.filter(function(r) { return r.name === ${JSON.stringify(scriptName)}; });
      if (!matches.length) return { success: false, error: 'Script not found: ' + ${JSON.stringify(scriptName)} };
      var want = ${enable ? 'true' : 'false'};
      var todo = matches.filter(function(r) { return r.enabled !== want && r.button; });
      if (!todo.length) return { success: true, already: true };
      // Same-name copies: act on the newest version only.
      todo.sort(function(a, b) { return b.version.localeCompare(a.version, undefined, { numeric: true }); });
      todo[0].button.click();
      return { success: true, version: todo[0].version };
    })()
  `).catch(e => ({ success: false, error: e.message }));

  // NovelAI saves the change to its server before the button flips; report
  // success only once the row shows the new state.
  if (result.success && !result.already) {
    let flipped = false;
    for (let i = 0; i < 20 && !flipped; i++) {
      await new Promise(r => setTimeout(r, 400));
      flipped = await wc.executeJavaScript(`
        (function() {
          ${ROWS_JS}
          return (scriptRows() || []).some(function(r) {
            return r.name === ${JSON.stringify(scriptName)} && r.version === ${JSON.stringify(result.version)} && r.enabled === ${enable ? 'true' : 'false'};
          });
        })()
      `).catch(() => false);
    }
    if (!flipped) Object.assign(result, { success: false, error: 'NovelAI did not confirm the change' });
  }

  console.log(`${LOG_PREFIX} ${enable ? 'Enable' : 'Disable'} "${scriptName}":`, result);
  return result;
}

/** Enable a script by name. */
function enableScript(wc, scriptName) {
  return setScriptEnabled(wc, scriptName, true);
}

/** Disable a script by name. */
function disableScript(wc, scriptName) {
  return setScriptEnabled(wc, scriptName, false);
}

/**
 * Import (or upgrade) a script. The dialog's hidden file input takes the
 * script as a File; NovelAI then asks where to add it ("To My Account") and,
 * when a script with the same id exists, offers "Upgrade", which replaces it
 * in place and keeps its enabled state. Success means the list shows the
 * imported version.
 */
async function importScript(wc, scriptText) {
  const opened = await openScriptManager(wc);
  if (!opened) return { success: false, error: 'Could not open Script Manager' };

  const header = String(scriptText).match(/^name:\s*(.+)$/m);
  const ver = String(scriptText).match(/^version:\s*(.+)$/m);
  const name = header ? header[1].trim() : '';
  const version = ver ? ver[1].trim().replace(/^v/, '') : '';
  const fileName = (name || 'script') + '.naiscript';

  const sent = await wc.executeJavaScript(`
    (function() {
      var dialog = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(function(d) {
        return d.textContent.includes('Account Scripts');
      });
      var input = dialog && dialog.querySelector('input[type="file"]');
      if (!input) return { success: false, error: 'Import file input not found' };
      var dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(scriptText)}], ${JSON.stringify(fileName)}, { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true };
    })()
  `).catch(e => ({ success: false, error: e.message }));
  if (!sent.success) {
    console.warn(`${LOG_PREFIX} Import script:`, sent);
    return sent;
  }

  // Answer NovelAI's follow-up prompts until the list shows the new version.
  const steps = [];
  const start = Date.now();
  let listed = null;
  while (Date.now() - start < 15000) {
    await new Promise(r => setTimeout(r, 500));
    const tick = await wc.executeJavaScript(`
      (function() {
        ${ROWS_JS}
        var dialogs = Array.from(document.querySelectorAll('dialog, [role="dialog"]'));
        function press(prompt, test) {
          var d = dialogs.find(function(x) { return x.textContent.includes(prompt); });
          var b = d && Array.from(d.querySelectorAll('button')).find(function(x) { return test(x.textContent.trim()); });
          if (b) b.click();
          return !!b;
        }
        if (press('Where do you want to add this script', function(t) { return t.indexOf('To My Account') === 0; })) return { step: 'account' };
        if (press('Script Already Exists', function(t) { return t === 'Upgrade'; })) return { step: 'upgrade' };
        var rows = (scriptRows() || []).filter(function(r) { return r.name === ${JSON.stringify(name)}; });
        return { rows: rows.map(function(r) { return { version: r.version, enabled: r.enabled }; }) };
      })()
    `).catch(e => ({ error: e.message }));
    if (tick.step) { steps.push(tick.step); continue; }
    const hit = (tick.rows || []).find(r => r.version.replace(/^v/, '') === version);
    if (hit) { listed = hit; break; }
  }

  if (!listed) {
    // Leave nothing half-answered (e.g. a downgrade prompt we do not accept).
    await wc.executeJavaScript(`
      (function() {
        var d = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(function(x) {
          return x.textContent.includes('Script Already Exists') || x.textContent.includes('Where do you want to add this script');
        });
        var b = d && Array.from(d.querySelectorAll('button')).find(function(x) { return x.textContent.trim() === 'Cancel'; });
        if (b) b.click();
      })()
    `).catch(() => {});
  }
  const result = listed
    ? { success: true, name, version, enabled: listed.enabled, steps }
    : { success: false, error: `NovelAI does not list ${name} ${version} after import`, steps };
  console.log(`${LOG_PREFIX} Import script:`, result);
  return result;
}

/**
 * Get the status of a specific script.
 * Returns { installed, enabled, version, author } or null.
 */
async function getScriptStatus(wc, scriptName) {
  const scripts = await listInstalledScripts(wc);
  const match = scripts.find(s => s.name === scriptName);
  if (!match) return { installed: false, enabled: false, version: null, author: null };
  return { installed: true, enabled: match.enabled, version: match.version, author: match.author };
}

/**
 * Get the bundled PowerTool script version from the .naiscript header.
 */
function getBundledVersion(scriptPath) {
  try {
    const fs = require('fs');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    const match = content.match(/^version:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Read the bundled script content from disk.
 */
function getBundledScriptContent(scriptPath) {
  try {
    const fs = require('fs');
    return fs.readFileSync(scriptPath, 'utf-8');
  } catch (e) {
    return null;
  }
}

module.exports = {
  openScriptManager,
  closeScriptManager,
  listInstalledScripts,
  enableScript,
  disableScript,
  importScript,
  getScriptStatus,
  getBundledVersion,
  getBundledScriptContent,
};
