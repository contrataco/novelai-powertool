// nai-doc.js - Read and edit NovelAI's ProseMirror document from the renderer.
//
// The functions marked INJECTED run inside the NovelAI webview: they are sent
// as source with fn.toString(), so each one must be fully self-contained (no
// imports, no module-level references). They take the EditorView as their
// first argument and are unit-tested in Node against a NovelAI-shaped schema.
//
// Offsets are plain-text offsets in doc.textBetween(0, size, '\n'), the same
// text the headless editor shows: paragraphs joined by single newlines.
//
// Every write first checks that NovelAI's text still equals the text the
// headless editor last read (`expected`). If NovelAI changed in between - an
// edit in webview mode, a generation - the write is refused instead of
// overwriting it.

/**
 * INJECTED (no view argument). NovelAI keeps its EditorView in a React ref on
 * an ancestor of .ProseMirror; pmViewDesc carries only the doc node.
 */
export function findEditorView() {
  var isView = function (v) {
    return v && typeof v === 'object' && typeof v.dispatch === 'function' && v.state && v.state.doc && v.dom;
  };
  var pm = document.querySelector('.ProseMirror');
  var el = pm;
  for (var d = 0; el && d < 8; d++, el = el.parentElement) {
    var fk = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0; });
    if (!fk) continue;
    for (var f = el[fk], h = 0; f && h < 40; f = f.return, h++) {
      for (var s = f.memoizedState, i = 0; s && i < 30; s = s.next, i++) {
        var ms = s.memoizedState;
        if (isView(ms) && ms.dom === pm) return ms;
        if (ms && isView(ms.current) && ms.current.dom === pm) return ms.current;
      }
    }
  }
  return null;
}

/**
 * INJECTED. The story as text plus mark runs:
 * { text, runs: [{ s, e, m: [markNames], link }], paraIds: [id] }.
 */
export function readRich(view) {
  var doc = view.state.doc;
  var runs = [];
  var paraIds = [];
  var parts = [];
  var t = 0;
  doc.forEach(function (para, _o, index) {
    if (index > 0) t += 1;
    paraIds.push(para.attrs && para.attrs.id != null ? String(para.attrs.id) : null);
    var local = 0;
    para.forEach(function (child) {
      if (!child.isText) return;
      var len = child.text.length;
      var names = child.marks.map(function (m) { return m.type.name; });
      var link = null;
      child.marks.forEach(function (m) { if (m.type.name === 'link' && m.attrs) link = m.attrs.id || null; });
      if (names.length) runs.push({ s: t + local, e: t + local + len, m: names, link: link });
      local += len;
    });
    parts.push(para.textContent);
    t += para.textContent.length;
  });
  return { text: parts.join('\n'), runs: runs, paraIds: paraIds };
}

/**
 * INJECTED. How much of the story the EditorView holds. NovelAI opens a story
 * with only its last paragraphs and adds earlier ones (about 30 at a time)
 * while its scroller sits at the top. Its React `document` prop lists every
 * paragraph id in `order`; the view is complete when its first paragraph is
 * the story's first. `order` itself lags behind edits, so it is only used
 * for that first id, never as the text.
 */
export function storyLoadState(view) {
  var doc = view.state.doc;
  var first = doc.firstChild;
  var storyFirstId = null;
  var storyParas = null;
  var el = view.dom;
  for (var d = 0; el && d < 12 && storyFirstId === null; d++, el = el.parentElement) {
    var fk = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0; });
    if (!fk) continue;
    for (var f = el[fk], h = 0; f && h < 60; f = f.return, h++) {
      var p = f.memoizedProps;
      var dm = p && p.document;
      if (dm && dm.order && dm.sections) {
        var order = Array.isArray(dm.order) ? dm.order : Array.from(dm.order);
        if (order.length) { storyFirstId = String(order[0]); storyParas = order.length; }
        break;
      }
    }
  }
  return {
    paras: doc.childCount,
    chars: doc.textBetween(0, doc.content.size, '\n').length,
    firstId: first && first.attrs && first.attrs.id != null ? String(first.attrs.id) : null,
    storyFirstId: storyFirstId,
    storyParas: storyParas,
  };
}

/**
 * INJECTED. Apply text edits - `args.edits` [{from, to, insert}] in offsets
 * of `expected`, or a single from/to/insert - as one transaction, last edit
 * first so earlier positions stay valid. Follows NovelAI's own marking: text
 * typed into AI or edited text becomes edit_text, anything else user_text.
 * Bold/italic/underline/strikethrough carry on from the text being replaced
 * (or the character before). A newline in an insert starts a new paragraph,
 * as pressing Enter does.
 */
export function applyTextEdit(view, args) {
  var state = view.state;
  var doc = state.doc;
  var schema = state.schema;
  var current = doc.textBetween(0, doc.content.size, '\n');
  if (current !== args.expected) return { stale: true, text: current };

  var posAt = function (off) {
    var t = 0;
    var o = 0;
    for (var i = 0; i < doc.childCount; i++) {
      var para = doc.child(i);
      var len = para.content.size;
      if (off <= t + len) return o + 1 + (off - t);
      t += len + 1;
      o += para.nodeSize;
    }
    return doc.content.size - 1;
  };

  // Marks of the text being replaced, else of the character before the
  // caret, else of the character after (start of a paragraph).
  var marksFor = function (pFrom, replacing) {
    var context = [];
    var $from = doc.resolve(pFrom);
    if (replacing && $from.nodeAfter) context = $from.nodeAfter.marks;
    else if ($from.nodeBefore) context = $from.nodeBefore.marks;
    else if ($from.nodeAfter) context = $from.nodeAfter.marks;
    var names = context.map(function (m) { return m.type.name; });
    var origin = (names.indexOf('ai_text') !== -1 || names.indexOf('edit_text') !== -1) ? 'edit_text' : 'user_text';
    var marks = [];
    if (schema.marks[origin]) marks.push(schema.marks[origin].create());
    ['bold', 'italic', 'underline', 'strikethrough'].forEach(function (n) {
      if (names.indexOf(n) !== -1 && schema.marks[n]) marks.push(schema.marks[n].create());
    });
    return marks;
  };

  var edits = (args.edits || [{ from: args.from, to: args.to, insert: args.insert }]).slice()
    .sort(function (a, b) { return b.from - a.from; });
  var Fragment = doc.content.constructor;
  var Slice = doc.slice(0, 0).constructor;
  var tr = state.tr;
  for (var k = 0; k < edits.length; k++) {
    var e = edits[k];
    var pFrom = posAt(e.from);
    var pTo = posAt(e.to);
    var marks = marksFor(pFrom, e.to > e.from);
    var lines = String(e.insert || '').split('\n');
    if (lines.length === 1) {
      if (pTo > pFrom) tr.delete(pFrom, pTo);
      if (lines[0]) tr.insert(pFrom, schema.text(lines[0], marks));
    } else {
      // Multi-line text goes in the way a paste does: one replace with an
      // open-ended slice of whole paragraphs. The first line joins the
      // paragraph it starts in, which keeps its id; the others are new
      // paragraphs with no id, which NovelAI numbers itself. (A split copies
      // the id, leaving two paragraphs sharing it, and split + insert at the
      // end of the story crashes NovelAI's plugins - both measured.)
      var paras = lines.map(function (line) {
        return schema.nodes.paragraph.create(null, line ? [schema.text(line, marks)] : null);
      });
      tr.replace(pFrom, pTo, new Slice(Fragment.fromArray(paras), 1, 1));
    }
  }
  view.dispatch(tr);
  var after = view.state.doc;
  return { ok: true, text: after.textBetween(0, after.content.size, '\n') };
}

/**
 * INJECTED. Add or remove a formatting mark over text[from, to).
 */
export function applyMarkEdit(view, args) {
  var state = view.state;
  var doc = state.doc;
  var current = doc.textBetween(0, doc.content.size, '\n');
  if (current !== args.expected) return { stale: true, text: current };
  var type = state.schema.marks[args.mark];
  if (!type || ['bold', 'italic', 'underline', 'strikethrough'].indexOf(args.mark) === -1) {
    return { error: 'unsupported mark ' + args.mark };
  }
  var posAt = function (off) {
    var t = 0;
    var o = 0;
    for (var i = 0; i < doc.childCount; i++) {
      var para = doc.child(i);
      var len = para.content.size;
      if (off <= t + len) return o + 1 + (off - t);
      t += len + 1;
      o += para.nodeSize;
    }
    return doc.content.size - 1;
  };
  var tr = state.tr;
  if (args.add) tr.addMark(posAt(args.from), posAt(args.to), type.create());
  else tr.removeMark(posAt(args.from), posAt(args.to), type);
  view.dispatch(tr);
  return { ok: true };
}

/**
 * INJECTED (no view argument). NovelAI's editor look, read from computed
 * styles. Mark classes absent from the current story are measured on a
 * detached copy of the editor's ancestor class chain appended to <body> -
 * never inside .ProseMirror, whose DOM NovelAI watches for edits.
 */
export function probeTheme() {
  var pm = document.querySelector('.ProseMirror');
  if (!pm) return null;
  var para = pm.querySelector('p') || pm;
  var cs = getComputedStyle(pm);
  var ps = getComputedStyle(para);

  var chain = [];
  for (var e = pm; e && e !== document.body; e = e.parentElement) chain.unshift(e);
  var root = null;
  var parent = null;
  chain.forEach(function (node) {
    var copy = document.createElement(node.tagName);
    copy.className = node.className;
    if (!root) {
      root = copy;
      root.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
    } else {
      parent.appendChild(copy);
    }
    parent = copy;
  });
  var p = document.createElement('p');
  p.className = para.className || 'paragraph';
  parent.appendChild(p);
  document.body.appendChild(root);

  var measure = function (cls) {
    var span = document.createElement('span');
    span.className = cls;
    span.textContent = 'x';
    p.appendChild(span);
    var s = getComputedStyle(span);
    var out = {
      color: s.color, fontStyle: s.fontStyle, fontWeight: s.fontWeight,
      textDecoration: s.textDecorationLine, background: s.backgroundColor,
    };
    p.removeChild(span);
    return out;
  };
  var marks = {};
  ['userText', 'aiText', 'editText', 'promptText', 'scriptText', 'dialogue', 'highlight', 'link', 'inlineCode']
    .forEach(function (c) { marks[c] = measure(c); });
  root.remove();

  var bg = 'rgba(0, 0, 0, 0)';
  for (var a = pm; a; a = a.parentElement) {
    var b = getComputedStyle(a).backgroundColor;
    if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') { bg = b; break; }
  }
  return {
    fontFamily: cs.fontFamily,
    fontSize: parseFloat(cs.fontSize),
    lineHeight: parseFloat(ps.lineHeight) / parseFloat(ps.fontSize),
    color: cs.color,
    textIndent: ps.textIndent,
    paragraphGap: ps.paddingBottom !== '0px' ? ps.paddingBottom : ps.marginBottom,
    background: bg,
    marks: marks,
  };
}

/**
 * Source for webview.executeJavaScript: find the view, then run `fn(view,
 * args)`. Resolves to { noView: true } when the editor is not reachable, so a
 * caller can never fall back to rewriting the DOM.
 */
export function injected(fn, args) {
  return `(function () {
    var view = (${findEditorView.toString()})();
    if (!view) return { noView: true };
    try {
      return (${fn.toString()})(view, ${JSON.stringify(args === undefined ? null : args)});
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  })()`;
}

/** Source for a no-argument injected function such as probeTheme. */
export function injectedPlain(fn) {
  return `(${fn.toString()})()`;
}
