# NovelAI PowerTool

> Formerly "Scene Visualizer" — now a full-featured companion app for NovelAI.

A companion Electron app for NovelAI — image generation, lore management, LitRPG tracking, TTS narration, and more. Includes a companion NovelAI script for automatic scene prompt generation.

## Components

This repository contains two tightly integrated components:

### [Electron App](app/)
A desktop application that:
- Embeds NovelAI in a native window
- Generates images using NovelAI's image generation API
- Displays generated images in a side panel
- Supports multiple image models (V3, V4, V4.5)
- Provides extensive configuration options

### [Companion Script](script/)
A NovelAI user script that:
- Analyzes story content to generate image prompts
- Extracts character appearances from your lorebook
- Sends prompts to the Electron app automatically
- Provides UI controls for manual prompt generation

## Quick Start

### 1. Install the App

**Option A: Download Pre-built Release**

Download from the [Releases page](https://github.com/contrataco/novelai-powertool/releases):
- Windows: `.exe` installer or portable
- macOS: `.dmg` or `.zip`
- Linux: `.AppImage` or `.deb`

**Option B: Build from Source**
```bash
git clone https://github.com/contrataco/novelai-powertool.git
cd novelai-powertool/app
npm install
npm start
```

### 2. Configure the App

1. Launch PowerTool
2. Click **Settings** (gear icon)
3. Enter your NovelAI API token
4. Select your preferred image model and settings

### 3. Install the Companion Script (Optional)

For automatic prompt generation:

1. Open NovelAI **within the PowerTool app**
2. Go to **Settings → Advanced → Scripts**
3. Create new script named "NovelAI PowerTool"
4. Copy contents from [`script/novelai-powertool.ts`](script/novelai-powertool.ts)
5. Enable the script

## How It Works

```
┌────────────────────────────────────────────────────────────────┐
│  PowerTool App                                          │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────┐  ┌────────────────────────┐  │
│  │                              │  │                        │  │
│  │   NovelAI Web Interface      │  │   Generated Image      │  │
│  │                              │  │                        │  │
│  │   ┌────────────────────┐     │  │   ┌────────────────┐   │  │
│  │   │ Story content...   │     │  │   │                │   │  │
│  │   │                    │     │  │   │    [image]     │   │  │
│  │   │ Companion script   │─────┼──┼──►│                │   │  │
│  │   │ generates prompt   │     │  │   │                │   │  │
│  │   └────────────────────┘     │  │   └────────────────┘   │  │
│  │                              │  │                        │  │
│  └──────────────────────────────┘  └────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

1. **Write your story** in NovelAI (running inside the app)
2. **Script analyzes** the story and generates an image prompt
3. **App receives** the prompt and calls NovelAI's image API
4. **Image appears** in the side panel

## Supported Models

| Model | Version | SMEA Support |
|-------|---------|--------------|
| NAI Diffusion V3 | nai-diffusion-3 | Yes |
| NAI Diffusion Furry V3 | nai-diffusion-furry-3 | Yes |
| NAI Diffusion V4 Curated | nai-diffusion-4-curated-preview | No |
| NAI Diffusion V4 Full | nai-diffusion-4-full | No |
| NAI Diffusion V4.5 Curated | nai-diffusion-4-5-curated | No |
| NAI Diffusion V4.5 Full | nai-diffusion-4-5-full | No |

## Documentation

- **[App Documentation](app/README.md)** - Full guide for the Electron application
- **[Script Documentation](script/README.md)** - Full guide for the companion script

## Requirements

- **NovelAI Subscription** with image generation access
- **NovelAI API Token** for image generation
- **Script API access** (for companion script)

## Development

```bash
# Clone repository
git clone https://github.com/contrataco/novelai-powertool.git

# Install app dependencies
cd novelai-powertool/app
npm install

# Run in development mode
npm run dev

# Build for distribution
npm run build        # Current platform
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
npm run build:all    # All platforms
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Version History

- **1.1.1**: LitRPG tracker polish — R5 enrich indicator, scan ETA, re-enrich button, orphan tag cleanup, NPC grouping
- **1.1.0**: Per-story settings, TTS v2 (custom voice seeds, seedmix), scene pipeline v2 (char_captions), lore comprehension v2, lorebook optimizer, portrait manager
- **1.0.0**: Initial release with Electron app and companion script
