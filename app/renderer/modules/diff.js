// diff.js — Simple text diffing and patching utility for character-by-character updates

/**
 * Computes a simple character-level edit distance and returns a set of operations.
 * This is a minimal implementation of the Myers diff algorithm or similar.
 * For our purposes (story text), we mostly care about appending or small insertions.
 */
export function diffText(oldText, newText) {
  // Find common prefix
  let commonPrefixLen = 0;
  while (commonPrefixLen < oldText.length && commonPrefixLen < newText.length &&
         oldText[commonPrefixLen] === newText[commonPrefixLen]) {
    commonPrefixLen++;
  }

  // Find common suffix
  let oldSuffixIndex = oldText.length - 1;
  let newSuffixIndex = newText.length - 1;
  while (oldSuffixIndex >= commonPrefixLen && newSuffixIndex >= commonPrefixLen &&
         oldText[oldSuffixIndex] === newText[newSuffixIndex]) {
    oldSuffixIndex--;
    newSuffixIndex--;
  }

  const commonSuffixLen = oldText.length - 1 - oldSuffixIndex;

  return {
    prefixLen: commonPrefixLen,
    suffixLen: commonSuffixLen,
    removed: oldText.slice(commonPrefixLen, oldText.length - commonSuffixLen),
    added: newText.slice(commonPrefixLen, newText.length - commonSuffixLen)
  };
}

/**
 * Applies a diff to a contenteditable element while preserving cursor position.
 */
export function applyDiff(el, newText) {
  const oldText = el.innerText;
  if (oldText === newText) return;

  const selection = window.getSelection();
  let cursorOffset = -1;
  let isFocused = document.activeElement === el;

  if (isFocused && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const preCursorRange = range.cloneRange();
    preCursorRange.selectNodeContents(el);
    preCursorRange.setEnd(range.endContainer, range.endOffset);
    cursorOffset = preCursorRange.toString().length;
  }

  const diff = diffText(oldText, newText);
  
  // Apply changes via innerText (simplest for contenteditable without complex HTML)
  // If we want to be more surgical, we'd manipulate text nodes, but for story text,
  // innerText replacement is usually okay if we restore selection.
  el.innerText = newText;

  if (isFocused && cursorOffset !== -1) {
    // Restore cursor position
    // We need to account for shifts in text
    let newOffset = cursorOffset;
    
    // If cursor was after the change point, adjust it
    if (cursorOffset > diff.prefixLen) {
      const removedLen = diff.removed.length;
      const addedLen = diff.added.length;
      
      if (cursorOffset >= diff.prefixLen + removedLen) {
        // Cursor was after the entire changed block
        newOffset = cursorOffset - removedLen + addedLen;
      } else {
        // Cursor was inside the changed block — this is tricky.
        // We'll just snap to the end of the insertion.
        newOffset = diff.prefixLen + addedLen;
      }
    }
    
    restoreCursor(el, Math.min(newOffset, newText.length));
  }
}

function restoreCursor(el, offset) {
  const selection = window.getSelection();
  const range = document.createRange();
  
  let currentOffset = 0;
  let found = false;

  function traverse(node) {
    if (found) return;
    
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent.length;
      if (currentOffset + len >= offset) {
        range.setStart(node, offset - currentOffset);
        range.setEnd(node, offset - currentOffset);
        found = true;
      } else {
        currentOffset += len;
      }
    } else {
      for (let i = 0; i < node.childNodes.length; i++) {
        traverse(node.childNodes[i]);
      }
    }
  }

  traverse(el);
  
  if (!found) {
    // Fallback to end of element
    range.selectNodeContents(el);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}
