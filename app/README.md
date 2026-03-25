# NovelAI PowerTool

An Electron companion app for NovelAI — image generation, lore management, LitRPG tracking, TTS narration, and more.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Getting Your API Token](#getting-your-api-token)
- [Configuration](#configuration)
- [Supported Models](#supported-models)
- [Generation Parameters](#generation-parameters)
- [User Interface](#user-interface)
- [Using with the Companion Script](#using-with-the-companion-script)
- [Technical Details](#technical-details)
- [Troubleshooting](#troubleshooting)
- [Requirements](#requirements)

---

## Overview

PowerTool is an Electron app that:

- **Embeds NovelAI** in a native desktop window
- **Generates images** from story content using NovelAI's image API
- **Displays images** in a side panel alongside your story
- **Integrates** with a companion NovelAI script for automatic prompt generation

```
┌─────────────────────────────────────────────────────────────┐
│  PowerTool                              [─] [□] [×]  │
├─────────────────────────────────────────────────────────────┤
│ [Generate] [Toggle Panel] [Settings] [Reload]    Connected  │
├─────────────────────────────────────────┬───────────────────┤
│                                         │                   │
│         NovelAI Web Interface           │  Generated Image  │
│                                         │                   │
│    ┌─────────────────────────────┐      │  ┌─────────────┐  │
│    │  Your story content here... │      │  │             │  │
│    │                             │      │  │   [image]   │  │
│    │  Script panel with prompt   │◄─────┼──│             │  │
│    │  appears in sidebar         │      │  │             │  │
│    └─────────────────────────────┘      │  └─────────────┘  │
│                                         │                   │
│                                         │  Current Prompt:  │
│                                         │  "1girl, red..."  │
└─────────────────────────────────────────┴───────────────────┘
```

---

## Installation

### Option 1: Download Pre-built Release (Recommended)

Download the latest release for your platform from the [Releases page](https://github.com/contrataco/novelai-powertool/releases):

| Platform | Download |
|----------|----------|
| **Windows** | `Scene-Visualizer-Setup-x.x.x.exe` (installer) or `Scene-Visualizer-x.x.x-portable.exe` |
| **macOS** | `Scene-Visualizer-x.x.x.dmg` or `Scene-Visualizer-x.x.x-mac.zip` |
| **Linux** | `Scene-Visualizer-x.x.x.AppImage` or `novelai-powertool_x.x.x_amd64.deb` |

**macOS note**: On first launch, right-click the app and select "Open" to bypass Gatekeeper.

### Option 2: Build from Source

#### Prerequisites

- **Node.js 18** or higher
- **npm** (comes with Node.js)
- **NovelAI subscription** with image generation access

#### Steps

```bash
# Clone the repository
git clone https://github.com/contrataco/novelai-powertool.git
cd novelai-powertool/app

# Install dependencies
npm install

# Start the application
npm start

# Or with developer tools enabled
npm run dev
```

---

## Getting Your API Token

The app requires your NovelAI API token to generate images.

### Step 1: Log into NovelAI

1. Go to [novelai.net](https://novelai.net)
2. Log in with your account

### Step 2: Access Account Settings

1. Click on your profile/settings
2. Navigate to **Account Settings**

### Step 3: Get Your Token

1. Find the **"Get Persistent API Token"** section
2. Click to reveal/generate your token
3. **Copy the token** (it's a long string)

### Step 4: Enter Token in App

1. Open PowerTool
2. Click the **Settings** button (gear icon)
3. Paste your token in the **"NovelAI API Token"** field
4. The token is encrypted and stored locally

**Security Note**: Your token is stored locally using electron-store with encryption. It's never transmitted anywhere except to NovelAI's official API endpoint.

---

## Configuration

### Opening Settings

Click the **⚙️ Settings** button in the toolbar to open the configuration modal.

### Settings Overview

| Section | Options |
|---------|---------|
| **Authentication** | API Token |
| **Model** | Select image generation model |
| **Resolution** | Preset or custom dimensions |
| **Sampling** | Sampler, noise schedule, steps |
| **Quality** | UC preset, quality tags |
| **V3 Options** | SMEA settings (V3 models only) |

---

## Supported Models

### V3 Models (Anime/Furry)

| Model | ID | Features |
|-------|----|----|
| NAI Diffusion Anime V3 | `nai-diffusion-3` | SMEA support, anime style |
| NAI Diffusion Furry V3 | `nai-diffusion-furry-3` | SMEA support, furry/anthro style |

### V4 Models

| Model | ID | Features |
|-------|----|----|
| NAI Diffusion V4 Curated | `nai-diffusion-4-curated-preview` | **Default**, curated training |
| NAI Diffusion V4 Full | `nai-diffusion-4-full` | Full training dataset |

### V4.5 Models (Latest)

| Model | ID | Features |
|-------|----|----|
| NAI Diffusion V4.5 Curated | `nai-diffusion-4-5-curated` | Latest, curated |
| NAI Diffusion V4.5 Full | `nai-diffusion-4-5-full` | Latest, full dataset |

### Model-Specific Features

| Feature | V3 | V4/V4.5 |
|---------|----|----|
| SMEA | Yes | No |
| Quality Tags Format | `{best quality}` | `rating:general, best quality` |
| CFG Rescale | No | Yes |

---

## Generation Parameters

### Resolution

#### Presets

| Preset | Dimensions | Aspect Ratio |
|--------|------------|--------------|
| Square | 832 × 832 | 1:1 |
| Portrait | 832 × 1216 | ~2:3 |
| Landscape | 1216 × 832 | ~3:2 |
| Portrait Small | 512 × 768 | 2:3 |
| Landscape Small | 768 × 512 | 3:2 |
| Square Small | 640 × 640 | 1:1 |

#### Custom Resolution

- **Range**: 256 - 1536 pixels
- **Step**: 64 pixels
- Enter width and height manually for custom dimensions

### Sampling

| Parameter | Options | Default | Description |
|-----------|---------|---------|-------------|
| **Sampler** | Euler, Euler Ancestral, DPM++ 2S Ancestral, DPM++ 2M SDE, DPM++ 2M, DPM++ SDE | Euler | Sampling algorithm |
| **Noise Schedule** | Karras, Native, Exponential, Polyexponential | Karras | Noise reduction curve |
| **Steps** | 1 - 50 | 28 | Denoising iterations |
| **Guidance (CFG)** | 1 - 20 | 5 | Prompt adherence strength |
| **CFG Rescale** | 0 - 1 | 0 | V4/V4.5 only, reduces artifacts |

### Quality Settings

#### UC (Undesired Content) Presets

| Preset | Description |
|--------|-------------|
| **Heavy** | Comprehensive negative prompt excluding many unwanted elements (default) |
| **Light** | Minimal negative prompt, more creative freedom |

#### Quality Tags

When enabled, model-specific quality tags are appended to your prompt:

| Model | Tags Added |
|-------|------------|
| V3 | `, best quality, amazing quality, very aesthetic, absurdres` |
| V4 Curated | `, rating:general, best quality, very aesthetic, absurdres` |
| V4.5 Curated | `, very aesthetic, masterpiece, no text, rating:general` |
| Furry V3 | `, {best quality}, {amazing quality}` |

### V3-Only Options

These options are **disabled** for V4/V4.5 models:

| Option | Description |
|--------|-------------|
| **SMEA** | Stochastic Multi-scale Early Abort - can improve detail |
| **SMEA DYN** | Dynamic variant of SMEA |

---

## User Interface

### Toolbar

| Button | Function |
|--------|----------|
| **Generate Scene** | Manually trigger image generation |
| **Toggle Panel** | Show/hide the image panel |
| **Settings** | Open configuration modal |
| **Reload** | Refresh the NovelAI webview |

### Status Indicator

| Status | Meaning |
|--------|---------|
| **Initializing** | App starting up |
| **Loading** | NovelAI is loading |
| **Connected** | Ready for use |
| **Generating** | Image generation in progress |
| **Error** | Something went wrong |

### Image Panel

- **320px** fixed width on the right side
- Displays the most recent generated image
- Shows the current prompt being used
- Loading spinner during generation
- Toggle visibility with toolbar button

### Settings Modal

Organized into collapsible sections:
1. Authentication
2. Model Selection
3. Resolution
4. Sampling Parameters
5. Quality Settings
6. V3-Specific Options

---

## Using with the Companion Script

For automatic image generation based on your story:

### Step 1: Install the Script

1. Inside PowerTool, NovelAI loads in the webview
2. Go to **Settings → Advanced → Scripts**
3. Create a new script named "PowerTool"
4. Copy contents of [`scripts/novelai-powertool-script/novelai-powertool.ts`](../../scripts/novelai-powertool-script/novelai-powertool.ts)
5. Enable the script

### Step 2: Configure the Script

- **Auto Generate**: On (automatic) or Off (manual)
- **Use Character Lore**: Include character appearances from lorebook
- **Art Style**: Custom style tags for prompts
- **Min Text Length**: Threshold for auto-generation

### Step 3: Write Your Story

1. Write or generate story content
2. The script analyzes the scene
3. A prompt is generated and displayed
4. The app reads the prompt and generates an image
5. The image appears in the side panel

### Manual Generation

Without the script, you can:
1. Click **Generate Scene** in the toolbar
2. The app will attempt to generate based on visible content

---

## Technical Details

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Main Process                           │
│  ┌─────────────────┐  ┌─────────────────┐               │
│  │   main.js       │  │  electron-store │               │
│  │  - IPC handlers │  │  - API token    │               │
│  │  - API calls    │  │  - Settings     │               │
│  └────────┬────────┘  └─────────────────┘               │
│           │                                              │
├───────────┼──────────────────────────────────────────────┤
│           │         Renderer Process                     │
│           ▼                                              │
│  ┌─────────────────┐  ┌─────────────────────────────┐   │
│  │  preload.js     │  │     renderer/index.html      │   │
│  │  - IPC bridge   │  │  - UI components             │   │
│  │  - DOM observer │  │  - Settings modal            │   │
│  └────────┬────────┘  │  - Image panel               │   │
│           │           └─────────────────────────────────┘   │
│           ▼                                              │
│  ┌─────────────────────────────────────────────────────┐│
│  │              NovelAI WebView                         ││
│  │  ┌───────────────────────────────────────────────┐  ││
│  │  │  webview-preload.js                           │  ││
│  │  │  - Bridge for script communication            │  ││
│  │  │  - Exposes __powertoolBridge            │  ││
│  │  └───────────────────────────────────────────────┘  ││
│  └─────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

### IPC Handlers

| Handler | Purpose |
|---------|---------|
| `generate-image` | Execute image generation |
| `get-api-token` | Check token configuration |
| `set-api-token` | Store API token |
| `get-image-settings` | Retrieve current settings |
| `set-image-settings` | Save settings |
| `get-models` | List available models |

### API Integration

- **Endpoint**: `https://image.novelai.net/ai/generate-image`
- **Method**: POST
- **Auth**: Bearer token
- **Response**: ZIP file containing generated image
- **Extraction**: Using adm-zip library

### Security

| Feature | Implementation |
|---------|----------------|
| Context Isolation | `contextIsolation: true` |
| Node Integration | `nodeIntegration: false` |
| Token Storage | electron-store with encryption |
| CSP | Restricts to self and *.novelai.net |

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| electron | ^28.0.0 | Desktop app framework |
| adm-zip | ^0.5.10 | Extract images from API response |
| electron-store | ^8.1.0 | Encrypted local storage |

---

## Troubleshooting

### "Invalid API Token"

**Symptoms**: Error when generating images, or settings show token invalid.

**Solutions**:
1. Re-check your token in NovelAI Account Settings
2. Generate a new token if needed
3. Make sure you copied the entire token
4. Re-enter the token in PowerTool settings

### Images Not Generating

**Symptoms**: Click generate but nothing happens or errors occur.

**Solutions**:
1. Check status indicator shows "Connected"
2. Verify API token is configured
3. Ensure you have Anlas or active subscription
4. Check your subscription includes image generation
5. Try reducing resolution or steps

### "Insufficient Anlas"

**Symptoms**: Error about Anlas when generating.

**Solutions**:
1. Check your Anlas balance in NovelAI
2. Use smaller resolutions (costs fewer Anlas)
3. Reduce steps (costs fewer Anlas)
4. Purchase more Anlas if needed

### App Won't Start

**Symptoms**: Application crashes or doesn't open.

**Solutions**:
1. Ensure Node.js 18+ is installed
2. Run `npm install` to ensure dependencies
3. Check for error messages in terminal
4. Try `npm run dev` for debug output

### NovelAI Not Loading

**Symptoms**: Webview shows blank or error.

**Solutions**:
1. Click **Reload** in toolbar
2. Check internet connection
3. NovelAI might be down - check their status
4. Clear app data and restart

### Script Not Communicating

**Symptoms**: Script generates prompts but app doesn't read them.

**Solutions**:
1. Ensure you're using NovelAI inside the app (not browser)
2. Check script is enabled
3. Reload the NovelAI webview
4. Restart the application

### Poor Image Quality

**Symptoms**: Generated images look bad or don't match prompt.

**Solutions**:
1. Increase **Steps** (try 28-35)
2. Adjust **Guidance** (try 5-7)
3. Enable **Quality Tags**
4. Use **Heavy** UC preset
5. Try a different model

---

## Requirements

### System Requirements

- **OS**: Windows, macOS, or Linux
- **Node.js**: Version 18 or higher
- **RAM**: 4GB minimum recommended
- **Internet**: Required for API calls

### NovelAI Requirements

- **Subscription**: Any tier with image generation
- **Anlas**: Required for image generation
- **API Token**: Persistent token from account settings

---

## Version History

- **1.0.0**: Initial release with V3/V4/V4.5 model support, settings UI, and script integration
