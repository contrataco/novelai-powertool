# NovelAI PowerTool Script

A NovelAI user script that bridges the NovelAI web interface with the PowerTool Electron app, automatically generating image prompts from your story content.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Usage](#usage)
- [Settings](#settings)
- [Character Integration](#character-integration)
- [How It Works](#how-it-works)
- [Technical Details](#technical-details)
- [Troubleshooting](#troubleshooting)
- [Requirements](#requirements)

---

## Overview

This script is the **companion component** to the [PowerTool Electron App](../app/). While the app handles image generation and display, this script:

- Analyzes your story content to generate image prompts
- Extracts character appearances from your lorebook
- Sends prompts to the Electron app for image generation
- Provides a UI panel for prompt preview and settings

**Important**: This script requires the PowerTool app to be running. Without the app, prompts will be generated but no images will be created.

---

## Installation

### Prerequisites

1. **PowerTool App** must be installed and running
2. Access to NovelAI's **Script API** feature

### Steps

1. **Open NovelAI** within the PowerTool app's webview

2. Navigate to **Settings → Advanced → Scripts**

3. **Create a new script**:
   - Click "Add Script"
   - Name it "PowerTool"

4. **Copy the script**:
   - Open [`novelai-powertool.ts`](novelai-powertool.ts)
   - Copy the entire file contents

5. **Paste and save**:
   - Paste into the script editor
   - Click Save

6. **Enable the script**:
   - Toggle the script ON

---

## Usage

### Automatic Mode (Default)

With **Auto Generate** enabled:

1. Write or generate story content
2. After generation ends, the script analyzes recent text
3. A prompt is automatically generated
4. The prompt appears in the script's UI panel
5. The Electron app reads the prompt and generates an image
6. The image appears in the app's side panel

### Manual Mode

With **Auto Generate** disabled:

1. Write your story content
2. Click **"Regenerate Prompt"** in the script panel when you want an image
3. The prompt is generated and sent to the app

### UI Panel Controls

| Control | Description |
|---------|-------------|
| **Current Prompt** | Read-only display of the generated prompt |
| **Regenerate Prompt** | Force a new prompt for the current scene |
| **Auto Generate** | Toggle automatic prompt generation |
| **Use Character Lore** | Include character appearances from lorebook |
| **Art Style** | Custom tags appended to all prompts |
| **Min Text Length** | Minimum new content required to trigger |

---

## Settings

### Auto Generate

| Property | Value |
|----------|-------|
| Default | On |
| Type | Toggle |

When enabled, prompts are automatically generated after each story generation. Disable for manual control over when images are created.

### Use Character Lore

| Property | Value |
|----------|-------|
| Default | On |
| Type | Toggle |

When enabled, the script scans your lorebook for character entries and includes their appearance descriptions in prompts. This helps maintain visual consistency for characters across images.

### Art Style

| Property | Value |
|----------|-------|
| Default | `anime style, detailed, high quality` |
| Type | Text input |

Custom style tags that are appended to every generated prompt. Customize this to match your preferred art style.

**Examples**:
- `realistic, photographic, detailed lighting`
- `watercolor painting, soft colors, artistic`
- `pixel art, retro, 16-bit style`
- `dark fantasy, dramatic lighting, detailed`

### Min Text Length

| Property | Value |
|----------|-------|
| Default | 100 |
| Range | 50 - 500 characters |
| Type | Slider |

Minimum amount of new story content (in characters) required to trigger automatic prompt generation. Increase this to reduce frequency of image generation; decrease for more frequent updates.

---

## Character Integration

The script can automatically include character visual descriptions in prompts by scanning your lorebook.

### Setting Up Characters

1. **Create Lorebook Entries** for your characters

2. **Include Appearance Information** using one of these formats:
   ```
   Appearance: Tall woman with long red hair and green eyes.
   ```
   ```
   Physical description: Muscular build, short black hair, brown skin.
   ```
   ```
   She has silver hair, blue eyes, and wears a dark cloak.
   ```

3. **Enable the Entry** in your lorebook

### Supported Patterns

The script recognizes these patterns for appearance extraction:

| Pattern | Example |
|---------|---------|
| `Appearance:` | `Appearance: Tall with blonde hair...` |
| `Physical description:` | `Physical description: Athletic build...` |
| `Looks like:` | `Looks like: A young woman with...` |
| `Description:` | `Description: Short, stocky dwarf...` |
| Visual keywords | `She has red hair and blue eyes` |

**Visual keywords detected**: hair, eyes, tall, short, wears, wearing, dressed, skin, face, build

### How Detection Works

1. Script scans all enabled lorebook entries
2. Entries under 500 characters with visual keywords are considered
3. Up to 300 characters of appearance text extracted per character
4. When a character is mentioned in recent story text (last 3000 chars), their appearance is included

### Prompt Format

Character appearances are included in the prompt like this:
```
[CharacterName: appearance description], scene description, art style tags
```

---

## How It Works

### Processing Flow

```
Story Generation Ends
        ↓
Check Auto Generate enabled?
        ↓
Collect story text from all sections
        ↓
Check minimum text length threshold
        ↓
Scan lorebook for character entries (if enabled)
        ↓
Detect mentioned characters in recent text
        ↓
Send to GLM-4-6 for scene analysis
        ↓
Receive structured prompt (positive + negative)
        ↓
Display in UI panel
        ↓
Electron app reads prompt and generates image
```

### Scene Analysis

The script uses GLM-4-6 with a specialized prompt to analyze:

- **Characters present**: Who is in the current scene
- **Setting/location**: Where the scene takes place
- **Actions**: What's happening
- **Atmosphere**: Mood, lighting, weather
- **Character poses/expressions**: How characters appear

### Prompt Structure

The LLM returns a JSON structure:
```json
{
  "prompt": "1girl, red hair, green eyes, standing in library, surrounded by books, warm lighting, anime style, detailed, high quality",
  "negativePrompt": "blurry, low quality, bad anatomy, extra limbs"
}
```

---

## Technical Details

### APIs Used

| API | Purpose |
|-----|---------|
| `api.v1.generate` | GLM-4-6 for scene analysis |
| `api.v1.lorebook.entries()` | Read character definitions |
| `api.v1.document` | Read story content |
| `api.v1.storyStorage` | Persistent settings storage |
| `api.v1.hooks.register` | Hook generation events |
| `api.v1.ui.*` | Panel UI components |

### Processing Limits

| Limit | Value | Purpose |
|-------|-------|---------|
| Recent text analyzed | 2000 chars | Scene context extraction |
| Character mention scan | 3000 chars | Detect present characters |
| Max appearance text | 300 chars | Per-character description |
| Max lorebook entry | 500 chars | For full-entry consideration |
| Generation max tokens | 400 | LLM response limit |
| Generation temperature | 0.7 | Creativity balance |

### Storage Structure

```typescript
{
  settings: {
    autoGenerate: boolean,
    minTextLength: number,
    artStyle: string,
    useCharacterLore: boolean
  },
  lastProcessedSection: string,
  currentImage: string | null,
  lastPrompt: string
}
```

### Bridge Communication

The script communicates with the Electron app through a DOM bridge:

1. Script writes prompt to a designated textarea in the UI panel
2. Electron app polls this textarea every 3 seconds
3. When new prompt detected, app triggers image generation
4. App dispatches events back to script for status updates

---

## Troubleshooting

### Prompt Not Appearing

**Symptoms**: No prompt shows in the script panel after generation.

**Solutions**:
1. Check **Auto Generate** is enabled
2. Verify new content exceeds **Min Text Length** threshold
3. Click **Regenerate Prompt** to force generation
4. Ensure the script is enabled (toggle ON)

### Character Lore Not Included

**Symptoms**: Character appearances not in the prompt despite lorebook entries.

**Solutions**:
1. Verify **Use Character Lore** is enabled
2. Check lorebook entries are **enabled** (not disabled)
3. Ensure entries contain appearance keywords (hair, eyes, wears, etc.)
4. Character name must be mentioned in recent story text
5. Check entry isn't too long (>500 chars may be skipped)

### Images Not Generating

**Symptoms**: Prompts appear but no images are created.

**Solutions**:
1. Ensure **PowerTool app** is running
2. Check API token is configured in the app
3. Verify you have Anlas/image generation access
4. Check app's status indicator (should show "Connected")

### Poor Prompt Quality

**Symptoms**: Generated prompts don't match the scene well.

**Solutions**:
1. Ensure sufficient story content exists
2. Adjust **Art Style** tags for your preferred style
3. Add more descriptive content to your story
4. Enhance lorebook entries with detailed appearances

### Script Errors

**Symptoms**: Error messages in the NovelAI console.

**Solutions**:
1. Disable and re-enable the script
2. Check you're running the script inside the PowerTool app
3. Refresh the NovelAI page within the app
4. Clear script storage and restart

---

## Requirements

### PowerTool App
- **Required**: This script only works with the companion Electron app
- The app provides the webview that hosts NovelAI

### NovelAI Subscription
- Access to **Script API** feature
- Access to **GLM-4-6 model** for prompt generation

### Lorebook (Optional)
- Recommended for character consistency
- Entries should include visual appearance descriptions

---

## Version History

- **1.0.0**: Initial release with auto-generation, character lore integration, and Electron bridge
