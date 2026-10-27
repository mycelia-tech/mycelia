<!-- historical-plan -->
# Mycelia User Onboarding Flow - Decision Tree

Historical design proposal. See [current documentation](README.md) for setup.

**Version**: 1.0
**Last Updated**: 2025-11-27
**Status**: Design Document

---

## Overview

This document defines the complete user onboarding experience for Mycelia, from first clone to productive use. The flow is designed to be:

- **Frictionless**: Minimal steps, sensible defaults
- **Flexible**: Advanced users retain full control
- **Transparent**: Clear communication at each decision point
- **Sovereign**: Privacy-first, user-controlled infrastructure

---

## Onboarding Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     NEW USER ARRIVES                            │
│                                                                 │
│  git clone https://github.com/mycelia-tech/mycelia             │
│  cd mycelia                                                     │
│  docker compose up                                              │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              SYSTEM AUTO-INITIALIZATION                         │
│                                                                 │
│  ✓ MongoDB started                                              │
│  ✓ Redis started                                                │
│  ✓ Database schema initialized                                  │
│  ✓ API keys auto-generated                                      │
│  ✓ Backend started (port 5173)                                  │
│  ✓ Frontend started (port 3001)                                 │
│                                                                 │
│  Console Output:                                                │
│  ╔════════════════════════════════════════════╗                 │
│  ║  🎉 Mycelia is ready!                      ║                 │
│  ║                                            ║                 │
│  ║  Web Interface: http://localhost:3001      ║                 │
│  ║  API Endpoint:  http://localhost:5173      ║                 │
│  ║                                            ║                 │
│  ║  Your API credentials:                     ║                 │
│  ║  Client ID: mycelia_abc123...              ║                 │
│  ║  Token:     eyJhbGc...                     ║                 │
│  ║                                            ║                 │
│  ║  Complete setup: http://localhost:3001/setup ║              │
│  ╚════════════════════════════════════════════╝                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              USER OPENS WEB INTERFACE                           │
│                                                                 │
│  Browser → http://localhost:3001                                │
│                                                                 │
│  System detects: First visit (no setup completion flag)         │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 1                         │
│                      Welcome Screen                             │
│                                                                 │
│  ┌────────────────────────────────────────────────────┐         │
│  │  Welcome to Mycelia                                │         │
│  │                                                    │         │
│  │  Your personal memory system.                      │         │
│  │  Privacy-first. Sovereign by design.               │         │
│  │                                                    │         │
│  │  This setup will take ~5 minutes.                  │         │
│  │                                                    │         │
│  │  We'll configure:                                  │         │
│  │  • Inference servers (where processing happens)    │         │
│  │  • AI models (how your data is analyzed)          │         │
│  │  • Audio sources (what data to ingest)            │         │
│  │                                                    │         │
│  │  [Get Started]  [Skip - Use Defaults]              │         │
│  └────────────────────────────────────────────────────┘         │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
        ▼ [Get Started]                     ▼ [Skip - Use Defaults]
   Go to Step 2                        Apply default config,
                                       go to Dashboard
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 2                         │
│                 Inference Server Choice                         │
│                                                                 │
│  ┌────────────────────────────────────────────────────┐         │
│  │  Where should processing happen?                   │         │
│  │                                                    │         │
│  │  ◉ Quick Start (Mycelia-hosted)                    │         │
│  │                                                    │         │
│  │     What this means:                               │         │
│  │     • Get started in < 2 minutes                   │         │
│  │     • No hardware setup needed                     │         │
│  │     • Automatic updates & maintenance              │         │
│  │     • Best for trying Mycelia quickly              │         │
│  │                                                    │         │
│  │     What you get:                                  │         │
│  │     ✓ 1M free tokens/month                         │         │
│  │     ✓ Fast GPU-accelerated processing              │         │
│  │     ✓ High-quality Whisper large-v3 model          │         │
│  │                                                    │         │
│  │     Privacy trade-offs:                            │         │
│  │     ⚠ Audio sent to Mycelia servers for processing │         │
│  │     ⚠ Subject to monthly quota (upgradable)        │         │
│  │     ℹ️ You can switch to self-hosted anytime       │         │
│  │                                                    │         │
│  │  ○ Privacy First (Self-hosted)                     │         │
│  │                                                    │         │
│  │     What this means:                               │         │
│  │     • Complete data sovereignty (nothing leaves your control) │ │
│  │     • No usage limits or quotas                    │         │
│  │     • Full control over models & updates           │         │
│  │     • Can run on local machine or remote GPU server │       │
│  │                                                    │         │
│  │     What you need:                                 │         │
│  │     • GPU recommended (8GB+ VRAM for best performance) │    │
│  │     • OR CPU fallback (slower, still works)        │         │
│  │     • ~15GB disk space for models                  │         │
│  │     • 15-20 minutes setup time                     │         │
│  │                                                    │         │
│  │     Setup trade-offs:                              │         │
│  │     ⚠ Requires technical setup (Docker knowledge)  │         │
│  │     ⚠ GPU for good performance (CPU is slow)       │         │
│  │     ⚠ You manage updates & maintenance             │         │
│  │     [Learn more: Self-hosting Guide]               │         │
│  │                                                    │         │
│  │  [Back]  [Continue]                                │         │
│  └────────────────────────────────────────────────────┘         │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
        ▼ [Mycelia Infrastructure]          ▼ [Self-Hosted]
   Go to Step 2A                       Go to Step 2B


┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 2A                        │
│              Mycelia Managed Infrastructure                     │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Request access to Mycelia's processing servers       │     │
│  │                                                        │     │
│  │  Email: [__________________]                           │     │
│  │                                                        │     │
│  │  [Request Invite]                                      │     │
│  │                                                        │     │
│  │  Already have an API key?                              │     │
│  │                                                        │     │
│  │  API Key: [________________________]  [Test]           │     │
│  │                                                        │     │
│  │  Status: ● Not connected                               │     │
│  │                                                        │     │
│  │  [Back]  [Skip for now]  [Continue]                    │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
        ▼ [Request Invite]                  ▼ [API Key entered + Test]
   Submit email,                       Validate key,
   show "Check email",                 save config,
   allow skip                          go to Step 3
        │
        ▼ [Skip for now]
   Save as "managed mode (no key)",
   go to Step 3


┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 2B                        │
│                  Self-Hosted Configuration                      │
│                                                                 │
│  ┌────────────────────────────────────────────────────┐         │
│  │  Configure your self-hosted inference servers      │         │
│  │                                                    │         │
│  │  Need help setting up?                             │         │
│  │  [📖 Quick Start Guide] [🐳 Docker Compose Setup]  │         │
│  │                                                    │         │
│  │  Speech-to-Text Server:                            │         │
│  │  URL: [http://localhost:8081        ]  [Test]      │         │
│  │  Status: ● Not connected                           │         │
│  │                                                    │         │
│  │  Diarization Server (Optional):                    │         │
│  │  URL: [http://localhost:8085        ]  [Test]      │         │
│  │  Status: ● Not connected                           │         │
│  │                                                    │         │
│  │  To start your inference servers:                  │         │
│  │  $ docker compose -f docker-compose.inference.yml up │       │
│  │                                                    │         │
│  │  [Back]  [Skip for now]  [Continue]                │         │
│  └────────────────────────────────────────────────────┘         │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
        ▼ [Test: Success]                   ▼ [Skip for now]
   Save URLs,                          Mark as "self-hosted (not configured)",
   go to Step 3                        go to Step 3


                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 3                         │
│                   AI Model Configuration                        │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Which AI models should analyze your transcripts?      │     │
│  │                                                        │     │
│  │  ◉ Instant Start (Mycelia-provided)                    │     │
│  │                                                        │     │
│  │     What this means:                                   │     │
│  │     • Start using immediately (no API keys needed)     │     │
│  │     • High-quality models pre-configured               │     │
│  │     • Optimized for balanced quality & cost            │     │
│  │     • Zero setup time                                  │     │
│  │                                                        │     │
│  │     What you get:                                      │     │
│  │     • Small tasks: GPT-4o-mini (fast & cost-effective) │     │
│  │     • Medium tasks: Claude 3.5 Sonnet (balanced quality) │   │
│  │     • Large tasks: Claude 3.5 Opus (best quality)      │     │
│  │     • 1M tokens/month free quota                       │     │
│  │                                                        │     │
│  │     Privacy trade-offs:                                │     │
│  │     ⚠ Uses Mycelia's OpenRouter API key               │     │
│  │     ⚠ Subject to quota (heavy users may hit limit)     │     │
│  │     ⚠ Transcripts sent to OpenRouter for processing   │     │
│  │     ℹ️ Can add your own keys later for unlimited use   │     │
│  │                                                        │     │
│  │  ○ Unlimited Usage (Your API keys)                     │     │
│  │                                                        │     │
│  │     What this means:                                   │     │
│  │     • No usage limits (pay only for what you use)      │     │
│  │     • Direct relationship with AI provider             │     │
│  │     • Choose your preferred models                     │     │
│  │     • Potentially lower cost for heavy usage           │     │
│  │                                                        │     │
│  │     What you need:                                     │     │
│  │     • OpenRouter, OpenAI, or Anthropic account         │     │
│  │     • API key (5 minutes to create)                    │     │
│  │     • Credit card for API billing                      │     │
│  │                                                        │     │
│  │     Cost trade-offs:                                   │     │
│  │     ⚠ Requires account setup (~10 minutes)             │     │
│  │     ⚠ You pay for all API usage (can add up)           │     │
│  │     ℹ️ Transcripts sent to your chosen provider        │     │
│  │                                                        │     │
│  │  ○ Maximum Privacy (Local models)                      │     │
│  │                                                        │     │
│  │     What this means:                                   │     │
│  │     • Complete privacy (data never leaves your machine) │    │
│  │     • No API costs (free after hardware investment)    │     │
│  │     • Works offline                                    │     │
│  │     • Full control over model selection                │     │
│  │                                                        │     │
│  │     What you need:                                     │     │
│  │     • GPU recommended (16GB+ VRAM for best models)     │     │
│  │     • OR CPU (works but slow, limited model size)      │     │
│  │     • ~20-50GB disk space for models                   │     │
│  │     • Ollama installed (via docker-compose.inference.yml) │  │
│  │                                                        │     │
│  │     Quality trade-offs:                                │     │
│  │     ⚠ Lower quality than cloud models (especially on CPU) │  │
│  │     ⚠ Much slower processing (minutes vs seconds)      │     │
│  │     ⚠ Requires powerful hardware for good results      │     │
│  │     ℹ️ Good for experimentation & privacy-first use    │     │
│  │     [Learn more: Local LLM Guide]                      │     │
│  │                                                        │     │
│  │  [Back]  [Continue]                                    │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┬─────────────────┐
        │                                   │                 │
        ▼ [Use Defaults]                    ▼ [Own Keys]      ▼ [Local]
   Apply default config,              Go to Step 3A      Go to Step 3B
   go to Step 4


┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 3A                        │
│                  Add Custom API Keys                            │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Configure your AI provider                            │     │
│  │                                                        │     │
│  │  Provider: [OpenRouter ▼]                              │     │
│  │            (OpenRouter, OpenAI, Anthropic, Custom)     │     │
│  │                                                        │     │
│  │  API Key: [sk-or-v1-...                ]               │     │
│  │                                                        │     │
│  │  Model Selection:                                      │     │
│  │  Small:  [anthropic/claude-3.5-haiku ▼]                │     │
│  │  Medium: [anthropic/claude-3.5-sonnet ▼]               │     │
│  │  Large:  [anthropic/claude-3.5-opus ▼]                 │     │
│  │                                                        │     │
│  │  [Test Connection]                                     │     │
│  │  Status: ● Testing...                                  │     │
│  │                                                        │     │
│  │  💡 Tip: See our model comparison guide to choose      │     │
│  │  the best models for your needs.                       │     │
│  │  [📊 Model Comparison Guide]                           │     │
│  │                                                        │     │
│  │  [Back]  [Continue]                                    │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼ [Test: Success]
                     Save API config,
                     go to Step 4


┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 3B                        │
│                  Local Model Configuration                      │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Configure local AI models                             │     │
│  │                                                        │     │
│  │  Using: Ollama                                         │     │
│  │                                                        │     │
│  │  Ollama URL: [http://localhost:11434]  [Test]          │     │
│  │  Status: ● Connected ✓                                 │     │
│  │                                                        │     │
│  │  Available Models:                                     │     │
│  │  ☑ llama3:8b                                           │     │
│  │  ☑ mistral:7b                                          │     │
│  │  ☐ codellama:13b                                       │     │
│  │                                                        │     │
│  │  [Download Selected Models]                            │     │
│  │                                                        │     │
│  │  Model Assignments:                                    │     │
│  │  Small:  [llama3:8b ▼]                                 │     │
│  │  Medium: [mistral:7b ▼]                                │     │
│  │  Large:  [mistral:7b ▼]                                │     │
│  │                                                        │     │
│  │  Need to install Ollama?                               │     │
│  │  [📖 Ollama Setup Guide]                               │     │
│  │                                                        │     │
│  │  [Back]  [Continue]                                    │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
                     Save Ollama config,
                     go to Step 4


                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 4                         │
│                Audio Source Configuration                       │
│                     (Optional)                                  │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Where should Mycelia import audio from?               │     │
│  │                                                        │     │
│  │  Detected Sources:                                     │     │
│  │                                                        │     │
│  │  ☑ Apple Voice Memos                                   │     │
│  │    Path: ~/Library/CloudRecordings.db                  │     │
│  │    Status: ✓ 42 recordings found                       │     │
│  │                                                        │     │
│  │  ☐ Google Drive (Easy Voice Recorder)                  │     │
│  │    Path: [~/Google Drive/               ]  [Browse]    │     │
│  │    Status: ● Not configured                            │     │
│  │                                                        │     │
│  │  ☐ Local Audio Folder                                  │     │
│  │    Path: [~/Library/mycelia/audio       ]  [Browse]    │     │
│  │    Status: ● Empty                                     │     │
│  │                                                        │     │
│  │  Advanced: [Configure Custom Sources]                  │     │
│  │                                                        │     │
│  │  💡 You can always add more sources later in Settings. │     │
│  │                                                        │     │
│  │  [Back]  [Skip for now]  [Continue]                    │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
        ▼ [Continue]                        ▼ [Skip for now]
   Save source config,                 No sources configured,
   start import daemon,                go to Step 5
   go to Step 5


                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 5                         │
│                    Sample Data (Optional)                       │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Want to explore with sample data?                     │     │
│  │                                                        │     │
│  │  We can load demo audio, conversations, and artifacts  │     │
│  │  so you can try features immediately.                  │     │
│  │                                                        │     │
│  │  Sample data includes:                                 │     │
│  │  • 3 sample audio recordings                           │     │
│  │  • Transcripts                                         │     │
│  │  • 2 sample conversations                              │     │
│  │  • Example summary & task extraction                   │     │
│  │                                                        │     │
│  │  ☐ Load sample data                                    │     │
│  │                                                        │     │
│  │  (You can delete this later)                           │     │
│  │                                                        │     │
│  │  [Back]  [Skip]  [Load Sample Data & Continue]         │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
        ▼ [Load Sample Data]                ▼ [Skip]
   Import sample data,                 Go to Step 6
   go to Step 6


                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   SETUP WIZARD - STEP 6                         │
│                      Setup Complete!                            │
│                                                                 │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  🎉 You're all set!                                     │     │
│  │                                                        │     │
│  │  Configuration Summary:                                │     │
│  │                                                        │     │
│  │  Inference: ✓ Mycelia managed (1M tokens/month)        │     │
│  │  AI Models: ✓ Using defaults (Claude 3.5 Sonnet)       │     │
│  │  Audio Sources: ✓ Apple Voice Memos (42 recordings)    │     │
│  │  Sample Data: ✓ Loaded                                 │     │
│  │                                                        │     │
│  │  Next Steps:                                           │     │
│  │  1. View your timeline                                 │     │
│  │  2. Explore sample conversations                       │     │
│  │  3. Try creating a summary                             │     │
│  │                                                        │     │
│  │  Your data is being processed in the background.       │     │
│  │  You'll see transcripts appear in a few minutes.       │     │
│  │                                                        │     │
│  │  Need help? [📖 Documentation] [💬 Discord]            │     │
│  │                                                        │     │
│  │  [Go to Dashboard]                                     │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
                   Mark setup complete,
                   redirect to dashboard


                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                      DASHBOARD VIEW                             │
│                                                                 │
│  User sees:                                                     │
│  • Timeline with audio chunks (if imported)                     │
│  • Sample conversations (if loaded)                             │
│  • Processing status (daemon running)                           │
│  • Quick actions: Process period, View transcripts              │
│                                                                 │
│  System is now fully operational.                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Decision Tree (Textual Format)

```
START
  │
  ├─ User clones repo & runs `docker compose up`
  │   │
  │   ├─ System auto-initializes (database, keys, services)
  │   │   │
  │   │   └─ Frontend redirects to /setup (first visit detected)
  │   │
  │   └─ Setup Wizard Step 1: Welcome
  │       │
  │       ├─ [Get Started] → Continue to Step 2
  │       │
  │       └─ [Skip - Use Defaults] → Apply default config, go to Dashboard
  │
  └─ Setup Wizard Step 2: Inference Server Choice
      │
      ├─ [Mycelia Infrastructure]
      │   │
      │   └─ Step 2A: Invite Request
      │       │
      │       ├─ User enters email → Request sent
      │       │   │
      │       │   └─ [Skip for now] → Managed mode (no key), continue
      │       │
      │       └─ User enters API key → Test connection
      │           │
      │           ├─ Success → Save config, continue to Step 3
      │           │
      │           └─ Failure → Show error, retry or skip
      │
      └─ [Self-Hosted]
          │
          └─ Step 2B: Self-Hosted URLs
              │
              ├─ User enters STT URL → Test
              │   │
              │   ├─ Success → Save, continue
              │   │
              │   └─ Failure → Show error, retry or skip
              │
              └─ [Skip for now] → Self-hosted (not configured), continue
  │
  └─ Setup Wizard Step 3: AI Model Configuration
      │
      ├─ [Use Defaults]
      │   │
      │   └─ Apply default models, continue to Step 4
      │
      ├─ [Add Own API Keys]
      │   │
      │   └─ Step 3A: Custom Provider
      │       │
      │       ├─ Select provider (OpenRouter, OpenAI, etc.)
      │       │
      │       ├─ Enter API key
      │       │
      │       ├─ Select models
      │       │
      │       └─ Test → Save if successful, continue
      │
      └─ [Run Locally]
          │
          └─ Step 3B: Local Models (Ollama)
              │
              ├─ Enter Ollama URL → Test
              │
              ├─ Select models to download
              │
              └─ Assign model aliases → Continue
  │
  └─ Setup Wizard Step 4: Audio Sources (Optional)
      │
      ├─ System auto-detects sources
      │
      ├─ User enables/disables sources
      │
      ├─ [Continue] → Save config, start import
      │
      └─ [Skip] → No sources, continue
  │
  └─ Setup Wizard Step 5: Sample Data (Optional)
      │
      ├─ [Load Sample Data] → Import demo content, continue
      │
      └─ [Skip] → No sample data, continue
  │
  └─ Setup Wizard Step 6: Complete
      │
      └─ Show summary, mark setup complete, redirect to Dashboard
  │
  └─ DASHBOARD (User is now onboarded)
```

---

## Decision Framework: How to Choose

### Quick Decision Guide

**"I just want to try Mycelia quickly"**
- ✅ Inference: Quick Start (Mycelia-hosted)
- ✅ AI Models: Instant Start (Mycelia-provided)
- ✅ Skip audio sources for now
- ⏱️ Time to dashboard: **< 3 minutes**

**"I care deeply about privacy"**
- ✅ Inference: Privacy First (Self-hosted)
- ✅ AI Models: Maximum Privacy (Local models)
- ⚠️ Requires: GPU or powerful CPU
- ⏱️ Time to dashboard: **20-30 minutes** (including setup)

**"I want best quality, don't mind some cost"**
- ✅ Inference: Quick Start or Privacy First (with GPU)
- ✅ AI Models: Unlimited Usage (your API keys, Claude 3.5 Opus)
- ⏱️ Time to dashboard: **10 minutes**

**"I want to use this long-term with lots of data"**
- ✅ Inference: Privacy First (remote GPU server)
- ✅ AI Models: Unlimited Usage (your API keys)
- ⏱️ Time to dashboard: **30 minutes** (one-time setup)

### Detailed Comparison Tables

#### Inference Server Options

| Factor | Quick Start (Mycelia) | Privacy First (Local) | Privacy First (Remote GPU) |
|--------|----------------------|----------------------|---------------------------|
| **Setup Time** | < 2 minutes | 15-20 minutes | 30 minutes (one-time) |
| **Hardware Needed** | None | GPU or CPU | GPU server (8GB+ VRAM) |
| **Privacy** | Audio → Mycelia | 100% local | 100% your infrastructure |
| **Speed** | Fast (GPU) | Slow (CPU) / Fast (GPU) | Fast (dedicated GPU) |
| **Cost** | Free (quota) | Hardware only | GPU server cost |
| **Maintenance** | None | You manage | You manage |
| **Best For** | Quick start, trying out | Privacy-first, solo use | Production, heavy use |

#### AI Model Options

| Factor | Instant Start (Mycelia) | Unlimited Usage (Your Keys) | Maximum Privacy (Local) |
|--------|------------------------|----------------------------|------------------------|
| **Setup Time** | 0 minutes | 10 minutes | 20 minutes |
| **Cost** | Free (1M tokens/month) | Pay per use (~$0.10-5/1M tokens) | Free (after hardware) |
| **Quality** | Excellent (GPT-4o, Claude) | Excellent (your choice) | Good (limited by hardware) |
| **Speed** | Fast (seconds) | Fast (seconds) | Slow (minutes) |
| **Privacy** | Data → OpenRouter | Data → your provider | 100% local |
| **Quota** | 1M tokens/month | Unlimited (pay as you go) | Unlimited |
| **Best For** | Quick trials, casual use | Heavy users, businesses | Privacy-first, offline |

#### Combined Recommendations by Use Case

| Use Case | Inference | AI Model | Why? |
|----------|-----------|----------|------|
| **First-time user** | Quick Start | Instant Start | Fastest path to value (< 3 min) |
| **Privacy advocate** | Privacy First (Local) | Maximum Privacy | Zero external data transfer |
| **Power user** | Privacy First (GPU) | Unlimited Usage | Best quality + control + unlimited |
| **Business/Enterprise** | Privacy First (Remote) | Unlimited Usage | Compliance + scalability |
| **Experimenter** | Quick Start | Instant Start → upgrade later | Start fast, optimize later |
| **Budget-conscious** | Privacy First (CPU) | Maximum Privacy | No ongoing costs |

---

## Key Decision Points Explained

### 1. Inference Server Choice

**Why this matters**: Determines where audio processing (STT, diarization) happens and impacts privacy, cost, and setup time.

**Technical implications**:
- Managed: Backend calls Mycelia's API endpoints (transcripts stored locally)
- Self-hosted: Backend calls user's local/cloud servers (everything local)
- Configuration stored in `configs` collection

---

### 2. AI Model Configuration

**Why this matters**: Determines which LLM analyzes transcripts and creates summaries. Impacts quality, cost, and privacy.

**Technical implications**:
- Default: Uses pre-configured OpenRouter with Mycelia's key
- Own keys: User's provider credentials, stored encrypted
- Local: Ollama or similar, running on user's machine/server
- Model resolution: Alias (small/medium/large) → specific model

---

### 3. Audio Source Configuration

**Why this matters**: Determines what data is ingested and processed.

**Options**:
- **Apple Voice Memos**: Auto-detected if database found
- **Google Drive**: Manual path configuration
- **Local Folder**: Default path or custom
- **Custom**: Advanced users can configure other sources
- **None**: Skip, add later

**Technical implications**:
- Enabled sources tracked in `configs` collection
- Python daemon reads config and runs discovery
- Imported files tracked in `source_files` collection
- Can be changed anytime in Settings

---

## Privacy & Transparency Decision Flow

At each step, the system communicates:

1. **What data is sent where**:
   - Managed inference: Audio sent to Mycelia servers for STT
   - Self-hosted: Audio stays local
   - Default LLM: Transcripts sent to OpenRouter via Mycelia
   - Custom LLM: Transcripts sent to user's provider

2. **What is tracked**:
   - Token usage counts
   - Request timestamps
   - Model names

3. **What is NOT tracked**:
   - Audio content
   - Transcripts
   - LLM prompts/responses

4. **User rights**:
   - Export all data anytime
   - Delete all data anytime
   - Switch to self-hosted anytime

**Privacy assurance displayed**:
- Privacy Policy link on every page
- Usage dashboard shows what's tracked
- Clear opt-out path (use self-hosted)

---

## Alternative Paths

### Power User Path (Skip Wizard)

```
User runs: docker compose up
  │
  └─ Opens frontend, clicks "Skip - Use Defaults"
      │
      └─ Default config applied:
          • Managed inference (no key, limited)
          • Default LLM models (Mycelia quota)
          • No audio sources
          • No sample data
      │
      └─ User immediately at Dashboard
      │
      └─ Can configure later via Settings
```

**Time to productivity**: < 2 minutes

---

### CLI-Only Path (No Web UI)

```
User runs: docker compose run setup-cli
  │
  ├─ Interactive prompts (same questions as web wizard)
  │
  ├─ Saves to .env and database
  │
  └─ Outputs summary and URLs
  │
  └─ User can then use API or open web UI
```

**Use case**: Server deployment, automation, headless setups

---

### Re-run Setup

```
User goes to Settings → General → "Run Setup Wizard Again"
  │
  └─ Setup wizard opens with current config pre-filled
  │
  └─ User can modify any settings
  │
  └─ Saving applies new config (non-destructive)
```

**Use case**: Changing inference mode, adding API keys, reconfiguring

---

## Edge Cases & Error Handling

### Scenario: Managed API key not working

```
Step 2A: User enters API key → Test fails
  │
  ├─ Show error: "Could not connect to Mycelia servers"
  │
  ├─ Suggestions:
  │   • Check your internet connection
  │   • Verify the API key is correct
  │   • Contact support if issue persists
  │
  └─ Options:
      • [Retry]
      • [Skip for now] → Continue without key
      • [Switch to self-hosted]
```

---

### Scenario: Self-hosted server not running

```
Step 2B: User tests STT URL → Connection fails
  │
  ├─ Show error: "Could not reach http://localhost:8081"
  │
  ├─ Suggestions:
  │   • Start your inference server:
  │     $ docker compose -f docker-compose.inference.yml up
  │   • Ensure port 8081 is not blocked
  │   • Check server logs for errors
  │
  └─ Options:
      • [Retry]
      • [Change URL]
      • [View Setup Guide]
      • [Skip for now]
```

---

### Scenario: No audio sources detected

```
Step 4: No sources found
  │
  ├─ Show message: "No audio sources detected"
  │
  ├─ Options:
  │   • Manually enter path
  │   • Skip and add later
  │   • Upload files manually
  │
  └─ Continue to next step
```

---

### Scenario: Ollama not installed

```
Step 3B: Test Ollama URL → Not reachable
  │
  ├─ Show error: "Ollama is not running"
  │
  ├─ Help text:
  │   "Ollama is required for local models."
  │   [📖 Install Ollama] (opens https://ollama.ai)
  │
  └─ Options:
      • [Retry] (after installation)
      • [Back] → Choose different model option
      • [Skip for now]
```

---

## Post-Setup User Journeys

### Journey 1: Creating First Artifact

```
User completes setup with sample data
  │
  └─ Dashboard shows sample conversations
      │
      └─ User clicks "Process selected period" button
          │
          └─ Processing modal opens:
              • Date range pre-filled (last 7 days)
              • Type: Summary (selected)
              • Model: Medium (default)
          │
          └─ User clicks "Process"
              │
              └─ Job queued, progress bar appears
                  │
                  └─ Completes in ~30 seconds
                      │
                      └─ Notification: "Summary ready!"
                          │
                          └─ User clicks notification → Artifact detail page
                              │
                              └─ Reads summary, explores sections
                                  │
                                  └─ Clicks "Re-process with Large model"
                                      │
                                      └─ Creates improved version
```

---

### Journey 2: Switching to Self-Hosted

```
User starts with managed infrastructure
  │
  └─ Goes to Settings → Inference
      │
      └─ Switches to "Self-Hosted"
          │
          └─ Follows guide to start inference stack:
              $ docker compose -f docker-compose.inference.yml up
          │
          └─ Enters URLs, tests connections
              │
              └─ Saves configuration
                  │
                  └─ All future processing uses local servers
                      │
                      └─ No data sent to Mycelia
```

---

### Journey 3: Adding Custom LLM

```
User wants to use own OpenAI key
  │
  └─ Goes to Settings → LLMs → "Add New Model"
      │
      └─ Selects provider: OpenAI
          │
          └─ Enters API key
              │
              └─ Selects model: gpt-4o
                  │
                  └─ Assigns to "medium" alias
                      │
                      └─ Tests connection → Success
                          │
                          └─ Saves
                              │
                              └─ All new "medium" tasks use GPT-4o with user's key
```

---

## Measurement & Success Criteria

### Onboarding Funnel Metrics

```
1. Started setup wizard: 100%
   │
   ├─ Completed Step 1 (Welcome): ?%
   ├─ Completed Step 2 (Inference): ?%
   ├─ Completed Step 3 (LLM): ?%
   ├─ Completed Step 4 (Audio): ?%
   ├─ Completed Step 5 (Sample Data): ?%
   └─ Completed setup: Target > 80%

2. Time to completion: Target < 5 minutes

3. Skipped wizard (used defaults): ?%

4. Re-ran setup wizard: ?%
```

### User Behavior Metrics

```
• % using managed infrastructure
• % using self-hosted
• % using default LLMs
• % using custom LLMs
• % using local LLMs
• Average time to first artifact creation
• % of users with audio sources configured
```

### Quality Metrics

```
• Setup completion rate > 80%
• Error rate during setup < 5%
• Support tickets related to onboarding < 10%
• User satisfaction (survey): > 4/5
```

---

## Appendix: Configuration State Machine

```
System States:
  - UNINITIALIZED: Fresh install, no database
  - INITIALIZED: Database created, services running
  - SETUP_IN_PROGRESS: User in wizard
  - CONFIGURED: Setup complete, ready to use
  - RECONFIGURING: User modifying settings

Transitions:
  UNINITIALIZED → INITIALIZED (auto on first docker up)
  INITIALIZED → SETUP_IN_PROGRESS (user opens /setup)
  SETUP_IN_PROGRESS → CONFIGURED (wizard completed)
  CONFIGURED → RECONFIGURING (user opens settings)
  RECONFIGURING → CONFIGURED (settings saved)
```

---

## Appendix: Default Configuration Values

```yaml
# Applied when user skips setup or chooses defaults

inference:
  mode: managed
  api_key: null  # User must request invite to get key
  stt_url: null
  diarization_url: null

llm:
  provider: mycelia_default
  models:
    small:
      name: gpt-4o-mini
      provider: openrouter
      api_key: MYCELIA_OPENROUTER_KEY
    medium:
      name: anthropic/claude-3.5-sonnet
      provider: openrouter
      api_key: MYCELIA_OPENROUTER_KEY
    large:
      name: anthropic/claude-3.5-opus
      provider: openrouter
      api_key: MYCELIA_OPENROUTER_KEY

audio_sources:
  enabled: []
  # No sources enabled by default

sample_data:
  loaded: false

appearance:
  theme: dark
  time_format: gregorian

setup:
  completed: false
  completed_at: null
```

---

**Document Owner**: Product & UX Team
**Review Cycle**: Weekly during implementation
**User Testing**: Required before Phase 1 completion
**Last Updated**: 2025-11-27
