// relationship-graph.js — SVG radial character relationship graph for the LitRPG Cast panel

const RINGS = {
  party:    { r: 90,  color: '#4fc3f7', edgeColor: '#4fc3f7' },
  friendly: { r: 170, color: '#81c784', edgeColor: '#81c784' },
  neutral:  { r: 250, color: '#bbb',    edgeColor: '#555'    },
  hostile:  { r: 330, color: '#e57373', edgeColor: '#e57373' },
};

let panAbort = null;

const CENTER_X = 300;
const CENTER_Y = 300;
const VIEWBOX = '0 0 600 600';
const PROTAGONIST_R = 18;
const CHAR_R = 11;
const HUB_R = 7;

function getRing(char) {
  if (char.isPartyMember || char.partyRole === 'party-member' ||
      char.partyRole === 'companion' || char.partyRole === 'summon' ||
      char.partyRole === 'pet' || char.partyRole === 'mount') {
    return 'party';
  }
  const d = (char.disposition || '').toLowerCase();
  const nr = (char.npcRole || '').toLowerCase();
  if (d === 'friendly' || nr === 'ally' || nr === 'mentor') return 'friendly';
  if (d === 'hostile' || nr === 'rival' || nr === 'boss') return 'hostile';
  if (d === 'neutral') return 'neutral';
  return 'neutral';
}

function placeNodes(chars) {
  const rings = { party: [], friendly: [], neutral: [], hostile: [] };
  for (const char of chars) {
    rings[getRing(char)].push(char);
  }
  const nodes = [];
  for (const [ringName, members] of Object.entries(rings)) {
    const { r, color } = RINGS[ringName];
    const count = members.length;
    members.forEach((char, i) => {
      const angle = count === 1 ? -Math.PI / 2 : (2 * Math.PI * i / count) - Math.PI / 2;
      nodes.push({
        id: char.id,
        name: char.name,
        x: CENTER_X + r * Math.cos(angle),
        y: CENTER_Y + r * Math.sin(angle),
        color,
        ring: ringName,
        char,
      });
    });
  }
  return nodes;
}

function buildFactionHubs(nodes) {
  const factionMap = new Map();
  for (const node of nodes) {
    const f = node.char.faction;
    if (!f) continue;
    const key = f.toLowerCase();
    if (!factionMap.has(key)) factionMap.set(key, { name: f, members: [] });
    factionMap.get(key).members.push(node);
  }
  const hubs = [];
  for (const { name, members } of factionMap.values()) {
    if (members.length < 2) continue;
    const cx = members.reduce((s, n) => s + n.x, 0) / members.length;
    const cy = members.reduce((s, n) => s + n.y, 0) / members.length;
    // Nudge hub toward center slightly so it doesn't sit on top of nodes
    const nx = cx + (CENTER_X - cx) * 0.3;
    const ny = cy + (CENTER_Y - cy) * 0.3;
    hubs.push({ name, cx: nx, cy: ny, members });
  }
  return hubs;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function midpoint(x1, y1, x2, y2) {
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

export function renderRelationshipGraph(container, litrpgState) {
  container.innerHTML = '';

  const chars = Object.values(litrpgState.characters || {});
  if (!chars.length) {
    container.innerHTML = '<p class="rg-empty">No characters found. Run a LitRPG scan first.</p>';
    return;
  }

  // Build SVG
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', VIEWBOX);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');

  // Inner transform group (for pan/zoom)
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('id', 'rg-inner');
  svg.appendChild(g);

  const nodes = placeNodes(chars);
  const factionHubs = buildFactionHubs(nodes);

  // --- Edges: character → protagonist ---
  const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  edgeGroup.setAttribute('id', 'rg-edges');
  g.appendChild(edgeGroup);

  for (const node of nodes) {
    const ring = RINGS[node.ring];
    const isHostile = node.ring === 'hostile';
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', CENTER_X);
    line.setAttribute('y1', CENTER_Y);
    line.setAttribute('x2', node.x);
    line.setAttribute('y2', node.y);
    line.setAttribute('stroke', ring.edgeColor);
    line.setAttribute('stroke-width', '1');
    line.setAttribute('stroke-opacity', '0.4');
    if (isHostile) line.setAttribute('stroke-dasharray', '4 3');
    line.dataset.nodeId = node.id;
    line.classList.add('rg-edge');
    edgeGroup.appendChild(line);

    // Edge label: npcRole or partyRole
    const label = node.char.npcRole || (node.char.partyRole !== 'npc' ? node.char.partyRole : null);
    if (label) {
      const mid = midpoint(CENTER_X, CENTER_Y, node.x, node.y);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', mid.x);
      text.setAttribute('y', mid.y - 4);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '8');
      text.setAttribute('fill', ring.edgeColor);
      text.setAttribute('fill-opacity', '0.6');
      text.textContent = label;
      text.classList.add('rg-edge-label');
      text.dataset.nodeId = node.id;
      edgeGroup.appendChild(text);
    }
  }

  // --- Faction hub edges (dashed, thin) ---
  for (const hub of factionHubs) {
    for (const member of hub.members) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', hub.cx);
      line.setAttribute('y1', hub.cy);
      line.setAttribute('x2', member.x);
      line.setAttribute('y2', member.y);
      line.setAttribute('stroke', '#888');
      line.setAttribute('stroke-width', '0.8');
      line.setAttribute('stroke-dasharray', '2 2');
      line.setAttribute('stroke-opacity', '0.4');
      g.appendChild(line);
    }
  }

  // --- Character nodes ---
  const nodeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  nodeGroup.setAttribute('id', 'rg-nodes');
  g.appendChild(nodeGroup);

  for (const node of nodes) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', node.x);
    circle.setAttribute('cy', node.y);
    circle.setAttribute('r', CHAR_R);
    circle.setAttribute('fill', node.color);
    circle.setAttribute('stroke', '#1a1a2e');
    circle.setAttribute('stroke-width', '2');
    circle.dataset.nodeId = node.id;
    circle.classList.add('rg-node');
    nodeGroup.appendChild(circle);

    // Name label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', node.x);
    text.setAttribute('y', node.y + CHAR_R + 10);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '9');
    text.setAttribute('fill', '#ccc');
    text.textContent = node.name;
    nodeGroup.appendChild(text);
  }

  // --- Faction hub nodes ---
  for (const hub of factionHubs) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', hub.cx);
    circle.setAttribute('cy', hub.cy);
    circle.setAttribute('r', HUB_R);
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', '#888');
    circle.setAttribute('stroke-width', '1.5');
    circle.setAttribute('stroke-dasharray', '3 2');
    g.appendChild(circle);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', hub.cx);
    text.setAttribute('y', hub.cy - HUB_R - 3);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '8');
    text.setAttribute('fill', '#888');
    text.textContent = hub.name;
    g.appendChild(text);
  }

  // --- Protagonist node (drawn last, on top) ---
  const protCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  protCircle.setAttribute('cx', CENTER_X);
  protCircle.setAttribute('cy', CENTER_Y);
  protCircle.setAttribute('r', PROTAGONIST_R);
  protCircle.setAttribute('fill', '#e94560');
  protCircle.setAttribute('stroke', '#fff');
  protCircle.setAttribute('stroke-width', '2');
  g.appendChild(protCircle);

  const protLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  protLabel.setAttribute('x', CENTER_X);
  protLabel.setAttribute('y', CENTER_Y + PROTAGONIST_R + 12);
  protLabel.setAttribute('text-anchor', 'middle');
  protLabel.setAttribute('font-size', '10');
  protLabel.setAttribute('fill', '#e94560');
  protLabel.textContent = 'Protagonist';
  g.appendChild(protLabel);

  container.appendChild(svg);

  // --- Tooltip ---
  const tooltip = document.createElement('div');
  tooltip.className = 'rg-tooltip u-hidden';
  container.appendChild(tooltip);

  // --- Interaction: hover tooltip ---
  for (const circle of nodeGroup.querySelectorAll('.rg-node')) {
    circle.addEventListener('mouseenter', (e) => {
      const nodeId = e.currentTarget.dataset.nodeId;
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return;
      const c = node.char;
      const lines = [
        `<strong>${escapeHtml(c.name)}</strong>`,
        c.class ? `${escapeHtml(c.class)}${c.level ? ' Lv.' + c.level : ''}` : null,
        c.faction ? `Faction: ${escapeHtml(c.faction)}` : null,
        c.npcRelationship ? escapeHtml(c.npcRelationship) : null,
      ].filter(Boolean);
      tooltip.innerHTML = lines.join('<br>');
      tooltip.classList.remove('u-hidden');

      // Position relative to container
      const cx = e.currentTarget.getAttribute('cx') * 1;
      const cy = e.currentTarget.getAttribute('cy') * 1;
      // Approximate SVG→screen transform (viewBox 600×600, container fills 100%)
      const scaleX = container.clientWidth / 600;
      const scaleY = container.clientHeight / 600;
      let tx = cx * scaleX + 16;
      let ty = cy * scaleY - 16;
      if (tx + 160 > container.clientWidth) tx = cx * scaleX - 160;
      tooltip.style.left = tx + 'px';
      tooltip.style.top = ty + 'px';
    });
    circle.addEventListener('mouseleave', () => {
      tooltip.classList.add('u-hidden');
    });
  }

  // --- Interaction: click to highlight node's edges ---
  let selectedNodeId = null;
  for (const circle of nodeGroup.querySelectorAll('.rg-node')) {
    circle.addEventListener('click', (e) => {
      e.stopPropagation();
      const nodeId = e.currentTarget.dataset.nodeId;
      if (selectedNodeId === nodeId) {
        clearHighlight(edgeGroup, nodeGroup);
        selectedNodeId = null;
      } else {
        selectedNodeId = nodeId;
        highlightNode(nodeId, edgeGroup, nodeGroup);
      }
    });
  }
  svg.addEventListener('click', () => {
    if (selectedNodeId) {
      clearHighlight(edgeGroup, nodeGroup);
      selectedNodeId = null;
    }
  });

  // --- Pan + Zoom ---
  if (panAbort) panAbort.abort();
  panAbort = new AbortController();
  const { signal } = panAbort;

  let panActive = false;
  let panStart = { x: 0, y: 0 };
  let translate = { x: 0, y: 0 };
  let scale = 1;

  svg.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('rg-node')) return;
    panActive = true;
    panStart = { x: e.clientX - translate.x, y: e.clientY - translate.y };
    svg.style.cursor = 'grabbing';
  }, { signal });
  window.addEventListener('mousemove', (e) => {
    if (!panActive) return;
    translate.x = e.clientX - panStart.x;
    translate.y = e.clientY - panStart.y;
    applyTransform(g, translate, scale);
  }, { signal });
  window.addEventListener('mouseup', () => {
    if (panActive) { panActive = false; svg.style.cursor = ''; }
  }, { signal });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    scale = Math.max(0.5, Math.min(2.0, scale + delta));
    applyTransform(g, translate, scale);
  }, { passive: false, signal });
}

function applyTransform(g, translate, scale) {
  g.setAttribute('transform', `translate(${translate.x},${translate.y}) scale(${scale})`);
}

function highlightNode(nodeId, edgeGroup, nodeGroup) {
  for (const el of edgeGroup.querySelectorAll('.rg-edge, .rg-edge-label')) {
    if (el.dataset.nodeId === nodeId) {
      el.setAttribute('stroke-opacity', '1');
      el.setAttribute('fill-opacity', '1');
    } else {
      el.setAttribute('stroke-opacity', '0.1');
      el.setAttribute('fill-opacity', '0.1');
    }
  }
  for (const el of nodeGroup.querySelectorAll('.rg-node')) {
    el.setAttribute('opacity', el.dataset.nodeId === nodeId ? '1' : '0.3');
  }
}

function clearHighlight(edgeGroup, nodeGroup) {
  for (const el of edgeGroup.querySelectorAll('.rg-edge')) {
    el.setAttribute('stroke-opacity', '0.4');
  }
  for (const el of edgeGroup.querySelectorAll('.rg-edge-label')) {
    el.setAttribute('fill-opacity', '0.6');
  }
  for (const el of nodeGroup.querySelectorAll('.rg-node')) {
    el.setAttribute('opacity', '1');
  }
}

export function clearRelationshipGraph(container) {
  if (panAbort) { panAbort.abort(); panAbort = null; }
  container.innerHTML = '';
}
