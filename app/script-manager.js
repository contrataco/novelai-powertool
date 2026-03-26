/**
 * Script Manager — DOM automation for NovelAI's User Scripts modal.
 *
 * NovelAI has no API for script management. All operations (list, import,
 * enable, disable) are done via DOM automation of the "User Scripts" dialog.
 *
 * The dialog is opened via the "Edit User Scripts" button in the Advanced
 * sidebar tab, or via the "User Scripts" item in the left sidebar menu.
 *
 * DOM structure (captured March 2026):
 *   dialog "User Scripts"
 *     button "Import Script" / button "New"
 *     "Account Scripts" section → script entries
 *     "Story Scripts" section → script entries
 *     Each script: generic "{name}", generic "v{X.X.X} • {author}", button "Enable/Disable Script"
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

/**
 * List all installed scripts from the Script Manager dialog.
 * Returns array of { name, version, author, enabled, section }.
 */
async function listInstalledScripts(wc) {
  const opened = await openScriptManager(wc);
  if (!opened) return [];

  const scripts = await wc.executeJavaScript(`
    (function() {
      var dialog = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(d =>
        d.textContent.includes('Account Scripts')
      );
      if (!dialog) return [];

      var results = [];
      var allElements = dialog.querySelectorAll('*');
      var section = 'unknown';

      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        var text = el.textContent.trim();

        // Detect section headers
        if (text === 'Account Scripts') { section = 'account'; continue; }
        if (text === 'Story Scripts') { section = 'story'; continue; }

        // Detect version pattern: vX.X.X • Author
        if (/^v\\d+\\.\\d+/.test(text) && text.includes('•')) {
          // The script name is the previous sibling or previous element
          var nameEl = el.previousElementSibling;
          var name = nameEl ? nameEl.textContent.trim() : '';

          // Parse version and author
          var parts = text.split('•').map(function(s) { return s.trim(); });
          var version = parts[0] || '';
          var author = parts[1] || '';

          // Find the enable/disable button (next sibling button)
          var enabled = false;
          var next = el.nextElementSibling;
          while (next) {
            if (next.tagName === 'BUTTON') {
              var btnText = next.textContent.trim();
              if (btnText === 'Disable Script') { enabled = true; break; }
              if (btnText === 'Enable Script') { enabled = false; break; }
            }
            next = next.nextElementSibling;
          }

          if (name && name !== 'Account Scripts' && name !== 'Story Scripts' &&
              name !== 'loaded for all stories' && name !== 'loaded for this story') {
            results.push({ name: name, version: version, author: author, enabled: enabled, section: section });
          }
        }
      }
      return results;
    })()
  `).catch(() => []);

  console.log(`${LOG_PREFIX} Found ${scripts.length} scripts`);
  return scripts;
}

/**
 * Enable a script by name.
 */
async function enableScript(wc, scriptName) {
  const opened = await openScriptManager(wc);
  if (!opened) return false;

  const result = await wc.executeJavaScript(`
    (function() {
      var dialog = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(d =>
        d.textContent.includes('Account Scripts')
      );
      if (!dialog) return { success: false, error: 'Dialog not found' };

      // Find the script name element
      var allEls = dialog.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        if (allEls[i].textContent.trim() === ${JSON.stringify(scriptName)} && allEls[i].children.length === 0) {
          // Walk siblings to find "Enable Script" button
          var parent = allEls[i].parentElement;
          var buttons = parent ? parent.querySelectorAll('button') : [];
          for (var j = 0; j < buttons.length; j++) {
            if (buttons[j].textContent.trim() === 'Enable Script') {
              buttons[j].click();
              return { success: true };
            }
          }
          // Also check nearby siblings
          var sib = allEls[i].nextElementSibling;
          while (sib) {
            if (sib.tagName === 'BUTTON' && sib.textContent.trim() === 'Enable Script') {
              sib.click();
              return { success: true };
            }
            sib = sib.nextElementSibling;
          }
          return { success: false, error: 'Already enabled or button not found' };
        }
      }
      return { success: false, error: 'Script not found: ' + ${JSON.stringify(scriptName)} };
    })()
  `).catch(e => ({ success: false, error: e.message }));

  console.log(`${LOG_PREFIX} Enable "${scriptName}":`, result);
  return result;
}

/**
 * Disable a script by name.
 */
async function disableScript(wc, scriptName) {
  const opened = await openScriptManager(wc);
  if (!opened) return false;

  const result = await wc.executeJavaScript(`
    (function() {
      var dialog = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(d =>
        d.textContent.includes('Account Scripts')
      );
      if (!dialog) return { success: false, error: 'Dialog not found' };

      var allEls = dialog.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        if (allEls[i].textContent.trim() === ${JSON.stringify(scriptName)} && allEls[i].children.length === 0) {
          var parent = allEls[i].parentElement;
          var buttons = parent ? parent.querySelectorAll('button') : [];
          for (var j = 0; j < buttons.length; j++) {
            if (buttons[j].textContent.trim() === 'Disable Script') {
              buttons[j].click();
              return { success: true };
            }
          }
          var sib = allEls[i].nextElementSibling;
          while (sib) {
            if (sib.tagName === 'BUTTON' && sib.textContent.trim() === 'Disable Script') {
              sib.click();
              return { success: true };
            }
            sib = sib.nextElementSibling;
          }
          return { success: false, error: 'Already disabled or button not found' };
        }
      }
      return { success: false, error: 'Script not found: ' + ${JSON.stringify(scriptName)} };
    })()
  `).catch(e => ({ success: false, error: e.message }));

  console.log(`${LOG_PREFIX} Disable "${scriptName}":`, result);
  return result;
}

/**
 * Import a script by clicking "Import Script" and using the file input.
 * Since we can't create a real File object easily, we click the script name
 * in the list after import to select it, then paste into the editor.
 *
 * Alternative: use the "New" button to create a blank script, then paste content.
 */
async function importScript(wc, scriptText) {
  const opened = await openScriptManager(wc);
  if (!opened) return { success: false, error: 'Could not open Script Manager' };

  // Use "New" button to create a script, then paste content into the editor
  const result = await wc.executeJavaScript(`
    (function() {
      var dialog = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(d =>
        d.textContent.includes('Account Scripts')
      );
      if (!dialog) return { success: false, error: 'Dialog not found' };

      // Click "Import Script" button — this typically opens a file picker
      // But we'll use "New" instead and paste content
      var buttons = dialog.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent.trim() === 'New') {
          buttons[i].click();
          return { success: true, step: 'clicked-new' };
        }
      }
      return { success: false, error: '"New" button not found' };
    })()
  `).catch(e => ({ success: false, error: e.message }));

  if (!result.success) return result;

  // Wait for editor to appear, then paste the script content
  await new Promise(r => setTimeout(r, 1000));

  const pasteResult = await wc.executeJavaScript(`
    (function() {
      // Find CodeMirror or textarea in the script editor area
      var editor = document.querySelector('.CodeMirror') ||
                   document.querySelector('.cm-editor') ||
                   document.querySelector('textarea[class*="script"]');

      if (editor) {
        // CodeMirror
        if (editor.CodeMirror) {
          editor.CodeMirror.setValue(${JSON.stringify(scriptText)});
          return { success: true, method: 'codemirror' };
        }
        // CM6
        if (editor.cmView && editor.cmView.view) {
          var view = editor.cmView.view;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(scriptText)} }
          });
          return { success: true, method: 'cm6' };
        }
      }

      // Fallback: find any large textarea in the dialog
      var dialog = Array.from(document.querySelectorAll('dialog, [role="dialog"]')).find(d =>
        d.textContent.includes('Account Scripts') || d.querySelector('textarea')
      );
      if (dialog) {
        var ta = dialog.querySelector('textarea');
        if (ta) {
          var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, ${JSON.stringify(scriptText)});
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, method: 'textarea' };
        }
      }

      return { success: false, error: 'No script editor found' };
    })()
  `).catch(e => ({ success: false, error: e.message }));

  if (!pasteResult.success) return pasteResult;

  // Look for a Save button and click it
  await new Promise(r => setTimeout(r, 500));
  const saveResult = await wc.executeJavaScript(`
    (function() {
      var buttons = document.querySelectorAll('button');
      for (var i = 0; i < buttons.length; i++) {
        var text = buttons[i].textContent.trim().toLowerCase();
        if (text === 'save' || text === 'save script' || text === 'import') {
          buttons[i].click();
          return { success: true, button: text };
        }
      }
      return { success: false, error: 'No save button found' };
    })()
  `).catch(e => ({ success: false, error: e.message }));

  console.log(`${LOG_PREFIX} Import script:`, pasteResult, saveResult);
  return { success: true, paste: pasteResult, save: saveResult };
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
