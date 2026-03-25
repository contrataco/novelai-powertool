// story-selector.js — Native dashboard for headless story selection
import { state, bus } from './state.js';
import * as refs from './dom-refs.js';

export function init() {
  if (!refs.storySelectionOverlay) return;

  // Handle "Dashboard" button in editor toolbar
  if (refs.editorBackBtn) {
    refs.editorBackBtn.addEventListener('click', () => {
      console.log('[StorySelector] Dashboard button clicked, navigating back...');
      bus.emit('headless:select-story', ''); // Empty ID tells webview to go to dashboard
      state.currentStoryId = null;
      state.currentStoryTitle = null;
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
    if (state.isDashboardActive) {
      renderStoryList();
    }
  });

  // Listen for dashboard state changes
  bus.on('headless:dashboard-state-changed', (isActive) => {
    state.isDashboardActive = isActive;
    updateVisibility();
    if (isActive) {
      tryFetchFromAPI();
    }
  });

  // Handle "Refresh" button
  if (refs.refreshStoriesBtn) {
    refs.refreshStoriesBtn.addEventListener('click', () => {
      console.log('[StorySelector] Refresh button clicked, fetching...');
      showLoading();
      tryFetchFromAPI();
      // Also reset polling's dashboard check so it re-parses from DOM
      bus.emit('headless:force-dashboard-reparse');
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
  
  // Initial check
  updateVisibility();
}

export function updateVisibility() {
  // We should show the selector if headless mode is active AND no story is currently loaded
  // OR if we are explicitly on the dashboard
  const shouldShow = state.headlessMode && (!state.currentStoryId || state.isDashboardActive);
  
  if (shouldShow) {
    document.querySelector('.main-container').classList.add('showing-story-selector');
    
    // Ensure the editor container is hidden when selector is shown
    if (refs.editorContainer) {
      refs.editorContainer.style.display = 'none';
    }

    if (state.availableStories.length > 0) {
      renderStoryList();
    } else {
      showLoading();
      // Add a timeout to show the empty state if nothing loads in 20s
      setTimeout(() => {
        if (state.availableStories.length === 0 && state.isDashboardActive) {
          refs.storySelectionLoading.style.display = 'none';
          refs.storySelectionEmpty.style.display = 'block';
        }
      }, 20000);
    }
  } else {
    document.querySelector('.main-container').classList.remove('showing-story-selector');
    
    // Restore editor container visibility if headless mode is on
    if (state.headlessMode && state.currentStoryId && refs.editorContainer) {
      refs.editorContainer.style.display = 'flex';
    }
  }
}

function showLoading() {
  refs.storySelectionLoading.style.display = 'flex';
  refs.storyList.style.display = 'none';
  refs.storySelectionEmpty.style.display = 'none';
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
    
    const lastModifiedStr = story.lastModified ? new Date(story.lastModified).toLocaleDateString() : 'Unknown';
    const lastModifiedFull = story.lastModified ? new Date(story.lastModified).toLocaleString() : 'Unknown';
    
    card.innerHTML = `
      <div class="story-title" title="${story.title}">${story.title}</div>
      <div class="story-description">${story.description || 'No description available.'}</div>
      <div class="story-meta">
        <span title="${lastModifiedFull}">Updated: ${lastModifiedStr}</span>
        ${story.wordCount ? `<span>${story.wordCount} words</span>` : ''}
      </div>
      <div class="story-tags">
        ${(story.tags || []).map(tag => `<span class="story-tag">${tag}</span>`).join('')}
      </div>
    `;
    
    // Add staggered delay for animation
    card.style.animationDelay = `${index * 0.05}s`;

    card.addEventListener('click', () => {
      selectStory(story.id);
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

function selectStory(storyId) {
  console.log(`[PowerTool] Selecting story: ${storyId}`);
  
  // Show loading while we navigate
  showLoading();
  
  // Inform webview-polling/headless-sync to navigate the webview
  bus.emit('headless:select-story', storyId);
}
