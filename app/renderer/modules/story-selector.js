// story-selector.js — Native dashboard for headless story selection
import { state, bus } from './state.js';
import * as refs from './dom-refs.js';

export function init() {
  if (!refs.storySelectionOverlay) return;

  // Handle "Dashboard" button in editor toolbar
  if (refs.editorBackBtn) {
    refs.editorBackBtn.addEventListener('click', () => {
      console.log('[StorySelector] Dashboard button clicked, navigating back...');
      bus.emit('headless:select-story', { storyId: '', title: '' }); // Empty ID = go to dashboard
      state.currentStoryId = null;
      state.currentStoryTitle = null;
      state.storyTextLoaded = false;
      state._loadingStoryId = null;
      if (refs.editorStoryTitle) refs.editorStoryTitle.textContent = 'No Story Loaded';
      updateVisibility();
    });
  }

  // Handle story title click (metadata edit)
  if (refs.editorStoryTitle) {
    refs.editorStoryTitle.addEventListener('click', () => {
      if (state.currentStoryId) {
        bus.emit('headless:open-metadata-panel');
      }
    });
  }

  // Listen for story list updates from webview-polling
  bus.on('headless:stories-updated', (stories) => {
    state.availableStories = stories;
    // Don't update dashboard phases if a story is loading
    if (state._loadingStoryId) return;
    if (stories.length > 0) {
      updateLoadingPhase('found', `Found ${stories.length} stories!`);
      setTimeout(() => {
        updateVisibility();
        if (state.isDashboardActive) renderStoryList();
      }, 400);
    } else {
      updateLoadingPhase('parsing');
      updateVisibility();
    }
  });

  // Listen for dashboard state changes
  bus.on('headless:dashboard-state-changed', (isActive) => {
    state.isDashboardActive = isActive;
    // Don't override story loading phases with dashboard phases
    if (state._loadingStoryId) return;
    if (isActive) {
      updateLoadingPhase('dashboard');
      tryFetchFromAPI();
    }
    updateVisibility();
  });

  // Handle "Refresh" button
  if (refs.refreshStoriesBtn) {
    refs.refreshStoriesBtn.addEventListener('click', () => {
      console.log('[StorySelector] Refresh button clicked');
      updateLoadingPhase('connecting');
      showLoading();
      tryFetchFromAPI();
      bus.emit('headless:force-dashboard-reparse');
    });
  }

  // Handle "Retry" button (error state)
  if (refs.retryStoriesBtn) {
    refs.retryStoriesBtn.addEventListener('click', () => {
      console.log('[StorySelector] Retry button clicked');
      updateLoadingPhase('connecting');
      showLoading();
      bus.emit('headless:force-dashboard-reparse');
      tryFetchFromAPI();
    });
  }

  // Handle Search input
  if (refs.headlessStorySearch) {
    refs.headlessStorySearch.addEventListener('input', () => {
      renderStoryList();
    });
  }

  // Handle "Go to NovelAI Dashboard" button (in case they want to see the real webview)
  if (refs.goToNovelaiDashboard) {
    refs.goToNovelaiDashboard.addEventListener('click', () => {
      bus.emit('headless:force-webview', true);
    });
  }

  // Handle List/Grid toggle
  if (refs.toggleStoryListViewBtn) {
    refs.toggleStoryListViewBtn.addEventListener('click', () => {
      refs.storyList.classList.toggle('list-view');
      const isListView = refs.storyList.classList.contains('list-view');
      localStorage.setItem('powertool-story-list-view', isListView ? 'list' : 'grid');
    });

    // Restore preference
    if (localStorage.getItem('powertool-story-list-view') === 'list') {
      refs.storyList.classList.add('list-view');
    }
  }
  
  // Listen for story loading phases from headless-editor
  bus.on('story:loading-phase', (phase, detail) => {
    updateLoadingPhase(phase, detail);
  });

  // Initial check
  updateVisibility();
}

export function updateVisibility() {
  // Show overlay when: no story, on dashboard, or story selected but text not yet loaded
  const storyReady = state.currentStoryId && state.storyTextLoaded;
  const shouldShowOverlay = state.headlessMode && (!state.currentStoryId || state.isDashboardActive || !storyReady);

  if (shouldShowOverlay) {
    refs.storySelectionOverlay.classList.add('visible');

    if (refs.editorContainer) {
      refs.editorContainer.style.display = 'none';
    }

    // If story is selected but still loading, show loading phase
    if (state.currentStoryId && !state.storyTextLoaded && !state.isDashboardActive) {
      showLoading();
      return;
    }

    if (state.availableStories.length > 0) {
      renderStoryList();
    } else {
      showLoading();
      // Show error state if nothing loads in 30s
      setTimeout(() => {
        if (state.availableStories.length === 0 && state.isDashboardActive) {
          updateLoadingPhase('error', 'The connection timed out. NovelAI may be slow or unavailable.');
          refs.storySelectionLoading.style.display = 'none';
          refs.storySelectionEmpty.style.display = 'flex';
        }
      }, 30000);
    }
  } else {
    refs.storySelectionOverlay.classList.remove('visible');

    if (state.headlessMode && state.currentStoryId && refs.editorContainer) {
      refs.editorContainer.style.display = 'flex';
    }
  }
}

function showLoading() {
  refs.storySelectionLoading.style.display = 'flex';
  refs.storyList.style.display = 'none';
  refs.storySelectionEmpty.style.display = 'none';
  // Only set default dashboard text if not loading a story
  if (!state._loadingStoryId) {
    updateLoadingPhase('connecting');
  }
}

function updateLoadingPhase(phase, detail) {
  const statusEl = refs.storyLoadingStatus;
  const fillEl = refs.storyLoadingFill;
  const detailEl = refs.storyLoadingDetail;
  const iconEl = refs.storyLoadingIcon;
  if (!statusEl || !fillEl) return;

  // Clear modifier classes
  fillEl.classList.remove('error', 'success');
  if (iconEl) iconEl.style.animation = 'spin 2s linear infinite';

  // Detail text overrides defaults when provided (story loading sends its own text)
  var isStoryLoad = !!state.currentStoryId && !state.storyTextLoaded;
  switch (phase) {
    case 'connecting':
      statusEl.textContent = detail || 'Connecting to NovelAI...';
      fillEl.style.width = '10%';
      if (detailEl) detailEl.textContent = isStoryLoad ? '' : 'This usually takes 10-15 seconds';
      break;
    case 'dashboard':
      statusEl.textContent = detail || 'Waiting for stories to load...';
      fillEl.style.width = '30%';
      if (detailEl) detailEl.textContent = '';
      break;
    case 'parsing':
      statusEl.textContent = detail || 'Scanning for stories...';
      fillEl.style.width = '50%';
      if (detailEl) detailEl.textContent = '';
      break;
    case 'found':
      statusEl.textContent = detail || 'Stories found!';
      fillEl.style.width = '100%';
      fillEl.classList.add('success');
      if (iconEl) iconEl.style.animation = 'none';
      if (detailEl) detailEl.textContent = '';
      break;
    case 'error':
      statusEl.textContent = detail || 'Something went wrong';
      fillEl.style.width = '100%';
      fillEl.classList.add('error');
      if (iconEl) {
        iconEl.textContent = '\u26A0';
        iconEl.style.animation = 'none';
      }
      if (detailEl) detailEl.textContent = 'Click Retry or try selecting a different story.';
      break;
  }
}

function renderStoryList() {
  const stories = state.availableStories;
  
  refs.storySelectionLoading.style.display = 'none';
  
  if (!stories || stories.length === 0) {
    refs.storyList.style.display = 'none';
    refs.storySelectionEmpty.style.display = 'block';
    return;
  }

  // Apply search filter if active
  const filter = refs.headlessStorySearch?.value.toLowerCase() || '';
  const filtered = stories.filter(s => 
    (s.title || '').toLowerCase().includes(filter) || 
    (s.description || '').toLowerCase().includes(filter) ||
    (s.tags || []).some(t => t.toLowerCase().includes(filter))
  );

  if (filtered.length === 0 && filter) {
    refs.storyList.style.display = 'none';
    refs.storySelectionEmpty.style.display = 'block';
    refs.storySelectionEmptyText.textContent = 'No stories match your search.';
    return;
  }

  refs.storySelectionEmpty.style.display = 'none';
  refs.storyList.style.display = 'grid';
  refs.storyList.innerHTML = '';

  filtered.forEach((story, index) => {
    const card = document.createElement('div');
    card.className = 'story-card';
    card.dataset.id = story.id;

    // Use timeAgo from NovelAI dashboard if available, otherwise format lastModified
    const timeDisplay = story.timeAgo || (story.lastModified ? new Date(story.lastModified).toLocaleDateString() : '');

    // Escape HTML in title/description to prevent XSS
    const escTitle = story.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escDesc = (story.description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    card.innerHTML = `
      <div class="story-title" title="${escTitle}">${escTitle}</div>
      <div class="story-description">${escDesc || 'No description available.'}</div>
      <div class="story-meta">
        ${timeDisplay ? `<span>${timeDisplay}</span>` : ''}
        ${story.wordCount ? `<span>${story.wordCount} words</span>` : ''}
      </div>
      <div class="story-tags">
        ${(story.tags || []).map(tag => `<span class="story-tag">${tag}</span>`).join('')}
      </div>
    `;

    // Add staggered delay for animation
    card.style.animationDelay = `${index * 0.05}s`;

    card.addEventListener('click', () => {
      if (story._hasRealId === false) {
        console.log(`[StorySelector] Click-navigating story: "${story.title}" (index ${story._clickIndex})`);
        selectStoryByClick(story._clickIndex, story.title);
      } else {
        selectStory(story.id, story.title);
      }
    });

    refs.storyList.appendChild(card);
  });
  
  // Add "New Story" button at the end
  if (!filter) {
    const newStoryCard = document.createElement('div');
    newStoryCard.className = 'story-card new-story-card';
    newStoryCard.innerHTML = `
      <div class="story-title" style="color: var(--accent); text-align: center; margin-top: 20px;">+ Create New Story</div>
      <div class="story-description" style="text-align: center;">Click to switch to Webview mode and create a new story.</div>
    `;
    newStoryCard.addEventListener('click', () => {
      bus.emit('headless:force-webview', true);
    });
    refs.storyList.appendChild(newStoryCard);
  }
}

async function tryFetchFromAPI() {
  if (state.availableStories.length > 0) {
    // If we already have stories from DOM, still try API as it might have better metadata
    // but don't show loading if we have DOM results unless it's a manual refresh.
  }

  console.log('[StorySelector] Fetching stories via API...');
  try {
    const result = await window.powertool.novelaiFetchStories();
    if (result.success && result.stories && result.stories.length > 0) {
      console.log(`[StorySelector] Fetched ${result.stories.length} stories via API`);
      
      // Merge or replace? For now replace is safer to ensure valid IDs
      state.availableStories = result.stories;
      if (state.isDashboardActive) {
        renderStoryList();
      }
    } else if (!result.success) {
      console.warn('[StorySelector] API fetch returned failure:', result.error);
      if (result.error && result.error.includes('401')) {
        showLoginRequired();
      }
    }
  } catch (e) {
    console.error('[StorySelector] API fetch failed:', e);
  }
}

function showLoginRequired() {
  refs.storySelectionLoading.style.display = 'none';
  refs.storyList.style.display = 'none';
  refs.storySelectionEmpty.style.display = 'block';
  if (refs.storySelectionEmptyText) {
    refs.storySelectionEmptyText.textContent = 'Login required. Please log in to NovelAI in the dashboard.';
  }
}

function selectStory(storyId, title) {
  console.log(`[PowerTool] Selecting story: ${storyId} "${title}"`);

  // Set both flags: currentStoryId for visibility gating, _loadingStoryId for
  // dashboard suppression + allowing handleStoryContextChange to re-enter
  state.currentStoryId = storyId;
  state._loadingStoryId = storyId;
  state.storyTextLoaded = false;
  state.isDashboardActive = false;

  updateLoadingPhase('connecting', 'Opening story in NovelAI...');
  showLoading();
  bus.emit('headless:select-story', { storyId, title });
}

function selectStoryByClick(clickIndex, title) {
  console.log(`[StorySelector] Click-navigating: index=${clickIndex} title="${title}"`);

  state._loadingStoryId = true;
  state.storyTextLoaded = false;
  state.isDashboardActive = false;

  updateLoadingPhase('connecting', 'Opening story in NovelAI...');
  showLoading();
  bus.emit('headless:click-story', { clickIndex, title });
}
