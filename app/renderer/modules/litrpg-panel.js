// litrpg-panel.js — LitRPG RPG tab: stat sheets, quest log, party view, NPC registry, inventory, currency, status effects

import { state, bus } from './state.js';
import { saveLoreState, refreshLoreUI, loreCall } from './lore-creator.js';
import { enqueue as enqueuePortraits } from './portrait-queue.js';
import {
  rpgTab, rpgContent,
  rpgDetectionBanner, rpgEnableBtn, rpgDismissBtn,
  rpgSystemIndicator, rpgSystemType,
  rpgScanBtn, rpgSyncLorebookBtn, rpgReverseSyncBtn,
  rpgScanStatus, rpgScanPhase,
  rpgCastView,
  rpgPartySection, rpgQuestSection, rpgNpcSection,
  rpgInventorySection, rpgCurrencySection, rpgStatusSection,
  rpgFactionsSection, rpgClassesSection, rpgRacesSection,
  rpgPartyList, rpgPartyCount,
  rpgQuestListActive, rpgQuestListDone, rpgQuestCount,
  rpgNpcList, rpgNpcCount,
  rpgUpdatesList, rpgUpdatesSection, rpgUpdatesCount,
  rpgAutoScan, rpgAutoSync, rpgDisableBtn,
  rpgAcceptAllBtn, rpgRejectAllBtn,
  rpgForceReEnrich, rpgNpcSearch, rpgNpcGroupBtn,
  rpgInventoryList, rpgCurrencyList, rpgStatusEffectsList,
  rpgStatOverlay, rpgStatOverlayContent, rpgStatOverlayClose,
  rpgFactionList, rpgFactionCount,
  rpgClassList, rpgClassCount,
  rpgRaceList, rpgRaceCount,
  rpgScanSteps, rpgScanElapsed,
  rpgScanHistorySection, rpgScanHistoryCount, rpgScanHistoryList,
  rpgDetectedType,
  rpgAlbumLightbox, rpgAlbumLightboxImg, rpgAlbumPrev, rpgAlbumNext,
  rpgAlbumCounter, rpgAlbumSetActive, rpgAlbumDelete, rpgAlbumClose,
  rpgGenerateAllPortraits,
  graphToggleBtn, relationshipGraphContainer,
  webview,
} from './dom-refs.js';
import { escapeHtml, showToast } from './utils.js';
import { parseMetadataClient } from './metadata.js';

// =========================================================================
// ROLE CONSTANTS
// =========================================================================

const ROLE_CYCLE = ['party-member', 'companion', 'summon', 'pet', 'mount', 'npc'];
const PARTY_SIDE_ROLES = new Set(['party-member', 'companion', 'summon', 'pet', 'mount']);
const ROLE_LABELS = {
  'party-member': 'Party Member',
  'companion': 'Companion',
  'summon': 'Summon',
  'pet': 'Pet',
  'mount': 'Mount',
  'npc': 'NPC',
};
const ROLE_COLORS = {
  'party-member': '#4fc3f7',
  'companion': '#81c784',
  'summon': '#ce93d8',
  'pet': '#ffb74d',
  'mount': '#a1887f',
  'npc': '#90a4ae',
};

// =========================================================================
// NARRATIVE ROLE CONSTANTS (persona cards for non-LitRPG stories)
// =========================================================================

const NARRATIVE_ROLE_COLORS = {
  'protagonist': '#e94560',
  'deuteragonist': '#e94560',
  'antagonist': '#a855f7',
  'mentor': '#f59e0b',
  'love-interest': '#ec4899',
  'ally': '#4ade80',
  'rival': '#f97316',
  'default': '#4a9eff',
};

function getNarrativeRoleColor(storyFunction) {
  return NARRATIVE_ROLE_COLORS[storyFunction] || NARRATIVE_ROLE_COLORS.default;
}

// =========================================================================
// REVERSE SYNC HELPERS
// =========================================================================

// Client-side change scoring for reverse sync
function scoreChange(change) {
  const { field, before, after } = change;

  if (field === 'Level') {
    const oldVal = parseInt(before) || 0;
    const newVal = parseInt(after) || 0;
    if (newVal > oldVal) return { ...change, confidence: 'high', reason: 'Level increase' };
    if (newVal < oldVal) return { ...change, confidence: 'low', reason: 'Level decrease' };
  }
  if (field.startsWith('Stat:')) {
    const oldVal = typeof before === 'object' ? (before?.value || 0) : (parseInt(before) || 0);
    const newVal = typeof after === 'object' ? (after?.value || 0) : (parseInt(after) || 0);
    if (newVal > oldVal) return { ...change, confidence: 'high', reason: 'Stat increase' };
    if (newVal < oldVal) return { ...change, confidence: 'low', reason: 'Stat decrease' };
  }
  if (field === 'Currency' || field.startsWith('Currency:') || field === 'XP') {
    return { ...change, confidence: 'high', reason: 'Progression update' };
  }
  if (field === 'Cultivation Realm' || field === 'Cultivation Stage') {
    return { ...change, confidence: 'high', reason: 'Cultivation progression' };
  }
  if (!before && after) return { ...change, confidence: 'high', reason: 'New data added' };
  if (before && !after) return { ...change, confidence: 'low', reason: 'Data removed' };
  if (field === 'Class' || field === 'Subclass' || field === 'Race' || field === 'Role') {
    return { ...change, confidence: 'medium', reason: `${field} changed` };
  }
  return { ...change, confidence: 'medium', reason: 'Field update' };
}

function applyChangeToChar(char, scoredChange) {
  const { field, after } = scoredChange;
  if (field === 'Level') char.level = parseInt(after) || char.level;
  else if (field === 'Class') char.class = after;
  else if (field === 'Subclass') char.subclass = after;
  else if (field === 'Race') char.race = after;
  else if (field === 'Role') char.role = after;
  else if (field === 'XP') char.xp = after;
  else if (field === 'Cultivation Realm') char.cultivationRealm = after;
  else if (field === 'Cultivation Stage') char.cultivationStage = after;
  else if (field.startsWith('Stat:')) {
    const statName = field.replace('Stat: ', '');
    if (!char.stats) char.stats = {};
    char.stats[statName] = after;
  } else if (field.startsWith('Currency:')) {
    const currKey = field.replace('Currency: ', '');
    if (!char.currency) char.currency = {};
    char.currency[currKey] = after;
  }
}

// =========================================================================
// STATE HELPERS
// =========================================================================

let graphViewActive = false;

function getRpgState() {
  return state.litrpgState || {};
}

function saveLitrpgState() {
  if (!state.currentStoryId || !state.litrpgState) return;
  window.powertool.litrpgSetState(state.currentStoryId, state.litrpgState);
}

// =========================================================================
// UI REFRESH
// =========================================================================

export function refreshRpgUI() {
  const rpg = getRpgState();

  // Tab visibility — show whenever characters exist OR LitRPG is active
  if (rpgTab) {
    const litrpgState = state.litrpgState;
    const hasCharacters = litrpgState && Object.keys(litrpgState.characters || {}).length > 0;
    if (hasCharacters || rpg.enabled || rpg.detected) {
      rpgTab.classList.remove('u-hidden');
      rpgTab.textContent = (rpg.enabled || rpg.detected) ? 'Cast / RPG' : 'Cast';
    } else {
      rpgTab.classList.add('u-hidden');
    }
  }

  // Detection banner
  if (rpgDetectionBanner) {
    rpgDetectionBanner.classList.toggle('u-hidden', !(rpg.detected && !rpg.enabled && !rpg.dismissedDetection));
  }

  // System indicator
  if (rpgSystemIndicator && rpgSystemType) {
    if (rpg.enabled && rpg.systemType) {
      rpgSystemIndicator.classList.remove('u-hidden');
      const typeLabels = {
        generic: 'Generic RPG', dnd: 'D&D Style', cultivation: 'Cultivation',
        gamelit: 'GameLit', mmorpg: 'MMORPG', survival: 'Survival',
      };
      rpgSystemType.textContent = `System: ${typeLabels[rpg.systemType] || rpg.systemType}`;
    } else {
      rpgSystemIndicator.classList.add('u-hidden');
    }
  }

  // Scan/sync buttons visibility
  if (rpgScanBtn) rpgScanBtn.disabled = !rpg.enabled || state.litrpgScanning;
  if (rpgSyncLorebookBtn) rpgSyncLorebookBtn.disabled = !rpg.enabled;
  if (rpgReverseSyncBtn) rpgReverseSyncBtn.disabled = !rpg.enabled;

  // Graph toggle button — only visible when LitRPG is enabled with characters
  if (graphToggleBtn) {
    const hasChars = Object.keys(rpg.characters || {}).length > 0;
    graphToggleBtn.classList.toggle('u-hidden', !(rpg.enabled && hasChars));
    graphToggleBtn.textContent = graphViewActive ? 'List' : 'Graph';
  }

  // Settings persistence (Phase 5A)
  if (rpgAutoScan) rpgAutoScan.checked = rpg.autoScan !== false;
  if (rpgAutoSync) rpgAutoSync.checked = !!rpg.autoSync;

  const isLitRPG = rpg.enabled || rpg.detected;

  // Toggle between persona cast view and LitRPG sections
  const rpgOnlySections = [
    rpgPartySection, rpgQuestSection, rpgNpcSection,
    rpgInventorySection, rpgCurrencySection, rpgStatusSection,
    rpgFactionsSection, rpgClassesSection, rpgRacesSection,
  ];
  const hideRpgSections = !isLitRPG || graphViewActive;
  for (const el of rpgOnlySections) {
    if (el) el.classList.toggle('u-hidden', hideRpgSections);
  }
  if (rpgCastView) rpgCastView.classList.toggle('u-hidden', isLitRPG || graphViewActive);
  if (relationshipGraphContainer) {
    relationshipGraphContainer.classList.toggle('u-hidden', !graphViewActive);
  }

  if (isLitRPG) {
    // Party view
    renderParty(rpg);

    // Quest log
    renderQuests(rpg);

    // NPC registry
    renderNPCs(rpg);

    // Pending updates
    renderPendingUpdates(rpg);

    // New sections (Phase 5G)
    renderInventory(rpg);
    renderCurrency(rpg);
    renderStatusEffects(rpg);

    // Entity collections
    renderFactions(rpg);
    renderClasses(rpg);
    renderRaces(rpg);

    // Scan history (Phase 6.5)
    renderScanHistory(rpg);
  } else {
    // Persona-based cast view for non-LitRPG stories
    renderPersonaCast(rpg);
  }
}

// =========================================================================
// PERSONA CAST RENDERING (non-LitRPG stories)
// =========================================================================

function buildPersonaCardHTML(char) {
  const storyFunction = char.narrative?.storyFunction || '';
  const importance = char.narrative?.importance || '';
  const roleColor = getNarrativeRoleColor(storyFunction);
  const traits = (char.persona?.personalityTraits || []).slice(0, 3).join(', ');
  const roleLabel = storyFunction
    ? storyFunction.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : '';

  return `
    <div class="rpg-character-card-v2 persona-card" data-char-id="${escapeHtml(char.id)}" style="--role-color:${roleColor};">
      <div class="rpg-card-bg-gradient"></div>
      <div class="rpg-portrait-ring">
        <div class="rpg-portrait-inner">
          ${char._thumbnailData
            ? `<img src="data:image/png;base64,${char._thumbnailData}" alt="${escapeHtml(char.name)}">`
            : `<span class="rpg-portrait-initial">${escapeHtml((char.name || '?')[0].toUpperCase())}</span>`}
        </div>
      </div>
      <div class="rpg-char-info" style="position:relative;z-index:1;">
        <div class="rpg-char-name">${escapeHtml(char.name)}</div>
        ${traits ? `<div class="persona-traits">${escapeHtml(traits)}</div>` : ''}
        <div class="persona-badges">
          ${roleLabel ? `<span class="persona-role-badge" style="background:${roleColor}22;color:${roleColor};border-color:${roleColor}55;">${escapeHtml(roleLabel)}</span>` : ''}
          ${importance ? `<span class="persona-importance-badge">${escapeHtml(importance)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function buildCastSectionHTML(title, chars, open = false) {
  if (chars.length === 0) return '';
  const openAttr = open ? ' open' : '';
  const cardsHTML = chars
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(char => buildPersonaCardHTML(char))
    .join('');
  return `
    <details class="cast-section lore-section"${openAttr}>
      <summary>${escapeHtml(title)} <span class="count-badge count">(${chars.length})</span></summary>
      <div class="rpg-party-grid cast-grid">${cardsHTML}</div>
    </details>`;
}

function renderPersonaCast(rpg) {
  if (!rpgCastView) return;
  const allChars = Object.values(rpg.characters || {});

  if (allChars.length === 0) {
    rpgCastView.innerHTML = `<div class="rpg-party-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <div>No characters yet. Run a <b>Lore Scan</b> to populate your cast from the story.</div>
    </div>`;
    return;
  }

  // Partition into sections
  const protagonists = allChars.filter(c =>
    c.narrative?.storyFunction === 'protagonist' ||
    c.narrative?.storyFunction === 'deuteragonist'
  );
  const major = allChars.filter(c =>
    !protagonists.includes(c) &&
    c.narrative?.importance === 'major'
  );
  const supporting = allChars.filter(c =>
    !protagonists.includes(c) &&
    c.narrative?.importance === 'supporting'
  );
  const other = allChars.filter(c =>
    !protagonists.includes(c) &&
    c.narrative?.importance !== 'major' &&
    c.narrative?.importance !== 'supporting'
  );

  let html = '';

  // Protagonist section (always open, featured)
  if (protagonists.length > 0) {
    const cardsHTML = protagonists
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map(char => buildPersonaCardHTML(char))
      .join('');
    html += `
      <div class="cast-section cast-protagonist-section">
        <h4 class="cast-section-header">Protagonist</h4>
        <div class="rpg-party-grid cast-grid">${cardsHTML}</div>
      </div>`;
  }

  html += buildCastSectionHTML('Major Characters', major, /* open= */ true);
  html += buildCastSectionHTML('Supporting Characters', supporting, /* open= */ false);
  html += buildCastSectionHTML('Other Characters', other, /* open= */ false);

  rpgCastView.innerHTML = html;

  // Wire click handlers — open stat overlay for all persona cards
  rpgCastView.querySelectorAll('.rpg-character-card-v2').forEach(card => {
    card.addEventListener('click', () => openStatOverlay(card.dataset.charId, rpg));
  });
}

// =========================================================================
// PARTY RENDERING
// =========================================================================

function renderParty(rpg) {
  if (!rpgPartyList) return;
  const partyMembers = (rpg.party?.members || [])
    .map(id => rpg.characters?.[id])
    .filter(Boolean);

  rpgPartyCount.textContent = `(${partyMembers.length})`;

  if (partyMembers.length === 0) {
    rpgPartyList.innerHTML = `<div class="rpg-party-empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L4 7v6c0 5.5 3.4 10.7 8 12 4.6-1.3 8-6.5 8-12V7l-8-5z"/></svg>
      <div>No party members detected. Run a <b>Lore Scan</b> — party members are identified automatically from your story.</div>
    </div>`;
    return;
  }

  rpgPartyList.innerHTML = partyMembers.map(char => {
    const roleColor = ROLE_COLORS[char.partyRole || 'party-member'] || ROLE_COLORS['party-member'];
    const roleLabel = ROLE_LABELS[char.partyRole || 'party-member'] || 'Party Member';
    const xpPct = (char.xp?.current != null && char.xp?.needed) ? Math.min(100, (char.xp.current / char.xp.needed) * 100) : 0;
    return `
    <div class="rpg-character-card-v2" data-char-id="${escapeHtml(char.id)}" style="--role-color:${roleColor};">
      <div class="rpg-card-bg-gradient"></div>
      <div class="rpg-portrait-ring">
        <div class="rpg-portrait-inner">
          ${char._thumbnailData
            ? `<img src="data:image/png;base64,${char._thumbnailData}" alt="${escapeHtml(char.name)}">`
            : `<span class="rpg-portrait-initial">${escapeHtml((char.name || '?')[0].toUpperCase())}</span>`}
        </div>
        ${char.level ? `<span class="rpg-level-badge">${char.level}</span>` : ''}
      </div>
      <div class="rpg-char-info" style="position:relative;z-index:1;">
        <div class="rpg-char-name">${escapeHtml(char.name)}</div>
        <div class="rpg-char-class">${escapeHtml(char.class || 'Unknown Class')}${char.role ? ` (${escapeHtml(char.role)})` : ''}</div>
        <span class="rpg-card-role-dot">${escapeHtml(roleLabel)}</span>
      </div>
      ${xpPct > 0 ? `<div class="rpg-card-xp-bar"><div class="rpg-card-xp-fill" style="width:${xpPct}%;"></div></div>` : ''}
    </div>`;
  }).join('');

  // Party card click handlers delegated to rpgPartyList in init()
}

// =========================================================================
// STAT SHEET OVERLAY (Phase 5H)
// =========================================================================

export function openStatOverlay(charId, rpg) {
  const char = rpg?.characters?.[charId];
  if (!char || !rpgStatOverlay || !rpgStatOverlayContent) return;

  rpgStatOverlayContent.innerHTML = buildStatSheetHTML(char);
  rpgStatOverlay.classList.remove('u-hidden');
  rpgStatOverlay.classList.add('is-open');
  rpgStatOverlay.dataset.charId = charId;

  // Wire edit / portrait buttons inside overlay
  const editBtn = rpgStatOverlayContent.querySelector('.rpg-stat-edit-btn');
  const saveBtn = rpgStatOverlayContent.querySelector('.rpg-stat-save-btn');
  const cancelBtn = rpgStatOverlayContent.querySelector('.rpg-stat-cancel-btn');
  const genBtn = rpgStatOverlayContent.querySelector('.rpg-portrait-generate');
  const uploadBtn = rpgStatOverlayContent.querySelector('.rpg-portrait-upload');
  const deleteBtn = rpgStatOverlayContent.querySelector('.rpg-char-delete-btn');

  if (editBtn) editBtn.addEventListener('click', () => enterEditMode(charId));
  if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(charId));
  if (cancelBtn) cancelBtn.addEventListener('click', () => openStatOverlay(charId, getRpgState()));
  if (genBtn) genBtn.addEventListener('click', () => generatePortrait(charId));
  if (uploadBtn) uploadBtn.addEventListener('click', () => uploadPortrait(charId));
  if (deleteBtn) deleteBtn.addEventListener('click', () => deleteCharacter(charId));

  // Wire role cycle chip
  const roleChip = rpgStatOverlayContent.querySelector('.rpg-role-chip-styled');
  if (roleChip) roleChip.addEventListener('click', () => cycleRole(charId));

  // Load album
  loadAlbumStrip(charId);
}

function closeStatOverlay() {
  if (editDirty) {
    // Check if confirm bar already shown
    const existing = rpgStatOverlayContent?.querySelector('.rpg-confirm-bar');
    if (existing) return;
    const bar = document.createElement('div');
    bar.className = 'rpg-confirm-bar';
    bar.innerHTML = `<span>Unsaved changes.</span>
      <button class="btn-reject btn-xs">Discard</button>
      <button class="btn-accept btn-xs">Keep Editing</button>`;
    bar.querySelector('.btn-reject').addEventListener('click', () => {
      editDirty = false;
      if (rpgStatOverlay) { rpgStatOverlay.classList.remove('is-open'); rpgStatOverlay.classList.add('u-hidden'); }
    });
    bar.querySelector('.btn-accept').addEventListener('click', () => bar.remove());
    rpgStatOverlayContent?.prepend(bar);
    return;
  }
  if (rpgStatOverlay) { rpgStatOverlay.classList.remove('is-open'); rpgStatOverlay.classList.add('u-hidden'); }
}

async function cycleRole(charId) {
  const rpg = getRpgState();
  const char = rpg.characters?.[charId];
  if (!char) return;

  // Determine current role and cycle to next
  const currentRole = char.partyRole || (char.isPartyMember ? 'party-member' : (char.isNPC ? 'npc' : null));
  const currentIdx = currentRole ? ROLE_CYCLE.indexOf(currentRole) : -1;
  const nextRole = ROLE_CYCLE[(currentIdx + 1) % ROLE_CYCLE.length];

  // Update character flags
  const isPartySide = PARTY_SIDE_ROLES.has(nextRole);
  char.isPartyMember = isPartySide;
  char.isNPC = !isPartySide;
  char.partyRole = nextRole;

  // Update party members list
  rpg.party.members = Object.entries(rpg.characters)
    .filter(([, c]) => c.isPartyMember)
    .map(([id]) => id);
  rpg.party.lastUpdated = Date.now();

  // Save state
  state.litrpgState = rpg;
  saveLitrpgState();

  // Write @role metadata to lorebook entry
  if (char.loreEntryName) {
    try {
      await applyRoleUpdatesToLorebook([{ charName: char.name, loreEntryName: char.loreEntryName, role: nextRole }]);
    } catch (err) {
      console.error(`[LitRPG] Failed to write @role for ${char.name}:`, err);
    }
  }

  // Re-render stat sheet and refresh UI
  openStatOverlay(charId, getRpgState());
  refreshRpgUI();
}

function buildStatSheetHTML(char) {
  const statsHTML = Object.entries(char.stats || {}).map(([name, s]) =>
    `<div class="rpg-stat"><span class="stat-name">${escapeHtml(name)}</span><span class="stat-value">${s.value}${s.modifier != null ? ` (${s.modifier >= 0 ? '+' : ''}${s.modifier})` : ''}</span></div>`
  ).join('');

  const abilitiesHTML = (char.abilities || []).map(a => {
    let tags = '';
    if (a.category) tags += ` <span class="rpg-ability-cat rpg-ability-cat-${a.category}">${escapeHtml(a.category)}</span>`;
    if (a.cooldown) tags += ` <span class="rpg-ability-cd">CD: ${escapeHtml(a.cooldown)}</span>`;
    if (a.proficiency) tags += ` <span class="rpg-ability-prof">${escapeHtml(a.proficiency)}</span>`;
    return `<div class="rpg-ability">${escapeHtml(a.name)}${a.level ? ` (Lv.${a.level})` : ''}${tags} — ${escapeHtml(a.description || '')}${a.cost ? ` [${escapeHtml(a.cost)}]` : ''}</div>`;
  }).join('');

  const equipmentHTML = (char.equipment || []).map(e => {
    let extras = '';
    if (e.bonuses) extras += ` <span class="rpg-equip-bonus">{${escapeHtml(e.bonuses)}}</span>`;
    if (e.setName) extras += ` <span class="rpg-equip-set">[${escapeHtml(e.setName)}]</span>`;
    const rarityClass = e.rarity && e.rarity !== 'unknown' ? ` rarity-${e.rarity}` : '';
    return `<div class="rpg-equip-item${rarityClass}">${escapeHtml(e.name)} [${escapeHtml(e.slot || 'other')}]${e.rarity && e.rarity !== 'unknown' ? ` <span class="rpg-rarity rpg-rarity-${e.rarity}">${e.rarity}</span>` : ''}${extras} — ${escapeHtml(e.description || '')}</div>`;
  }).join('');

  const inventoryHTML = (char.inventory || []).map(i =>
    `<div class="rpg-inv-item">${escapeHtml(i.name)} x${i.quantity || 1} <span class="detail-muted">(${i.type || 'other'})</span>${i.rarity ? ` <span class="rpg-rarity rpg-rarity-${i.rarity}">${i.rarity}</span>` : ''}</div>`
  ).join('');

  const currencyHTML = Object.entries(char.currency || {}).length > 0
    ? `<div class="rpg-section-card rpg-currency-section"><h4>Currency</h4><div class="flex-row-wrap">${Object.entries(char.currency).map(([unit, amount]) =>
        `<div class="rpg-currency-card"><span class="rpg-currency-amount">${amount}</span><span class="rpg-currency-unit">${escapeHtml(unit)}</span></div>`
      ).join('')}</div></div>`
    : '';

  const statusHTML = (char.statusEffects || []).length > 0
    ? `<div class="rpg-section-card rpg-status-section"><h4>Status Effects</h4><div class="rpg-status-tag-row">${(char.statusEffects || []).map(s =>
        `<span class="rpg-status-tag rpg-status-${s.type || 'buff'}">${s.type === 'buff' ? '&#9650;' : s.type === 'debuff' ? '&#9660;' : '&#9679;'} ${escapeHtml(s.name)}${s.duration ? ` [${escapeHtml(s.duration)}]` : ''}</span>`
      ).join('')}</div></div>`
    : '';

  const xpPct = (char.xp?.current != null && char.xp?.needed) ? Math.min(100, (char.xp.current / char.xp.needed) * 100) : 0;
  const xpHTML = char.xp && (char.xp.current != null || char.xp.needed != null)
    ? `<div class="rpg-xp-bar-v2"><div class="rpg-xp-fill" style="width:${xpPct}%;"></div><span class="rpg-xp-text">XP: ${char.xp.current ?? '?'} / ${char.xp.needed ?? '?'} (${Math.round(xpPct)}%)</span></div>`
    : '';

  const cultivationHTML = char.cultivationRealm
    ? `<div class="cultivation-tag">Cultivation: ${escapeHtml(char.cultivationRealm)}${char.cultivationStage ? ` (${escapeHtml(char.cultivationStage)})` : ''}</div>`
    : '';

  // Role chip
  const currentRole = char.partyRole || (char.isPartyMember ? 'party-member' : (char.isNPC ? 'npc' : null));
  const roleLabel = currentRole ? (ROLE_LABELS[currentRole] || currentRole) : 'Unclassified';
  const roleColor = currentRole ? (ROLE_COLORS[currentRole] || '#666') : '#666';
  const roleChipHTML = `<button class="rpg-role-chip-styled" data-role="${escapeHtml(currentRole || '')}" title="Click to cycle role" style="--role-color:${roleColor};">${escapeHtml(roleLabel)}</button>`;

  // NPC info section
  const DISPOSITION_COLORS = { friendly: '#81c784', neutral: '#ffd54f', hostile: '#ff6b6b', unknown: '#90a4ae' };
  const npcInfoHTML = char.isNPC ? `
    <div class="rpg-section-card rpg-npc-info-box">
      <div class="rpg-npc-info-label">NPC Info</div>
      <div class="flex-row-wrap">
        ${char.disposition ? `<span class="rpg-disposition-pill" style="--disp-color:${DISPOSITION_COLORS[char.disposition] || DISPOSITION_COLORS.unknown};">${escapeHtml(char.disposition)}</span>` : ''}
        ${char.npcRole ? `<span class="detail-muted" style="color:#a0a0ff;">${escapeHtml(char.npcRole)}</span>` : ''}
      </div>
      ${char.faction ? `<div class="info-line" style="color:var(--cat-faction);">Faction: ${escapeHtml(char.faction)}</div>` : ''}
      ${char.npcRelationship ? `<div class="info-line">Relationship: ${escapeHtml(char.npcRelationship)}</div>` : ''}
    </div>
  ` : '';

  // ---- Persona section ----
  const persona = char.persona || {};
  const traits = persona.personalityTraits || [];
  const motivations = persona.motivations || [];
  const fears = persona.fears || [];
  const flaws = persona.flaws || [];
  const hasPersonaData = traits.length > 0 || motivations.length > 0 || fears.length > 0 ||
    flaws.length > 0 || persona.speechStyle || persona.emotionalState;

  const personaSectionHTML = hasPersonaData ? `
    <div class="persona-section stat-section">
      <h4>Personality</h4>
      ${traits.length > 0 ? `<div class="persona-traits-list">${traits.map(t => `<span class="persona-chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${motivations.length > 0 ? `<div class="persona-field" data-field="motivations"><label>Motivations</label><ul class="persona-list">${motivations.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul></div>` : ''}
      ${fears.length > 0 ? `<div class="persona-field" data-field="fears"><label>Fears</label><ul class="persona-list">${fears.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
      ${flaws.length > 0 ? `<div class="persona-field" data-field="flaws"><label>Flaws</label><ul class="persona-list">${flaws.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
      ${persona.speechStyle ? `<div class="persona-field" data-field="speechStyle"><label>Speech Style</label><span class="persona-badge">${escapeHtml(persona.speechStyle)}</span></div>` : ''}
      ${persona.emotionalState ? `<div class="persona-field" data-field="emotionalState"><label>Current State</label><span class="persona-badge mood">${escapeHtml(persona.emotionalState)}</span></div>` : ''}
    </div>
  ` : '';

  // ---- Narrative section ----
  const narrative = char.narrative || {};
  const narrativeStoryFunction = narrative.storyFunction || '';
  const narrativeImportance = narrative.importance || '';
  const goals = narrative.goals || [];
  const conflicts = narrative.conflicts || [];
  const allegiances = narrative.allegiances || [];
  const hasNarrativeData = narrativeStoryFunction || narrativeImportance || goals.length > 0 ||
    conflicts.length > 0 || allegiances.length > 0 || narrative.arcType;

  const narrativeRoleColor = getNarrativeRoleColor(narrativeStoryFunction);
  const narrativeRoleLabel = narrativeStoryFunction
    ? narrativeStoryFunction.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : '';

  const arcPct = typeof narrative.arcProgression === 'number' ? Math.min(100, Math.max(0, narrative.arcProgression)) : null;

  const narrativeSectionHTML = hasNarrativeData ? `
    <div class="narrative-section stat-section">
      <h4>Story Role</h4>
      ${(narrativeRoleLabel || narrativeImportance) ? `
        <div class="narrative-role-display">
          ${narrativeRoleLabel ? `<span class="narrative-role-badge" style="background:${narrativeRoleColor}22;color:${narrativeRoleColor};border:1px solid ${narrativeRoleColor}55;">${escapeHtml(narrativeRoleLabel)}</span>` : ''}
          ${narrativeImportance ? `<span class="persona-importance-badge">${escapeHtml(narrativeImportance)}</span>` : ''}
        </div>
      ` : ''}
      ${goals.length > 0 ? `<div class="persona-field" data-field="goals"><label>Goals</label><ul class="persona-list">${goals.map(g => `<li>${escapeHtml(g)}</li>`).join('')}</ul></div>` : ''}
      ${conflicts.length > 0 ? `<div class="persona-field" data-field="conflicts"><label>Conflicts</label><ul class="persona-list">${conflicts.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul></div>` : ''}
      ${allegiances.length > 0 ? `<div class="persona-field" data-field="allegiances"><label>Allegiances</label><div class="persona-traits-list">${allegiances.map(a => `<span class="persona-chip allegiance">${escapeHtml(a)}</span>`).join('')}</div></div>` : ''}
      ${narrative.arcType ? `
        <div class="persona-field" data-field="arcType">
          <label>Character Arc</label>
          <span class="persona-badge">${escapeHtml(narrative.arcType)}</span>
          ${arcPct !== null ? `
            <div class="arc-progress-bar">
              <div class="arc-progress-fill" style="width:${arcPct}%;"></div>
              <span class="arc-progress-label">${arcPct}%</span>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  ` : '';

  return `
    <div class="rpg-stat-header">
      <div class="rpg-portrait-large-v2" style="--role-color:${roleColor};border: 3px solid var(--role-color); border-radius: 8px;">
        ${char._portraitData
          ? `<img src="data:image/png;base64,${char._portraitData}" alt="${escapeHtml(char.name)}">`
          : char._thumbnailData
            ? `<img src="data:image/png;base64,${char._thumbnailData}" alt="${escapeHtml(char.name)}">`
            : `<span class="rpg-portrait-initial rpg-portrait-initial-lg">${escapeHtml((char.name || '?')[0].toUpperCase())}</span>`}
        <div class="rpg-portrait-actions">
          <button class="rpg-portrait-generate" title="Generate Portrait"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></button>
          <button class="rpg-portrait-upload" title="Upload Portrait"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg></button>
        </div>
      </div>
      <div style="flex:1;">
        <h3 class="rpg-stat-title">${escapeHtml(char.name)}</h3>
        <div class="rpg-stat-subtitle">${char.level ? `Level ${char.level} ` : ''}${escapeHtml(char.class || '')}${char.subclass ? ` / ${escapeHtml(char.subclass)}` : ''}${char.race ? ` (${escapeHtml(char.race)})` : ''}</div>
        ${roleChipHTML}
        ${cultivationHTML}
        ${xpHTML}
      </div>
      <div class="rpg-stat-actions">
        <button class="rpg-stat-edit-btn" title="Edit"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="rpg-char-delete-btn" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
      </div>
    </div>
    <details class="rpg-album-section" style="margin:8px 0;">
      <summary class="section-summary" style="user-select:none;">Image Album <span class="rpg-album-count"></span></summary>
      <div class="rpg-album-strip flex-row-wrap" style="padding:6px 0;min-height:40px;">
        <div class="empty-state-sm">Loading...</div>
      </div>
    </details>
    ${personaSectionHTML}
    ${narrativeSectionHTML}
    ${npcInfoHTML}
    ${currencyHTML}
    ${statusHTML}
    ${statsHTML ? `<div class="rpg-section-card"><h4>Stats</h4><div class="rpg-stat-grid">${statsHTML}</div></div>` : ''}
    ${abilitiesHTML ? `<div class="rpg-section-card"><h4>Abilities</h4>${abilitiesHTML}</div>` : ''}
    ${equipmentHTML ? `<div class="rpg-section-card"><h4>Equipment</h4>${equipmentHTML}</div>` : ''}
    ${inventoryHTML ? `<div class="rpg-section-card"><h4>Inventory</h4>${inventoryHTML}</div>` : ''}
  `;
}

// =========================================================================
// MANUAL STAT EDITING (Phase 5E)
// =========================================================================

let editDirty = false;

function markEditDirty() { editDirty = true; }

// INPUT_STYLE removed — all inputs/selects now use .rpg-edit-input CSS class
const SLOT_OPTIONS = ['weapon','off-hand','shield','helmet','armor','legs','boots','gloves','ring','amulet','cloak','belt','bracers','earring','trinket','accessory','other'];
const RARITY_OPTIONS = ['common','uncommon','rare','epic','legendary','unknown'];
const ABILITY_CATEGORY_OPTIONS = ['','combat','magic','crafting','social','utility','other'];
const STATUS_TYPE_OPTIONS = ['buff','debuff','condition'];
const NARRATIVE_ROLES_OPTIONS = ['','protagonist','deuteragonist','antagonist','rival','mentor','love-interest','ally','foil','comic-relief','herald','threshold-guardian','trickster','shapeshifter','shadow','catalyst','background'];
const ARC_TYPES_OPTIONS = ['','growth','corruption','redemption','coming-of-age','disillusionment','education','revenge','sacrifice','transformation','static'];
const IMPORTANCE_OPTIONS = ['','major','supporting','minor','background'];

function buildSelectHTML(name, options, selected) {
  return `<select data-field="${name}" class="rpg-edit-input">${options.map(o => `<option value="${o}"${o === selected ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
}

// Build editable chip list HTML (for personality traits, allegiances)
function buildEditChipListHTML(containerId, items) {
  const chips = items.map((item, idx) =>
    `<span class="persona-chip edit-chip" data-idx="${idx}">${escapeHtml(item)}<button class="edit-chip-remove" data-idx="${idx}" title="Remove">✕</button></span>`
  ).join('');
  return `
    <div class="edit-chip-container" id="${containerId}">
      ${chips}
      <input type="text" class="rpg-edit-input edit-chip-input" placeholder="Add..." style="width:80px;margin:2px;">
    </div>
  `;
}

// Build editable list-as-textarea HTML (for motivations, fears, flaws, goals, conflicts)
function buildEditListTextareaHTML(id, items) {
  return `<textarea id="${id}" class="rpg-edit-input" rows="3" style="width:100%;resize:vertical;">${escapeHtml(items.join('\n'))}</textarea>`;
}

function enterEditMode(charId) {
  const rpg = getRpgState();
  const char = rpg.characters?.[charId];
  if (!char || !rpgStatOverlayContent) return;

  const statsInputs = Object.entries(char.stats || {}).map(([name, s]) =>
    `<div class="rpg-stat"><span class="stat-name">${escapeHtml(name)}</span><input type="number" class="rpg-edit-stat rpg-edit-input" data-stat="${escapeHtml(name)}" value="${s.value}" style="width:50px;"></div>`
  ).join('');

  // Abilities section (with category, cooldown, proficiency)
  const abilitiesRows = (char.abilities || []).map((a, idx) =>
    `<div class="rpg-edit-row" data-section="abilities" data-idx="${idx}">
      <input type="text" data-field="name" value="${escapeHtml(a.name)}" placeholder="Name" class="rpg-edit-input" style="flex:2;">
      <input type="number" data-field="level" value="${a.level || ''}" placeholder="Lv" class="rpg-edit-input" style="width:40px;">
      ${buildSelectHTML('category', ABILITY_CATEGORY_OPTIONS, a.category || '')}
      <input type="text" data-field="description" value="${escapeHtml(a.description || '')}" placeholder="Description" class="rpg-edit-input" style="flex:3;">
      <input type="text" data-field="cooldown" value="${escapeHtml(a.cooldown || '')}" placeholder="Cooldown" class="rpg-edit-input" style="width:70px;">
      <input type="text" data-field="proficiency" value="${escapeHtml(a.proficiency || '')}" placeholder="Proficiency" class="rpg-edit-input" style="width:80px;">
      <button class="rpg-edit-remove-btn" title="Remove">✕</button>
    </div>`
  ).join('');

  // Equipment section (with bonuses, setName)
  const equipmentRows = (char.equipment || []).map((e, idx) =>
    `<div class="rpg-edit-row" data-section="equipment" data-idx="${idx}">
      <input type="text" data-field="name" value="${escapeHtml(e.name)}" placeholder="Name" class="rpg-edit-input" style="flex:2;">
      ${buildSelectHTML('slot', SLOT_OPTIONS, e.slot || 'other')}
      ${buildSelectHTML('rarity', RARITY_OPTIONS, e.rarity || 'unknown')}
      <input type="text" data-field="bonuses" value="${escapeHtml(e.bonuses || '')}" placeholder="Bonuses" class="rpg-edit-input" style="width:80px;">
      <input type="text" data-field="setName" value="${escapeHtml(e.setName || '')}" placeholder="Set Name" class="rpg-edit-input" style="width:80px;">
      <input type="text" data-field="description" value="${escapeHtml(e.description || '')}" placeholder="Description" class="rpg-edit-input" style="flex:2;">
      <button class="rpg-edit-remove-btn" title="Remove">✕</button>
    </div>`
  ).join('');

  // Inventory section (with rarity)
  const inventoryRows = (char.inventory || []).map((i, idx) =>
    `<div class="rpg-edit-row" data-section="inventory" data-idx="${idx}">
      <input type="text" data-field="name" value="${escapeHtml(i.name)}" placeholder="Name" class="rpg-edit-input" style="flex:2;">
      <input type="number" data-field="quantity" value="${i.quantity || 1}" placeholder="Qty" class="rpg-edit-input" style="width:45px;">
      ${buildSelectHTML('type', ['consumable','material','quest_item','other'], i.type || 'other')}
      ${buildSelectHTML('rarity', ['','common','uncommon','rare','epic','legendary'], i.rarity || '')}
      <button class="rpg-edit-remove-btn" title="Remove">✕</button>
    </div>`
  ).join('');

  // Currency section
  const currencyRows = Object.entries(char.currency || {}).map(([unit, amount], idx) =>
    `<div class="rpg-edit-row" data-section="currency" data-idx="${idx}">
      <input type="text" data-field="unit" value="${escapeHtml(unit)}" placeholder="Currency" class="rpg-edit-input" style="flex:1;">
      <input type="number" data-field="amount" value="${amount}" placeholder="Amount" class="rpg-edit-input" style="width:80px;">
      <button class="rpg-edit-remove-btn" title="Remove">✕</button>
    </div>`
  ).join('');

  // Status effects section
  const statusRows = (char.statusEffects || []).map((s, idx) =>
    `<div class="rpg-edit-row" data-section="statusEffects" data-idx="${idx}">
      <input type="text" data-field="name" value="${escapeHtml(s.name)}" placeholder="Name" class="rpg-edit-input" style="flex:2;">
      ${buildSelectHTML('type', STATUS_TYPE_OPTIONS, s.type || 'buff')}
      <input type="text" data-field="duration" value="${escapeHtml(s.duration || '')}" placeholder="Duration" class="rpg-edit-input" style="flex:1;">
      <button class="rpg-edit-remove-btn" title="Remove">✕</button>
    </div>`
  ).join('');

  rpgStatOverlayContent.innerHTML = `
    <div class="rpg-stat-header">
      <div style="flex:1;">
        <div class="mb-sm">
          <label class="rpg-edit-label">Name</label>
          <input type="text" id="rpgEditName" value="${escapeHtml(char.name)}" class="rpg-edit-input" style="width:100%;font-size:12px;">
        </div>
        <div class="flex-row mb-sm">
          <div style="flex:1;">
            <label class="rpg-edit-label">Class</label>
            <input type="text" id="rpgEditClass" value="${escapeHtml(char.class || '')}" class="rpg-edit-input" style="width:100%;">
          </div>
          <div style="flex:1;">
            <label class="rpg-edit-label">Subclass</label>
            <input type="text" id="rpgEditSubclass" value="${escapeHtml(char.subclass || '')}" class="rpg-edit-input" style="width:100%;">
          </div>
        </div>
        <div class="flex-row mb-sm">
          <div style="flex:1;">
            <label class="rpg-edit-label">Level</label>
            <input type="number" id="rpgEditLevel" value="${char.level || ''}" class="rpg-edit-input" style="width:100%;">
          </div>
          <div style="flex:1;">
            <label class="rpg-edit-label">Race</label>
            <input type="text" id="rpgEditRace" value="${escapeHtml(char.race || '')}" class="rpg-edit-input" style="width:100%;">
          </div>
        </div>
      </div>
    </div>
    ${char.isNPC ? `
    <details class="lore-section mt-sm" open>
      <summary class="section-summary">NPC Info</summary>
      <div class="flex-row" style="margin-top:4px;margin-bottom:4px;">
        <div style="flex:1;">
          <label class="rpg-edit-label">Disposition</label>
          ${buildSelectHTML('npcDisposition', ['friendly','neutral','hostile','unknown'], char.disposition || 'unknown')}
        </div>
        <div style="flex:1;">
          <label class="rpg-edit-label">NPC Role</label>
          ${buildSelectHTML('npcRoleField', ['mentor','rival','shopkeeper','quest_giver','boss','ally','other'], char.npcRole || 'other')}
        </div>
      </div>
      <div class="mb-xs">
        <label class="rpg-edit-label">Faction</label>
        <input type="text" id="rpgEditFaction" value="${escapeHtml(char.faction || '')}" class="rpg-edit-input" style="width:100%;">
      </div>
      <div>
        <label class="rpg-edit-label">Relationship to Party</label>
        <input type="text" id="rpgEditNpcRelationship" value="${escapeHtml(char.npcRelationship || '')}" class="rpg-edit-input" style="width:100%;">
      </div>
    </details>
    ` : ''}

    <details class="lore-section mt-sm">
      <summary class="section-summary">Personality</summary>
      <div style="padding:4px 0;">
        <div class="mb-xs">
          <label class="rpg-edit-label">Traits</label>
          ${buildEditChipListHTML('rpgEditTraitsChips', char.persona?.personalityTraits || [])}
        </div>
        <div class="mb-xs">
          <label class="rpg-edit-label">Motivations (one per line)</label>
          ${buildEditListTextareaHTML('rpgEditMotivations', char.persona?.motivations || [])}
        </div>
        <div class="mb-xs">
          <label class="rpg-edit-label">Fears (one per line)</label>
          ${buildEditListTextareaHTML('rpgEditFears', char.persona?.fears || [])}
        </div>
        <div class="mb-xs">
          <label class="rpg-edit-label">Flaws (one per line)</label>
          ${buildEditListTextareaHTML('rpgEditFlaws', char.persona?.flaws || [])}
        </div>
        <div class="mb-xs">
          <label class="rpg-edit-label">Speech Style</label>
          <input type="text" id="rpgEditSpeechStyle" value="${escapeHtml(char.persona?.speechStyle || '')}" class="rpg-edit-input" style="width:100%;" placeholder="e.g. formal and archaic">
        </div>
        <div>
          <label class="rpg-edit-label">Current Emotional State</label>
          <input type="text" id="rpgEditEmotionalState" value="${escapeHtml(char.persona?.emotionalState || '')}" class="rpg-edit-input" style="width:100%;" placeholder="e.g. tense, wary">
        </div>
      </div>
    </details>

    <details class="lore-section mt-xs">
      <summary class="section-summary">Story Role</summary>
      <div style="padding:4px 0;">
        <div class="flex-row mb-xs">
          <div style="flex:1;">
            <label class="rpg-edit-label">Story Function</label>
            ${buildSelectHTML('narrativeStoryFunction', NARRATIVE_ROLES_OPTIONS, char.narrative?.storyFunction || '')}
          </div>
          <div style="flex:1;">
            <label class="rpg-edit-label">Importance</label>
            ${buildSelectHTML('narrativeImportance', IMPORTANCE_OPTIONS, char.narrative?.importance || '')}
          </div>
        </div>
        <div class="mb-xs">
          <label class="rpg-edit-label">Goals (one per line)</label>
          ${buildEditListTextareaHTML('rpgEditGoals', char.narrative?.goals || [])}
        </div>
        <div class="mb-xs">
          <label class="rpg-edit-label">Conflicts (one per line)</label>
          ${buildEditListTextareaHTML('rpgEditConflicts', char.narrative?.conflicts || [])}
        </div>
        <div class="mb-xs">
          <label class="rpg-edit-label">Allegiances</label>
          ${buildEditChipListHTML('rpgEditAllegiancesChips', char.narrative?.allegiances || [])}
        </div>
        <div class="flex-row mb-xs">
          <div style="flex:1;">
            <label class="rpg-edit-label">Character Arc</label>
            ${buildSelectHTML('narrativeArcType', ARC_TYPES_OPTIONS, char.narrative?.arcType || '')}
          </div>
        </div>
        <div>
          <label class="rpg-edit-label">Arc Progression: <span id="rpgEditArcLabel">${char.narrative?.arcProgression ?? 0}%</span></label>
          <input type="range" id="rpgEditArcProgression" min="0" max="100" step="5" value="${char.narrative?.arcProgression ?? 0}" class="rpg-edit-input" style="width:100%;">
        </div>
      </div>
    </details>

    ${statsInputs ? `<div class="rpg-stat-grid">${statsInputs}</div>` : '<div class="empty-state-sm">No stats to edit.</div>'}

    <details class="lore-section mt-sm" open>
      <summary class="section-summary">Abilities (${(char.abilities || []).length})</summary>
      <div id="rpgEditAbilities">${abilitiesRows || '<div class="empty-state-sm">None</div>'}</div>
      <button class="rpg-edit-add rpg-edit-add-btn" data-section="abilities">+ Add Ability</button>
    </details>

    <details class="lore-section mt-xs">
      <summary class="section-summary">Equipment (${(char.equipment || []).length})</summary>
      <div id="rpgEditEquipment">${equipmentRows || '<div class="empty-state-sm">None</div>'}</div>
      <button class="rpg-edit-add rpg-edit-add-btn" data-section="equipment">+ Add Equipment</button>
    </details>

    <details class="lore-section mt-xs">
      <summary class="section-summary">Inventory (${(char.inventory || []).length})</summary>
      <div id="rpgEditInventory">${inventoryRows || '<div class="empty-state-sm">None</div>'}</div>
      <button class="rpg-edit-add rpg-edit-add-btn" data-section="inventory">+ Add Item</button>
    </details>

    <details class="lore-section mt-xs">
      <summary class="section-summary">Currency (${Object.keys(char.currency || {}).length})</summary>
      <div id="rpgEditCurrency">${currencyRows || '<div class="empty-state-sm">None</div>'}</div>
      <button class="rpg-edit-add rpg-edit-add-btn" data-section="currency">+ Add Currency</button>
    </details>

    <details class="lore-section mt-xs">
      <summary class="section-summary">Status Effects (${(char.statusEffects || []).length})</summary>
      <div id="rpgEditStatus">${statusRows || '<div class="empty-state-sm">None</div>'}</div>
      <button class="rpg-edit-add rpg-edit-add-btn" data-section="statusEffects">+ Add Effect</button>
    </details>

    <div class="flex-row mt-sm">
      <button class="rpg-stat-save-btn btn-accept btn-sm">Save</button>
      <button class="rpg-stat-cancel-btn btn-reject btn-sm">Cancel</button>
    </div>
  `;

  // Wire dirty tracking
  editDirty = false;
  rpgStatOverlayContent.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', markEditDirty);
  });

  // Wire remove buttons
  rpgStatOverlayContent.querySelectorAll('.rpg-edit-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.rpg-edit-row').remove();
      markEditDirty();
    });
  });

  // Wire add buttons
  rpgStatOverlayContent.querySelectorAll('.rpg-edit-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.section;
      const container = btn.previousElementSibling;
      // Clear "None" placeholder
      if (container.querySelector('.empty-state-sm')) container.innerHTML = '';
      const newRow = document.createElement('div');
      newRow.className = 'rpg-edit-row';
      newRow.dataset.section = section;
      newRow.innerHTML = getEmptyRowHTML(section);
      container.appendChild(newRow);
      newRow.querySelector('.rpg-edit-remove-btn')?.addEventListener('click', () => { newRow.remove(); markEditDirty(); });
      newRow.querySelectorAll('input, select').forEach(el => el.addEventListener('input', markEditDirty));
      markEditDirty();
    });
  });

  // Wire chip list add (Enter or blur on chip input)
  rpgStatOverlayContent.querySelectorAll('.edit-chip-container').forEach(container => {
    const input = container.querySelector('.edit-chip-input');
    if (!input) return;
    function addChip() {
      const val = input.value.trim();
      if (!val) return;
      const chip = document.createElement('span');
      chip.className = 'persona-chip edit-chip';
      chip.dataset.value = val;
      chip.innerHTML = `${escapeHtml(val)}<button class="edit-chip-remove" title="Remove">✕</button>`;
      chip.querySelector('.edit-chip-remove').addEventListener('click', () => { chip.remove(); markEditDirty(); });
      container.insertBefore(chip, input);
      input.value = '';
      markEditDirty();
    }
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addChip(); } });
    // Wire existing chip remove buttons
    container.querySelectorAll('.edit-chip-remove').forEach(btn => {
      btn.addEventListener('click', () => { btn.closest('.edit-chip').remove(); markEditDirty(); });
    });
  });

  // Wire arc progression label update
  const arcRangeInput = rpgStatOverlayContent.querySelector('#rpgEditArcProgression');
  const arcLabel = rpgStatOverlayContent.querySelector('#rpgEditArcLabel');
  if (arcRangeInput && arcLabel) {
    arcRangeInput.addEventListener('input', () => { arcLabel.textContent = `${arcRangeInput.value}%`; });
  }

  const saveBtn = rpgStatOverlayContent.querySelector('.rpg-stat-save-btn');
  const cancelBtn = rpgStatOverlayContent.querySelector('.rpg-stat-cancel-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(charId));
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    if (editDirty) {
      const existing = rpgStatOverlayContent?.querySelector('.rpg-confirm-bar');
      if (existing) return;
      const bar = document.createElement('div');
      bar.className = 'rpg-confirm-bar';
      bar.innerHTML = `<span>Unsaved changes.</span>
        <button class="btn-reject btn-xs">Discard</button>
        <button class="btn-accept btn-xs">Keep Editing</button>`;
      bar.querySelector('.btn-reject').addEventListener('click', () => { editDirty = false; openStatOverlay(charId, getRpgState()); });
      bar.querySelector('.btn-accept').addEventListener('click', () => bar.remove());
      rpgStatOverlayContent?.prepend(bar);
      return;
    }
    openStatOverlay(charId, getRpgState());
  });
}

function getEmptyRowHTML(section) {
  const rm = `<button class="rpg-edit-remove-btn" title="Remove">✕</button>`;
  switch (section) {
    case 'abilities':
      return `<input type="text" data-field="name" placeholder="Name" class="rpg-edit-input" style="flex:2;"><input type="number" data-field="level" placeholder="Lv" class="rpg-edit-input" style="width:40px;">${buildSelectHTML('category', ABILITY_CATEGORY_OPTIONS, '')}<input type="text" data-field="description" placeholder="Description" class="rpg-edit-input" style="flex:3;"><input type="text" data-field="cooldown" placeholder="Cooldown" class="rpg-edit-input" style="width:70px;"><input type="text" data-field="proficiency" placeholder="Proficiency" class="rpg-edit-input" style="width:80px;">${rm}`;
    case 'equipment':
      return `<input type="text" data-field="name" placeholder="Name" class="rpg-edit-input" style="flex:2;">${buildSelectHTML('slot', SLOT_OPTIONS, 'other')}${buildSelectHTML('rarity', RARITY_OPTIONS, 'unknown')}<input type="text" data-field="bonuses" placeholder="Bonuses" class="rpg-edit-input" style="width:80px;"><input type="text" data-field="setName" placeholder="Set Name" class="rpg-edit-input" style="width:80px;"><input type="text" data-field="description" placeholder="Description" class="rpg-edit-input" style="flex:2;">${rm}`;
    case 'inventory':
      return `<input type="text" data-field="name" placeholder="Name" class="rpg-edit-input" style="flex:2;"><input type="number" data-field="quantity" value="1" placeholder="Qty" class="rpg-edit-input" style="width:45px;">${buildSelectHTML('type', ['consumable','material','quest_item','other'], 'other')}${buildSelectHTML('rarity', ['','common','uncommon','rare','epic','legendary'], '')}${rm}`;
    case 'currency':
      return `<input type="text" data-field="unit" placeholder="Currency" class="rpg-edit-input" style="flex:1;"><input type="number" data-field="amount" placeholder="Amount" class="rpg-edit-input" style="width:80px;">${rm}`;
    case 'statusEffects':
      return `<input type="text" data-field="name" placeholder="Name" class="rpg-edit-input" style="flex:2;">${buildSelectHTML('type', STATUS_TYPE_OPTIONS, 'buff')}<input type="text" data-field="duration" placeholder="Duration" class="rpg-edit-input" style="flex:1;">${rm}`;
    default: return '';
  }
}

function collectEditRows(containerId) {
  const container = rpgStatOverlayContent.querySelector(`#${containerId}`);
  if (!container) return [];
  const rows = [];
  container.querySelectorAll('.rpg-edit-row').forEach(row => {
    const data = {};
    row.querySelectorAll('input, select').forEach(el => {
      const field = el.dataset.field || el.dataset.stat;
      if (field) data[field] = el.type === 'number' ? (el.value ? parseFloat(el.value) : null) : el.value.trim();
    });
    if (data.name || data.unit) rows.push(data);
  });
  return rows;
}

async function saveEdit(charId) {
  if (!rpgStatOverlayContent || !state.currentStoryId) return;
  editDirty = false;
  const saveBtn = rpgStatOverlayContent.querySelector('.rpg-stat-save-btn');
  const saveBtnOrigText = saveBtn?.textContent;
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  const updates = {};
  const nameInput = rpgStatOverlayContent.querySelector('#rpgEditName');
  const classInput = rpgStatOverlayContent.querySelector('#rpgEditClass');
  const subclassInput = rpgStatOverlayContent.querySelector('#rpgEditSubclass');
  const levelInput = rpgStatOverlayContent.querySelector('#rpgEditLevel');
  const raceInput = rpgStatOverlayContent.querySelector('#rpgEditRace');

  if (nameInput) updates.name = nameInput.value.trim() || null;
  if (classInput) updates.class = classInput.value.trim() || null;
  if (subclassInput) updates.subclass = subclassInput.value.trim() || null;
  if (levelInput) updates.level = levelInput.value ? parseInt(levelInput.value, 10) : null;
  if (raceInput) updates.race = raceInput.value.trim() || null;

  // Collect stat edits
  const statInputs = rpgStatOverlayContent.querySelectorAll('.rpg-edit-stat');
  if (statInputs.length > 0) {
    const stats = {};
    statInputs.forEach(input => {
      const statName = input.dataset.stat;
      const val = parseInt(input.value, 10);
      if (!isNaN(val)) {
        stats[statName] = { value: val, modifier: null };
      }
    });
    updates.stats = stats;
  }

  // Collect expanded section edits
  const abilitiesData = collectEditRows('rpgEditAbilities');
  if (abilitiesData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditAbilities')) {
    updates.abilities = abilitiesData.map(a => ({
      name: a.name, level: a.level || null, description: a.description || '', type: 'active', cost: null,
      category: a.category || null, cooldown: a.cooldown || null, proficiency: a.proficiency || null,
    }));
  }

  const equipmentData = collectEditRows('rpgEditEquipment');
  if (equipmentData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditEquipment')) {
    updates.equipment = equipmentData.map(e => ({
      name: e.name, slot: e.slot || 'other', rarity: e.rarity || 'unknown', description: e.description || '',
      bonuses: e.bonuses || null, setName: e.setName || null,
    }));
  }

  const inventoryData = collectEditRows('rpgEditInventory');
  if (inventoryData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditInventory')) {
    updates.inventory = inventoryData.map(i => ({
      name: i.name, quantity: i.quantity || 1, type: i.type || 'other',
      rarity: i.rarity || null,
    }));
  }

  const currencyData = collectEditRows('rpgEditCurrency');
  if (currencyData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditCurrency')) {
    updates.currency = {};
    for (const c of currencyData) {
      if (c.unit) updates.currency[c.unit.toLowerCase()] = c.amount || 0;
    }
  }

  const statusData = collectEditRows('rpgEditStatus');
  if (statusData.length > 0 || rpgStatOverlayContent.querySelector('#rpgEditStatus')) {
    updates.statusEffects = statusData.map(s => ({
      name: s.name, type: s.type || 'buff', duration: s.duration || null,
    }));
  }

  // Persona fields
  const traitsChipContainer = rpgStatOverlayContent.querySelector('#rpgEditTraitsChips');
  const speechStyleInput = rpgStatOverlayContent.querySelector('#rpgEditSpeechStyle');
  const emotionalStateInput = rpgStatOverlayContent.querySelector('#rpgEditEmotionalState');
  const motivationsTA = rpgStatOverlayContent.querySelector('#rpgEditMotivations');
  const fearsTA = rpgStatOverlayContent.querySelector('#rpgEditFears');
  const flawsTA = rpgStatOverlayContent.querySelector('#rpgEditFlaws');
  if (traitsChipContainer || speechStyleInput || motivationsTA) {
    const existingPersona = getRpgState()?.characters?.[charId]?.persona || {};
    updates.persona = {
      ...existingPersona,
      personalityTraits: traitsChipContainer
        ? Array.from(traitsChipContainer.querySelectorAll('.edit-chip')).map(c => c.dataset.value || c.textContent.replace('✕', '').trim()).filter(Boolean)
        : existingPersona.personalityTraits || [],
      motivations: motivationsTA ? motivationsTA.value.split('\n').map(s => s.trim()).filter(Boolean) : existingPersona.motivations || [],
      fears: fearsTA ? fearsTA.value.split('\n').map(s => s.trim()).filter(Boolean) : existingPersona.fears || [],
      flaws: flawsTA ? flawsTA.value.split('\n').map(s => s.trim()).filter(Boolean) : existingPersona.flaws || [],
      speechStyle: speechStyleInput ? (speechStyleInput.value.trim() || null) : existingPersona.speechStyle,
      emotionalState: emotionalStateInput ? (emotionalStateInput.value.trim() || null) : existingPersona.emotionalState,
    };
  }

  // Narrative fields
  const storyFunctionSelect = rpgStatOverlayContent.querySelector('[data-field="narrativeStoryFunction"]');
  const importanceSelect = rpgStatOverlayContent.querySelector('[data-field="narrativeImportance"]');
  const goalsTA = rpgStatOverlayContent.querySelector('#rpgEditGoals');
  const conflictsTA = rpgStatOverlayContent.querySelector('#rpgEditConflicts');
  const allegiancesChipContainer = rpgStatOverlayContent.querySelector('#rpgEditAllegiancesChips');
  const arcTypeSelect = rpgStatOverlayContent.querySelector('[data-field="narrativeArcType"]');
  const arcProgressionInput = rpgStatOverlayContent.querySelector('#rpgEditArcProgression');
  if (storyFunctionSelect || goalsTA || arcTypeSelect) {
    const existingNarrative = getRpgState()?.characters?.[charId]?.narrative || {};
    updates.narrative = {
      ...existingNarrative,
      storyFunction: storyFunctionSelect ? (storyFunctionSelect.value || null) : existingNarrative.storyFunction,
      importance: importanceSelect ? (importanceSelect.value || null) : existingNarrative.importance,
      goals: goalsTA ? goalsTA.value.split('\n').map(s => s.trim()).filter(Boolean) : existingNarrative.goals || [],
      conflicts: conflictsTA ? conflictsTA.value.split('\n').map(s => s.trim()).filter(Boolean) : existingNarrative.conflicts || [],
      allegiances: allegiancesChipContainer
        ? Array.from(allegiancesChipContainer.querySelectorAll('.edit-chip')).map(c => c.dataset.value || c.textContent.replace('✕', '').trim()).filter(Boolean)
        : existingNarrative.allegiances || [],
      arcType: arcTypeSelect ? (arcTypeSelect.value || null) : existingNarrative.arcType,
      arcProgression: arcProgressionInput ? parseInt(arcProgressionInput.value, 10) : existingNarrative.arcProgression,
    };
  }

  // NPC-specific fields
  const dispositionSelect = rpgStatOverlayContent.querySelector('[data-field="npcDisposition"]');
  const npcRoleSelect = rpgStatOverlayContent.querySelector('[data-field="npcRoleField"]');
  const factionInput = rpgStatOverlayContent.querySelector('#rpgEditFaction');
  const npcRelInput = rpgStatOverlayContent.querySelector('#rpgEditNpcRelationship');
  if (dispositionSelect) updates.disposition = dispositionSelect.value;
  if (npcRoleSelect) updates.npcRole = npcRoleSelect.value;
  if (factionInput) updates.faction = factionInput.value.trim() || null;
  if (npcRelInput) updates.npcRelationship = npcRelInput.value.trim() || null;

  try {
    const result = await window.powertool.litrpgUpdateCharacter(state.currentStoryId, charId, updates);
    if (result.success) {
      state.litrpgState = result.state;

      // Sync @narrative-role and @arc to lorebook metadata when narrative fields change
      if (updates.narrative?.storyFunction || updates.narrative?.arcType) {
        const char = result.state?.characters?.[charId];
        const charName = char?.name || charId;
        const extras = {};
        if (updates.narrative.storyFunction) extras['narrative-role'] = updates.narrative.storyFunction;
        if (updates.narrative.arcType) extras['arc'] = updates.narrative.arcType;
        console.log('[Cast] Narrative metadata to sync:', extras, 'for', charName);
        
        // Synchronize narrative metadata directly to NovelAI lorebook entry
        try {
          await loreCall('setMetadata', charName, { extras });
          console.log(`[Cast] Successfully synchronized narrative metadata for "${charName}"`);
        } catch (err) {
          console.warn(`[Cast] Failed to synchronize narrative metadata for "${charName}":`, err.message);
        }
      }

      refreshRpgUI();
      openStatOverlay(charId, getRpgState());
      showToast('Character updated', 2000, 'success');
    } else {
      showToast(`Failed to save: ${result.error || 'Unknown error'}`, 3000, 'error');
    }
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = saveBtnOrigText || 'Save'; }
  }
}

async function deleteCharacter(charId) {
  if (!state.currentStoryId) return;
  // Show inline confirmation in stat overlay
  const existing = rpgStatOverlayContent?.querySelector('.rpg-confirm-bar');
  if (existing) existing.remove();
  const bar = document.createElement('div');
  bar.className = 'rpg-confirm-bar';
  bar.innerHTML = `<span>Delete this character permanently?</span>
    <button class="btn-reject btn-xs">Delete</button>
    <button class="btn-xs" style="background:var(--bg-input);color:var(--text-muted);border:1px solid #444;border-radius:var(--radius-sm);cursor:pointer;">Cancel</button>`;
  bar.querySelector('.btn-reject').addEventListener('click', async () => {
    const result = await window.powertool.litrpgDeleteCharacter(state.currentStoryId, charId);
    if (result.success) {
      state.litrpgState = result.state;
      editDirty = false;
      if (rpgStatOverlay) { rpgStatOverlay.classList.remove('is-open'); rpgStatOverlay.classList.add('u-hidden'); }
      refreshRpgUI();
      showToast('Character deleted', 2000, 'success');
    } else {
      showToast(`Failed to delete: ${result.error || 'Unknown error'}`, 3000, 'error');
    }
  });
  bar.querySelector('button:last-child').addEventListener('click', () => bar.remove());
  rpgStatOverlayContent?.prepend(bar);
}

// =========================================================================
// QUEST RENDERING (Phase 5D — progress bars)
// =========================================================================

function renderQuests(rpg) {
  if (!rpgQuestListActive || !rpgQuestListDone) return;
  const quests = Object.values(rpg.quests || {});
  const active = quests.filter(q => q.status === 'active');
  const done = quests.filter(q => q.status !== 'active');

  rpgQuestCount.textContent = `(${active.length} active)`;

  if (active.length === 0) {
    rpgQuestListActive.innerHTML = '<div class="empty-state-sm" style="padding:4px;">No active quests. Quest tracking activates when your story mentions objectives, missions, or quests.</div>';
  } else {
    rpgQuestListActive.innerHTML = active.map(q => buildQuestCardHTML(q)).join('');
  }

  rpgQuestListDone.innerHTML = done.length === 0
    ? '<div class="empty-state-sm" style="padding:4px;">None yet.</div>'
    : done.map(q => buildQuestCardHTML(q)).join('');
}

function buildQuestCardHTML(quest) {
  const objectives = (quest.objectives || []).map(o =>
    `<div class="rpg-objective-v2${o.completed ? ' completed' : ''}"><span class="rpg-obj-check">${o.completed ? '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>' : ''}</span>${escapeHtml(o.text)}</div>`
  ).join('');

  const metaParts = [];
  if (quest.giver) metaParts.push(`Giver: ${escapeHtml(quest.giver)}`);
  if (quest.rewards) metaParts.push(`<span class="rpg-quest-reward">${escapeHtml(quest.rewards)}</span>`);
  const meta = metaParts.join(' ');

  const totalObj = (quest.objectives || []).length;
  const completedObj = (quest.objectives || []).filter(o => o.completed).length;
  const progressPct = totalObj > 0 ? Math.round((completedObj / totalObj) * 100) : 0;
  const progressBar = totalObj > 0
    ? `<div class="rpg-quest-progress-v2"><div class="rpg-quest-progress-fill" style="width:${progressPct}%;"></div><span class="rpg-quest-progress-text">${completedObj}/${totalObj} (${progressPct}%)</span></div>`
    : '';

  const questType = quest.type || 'side';
  return `
    <div class="rpg-quest-card-v2 type-${questType} ${quest.status}">
      <div class="rpg-quest-header">
        <span class="rpg-quest-type ${questType}">${escapeHtml(questType.toUpperCase())}</span>
        <span class="rpg-quest-title">${escapeHtml(quest.title)}</span>
      </div>
      ${quest.description ? `<div class="rpg-quest-desc">${escapeHtml(quest.description)}</div>` : ''}
      ${progressBar}
      ${objectives ? `<div class="rpg-quest-objectives">${objectives}</div>` : ''}
      ${meta ? `<div class="rpg-quest-meta">${meta}</div>` : ''}
    </div>
  `;
}

// =========================================================================
// NPC RENDERING (Phase 5F — search/filter)
// =========================================================================

let npcSearchFilter = '';
let npcGroupByDisposition = false;
const DISP_RING_COLORS = { friendly: '#81c784', neutral: '#ffd54f', hostile: '#ff6b6b', unknown: '#90a4ae' };

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return escaped.replace(re, '<mark style="background:rgba(233,69,96,0.3);color:inherit;padding:0 1px;border-radius:2px;">$1</mark>');
}

function buildNpcCardHTML(id, npc, q) {
  const dispColor = DISP_RING_COLORS[npc.disposition] || DISP_RING_COLORS.unknown;
  return `
  <div class="rpg-npc-card rpg-clickable" data-char-id="${escapeHtml(id)}" style="cursor:pointer;--disp-color:${dispColor};">
    <div class="rpg-portrait rpg-npc-portrait">
      ${npc._thumbnailData
        ? `<img src="data:image/png;base64,${npc._thumbnailData}" alt="${escapeHtml(npc.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
        : `<span class="rpg-portrait-initial rpg-portrait-initial-sm">${escapeHtml((npc.name || '?')[0].toUpperCase())}</span>`}
    </div>
    <div style="flex:1;min-width:0;">
      <span class="rpg-npc-name">${highlightMatch(npc.name, q)}${npc.level ? ` (Lv.${npc.level})` : ''}${npc.class ? ` — ${highlightMatch(npc.class, q)}` : ''}</span>
      ${npc.faction ? `<div class="detail-muted" style="font-size:9px;color:var(--cat-faction);">${highlightMatch(npc.faction, q)}</div>` : ''}
      <div class="flex-row-wrap" style="gap:4px;">
        ${npc.npcRole ? `<span class="detail-muted" style="font-size:9px;color:#a0a0ff;">${highlightMatch(npc.npcRole, q)}</span>` : ''}
        <span class="rpg-disposition ${npc.disposition || 'unknown'}">${highlightMatch((npc.disposition || 'unknown').toUpperCase(), q)}</span>
      </div>
    </div>
    <button class="rpg-npc-dismiss rpg-edit-remove-btn" data-char-id="${escapeHtml(id)}" title="Remove from tracking">&#10005;</button>
  </div>`;
}

function renderNPCs(rpg) {
  if (!rpgNpcList) return;
  const allNpcEntries = Object.entries(rpg.characters || {}).filter(([, c]) => c.isNPC);
  let npcEntries = allNpcEntries;

  // Apply search filter (Phase 5F)
  if (npcSearchFilter) {
    const q = npcSearchFilter.toLowerCase();
    npcEntries = npcEntries.filter(([, n]) =>
      n.name.toLowerCase().includes(q) ||
      (n.faction || '').toLowerCase().includes(q) ||
      (n.disposition || '').toLowerCase().includes(q) ||
      (n.npcRole || '').toLowerCase().includes(q)
    );
  }

  rpgNpcCount.textContent = npcSearchFilter
    ? `(${npcEntries.length} of ${allNpcEntries.length})`
    : `(${npcEntries.length})`;

  if (npcEntries.length === 0) {
    rpgNpcList.innerHTML = '<div class="empty-state-sm" style="padding:4px;">No NPCs identified. NPCs are detected during story scanning — keep writing!</div>';
    return;
  }

  const q = npcSearchFilter;

  if (npcGroupByDisposition) {
    const groups = { friendly: [], neutral: [], hostile: [], unknown: [] };
    for (const [id, npc] of npcEntries) {
      const disp = npc.disposition || 'unknown';
      (groups[disp] || groups.unknown).push([id, npc]);
    }
    let html = '';
    for (const [disp, entries] of Object.entries(groups)) {
      if (entries.length === 0) continue;
      const color = DISP_RING_COLORS[disp] || DISP_RING_COLORS.unknown;
      html += `<div class="rpg-npc-group-header" style="--disp-color:${color};">${disp.toUpperCase()} (${entries.length})</div>`;
      html += entries.map(([id, npc]) => buildNpcCardHTML(id, npc, q)).join('');
    }
    rpgNpcList.innerHTML = html;
  } else {
    rpgNpcList.innerHTML = npcEntries.map(([id, npc]) => buildNpcCardHTML(id, npc, q)).join('');
  }

  // Click handlers for stat sheet overlay
  rpgNpcList.querySelectorAll('.rpg-npc-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't open stat sheet if dismiss button was clicked
      if (e.target.closest('.rpg-npc-dismiss')) return;
      openStatOverlay(card.dataset.charId, rpg);
    });
  });

  // Dismiss button handlers — undo toast pattern
  rpgNpcList.querySelectorAll('.rpg-npc-dismiss').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const charId = btn.dataset.charId;
      const charName = rpg.characters?.[charId]?.name || 'this character';
      const card = btn.closest('.rpg-npc-card');
      if (card) { card.classList.add('rpg-slide-out-right'); }
      // Deep snapshot for undo (character objects have nested arrays/objects)
      const snapshot = rpg.characters?.[charId]
        ? JSON.parse(JSON.stringify(rpg.characters[charId])) : null;
      // Remove from state immediately so refreshRpgUI() won't re-render it
      if (rpg.characters?.[charId]) {
        delete rpg.characters[charId];
        state.litrpgState = rpg;
        saveLitrpgState();
      }
      // Slide out card
      setTimeout(() => { if (card) card.remove(); }, 200);
      showToast(`Removed ${charName}`, 5000, '', {
        onUndo: () => {
          // Restore snapshot into current state (not captured rpg — may be stale if scan ran)
          if (snapshot && state.litrpgState) {
            if (!state.litrpgState.characters) state.litrpgState.characters = {};
            state.litrpgState.characters[charId] = snapshot;
            saveLitrpgState();
            refreshRpgUI();
          }
          showToast(`${charName} restored`, 2000, 'success');
        },
        onExpire: async () => {
          // Persist delete to backend when undo window expires
          const result = await window.powertool.litrpgDeleteCharacter(state.currentStoryId, charId);
          if (result.success) {
            state.litrpgState = result.state;
            refreshRpgUI();
          }
        },
      });
    });
  });
}

// =========================================================================
// PENDING UPDATES RENDERING (Phase 5B — bulk actions, Phase 5C — diff display)
// =========================================================================

function renderPendingUpdates(rpg) {
  if (!rpgUpdatesList || !rpgUpdatesSection) return;
  const updates = rpg.pendingUpdates || [];
  rpgUpdatesCount.textContent = `(${updates.length})`;
  rpgUpdatesSection.classList.toggle('u-hidden', updates.length === 0);

  // Show/hide bulk buttons
  if (rpgAcceptAllBtn) rpgAcceptAllBtn.classList.toggle('u-hidden', updates.length <= 1);
  if (rpgRejectAllBtn) rpgRejectAllBtn.classList.toggle('u-hidden', updates.length <= 1);

  if (updates.length === 0) return;

  rpgUpdatesList.innerHTML = updates.map(update => {
    let desc = '';
    let diffHTML = '';

    if (update.type === 'character') {
      // Phase 5C — use changes array for field-level diffs
      const changes = update.changes || [];
      if (changes.length > 0) {
        diffHTML = `<div class="rpg-update-diff">${changes.map(c =>
          `<div class="rpg-diff-line"><span class="rpg-diff-field">${escapeHtml(c.field)}:</span> <span class="rpg-diff-before">${escapeHtml(String(c.before))}</span> → <span class="rpg-diff-after">${escapeHtml(String(c.after))}</span></div>`
        ).join('')}</div>`;
      }
      desc = escapeHtml(update.characterName);
    } else if (update.type === 'quest_status') {
      desc = `Quest "${escapeHtml(update.questTitle)}": ${update.oldStatus} → ${update.newStatus}`;
    } else if (update.type === 'quest_objective') {
      desc = `Quest "${escapeHtml(update.questTitle)}": objective completed — ${escapeHtml(update.objectiveText)}`;
    }

    return `
      <div class="rpg-update-card" data-update-id="${escapeHtml(update.id)}">
        <div class="update-type">${escapeHtml(update.type.replace('_', ' '))}</div>
        <div class="update-desc">${desc}</div>
        ${diffHTML}
        <div class="update-actions">
          <button class="btn-accept btn-xs rpg-accept-update">Accept</button>
          <button class="btn-reject btn-xs rpg-reject-update">Reject</button>
        </div>
      </div>
    `;
  }).join('');

  // Accept/reject handlers delegated to rpgUpdatesList in init()
}

// =========================================================================
// NEW UI SECTIONS (Phase 5G)
// =========================================================================

function renderInventory(rpg) {
  if (!rpgInventoryList) return;
  const allChars = Object.values(rpg.characters || {});
  const globalInv = rpg.globalInventory || [];
  const charItems = allChars.flatMap(c => (c.inventory || []).map(i => ({ ...i, owner: c.name })));
  const allItems = [...globalInv.map(i => ({ ...i, owner: 'Shared' })), ...charItems];

  if (allItems.length === 0) {
    rpgInventoryList.innerHTML = `<div class="rpg-empty-state">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg>
      <div>No inventory tracked.</div>
    </div>`;
    return;
  }

  rpgInventoryList.innerHTML = `<div class="rpg-inv-grid">${allItems.map(i =>
    `<div class="rpg-inv-slot${i.rarity ? ` rarity-${i.rarity}` : ''}"><span style="flex:1;color:var(--text-primary);">${escapeHtml(i.name)}</span><span class="rpg-inv-qty">x${i.quantity || 1}</span><span class="detail-muted" style="font-size:9px;">${escapeHtml(i.owner)}</span></div>`
  ).join('')}</div>`;
}

function renderCurrency(rpg) {
  if (!rpgCurrencyList) return;
  const globalCurr = rpg.globalCurrency || {};
  const allChars = Object.values(rpg.characters || {});
  const entries = [];

  if (Object.keys(globalCurr).length > 0) {
    entries.push({ owner: 'Shared', currency: globalCurr });
  }
  for (const c of allChars) {
    if (c.currency && Object.keys(c.currency).length > 0) {
      entries.push({ owner: c.name, currency: c.currency });
    }
  }

  if (entries.length === 0) {
    rpgCurrencyList.innerHTML = `<div class="rpg-empty-state">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M15 9.5c-.6-.8-1.5-1.5-3-1.5-2 0-3 1.3-3 2.5s1 2 3 2.5c2 .5 3 1.3 3 2.5s-1 2.5-3 2.5c-1.5 0-2.4-.7-3-1.5"/></svg>
      <div>No currency tracked.</div>
    </div>`;
    return;
  }

  rpgCurrencyList.innerHTML = entries.map(e =>
    `<div class="mb-sm"><div class="detail-muted" style="font-size:9px;margin-bottom:3px;">${escapeHtml(e.owner)}</div><div class="flex-row-wrap">${Object.entries(e.currency).map(([unit, amount]) =>
      `<div class="rpg-currency-card"><span class="rpg-currency-amount">${amount}</span><span class="rpg-currency-unit">${escapeHtml(unit)}</span></div>`
    ).join('')}</div></div>`
  ).join('');
}

function renderStatusEffects(rpg) {
  if (!rpgStatusEffectsList) return;
  const allChars = Object.values(rpg.characters || {});
  const allEffects = allChars.flatMap(c => (c.statusEffects || []).map(s => ({ ...s, owner: c.name })));

  if (allEffects.length === 0) {
    rpgStatusEffectsList.innerHTML = `<div class="rpg-empty-state">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      <div>No active effects.</div>
    </div>`;
    return;
  }

  rpgStatusEffectsList.innerHTML = `<div class="rpg-status-tag-row">${allEffects.map(s =>
    `<span class="rpg-status-tag rpg-status-${s.type || 'buff'}" title="${escapeHtml(s.owner)}${s.duration ? ` — ${escapeHtml(s.duration)}` : ''}">${s.type === 'buff' ? '&#9650;' : s.type === 'debuff' ? '&#9660;' : '&#9679;'} ${escapeHtml(s.name)}</span>`
  ).join('')}</div>`;
}

// =========================================================================
// ENTITY COLLECTION RENDERERS
// =========================================================================

function renderFactions(rpg) {
  if (!rpgFactionList) return;
  const factions = Object.values(rpg.factions || {});
  const orphanFactionCount = factions.filter(f => (f.members || []).length === 0).length;
  if (rpgFactionCount) rpgFactionCount.textContent = `(${factions.length}${orphanFactionCount > 0 ? ' \u00b7 ' + orphanFactionCount + ' orphaned' : ''})`;

  if (factions.length === 0) {
    rpgFactionList.innerHTML = `<div class="rpg-empty-state">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
      <div>No factions tracked yet.</div>
    </div>`;
    return;
  }

  rpgFactionList.innerHTML = factions.map(fac => {
    const dispClass = `rpg-disposition-${(fac.disposition || 'unknown').toLowerCase()}`;
    const memberLinks = (fac.members || []).map(m =>
      `<span class="rpg-entity-member-link" data-member-name="${escapeHtml(m)}">${escapeHtml(m)}</span>`
    ).join(', ');
    return `<div class="rpg-entity-card rpg-clickable">
      <div class="flex-row">
        <span class="rpg-entity-name">${escapeHtml(fac.name)}</span>
        <span class="rpg-disposition ${dispClass}">${escapeHtml(fac.disposition || 'unknown')}</span>
        <span class="detail-muted" style="font-size:9px;">${(fac.members || []).length} members</span>
        ${(fac.members || []).length === 0 ? '<span class="rpg-orphan-tag">orphaned</span>' : ''}
      </div>
      ${fac.description ? `<div class="rpg-entity-desc">${escapeHtml(fac.description)}</div>` : ''}
      ${fac.territory ? `<div class="detail-muted">Territory: ${escapeHtml(fac.territory)}</div>` : ''}
      ${memberLinks ? `<div class="rpg-entity-members">Members: ${memberLinks}</div>` : ''}
    </div>`;
  }).join('');

  // Wire clickable member names
  rpgFactionList.querySelectorAll('.rpg-entity-member-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = link.dataset.memberName;
      const charEntry = Object.entries(rpg.characters || {}).find(([, c]) => c.name === name);
      if (charEntry) openStatOverlay(charEntry[0], rpg);
    });
  });
}

function renderClasses(rpg) {
  if (!rpgClassList) return;
  const classes = Object.values(rpg.classes || {});
  const orphanClassCount = classes.filter(c => (c.practitioners || []).length === 0).length;
  if (rpgClassCount) rpgClassCount.textContent = `(${classes.length}${orphanClassCount > 0 ? ' \u00b7 ' + orphanClassCount + ' orphaned' : ''})`;

  if (classes.length === 0) {
    rpgClassList.innerHTML = `<div class="rpg-empty-state">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      <div>No classes tracked yet.</div>
    </div>`;
    return;
  }

  const sorted = [...classes].sort((a, b) => {
    if (a.type === 'class' && b.type === 'subclass') return -1;
    if (a.type === 'subclass' && b.type === 'class') return 1;
    return a.name.localeCompare(b.name);
  });

  rpgClassList.innerHTML = sorted.map(cls => {
    const practitionerLinks = (cls.practitioners || []).map(p =>
      `<span class="rpg-entity-member-link" data-member-name="${escapeHtml(p)}">${escapeHtml(p)}</span>`
    ).join(', ');
    const typeLabel = cls.type === 'subclass' ? `<span class="detail-muted" style="font-size:9px;color:#ce93d8;">subclass</span>` : '';
    const parent = cls.parentClass ? `<span class="detail-muted" style="font-size:9px;"> of ${escapeHtml(cls.parentClass)}</span>` : '';
    return `<div class="rpg-entity-card${cls.type === 'subclass' ? ' rpg-entity-subclass' : ''}">
      <div class="flex-row">
        <span class="rpg-entity-name">${escapeHtml(cls.name)}</span>
        ${typeLabel}${parent}
        <span class="detail-muted" style="font-size:9px;">${(cls.practitioners || []).length} practitioners</span>
        ${(cls.practitioners || []).length === 0 ? '<span class="rpg-orphan-tag">orphaned</span>' : ''}
      </div>
      ${cls.description ? `<div class="rpg-entity-desc">${escapeHtml(cls.description)}</div>` : ''}
      ${cls.requirements ? `<div class="detail-muted">Requires: ${escapeHtml(cls.requirements)}</div>` : ''}
      ${practitionerLinks ? `<div class="rpg-entity-members">${practitionerLinks}</div>` : ''}
    </div>`;
  }).join('');

  // Wire clickable practitioner names
  rpgClassList.querySelectorAll('.rpg-entity-member-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = link.dataset.memberName;
      const charEntry = Object.entries(rpg.characters || {}).find(([, c]) => c.name === name);
      if (charEntry) openStatOverlay(charEntry[0], rpg);
    });
  });
}

function renderRaces(rpg) {
  if (!rpgRaceList) return;
  const races = Object.values(rpg.races || {});
  const orphanRaceCount = races.filter(r => (r.knownMembers || []).length === 0).length;
  if (rpgRaceCount) rpgRaceCount.textContent = `(${races.length}${orphanRaceCount > 0 ? ' \u00b7 ' + orphanRaceCount + ' orphaned' : ''})`;

  if (races.length === 0) {
    rpgRaceList.innerHTML = `<div class="rpg-empty-state">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
      <div>No races tracked yet.</div>
    </div>`;
    return;
  }

  rpgRaceList.innerHTML = races.map(race => {
    const memberLinks = (race.knownMembers || []).map(m =>
      `<span class="rpg-entity-member-link" data-member-name="${escapeHtml(m)}">${escapeHtml(m)}</span>`
    ).join(', ');
    const traitPills = race.traits
      ? race.traits.split(',').map(t => t.trim()).filter(Boolean).map(t => `<span class="rpg-trait-pill">${escapeHtml(t)}</span>`).join('')
      : '';
    return `<div class="rpg-entity-card">
      <div class="flex-row">
        <span class="rpg-entity-name">${escapeHtml(race.name)}</span>
        <span class="detail-muted" style="font-size:9px;">${(race.knownMembers || []).length} known</span>
        ${(race.knownMembers || []).length === 0 ? '<span class="rpg-orphan-tag">orphaned</span>' : ''}
      </div>
      ${race.description ? `<div class="rpg-entity-desc">${escapeHtml(race.description)}</div>` : ''}
      ${traitPills ? `<div class="mt-xs">${traitPills}</div>` : ''}
      ${memberLinks ? `<div class="rpg-entity-members">${memberLinks}</div>` : ''}
    </div>`;
  }).join('');

  rpgRaceList.querySelectorAll('.rpg-entity-member-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = link.dataset.memberName;
      const charEntry = Object.entries(rpg.characters || {}).find(([, c]) => c.name === name);
      if (charEntry) openStatOverlay(charEntry[0], rpg);
    });
  });
}

// =========================================================================
// SCAN HISTORY (Phase 6.5)
// =========================================================================

function renderScanHistory(rpg) {
  if (!rpgScanHistorySection || !rpgScanHistoryList) return;
  const history = rpg.scanHistory || [];

  if (history.length === 0) {
    rpgScanHistorySection.classList.add('u-hidden');
    return;
  }

  rpgScanHistorySection.classList.remove('u-hidden');
  if (rpgScanHistoryCount) rpgScanHistoryCount.textContent = `(${history.length})`;

  rpgScanHistoryList.innerHTML = history.map(entry => {
    const date = new Date(entry.timestamp);
    const timeStr = date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const durationStr = entry.duration != null ? `${Math.round(entry.duration / 1000)}s` : '?';
    const passKeys = Object.keys(entry.passes || {});
    const passSummary = passKeys.map(k => {
      const p = entry.passes[k];
      return `${k}: ${p.succeeded}/${p.attempted}`;
    }).join(', ');
    const errorBadge = entry.errorCount > 0
      ? `<span class="rpg-scan-history-errors">${entry.errorCount} error${entry.errorCount !== 1 ? 's' : ''}</span>`
      : '';
    return `<div class="rpg-scan-history-item">
      <div class="flex-row" style="justify-content:space-between;">
        <span style="color:var(--text-secondary);">${timeStr}</span>
        <span class="detail-muted">${durationStr}${errorBadge}</span>
      </div>
      <div class="detail-muted" style="margin-top:2px;">${escapeHtml(entry.summary || '')}</div>
      ${passSummary ? `<div class="detail-muted" style="margin-top:1px;font-size:10px;color:var(--text-disabled);">${escapeHtml(passSummary)}</div>` : ''}
    </div>`;
  }).join('');
}

// =========================================================================
// PORTRAIT ACTIONS
// =========================================================================

async function generatePortrait(charId) {
  if (!state.currentStoryId) return;
  const rpg = getRpgState();
  const char = rpg.characters?.[charId];
  if (!char) return;

  const genBtn = rpgStatOverlayContent?.querySelector('.rpg-portrait-generate');
  if (genBtn) genBtn.disabled = true;
  showToast('Generating portrait...');
  try {
    const result = await window.powertool.portraitGenerate(
      state.currentStoryId, charId, char.loreEntryName, char
    );
    if (result.success) {
      char.portraitPath = true;
      char._portraitData = result.imageData;
      char._thumbnailData = result.thumbnailData;
      saveLitrpgState();
      refreshRpgUI();
      showToast('Portrait generated!');
    }
  } catch (err) {
    showToast('Portrait generation failed');
  } finally {
    if (genBtn) genBtn.disabled = false;
  }
}

async function uploadPortrait(charId) {
  if (!state.currentStoryId) return;
  try {
    const result = await window.powertool.portraitUpload(state.currentStoryId, charId);
    if (result.success) {
      const rpg = getRpgState();
      const char = rpg.characters?.[charId];
      if (char) {
        char.portraitPath = true;
        char._portraitData = result.imageData;
        saveLitrpgState();
        refreshRpgUI();
        showToast('Portrait uploaded!');
      }
    }
  } catch (err) {
    showToast('Portrait upload failed');
  }
}

// =========================================================================
// ALBUM
// =========================================================================

async function loadAlbumStrip(charId) {
  if (!state.currentStoryId) return;
  const strip = rpgStatOverlayContent?.querySelector('.rpg-album-strip');
  const countEl = rpgStatOverlayContent?.querySelector('.rpg-album-count');
  if (!strip) return;

  try {
    const items = await window.powertool.portraitAlbumList(state.currentStoryId, charId);
    if (countEl) countEl.textContent = `(${items.length})`;

    if (items.length === 0) {
      strip.innerHTML = '<div class="empty-state-sm" style="padding:4px;">No images yet. Generate or upload a portrait to start the album.</div>';
      return;
    }

    albumItems = items;
    albumCharId = charId;

    strip.innerHTML = items.map((item, idx) => `
      <div class="rpg-album-thumb-v2${idx === 0 ? ' active-portrait' : ''}" data-image-id="${escapeHtml(item.id)}" title="Click to view">
        ${item.thumbnailData
          ? `<img src="data:image/png;base64,${item.thumbnailData}" style="width:100%;height:100%;object-fit:cover;">`
          : '<div style="width:100%;height:100%;background:#222;"></div>'}
        <div class="rpg-album-actions" style="position:absolute;bottom:0;left:0;right:0;display:flex;gap:1px;opacity:0;transition:opacity 0.15s;">
          <button class="rpg-album-use" data-image-id="${escapeHtml(item.id)}" title="Set as active portrait" style="flex:1;font-size:8px;padding:3px;background:rgba(0,120,255,0.85);color:#fff;border:none;cursor:pointer;">Use</button>
          <button class="rpg-album-del" data-image-id="${escapeHtml(item.id)}" title="Delete" style="flex:0;font-size:8px;padding:3px 5px;background:rgba(200,0,0,0.85);color:#fff;border:none;cursor:pointer;">X</button>
        </div>
      </div>
    `).join('');

    // Wire click-to-view (full size in lightbox-style overlay)
    strip.querySelectorAll('.rpg-album-thumb').forEach(el => {
      el.addEventListener('mouseenter', () => {
        const actions = el.querySelector('.rpg-album-actions');
        if (actions) actions.style.opacity = '1';
      });
      el.addEventListener('mouseleave', () => {
        const actions = el.querySelector('.rpg-album-actions');
        if (actions) actions.style.opacity = '0';
      });
      el.addEventListener('click', (e) => {
        if (e.target.closest('.rpg-album-use') || e.target.closest('.rpg-album-del')) return;
        viewAlbumImage(charId, el.dataset.imageId);
      });
    });

    // Wire "Use as active" buttons
    strip.querySelectorAll('.rpg-album-use').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setAlbumAsActive(charId, btn.dataset.imageId);
      });
    });

    // Wire delete buttons
    strip.querySelectorAll('.rpg-album-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAlbumImage(charId, btn.dataset.imageId);
      });
    });
  } catch (err) {
    strip.innerHTML = '<div class="empty-state-sm" style="color:var(--error-light);">Failed to load album</div>';
    console.error('[LitRPG] Album load error:', err);
  }
}

// Album lightbox state
let albumItems = [];
let albumCharId = null;
let albumIndex = 0;

async function viewAlbumImage(charId, imageId) {
  if (!state.currentStoryId) return;
  albumCharId = charId;
  const idx = albumItems.findIndex(item => item.id === imageId);
  albumIndex = idx >= 0 ? idx : 0;
  await showAlbumLightbox();
}

async function showAlbumLightbox() {
  if (!rpgAlbumLightbox || !rpgAlbumLightboxImg || albumItems.length === 0) return;
  const item = albumItems[albumIndex];
  if (!item) return;
  try {
    const imageData = await window.powertool.portraitAlbumGet(state.currentStoryId, albumCharId, item.id);
    if (!imageData) return;
    rpgAlbumLightboxImg.src = `data:image/png;base64,${imageData}`;
    if (rpgAlbumCounter) rpgAlbumCounter.textContent = `${albumIndex + 1} of ${albumItems.length}`;
    rpgAlbumLightbox.classList.remove('u-hidden');
    rpgAlbumLightbox.classList.add('is-open');
  } catch (err) {
    showToast('Failed to load image');
  }
}

async function setAlbumAsActive(charId, imageId) {
  if (!state.currentStoryId) return;
  try {
    const result = await window.powertool.portraitAlbumSetActive(state.currentStoryId, charId, imageId);
    if (result.success) {
      const rpg = getRpgState();
      const char = rpg.characters?.[charId];
      if (char) {
        char.portraitPath = true;
        char._portraitData = result.imageData;
        char._thumbnailData = result.thumbnailData;
        saveLitrpgState();
      }
      // Refresh stat overlay with new portrait
      openStatOverlay(charId, getRpgState());
      refreshRpgUI();
      showToast('Portrait updated!');
    }
  } catch (err) {
    showToast('Failed to set portrait');
  }
}

async function deleteAlbumImage(charId, imageId) {
  if (!state.currentStoryId) return;
  try {
    await window.powertool.portraitAlbumDelete(state.currentStoryId, charId, imageId);
    // Reload album strip
    loadAlbumStrip(charId);
    showToast('Album image deleted');
  } catch (err) {
    showToast('Failed to delete image');
  }
}

// =========================================================================
// ACTIONS
// =========================================================================

let scanElapsedTimer = null;
let lastEtaText = '';

async function runRpgScan() {
  if (!state.currentStoryId || state.litrpgScanning) return;
  state.litrpgScanning = true;
  state.llmBusy = true;
  if (rpgScanStatus) rpgScanStatus.classList.remove('u-hidden');
  if (rpgScanPhase) rpgScanPhase.textContent = 'Starting RPG scan...';
  if (rpgScanBtn) { rpgScanBtn.disabled = true; rpgScanBtn.classList.add('scanning'); }

  // Reset step indicators
  if (rpgScanSteps) {
    rpgScanSteps.querySelectorAll('.rpg-scan-step').forEach(s => {
      s.classList.remove('active', 'completed');
    });
  }

  // Elapsed timer
  lastEtaText = '';
  const scanStartTime = Date.now();
  if (scanElapsedTimer) clearInterval(scanElapsedTimer);
  scanElapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - scanStartTime) / 1000);
    if (rpgScanElapsed) rpgScanElapsed.textContent = `${elapsed}s elapsed${lastEtaText}`;
  }, 1000);

  try {
    let storyText = '';
    try {
      storyText = await webview.executeJavaScript(`
        (function() {
          var pm = document.querySelector('.ProseMirror');
          if (pm) return pm.textContent || '';
          var el = document.querySelector('#scene-vis-story-text');
          return el ? (el.dataset.text || el.textContent || '') : '';
        })()
      `);
    } catch (_) { /* fallback empty */ }

    let loreEntries = [];
    try {
      loreEntries = await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.getEntries) {
            return window.__loreCreator.getEntries();
          }
          return [];
        })()
      `);
    } catch (_) { /* fallback empty */ }

    const startedForStory = state.currentStoryId;
    const scanOptions = {};
    if (rpgForceReEnrich && rpgForceReEnrich.checked) {
      scanOptions.forceReEnrich = true;
      rpgForceReEnrich.checked = false;
    }
    const result = await window.powertool.litrpgScan(storyText, state.currentStoryId, loreEntries, scanOptions);

    // Discard result if story changed during scan
    if (state.currentStoryId !== startedForStory) {
      console.log('[LitRPG] Discarding scan result — story changed during scan');
      return;
    }

    if (result.success) {
      state.litrpgState = result.state;
      refreshRpgUI();

      // Emit events for portrait queue (standalone scan path)
      if (result.newCharacterIds?.length && result.state?.characters) {
        bus.emit('litrpg:new-characters', {
          newCharacterIds: result.newCharacterIds,
          characters: result.state.characters,
        });
      }

      // Apply @role metadata updates to lorebook entries
      if (result.roleUpdates && result.roleUpdates.length > 0) {
        await applyRoleUpdatesToLorebook(result.roleUpdates);
      }

      // Push R4 lore entries into the Lore tab pending queue
      if (result.pendingLoreEntries && result.pendingLoreEntries.length > 0) {
        if (!state.loreState) state.loreState = { pendingEntries: [], rejectedNames: [] };
        if (!state.loreState.pendingEntries) state.loreState.pendingEntries = [];
        const existingNames = new Set((state.loreState.pendingEntries || []).map(e => e.displayName.toLowerCase()));
        const rejectedNames = new Set((state.loreState.rejectedNames || []).map(n => n.toLowerCase()));
        const newEntries = result.pendingLoreEntries.filter(e =>
          !existingNames.has(e.displayName.toLowerCase()) && !rejectedNames.has(e.displayName.toLowerCase())
        );
        if (newEntries.length > 0) {
          state.loreState.pendingEntries.push(...newEntries);
          await saveLoreState();
          refreshLoreUI();
          showToast(`Found ${newEntries.length} RPG lore entr${newEntries.length === 1 ? 'y' : 'ies'} — check Lore tab`);
        }
      }

      // R4 dedup transparency
      if (result.r4Skipped > 0) {
        showToast(`${result.r4Skipped} more RPG elements found but capped`, 3000);
      }

      // Show report summary (Phase 6.5)
      if (result.report) {
        showToast(result.report.summary, 4000, 'success');
        renderScanHistory(state.litrpgState);
      } else {
        showToast('RPG scan complete', 2000, 'success');
      }
    } else {
      showToast(`RPG scan failed: ${result.error || 'Unknown error'}`, 3000, 'error');
    }
  } catch (err) {
    showToast(`RPG scan error: ${err.message || 'Unknown error'}`, 3000, 'error');
    console.error('[LitRPG] Scan error:', err);
  } finally {
    state.litrpgScanning = false;
    state.llmBusy = false;
    lastEtaText = '';
    if (scanElapsedTimer) { clearInterval(scanElapsedTimer); scanElapsedTimer = null; }
    if (rpgScanPhase) rpgScanPhase.textContent = 'Scan complete';
    if (rpgScanElapsed) rpgScanElapsed.textContent = '';
    if (rpgScanBtn) { rpgScanBtn.disabled = false; rpgScanBtn.classList.remove('scanning'); }
    // Mark all steps as completed
    if (rpgScanSteps) {
      rpgScanSteps.querySelectorAll('.rpg-scan-step').forEach(s => {
        s.classList.remove('active');
        s.classList.add('completed');
      });
    }
    setTimeout(() => {
      if (rpgScanStatus) rpgScanStatus.classList.add('u-hidden');
      if (rpgScanSteps) {
        rpgScanSteps.querySelectorAll('.rpg-scan-step').forEach(s => s.classList.remove('completed'));
      }
    }, 2000);
  }
}

async function syncToLorebook() {
  const rpg = getRpgState();
  if (!rpg.enabled) return;

  if (rpgSyncLorebookBtn) rpgSyncLorebookBtn.disabled = true;
  try {
  const characters = Object.values(rpg.characters || {});
  let synced = 0;

  for (const char of characters) {
    if (!char.class && !char.level && Object.keys(char.stats || {}).length === 0) continue;

    try {
      const entries = await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.getEntries) {
            return window.__loreCreator.getEntries().filter(e => e.displayName === ${JSON.stringify(char.loreEntryName)});
          }
          return [];
        })()
      `);

      if (entries.length === 0) continue;
      const entry = entries[0];

      const updatedText = await window.powertool.litrpgBuildLorebookText(entry.text, char);

      await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.updateEntry) {
            window.__loreCreator.updateEntry({
              displayName: ${JSON.stringify(char.loreEntryName)},
              text: ${JSON.stringify(updatedText)}
            });
          }
        })()
      `);
      synced++;
    } catch (err) {
      console.error(`[LitRPG] Sync failed for ${char.name}:`, err);
    }
  }

  showToast(synced > 0 ? `Synced ${synced} character${synced > 1 ? 's' : ''} to lorebook` : 'No characters to sync');
  } finally {
    if (rpgSyncLorebookBtn) rpgSyncLorebookBtn.disabled = false;
  }
}

async function applyRoleUpdatesToLorebook(roleUpdates) {
  if (!roleUpdates || roleUpdates.length === 0) return;
  let updated = 0;

  for (const { loreEntryName, role } of roleUpdates) {
    try {
      const entries = await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.getEntries) {
            return window.__loreCreator.getEntries().filter(e => e.displayName === ${JSON.stringify(loreEntryName)});
          }
          return [];
        })()
      `);

      if (entries.length === 0) continue;
      const entry = entries[0];

      const updatedText = await window.powertool.litrpgBuildRoleUpdate(entry.text, role);
      if (!updatedText) continue; // already correct

      await webview.executeJavaScript(`
        (function() {
          if (window.__loreCreator && window.__loreCreator.updateEntry) {
            window.__loreCreator.updateEntry({
              displayName: ${JSON.stringify(loreEntryName)},
              text: ${JSON.stringify(updatedText)}
            });
          }
        })()
      `);
      updated++;
    } catch (err) {
      console.error(`[LitRPG] Role update failed for ${loreEntryName}:`, err);
    }
  }

  if (updated > 0) {
    console.log(`[LitRPG] Updated @role metadata for ${updated} lorebook entries`);
  }
}

// Smart reverse sync: auto-apply high-confidence, skip regressions, show ambiguous as pending
async function handleReverseSync() {
  if (!state.currentStoryId || !state.loreProxyReady) {
    showToast('Proxy not connected', null, 'warn');
    return;
  }

  rpgReverseSyncBtn.disabled = true;
  rpgReverseSyncBtn.title = 'Sync in progress';

  try {
    // Get lorebook entries via proxy
    const entries = await loreCall('getEntries');
    if (!entries || entries.length === 0) {
      showToast('No lorebook entries found', null, 'warn');
      return;
    }

    // Filter to character entries
    const characterEntries = entries.filter(e => {
      if (e.text && parseMetadataClient(e.text).type === 'character') return true;
      return e.category === 'character' || (e.text && /^Name:/m.test(e.text) && /^(Age|Gender|Physical Appearance):/m.test(e.text));
    });

    if (characterEntries.length === 0) {
      showToast('No character entries found in lorebook', null, 'warn');
      return;
    }

    const result = await window.powertool.litrpgReverseSyncAll(characterEntries, state.currentStoryId);

    if (!result.success) {
      showToast(result.error || 'Reverse sync failed', null, 'error');
      return;
    }

    const results = result.results || [];
    if (results.length === 0) {
      showToast('No syncable changes found');
      return;
    }

    // Score and categorize changes
    const autoApplied = [];
    const skipped = [];
    const ambiguous = [];
    const snapshots = {}; // for undo: charId -> previous state

    for (const r of results) {
      if (!r.changed && !r.isNew) continue;

      const scored = (r.changes || []).map(c => scoreChange(c));

      const high = scored.filter(s => s.confidence === 'high');
      const low = scored.filter(s => s.confidence === 'low');
      const med = scored.filter(s => s.confidence === 'medium');

      if (high.length > 0 || r.isNew) {
        // Snapshot for undo
        if (r.charId && state.litrpgState?.characters?.[r.charId]) {
          snapshots[r.charId] = JSON.parse(JSON.stringify(state.litrpgState.characters[r.charId]));
        }

        // Auto-apply: merge parsed data into RPG state
        if (r.isNew && r.parsed) {
          // New character
          const newId = `char_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
          if (!state.litrpgState.characters) state.litrpgState.characters = {};
          state.litrpgState.characters[newId] = {
            id: newId,
            name: r.entryName || 'Unknown',
            ...r.parsed,
            lastUpdated: new Date().toISOString(),
          };
          autoApplied.push({ name: r.entryName, type: 'new', count: Object.keys(r.parsed).length });
        } else if (r.charId && r.parsed) {
          // Apply high-confidence changes
          const char = state.litrpgState.characters[r.charId];
          if (char) {
            for (const sc of high) {
              applyChangeToChar(char, sc);
            }
            char.lastUpdated = new Date().toISOString();
            autoApplied.push({ name: char.name, type: 'update', count: high.length });
          }
        }
      }

      if (low.length > 0) {
        skipped.push({ name: r.entryName || r.charId, count: low.length });
      }

      if (med.length > 0) {
        // Add as pending updates for user review
        const rpg = getRpgState();
        if (!rpg.pendingUpdates) rpg.pendingUpdates = [];
        for (const mc of med) {
          rpg.pendingUpdates.push({
            id: `rsync_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            charId: r.charId,
            charName: r.entryName || 'Unknown',
            field: mc.field,
            before: mc.before,
            after: mc.after,
            reason: mc.reason,
            source: 'reverse-sync',
            timestamp: new Date().toISOString(),
          });
        }
        ambiguous.push({ name: r.entryName || r.charId, count: med.length });
      }
    }

    // Save state
    saveLitrpgState();

    // Build summary toast
    const parts = [];
    const totalAutoApplied = autoApplied.reduce((sum, a) => sum + a.count, 0);
    if (totalAutoApplied > 0) {
      const names = autoApplied.map(a => a.name).slice(0, 3).join(', ');
      parts.push(`${totalAutoApplied} changes for ${names}`);
    }
    if (ambiguous.length > 0) {
      const ambCount = ambiguous.reduce((sum, a) => sum + a.count, 0);
      parts.push(`${ambCount} need review`);
    }
    if (skipped.length > 0) {
      console.log('[LitRPG] Reverse sync skipped regressions:', skipped);
    }

    if (parts.length > 0) {
      const hasUndo = Object.keys(snapshots).length > 0;
      showToast(
        `Synced: ${parts.join(', ')}`,
        null,
        'success',
        hasUndo ? {
          onUndo: () => {
            // Restore snapshots
            for (const [charId, snapshot] of Object.entries(snapshots)) {
              state.litrpgState.characters[charId] = snapshot;
            }
            saveLitrpgState();
            refreshRpgUI();
            showToast('Reverse sync undone');
          },
        } : {}
      );
    } else {
      showToast('No actionable changes found');
    }

    refreshRpgUI();
  } catch (e) {
    console.error('[LitRPG] Reverse sync error:', e);
    showToast(e.message || 'Reverse sync failed', null, 'error');
  } finally {
    rpgReverseSyncBtn.disabled = false;
    rpgReverseSyncBtn.title = '';
  }
}

async function enableLitRPG() {
  if (!state.litrpgState) state.litrpgState = {};
  state.litrpgState.enabled = true;
  state.litrpgState.dismissedDetection = false;
  state.litrpgEnabled = true;
  saveLitrpgState();
  refreshRpgUI();
  showToast('LitRPG tracking enabled!');
}

function dismissDetection() {
  if (!state.litrpgState) state.litrpgState = {};
  state.litrpgState.dismissedDetection = true;
  saveLitrpgState();
  refreshRpgUI();
}

function disableLitRPG() {
  if (!state.litrpgState) return;
  state.litrpgState.enabled = false;
  state.litrpgEnabled = false;
  saveLitrpgState();
  refreshRpgUI();
  showToast('LitRPG tracking disabled');
}

// Bulk actions (Phase 5B)
async function acceptAll() {
  if (!state.currentStoryId) return;
  if (rpgAcceptAllBtn) rpgAcceptAllBtn.disabled = true;
  try {
    const result = await window.powertool.litrpgAcceptAllUpdates(state.currentStoryId);
    if (result.success) {
      state.litrpgState = result.state;
      refreshRpgUI();
      showToast('All updates accepted');
    }
  } finally {
    if (rpgAcceptAllBtn) rpgAcceptAllBtn.disabled = false;
  }
}

async function rejectAll() {
  if (!state.currentStoryId) return;
  // Save snapshot for undo
  const snapshot = JSON.parse(JSON.stringify(state.litrpgState?.pendingUpdates || []));
  if (rpgRejectAllBtn) rpgRejectAllBtn.disabled = true;
  try {
    const result = await window.powertool.litrpgRejectAllUpdates(state.currentStoryId);
    if (result.success) {
      state.litrpgState = result.state;
      refreshRpgUI();
      showToast('All updates rejected', 5000, '', {
        onUndo: () => {
          // Restore pending updates
          if (state.litrpgState) {
            state.litrpgState.pendingUpdates = snapshot;
            saveLitrpgState();
            refreshRpgUI();
          }
          showToast('Updates restored', 2000, 'success');
        },
      });
    }
  } finally {
    if (rpgRejectAllBtn) rpgRejectAllBtn.disabled = false;
  }
}

// =========================================================================
// IPC LISTENERS
// =========================================================================

function setupIPCListeners() {
  window.powertool.onLitrpgScanProgress((progress) => {
    const phaseLabels = {
      characters: 'Extracting character RPG data',
      quests: 'Scanning for quests',
      party: 'Classifying party & NPCs',
      'lore-elements': 'Generating RPG lore entries',
      enrichment: 'Enriching entity descriptions',
      complete: 'Scan complete',
    };
    if (rpgScanPhase) {
      let label = phaseLabels[progress.phase] || progress.phase;
      if (progress.current != null && progress.total) {
        label += ` (${progress.current}/${progress.total})`;
      }
      if (progress.characterName) {
        label += ` — ${progress.characterName}`;
      }
      if (progress.errorCount > 0) {
        label += ` [${progress.errorCount} error${progress.errorCount > 1 ? 's' : ''}]`;
      }
      rpgScanPhase.textContent = label;

      // Compute ETA from passStartedAt
      if (progress.passStartedAt && progress.current > 0 && progress.total > progress.current) {
        const elapsed = Date.now() - progress.passStartedAt;
        const remaining = Math.round((elapsed / progress.current) * (progress.total - progress.current) / 1000);
        lastEtaText = remaining > 2 ? ` · ~${remaining}s remaining` : '';
      } else {
        lastEtaText = '';
      }
    }
    // Update step indicator
    if (rpgScanSteps) {
      const phaseOrder = ['characters', 'quests', 'party', 'lore-elements', 'enrichment'];
      const currentIdx = phaseOrder.indexOf(progress.phase);
      rpgScanSteps.querySelectorAll('.rpg-scan-step').forEach(step => {
        const stepPhase = step.dataset.phase;
        const stepIdx = phaseOrder.indexOf(stepPhase);
        step.classList.remove('active', 'completed');
        if (stepIdx < currentIdx) step.classList.add('completed');
        else if (stepIdx === currentIdx) step.classList.add('active');
      });
    }
  });

  window.powertool.onLitrpgStateUpdated(async (data) => {
    // Support both old shape (raw state) and new shape ({ state, roleUpdates, pendingLoreEntries })
    const newState = data.state || data;
    state.litrpgState = newState;
    state.litrpgEnabled = newState.enabled;
    refreshRpgUI();
    if (graphViewActive && relationshipGraphContainer) {
      import('./relationship-graph.js').then(({ renderRelationshipGraph }) => {
        renderRelationshipGraph(relationshipGraphContainer, newState);
      });
    }

    // Emit events for portrait queue
    const updatedChars = getRpgState()?.characters;
    if (data.newCharacterIds?.length && updatedChars) {
      bus.emit('litrpg:new-characters', {
        newCharacterIds: data.newCharacterIds,
        characters: updatedChars,
      });
    }
    if (data.visualProfileUpdatedIds?.length && updatedChars) {
      bus.emit('litrpg:visual-profiles-updated', {
        visualProfileUpdatedIds: data.visualProfileUpdatedIds,
        characters: updatedChars,
      });
    }

    // Process transient fields from chained RPG scan
    if (data.roleUpdates && data.roleUpdates.length > 0) {
      await applyRoleUpdatesToLorebook(data.roleUpdates);
    }
    if (data.pendingLoreEntries && data.pendingLoreEntries.length > 0) {
      if (!state.loreState) state.loreState = { pendingEntries: [], rejectedNames: [] };
      if (!state.loreState.pendingEntries) state.loreState.pendingEntries = [];
      const existingNames = new Set((state.loreState.pendingEntries || []).map(e => e.displayName.toLowerCase()));
      const rejectedNames = new Set((state.loreState.rejectedNames || []).map(n => n.toLowerCase()));
      const newEntries = data.pendingLoreEntries.filter(e =>
        !existingNames.has(e.displayName.toLowerCase()) && !rejectedNames.has(e.displayName.toLowerCase())
      );
      if (newEntries.length > 0) {
        state.loreState.pendingEntries.push(...newEntries);
        await saveLoreState();
        refreshLoreUI();
        showToast(`Found ${newEntries.length} RPG lore entr${newEntries.length === 1 ? 'y' : 'ies'} — check Lore tab`);
      }
    }
  });

  window.powertool.onLitrpgDetected(({ systemType }) => {
    if (!state.litrpgState) state.litrpgState = {};
    state.litrpgState.detected = true;
    state.litrpgState.systemType = systemType;
    saveLitrpgState();
    if (rpgDetectedType) {
      const typeLabels = {
        generic: 'Generic RPG', dnd: 'D&D Style', cultivation: 'Cultivation',
        gamelit: 'GameLit', mmorpg: 'MMORPG', survival: 'Survival',
      };
      rpgDetectedType.textContent = typeLabels[systemType] || systemType;
    }
    refreshRpgUI();
    showToast(`LitRPG story detected (${systemType})!`);
  });
}

// =========================================================================
// STORY SWITCH HANDLER
// =========================================================================

function onStorySwitch() {
  graphViewActive = false;
  const rpg = state.litrpgState || {};
  state.litrpgEnabled = !!rpg.enabled;
  refreshRpgUI();
}

// =========================================================================
// INIT
// =========================================================================

export function init() {
  // Button handlers
  if (rpgEnableBtn) rpgEnableBtn.addEventListener('click', enableLitRPG);
  if (rpgDismissBtn) rpgDismissBtn.addEventListener('click', dismissDetection);
  if (rpgScanBtn) rpgScanBtn.addEventListener('click', runRpgScan);
  if (rpgSyncLorebookBtn) rpgSyncLorebookBtn.addEventListener('click', syncToLorebook);
  if (rpgReverseSyncBtn) rpgReverseSyncBtn.addEventListener('click', handleReverseSync);
  if (rpgDisableBtn) rpgDisableBtn.addEventListener('click', disableLitRPG);

  // Bulk actions (Phase 5B)
  if (rpgAcceptAllBtn) rpgAcceptAllBtn.addEventListener('click', acceptAll);
  if (rpgRejectAllBtn) rpgRejectAllBtn.addEventListener('click', rejectAll);

  // Stat overlay close
  if (rpgStatOverlayClose) rpgStatOverlayClose.addEventListener('click', closeStatOverlay);
  if (rpgStatOverlay) rpgStatOverlay.addEventListener('click', (e) => {
    if (e.target === rpgStatOverlay) closeStatOverlay();
  });

  // --- Delegated event listeners for RPG card lists ---
  if (rpgPartyList) rpgPartyList.addEventListener('click', (e) => {
    const card = e.target.closest('.rpg-character-card-v2');
    if (card) openStatOverlay(card.dataset.charId, getRpgState());
  });

  if (rpgUpdatesList) rpgUpdatesList.addEventListener('click', async (e) => {
    const acceptBtn = e.target.closest('.rpg-accept-update');
    const rejectBtn = e.target.closest('.rpg-reject-update');
    if (!acceptBtn && !rejectBtn) return;
    const card = (acceptBtn || rejectBtn).closest('.rpg-update-card');
    if (!card) return;
    const updateId = card.dataset.updateId;
    if (acceptBtn) {
      const result = await window.powertool.litrpgAcceptUpdate(state.currentStoryId, updateId);
      if (result.success) {
        state.litrpgState = result.state;
        refreshRpgUI();
        showToast('Update accepted', 2000, 'success');
      } else {
        showToast(`Failed to accept: ${result.error || 'Unknown error'}`, 3000, 'error');
      }
    } else {
      const result = await window.powertool.litrpgRejectUpdate(state.currentStoryId, updateId);
      if (result.success) {
        state.litrpgState = result.state;
        refreshRpgUI();
      }
    }
  });

  // NPC search (Phase 5F)
  if (rpgNpcSearch) {
    rpgNpcSearch.addEventListener('input', () => {
      npcSearchFilter = rpgNpcSearch.value;
      renderNPCs(getRpgState());
    });
  }

  // NPC group by disposition toggle (Gap 6)
  if (rpgNpcGroupBtn) {
    rpgNpcGroupBtn.addEventListener('click', () => {
      npcGroupByDisposition = !npcGroupByDisposition;
      rpgNpcGroupBtn.classList.toggle('active', npcGroupByDisposition);
      renderNPCs(getRpgState());
    });
  }

  // Album lightbox controls
  if (rpgAlbumPrev) rpgAlbumPrev.addEventListener('click', () => {
    if (albumItems.length === 0) return;
    albumIndex = (albumIndex - 1 + albumItems.length) % albumItems.length;
    showAlbumLightbox();
  });
  if (rpgAlbumNext) rpgAlbumNext.addEventListener('click', () => {
    if (albumItems.length === 0) return;
    albumIndex = (albumIndex + 1) % albumItems.length;
    showAlbumLightbox();
  });
  if (rpgAlbumClose) rpgAlbumClose.addEventListener('click', () => {
    if (rpgAlbumLightbox) { rpgAlbumLightbox.classList.remove('is-open'); rpgAlbumLightbox.classList.add('u-hidden'); }
  });
  if (rpgAlbumSetActive) rpgAlbumSetActive.addEventListener('click', () => {
    if (albumItems[albumIndex]) {
      setAlbumAsActive(albumCharId, albumItems[albumIndex].id);
      if (rpgAlbumLightbox) { rpgAlbumLightbox.classList.remove('is-open'); rpgAlbumLightbox.classList.add('u-hidden'); }
    }
  });
  if (rpgAlbumDelete) rpgAlbumDelete.addEventListener('click', () => {
    if (albumItems[albumIndex]) {
      deleteAlbumImage(albumCharId, albumItems[albumIndex].id);
      if (rpgAlbumLightbox) { rpgAlbumLightbox.classList.remove('is-open'); rpgAlbumLightbox.classList.add('u-hidden'); }
    }
  });
  // Keyboard navigation for album lightbox
  document.addEventListener('keydown', (e) => {
    if (!rpgAlbumLightbox || !rpgAlbumLightbox.classList.contains('is-open')) return;
    if (e.key === 'ArrowLeft') { rpgAlbumPrev?.click(); }
    else if (e.key === 'ArrowRight') { rpgAlbumNext?.click(); }
    else if (e.key === 'Escape') { rpgAlbumClose?.click(); }
  });

  // Settings persistence (Phase 5A)
  if (rpgAutoScan) {
    rpgAutoScan.addEventListener('change', () => {
      if (!state.litrpgState) state.litrpgState = {};
      state.litrpgState.autoScan = rpgAutoScan.checked;
      saveLitrpgState();
    });
  }
  if (rpgAutoSync) {
    rpgAutoSync.addEventListener('change', () => {
      if (!state.litrpgState) state.litrpgState = {};
      state.litrpgState.autoSync = rpgAutoSync.checked;
      saveLitrpgState();
    });
  }

  // Bulk portrait generation
  if (rpgGenerateAllPortraits) {
    rpgGenerateAllPortraits.addEventListener('click', (e) => {
      const rpg = getRpgState();
      if (!rpg?.characters) return;
      const regenerate = e.shiftKey;
      const chars = Object.entries(rpg.characters).map(([charId, char]) => ({
        charId,
        charName: char.name || char.loreEntryName || charId,
        rpgData: char,
      }));
      enqueuePortraits(chars, { regenerate });
    });
  }

  // Graph toggle
  if (graphToggleBtn) {
    graphToggleBtn.addEventListener('click', () => {
      graphViewActive = !graphViewActive;
      graphToggleBtn.textContent = graphViewActive ? 'List' : 'Graph';
      if (graphViewActive && relationshipGraphContainer) {
        import('./relationship-graph.js').then(({ renderRelationshipGraph }) => {
          renderRelationshipGraph(relationshipGraphContainer, getRpgState());
        });
      } else if (relationshipGraphContainer) {
        import('./relationship-graph.js').then(({ clearRelationshipGraph }) => {
          clearRelationshipGraph(relationshipGraphContainer);
        });
      }
      refreshRpgUI();
    });
  }

  // IPC listeners
  setupIPCListeners();

  // Listen for story switch events
  bus.on('story:changed', onStorySwitch);

  // Refresh Cast tab when a timeline scan completes — new scene characters may have been detected
  bus.on('timeline:scanned', () => {
    refreshRpgUI();
  });

  // Refresh UI when portrait queue finishes or a portrait is generated
  bus.on('portrait:queue-complete', () => { saveLitrpgState(); refreshRpgUI(); });
  bus.on('portrait:generated', () => refreshRpgUI());
}
