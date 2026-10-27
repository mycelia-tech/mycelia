<!-- historical-plan -->
# Mycelia Developer Experience - Task Breakdown

Historical proposal; paths below describe a proposed implementation. See the
[current documentation](README.md) for supported behavior and commands.

**Version**: 1.0
**Last Updated**: 2025-11-27
**Status**: Implementation Ready

---

## Overview

This document provides a detailed task breakdown for implementing the Mycelia Developer Experience Roadmap. Tasks are organized by phase, component area, and priority.

**Total Estimated Effort**: 16 weeks (4 months)
**Team Size**: 3-4 engineers

---

## Task Categories

- **BE** - Backend (Deno/TypeScript)
- **FE** - Frontend (React/TypeScript)
- **PY** - Python (Processing Pipeline)
- **OPS** - DevOps/Infrastructure
- **DOC** - Documentation
- **UX** - User Experience Design

---

## Phase 0: Foundation (Weeks 1-2)

### OPS-001: Unified Docker Compose Configuration (Main Stack)
**Priority**: P0 (Critical)
**Effort**: 3 days
**Dependencies**: None

**Tasks**:
- [ ] Create backend Dockerfile (`backend/Dockerfile`)
  - Base image: `denoland/deno:alpine`
  - Copy source + deno.json
  - Install dependencies
  - Expose port 5173
  - Health check: `curl localhost:5173/health`
- [ ] Create frontend Dockerfile (`frontend/Dockerfile`)
  - Multi-stage build: Deno builder → Nginx server
  - Build production assets with Vite
  - Expose port 3001
  - Health check: `curl localhost:3001`
- [ ] Create Python pipeline Dockerfile (`python/Dockerfile`)
  - Base: `python:3.12-slim`
  - Install system deps (ffmpeg, portaudio)
  - Install uv
  - Copy source + pyproject.toml
  - Run `uv sync`
  - Default command: `uv run daemon.py`
- [ ] Update `docker-compose.yml`:
  - Add service: `backend`
  - Add service: `frontend`
  - Add service: `pipeline`
  - Configure networks (all on `mycelia-network`)
  - Configure volumes:
    - `mongo_data`
    - `redis_data`
    - `audio_files` (shared between frontend/backend/pipeline)
  - Add depends_on with health checks
- [ ] Test full stack startup
- [ ] Document resource requirements (CPU, RAM)

**Acceptance Criteria**:
- `docker compose up` starts all main services
- All health checks pass within 2 minutes
- Backend accessible at `localhost:5173`
- Frontend accessible at `localhost:3001`
- Database initialized and accessible

---

### OPS-001b: Inference Stack Docker Compose (Separate)
**Priority**: P0 (Critical)
**Effort**: 5 days
**Dependencies**: OPS-001

**Tasks**:
- [ ] Create Whisper STT Dockerfile (`python/whisper_server/Dockerfile`)
  - GPU support: NVIDIA CUDA base image
  - CPU fallback: Python slim
  - Download large-v3 model on build
  - Expose port 8081
  - Health check: `curl localhost:8081/health`
- [ ] Create Diarization Dockerfile (`python/diarization/Dockerfile`)
  - Base: Python 3.12 with CUDA (optional)
  - Install pyannote.audio or custom model
  - Download speaker diarization model
  - Expose port 8085
  - Health check endpoint
- [ ] Create `docker-compose.inference.yml`:
  - Service: `whisper-stt`
  - Service: `diarization`
  - Service: `ollama` (for local LLM)
  - Configure GPU passthrough (with NVIDIA runtime)
  - Configure CPU fallback
  - Network configuration (can join main network or separate)
  - Volume mounts for models
  - Environment variables for remote access
- [ ] Create `scripts/start-inference.sh`:
  - Detect GPU availability
  - Start appropriate services (GPU or CPU)
  - Display access URLs and status
  - Health check all inference services
- [ ] Test inference stack:
  - Local deployment (same machine as main stack)
  - Remote deployment (separate machine)
  - GPU acceleration
  - CPU fallback
- [ ] Document resource requirements:
  - GPU: VRAM, CUDA version
  - CPU: Cores, RAM
  - Disk space for models
  - Network bandwidth for remote setup

**Acceptance Criteria**:
- `docker compose -f docker-compose.inference.yml up` starts all inference services
- Can run on same machine OR remote machine
- GPU detected and used if available
- CPU fallback works correctly
- All inference services healthy and accessible
- Main stack can connect to inference stack (local or remote)

---

### OPS-002: Auto-initialization Scripts
**Priority**: P0 (Critical)
**Effort**: 3 days
**Dependencies**: OPS-001

**Tasks**:
- [ ] Create `scripts/init-db.sh`:
  - Check if database already initialized
  - Run MongoDB migrations if needed
  - Create indexes (from `backend/app/lib/mongo/collections.ts`)
  - Seed default configuration
  - Exit gracefully if already initialized
- [ ] Create `scripts/generate-keys.sh`:
  - Generate `SECRET_KEY` if missing
  - Generate API key pair
  - Store in database
  - Output credentials to console
  - Write to `.env` file
- [ ] Create `scripts/health-check.sh`:
  - Check all service health endpoints
  - Output status table
  - Exit code 0 if all healthy, 1 otherwise
- [ ] Update `docker-compose.yml`:
  - Add init container that runs `init-db.sh` and `generate-keys.sh`
  - Use `command` override to run scripts on first start
- [ ] Add database migration system:
  - Create `backend/migrations/` directory
  - Create migration runner script
  - Add version tracking in database

**Acceptance Criteria**:
- First run auto-generates all keys
- Database schema initialized correctly
- Health check script reports all services
- No manual steps required

---

### OPS-003: Environment Consolidation
**Priority**: P0 (Critical)
**Effort**: 2 days
**Dependencies**: OPS-001, OPS-002

**Tasks**:
- [ ] Create unified `.env.example` at root:
  - Merge settings from `backend/.env.example` and `python/settings.py`
  - Add sensible defaults for all services
  - Document each variable
  - Mark required vs optional
- [ ] Create `.env.defaults`:
  - Default values that work for local development
  - Can be overridden by `.env`
- [ ] Create `scripts/check-env.sh`:
  - Validate required variables are set
  - Check variable formats (URLs, etc.)
  - Warn about missing optional variables
  - Suggest fixes for common issues
- [ ] Update all services to read from unified `.env`:
  - Backend: Use root `.env`
  - Frontend: Use root `.env` (build-time substitution)
  - Python: Use root `.env`
  - Docker Compose: Use root `.env`
- [ ] Add `.env` auto-copy on first run:
  - Check if `.env` exists
  - If not, copy from `.env.example`
  - Run `generate-keys.sh` to populate secrets

**Acceptance Criteria**:
- Single `.env` file controls all services
- `check-env.sh` validates configuration
- Default values work for local development
- Clear error messages for missing/invalid config

---

### BE-001: Health Check Endpoints
**Priority**: P1 (High)
**Effort**: 1 day
**Dependencies**: None

**Tasks**:
- [ ] Enhance `GET /health` endpoint in [backend/app/routes/health.ts](backend/app/routes/health.ts):
  - Return JSON with service status
  - Check MongoDB connection
  - Check Redis connection
  - Check GridFS availability
  - Include version info
  - Response format:
    ```json
    {
      "status": "healthy",
      "version": "1.0.0",
      "services": {
        "mongodb": "connected",
        "redis": "connected",
        "gridfs": "available"
      },
      "uptime": 12345
    }
    ```
- [ ] Add health check for Whisper server
- [ ] Add health check for diarization server
- [ ] Create monitoring dashboard endpoint (optional)

**Acceptance Criteria**:
- `/health` returns detailed status
- Health check works in Docker
- Unhealthy services return 503

---

### DOC-001: Quick Start Documentation
**Priority**: P1 (High)
**Effort**: 2 days
**Dependencies**: OPS-001, OPS-002, OPS-003

**Tasks**:
- [ ] Update [README.md](README.md):
  - Add "Quick Start" section at top
  - Prerequisites: Docker Desktop
  - Three commands: clone, cd, docker compose up
  - Expected output/timeline
  - Troubleshooting section
- [ ] Create `docs/QUICKSTART.md`:
  - Detailed quick start guide
  - Screenshots of expected output
  - First-time user walkthrough
  - Common issues and solutions
- [ ] Create `docs/ARCHITECTURE.md`:
  - System architecture diagram
  - Component overview
  - Data flow
  - Service dependencies
- [ ] Create `docs/DOCKER.md`:
  - Docker Compose configuration explained
  - Service descriptions
  - Volume management
  - Network configuration
  - Resource requirements

**Acceptance Criteria**:
- README has clear Quick Start section
- New user can start system in < 5 minutes
- Documentation is accurate and tested

---

## Phase 1: Developer Onboarding Experience (Weeks 3-4)

### BE-002: Setup Wizard Backend API
**Priority**: P0 (Critical)
**Effort**: 3 days
**Dependencies**: OPS-003

**Tasks**:
- [ ] Create `POST /api/setup/status` endpoint:
  - Check if setup completed
  - Return setup state (new, in_progress, completed)
  - Check for API keys, LLM config, etc.
- [ ] Create `POST /api/setup/initialize` endpoint:
  - Generate API keys
  - Create default admin user
  - Seed default LLM models
  - Mark setup as completed
  - Return credentials
- [ ] Create `POST /api/setup/test-connection` endpoint:
  - Test database connection
  - Test Redis connection
  - Test inference server (if configured)
  - Return results
- [ ] Create `POST /api/setup/import-sample-data` endpoint:
  - Load sample audio files
  - Load sample conversations
  - Load sample artifacts
  - For demo purposes
- [ ] Add setup state to MongoDB:
  - Collection: `system_config`
  - Document: `{ _id: "setup", completed: true, completed_at: Date }`

**Acceptance Criteria**:
- Setup API endpoints functional
- API returns clear error messages
- Setup state persisted correctly

---

### FE-001: Setup Wizard UI
**Priority**: P0 (Critical)
**Effort**: 5 days
**Dependencies**: BE-002

**Tasks**:
- [ ] Create `frontend/src/pages/SetupWizardPage.tsx`:
  - Multi-step wizard component
  - Progress indicator (1/5, 2/5, etc.)
  - Navigation (Next, Back, Skip)
  - Persist progress to localStorage
- [ ] Step 1: Welcome
  - Project overview
  - What to expect
  - Estimated time: 5 minutes
  - "Get Started" button
- [ ] Step 2: System Initialization
  - Auto-run `POST /api/setup/initialize`
  - Display progress spinner
  - Show generated credentials (copy buttons)
  - Connection test results
  - "Continue" button
- [ ] Step 3: Inference Configuration
  - Radio selection: Managed / Self-hosted
  - For "Managed": Invite request form
  - For "Self-hosted": Server URL inputs
  - "Test Connection" button
  - "Continue" or "Skip for now"
- [ ] Step 4: LLM Configuration
  - Option A: Use default (pre-selected)
  - Option B: Add custom LLM provider
  - Form: Provider, API key, model selection
  - "Test" button
  - "Continue" or "Use default"
- [ ] Step 5: Audio Sources (Optional)
  - Checkboxes: Voice Memos, Google Drive, Local
  - Path inputs
  - "Test" buttons
  - "Skip" or "Configure later"
- [ ] Step 6: Complete
  - Summary of configuration
  - "Load sample data" checkbox
  - "Go to Dashboard" button
- [ ] Add first-visit detection:
  - Check localStorage for `setup_completed`
  - Check backend `/api/setup/status`
  - Redirect to wizard if not completed
  - Add "Run setup again" in settings

**Acceptance Criteria**:
- Wizard guides user through all steps
- Progress saved between steps
- Can skip optional steps
- Credentials displayed clearly
- Redirects to dashboard on completion

---

### OPS-004: CLI Setup Wizard
**Priority**: P2 (Medium)
**Effort**: 3 days
**Dependencies**: BE-002

**Tasks**:
- [ ] Create `scripts/setup-wizard.ts`:
  - Interactive CLI prompts (use `cliffy` or `inquirer`)
  - Welcome message
  - Prompt: Generate secrets? (Y/n)
  - Prompt: Import sample data? (Y/n)
  - Prompt: Inference mode? (Managed/Self-hosted)
  - Prompt: Configure LLM? (Default/Custom)
  - Call backend API endpoints
  - Save to `.env`
  - Display summary and next steps
- [ ] Add to `docker-compose.yml`:
  - Optional service: `setup-cli`
  - Run: `deno run -A scripts/setup-wizard.ts`
  - Command: `docker compose run setup-cli`
- [ ] Update README with CLI option

**Acceptance Criteria**:
- CLI wizard fully functional
- Can run independently or in Docker
- Saves configuration correctly

---

### DOC-002: Video Walkthrough
**Priority**: P2 (Medium)
**Effort**: 2 days
**Dependencies**: FE-001, OPS-004

**Tasks**:
- [ ] Record screen capture:
  - Clone repository
  - Run `docker compose up`
  - Complete setup wizard
  - Import sample data
  - Navigate timeline
  - Play audio
  - View artifacts
- [ ] Edit video:
  - Add titles/captions
  - Highlight key features
  - Add voiceover or text explanations
  - Keep under 5 minutes
- [ ] Upload to YouTube/Vimeo
- [ ] Embed in README and docs

**Acceptance Criteria**:
- Video < 5 minutes
- High quality (1080p)
- Clear audio/captions
- Linked in README

---

## Phase 2: Inference Server Configuration & UI (Weeks 5-6)

**Note**: Inference Docker infrastructure (docker-compose.inference.yml) was created in Phase 0 (OPS-001b). This phase focuses on the managed infrastructure option and configuration UI.

### BE-003: Invite System Backend
**Priority**: P1 (High)
**Effort**: 4 days
**Dependencies**: None

**Tasks**:
- [ ] Create `invites` MongoDB collection:
  - Schema: `{ email, status, requested_at, approved_at, api_key }`
- [ ] Create `POST /api/invites/request` endpoint:
  - Accept email address
  - Validate format
  - Check if already requested
  - Create invite record
  - Send confirmation email (optional)
  - Return status
- [ ] Create `POST /api/invites/approve` endpoint (admin only):
  - Approve invite
  - Generate Mycelia API key
  - Send email with credentials
  - Update invite status
- [ ] Create `GET /api/invites/list` endpoint (admin only):
  - List all invites
  - Filter by status
  - Pagination
- [ ] Create admin UI for invite management:
  - List pending invites
  - Approve/reject buttons
  - Search/filter
- [ ] Add usage tracking for managed infrastructure:
  - Track token usage per API key
  - Enforce quota limits
  - Warn when approaching limit

**Acceptance Criteria**:
- Users can request invites
- Admins can approve invites
- API keys provisioned correctly
- Usage tracked and limited

---

### FE-002: Inference Settings UI
**Priority**: P1 (High)
**Effort**: 3 days
**Dependencies**: BE-003, OPS-001b

**Tasks**:
- [ ] Create `frontend/src/pages/settings/InferenceSettingsPage.tsx`:
  - Radio buttons: "Mycelia Managed" / "Self-Hosted"
  - Conditional forms based on selection
- [ ] Managed inference section:
  - Display: "Using Mycelia's infrastructure"
  - If no API key:
    - Button: "Request Invite"
    - Form: Email input
    - Submit → call `POST /api/invites/request`
    - Success message
  - If has API key:
    - Input: API key (password field)
    - Button: "Test Connection"
    - Display: Usage stats (tokens used, quota remaining)
  - Save button
- [ ] Self-hosted section:
  - Input: STT Server URL (supports local or remote, default: http://localhost:8081)
  - Input: Diarization Server URL (supports local or remote, default: http://localhost:8085)
  - Help text: "Can point to same machine or remote inference server"
  - Buttons: "Test STT", "Test Diarization"
  - Display: Connection status (green check / red X)
  - Display: GPU status (if detectable)
  - Link: "Self-hosting guide" (with remote setup instructions)
  - Save button
- [ ] Add to [frontend/src/components/SettingsLayout.tsx](frontend/src/components/SettingsLayout.tsx):
  - New tab: "Inference"
- [ ] Add connection test API calls:
  - `POST /api/inference/test-stt`
  - `POST /api/inference/test-diarization`
  - Return: status, latency, GPU info (if available)
- [ ] Save configuration to backend:
  - Store in `configs` collection
  - Key: `inference_config`

**Acceptance Criteria**:
- UI shows both options clearly
- Invite request flow works
- Self-hosted URLs configurable (local or remote)
- Connection tests functional for both local and remote
- Configuration persisted

---

### DOC-003: Privacy Policy & Remote Inference Guide
**Priority**: P1 (High)
**Effort**: 2 days
**Dependencies**: BE-003, OPS-001b

**Tasks**:
- [ ] Create `docs/PRIVACY.md`:
  - What data is tracked (token usage, timestamps)
  - What is NEVER tracked (content, transcripts, prompts)
  - Third-party services used (OpenRouter, etc.)
  - Data retention policy
  - User rights (export, delete)
  - GDPR compliance notes
- [ ] Update `docs/SELF_HOSTING.md` (basic version from Phase 0):
  - Why self-host (privacy, cost, control)
  - Prerequisites and requirements
  - Local setup (same machine as main stack)
  - Remote setup (separate inference server):
    - Network configuration
    - Firewall rules
    - SSL/TLS setup (optional but recommended)
    - Security considerations
  - Model recommendations
  - Performance expectations
  - Maintenance and updates
- [ ] Link from frontend:
  - Add "Privacy Policy" link in footer
  - Add "Self-hosting Guide" in inference settings

**Acceptance Criteria**:
- Privacy policy published and accessible
- Self-hosting guide covers both local and remote setups
- Remote setup instructions tested
- Links visible in UI

---

## Phase 3: LLM Provider & Model Management (Weeks 7-8)

### BE-004: Default LLM Configuration
**Priority**: P0 (Critical)
**Effort**: 2 days
**Dependencies**: None

**Tasks**:
- [ ] Create database seed for default LLMs:
  - Insert into `llm_models` collection:
    - Small: `{ alias: "small", name: "gpt-4o-mini", provider: "openrouter", baseUrl: "...", apiKey: "MYCELIA_KEY" }`
    - Medium: `{ alias: "medium", name: "anthropic/claude-3.5-sonnet", provider: "openrouter", baseUrl: "...", apiKey: "MYCELIA_KEY" }`
    - Large: `{ alias: "large", name: "anthropic/claude-3.5-opus", provider: "openrouter", baseUrl: "...", apiKey: "MYCELIA_KEY" }`
  - Run in database initialization script
- [ ] Store Mycelia's OpenRouter API key securely:
  - Environment variable: `MYCELIA_OPENROUTER_KEY`
  - Encrypt in database
  - Rotate periodically
- [ ] Add rate limiting for default LLMs:
  - Track usage per user
  - Quota: 1M tokens/month (configurable)
  - Return 429 when exceeded
  - Clear error message: "Quota exceeded. Add your own API key in Settings."
- [ ] Update LLMResource ([backend/app/lib/llm/resource.server.ts](backend/app/lib/llm/resource.server.ts)):
  - Resolve alias → model
  - Use user's API key if available, else default
  - Track token usage
  - Enforce quotas

**Acceptance Criteria**:
- Default LLMs configured and functional
- Quota system working
- Clear messaging when using Mycelia's quota

---

### FE-003: Enhanced LLM Settings UI
**Priority**: P1 (High)
**Effort**: 4 days
**Dependencies**: BE-004

**Tasks**:
- [ ] Update [frontend/src/pages/settings/LLMSettingsPage.tsx](frontend/src/pages/settings/LLMSettingsPage.tsx):
  - Section: "Default Models (Mycelia)"
    - Display table: Alias, Model, Provider, Status
    - Show current usage: X / 1M tokens
    - Link: "Upgrade by adding your own API key"
  - Section: "Your Models"
    - List user-configured LLMs
    - Columns: Alias, Model, Provider, Actions (Edit, Delete, Test)
    - Button: "Add New Model"
- [ ] Update [frontend/src/pages/settings/CreateLLMPage.tsx](frontend/src/pages/settings/CreateLLMPage.tsx):
  - Form fields:
    - Provider dropdown (OpenRouter, OpenAI, Anthropic, Ollama, Custom)
    - API Key input (password, encrypted storage)
    - Model name input (with autocomplete if possible)
    - Alias assignment (small/medium/large or custom)
    - Base URL (for custom providers)
  - Validation with Zod schema
  - "Test Connection" button
  - Submit → save to database
- [ ] Update [frontend/src/pages/settings/LLMDetailPage.tsx](frontend/src/pages/settings/LLMDetailPage.tsx):
  - Edit form (similar to create)
  - "Delete" button with confirmation
  - Usage statistics (if available)
  - Connection status
- [ ] Add LLM testing functionality:
  - `POST /api/llm/test` endpoint
  - Send simple prompt
  - Return response or error
  - Display in UI
- [ ] Add model selection dropdown in processing UIs:
  - When creating artifacts
  - When extracting conversations
  - Dropdown: "Default (Small)" / "Default (Medium)" / "Custom Model Name"

**Acceptance Criteria**:
- UI shows default and custom models
- Users can add/edit/delete models
- Test connection works
- Model selection available in workflows

---

### BE-005: Multi-Provider LLM Support
**Priority**: P1 (High)
**Effort**: 3 days
**Dependencies**: BE-004

**Tasks**:
- [ ] Refactor LLMResource to support multiple providers:
  - Abstract provider interface
  - Implementations:
    - OpenRouterProvider
    - OpenAIProvider
    - AnthropicProvider
    - OllamaProvider (local)
    - CustomProvider (generic OpenAI-compatible)
  - Provider factory based on `provider` field
- [ ] Implement provider-specific logic:
  - API endpoint URLs
  - Authentication headers
  - Request/response format
  - Error handling
  - Streaming support
- [ ] Add fallback logic:
  - Primary model fails → try fallback
  - Configure fallback in model settings
  - Log fallback events
- [ ] Encrypt API keys in database:
  - Use `SECRET_KEY` for encryption
  - Decrypt on read
  - Never return plaintext in API responses

**Acceptance Criteria**:
- Multiple providers supported
- API keys encrypted
- Fallback logic works
- Provider-specific features handled

---

### OPS-006: Local LLM with Ollama
**Priority**: P2 (Medium)
**Effort**: 2 days
**Dependencies**: OPS-005

**Tasks**:
- [ ] Enhance `docker-compose.inference.yml`:
  - Ollama service configuration
  - Auto-pull models: llama3, mistral
  - GPU passthrough
  - Expose port 11434
- [ ] Create setup script for Ollama:
  - `scripts/setup-ollama.sh`
  - Pull recommended models
  - Test inference
  - Display usage instructions
- [ ] Document local LLM setup:
  - Add to `docs/SELF_HOSTING.md`
  - Model recommendations
  - Performance benchmarks
  - GPU requirements
  - Cost comparison (GPU vs. API)

**Acceptance Criteria**:
- Ollama runs in Docker
- Models pulled automatically
- Documentation complete

---

### DOC-004: Model Selection Wiki
**Priority**: P2 (Medium)
**Effort**: 3 days
**Dependencies**: BE-005, OPS-006

**Tasks**:
- [ ] Create `docs/MODEL_SELECTION.md`:
  - Comparison table:
    - Model name
    - Provider
    - Cost per 1M tokens
    - Speed (tokens/sec)
    - Quality score
    - Privacy (hosted vs. local)
    - Best use case
  - Recommended configurations:
    - Personal use: Ollama + llama3
    - Privacy-first: Self-hosted Whisper + local LLM
    - Performance: OpenRouter + Claude 3.5
    - Cost-effective: OpenRouter + GPT-4o-mini
  - Performance benchmarks:
    - Conversation extraction time
    - Summary quality comparison
    - Token usage statistics
  - Self-hosting considerations:
    - GPU requirements per model
    - RAM requirements
    - Disk space for models
    - Inference speed comparisons
- [ ] Create cost calculator tool (optional):
  - Web page or CLI
  - Input: Expected audio hours/month
  - Output: Estimated costs for different providers
- [ ] Link from frontend settings

**Acceptance Criteria**:
- Comprehensive model comparison
- Clear recommendations
- Benchmarks provided
- Accessible from UI

---

## Phase 4: Privacy & Transparency (Weeks 9-10)

### BE-006: Usage Tracking System
**Priority**: P0 (Critical)
**Effort**: 3 days
**Dependencies**: BE-004

**Tasks**:
- [ ] Create `usage_logs` MongoDB collection:
  - Schema:
    ```json
    {
      "_id": ObjectId,
      "timestamp": ISODate,
      "user_id": ObjectId,
      "api_key_id": ObjectId,
      "request_type": "transcription|conversation|summary|chat",
      "model": "gpt-4o-mini",
      "provider": "openrouter",
      "tokens": {
        "input": 1000,
        "output": 500,
        "total": 1500
      },
      "cost_usd": 0.00015,
      "duration_ms": 2500,
      "success": true
    }
    ```
  - Indexes: `timestamp`, `user_id`, `api_key_id`, `request_type`
- [ ] Implement logging middleware:
  - Wrap LLMResource calls
  - Extract token usage from response
  - Calculate cost (based on provider pricing)
  - Log to `usage_logs` collection
  - **Never log**: prompts, responses, content
- [ ] Create `GET /api/usage/stats` endpoint:
  - Query parameters: `start`, `end`, `group_by` (day/week/month)
  - Return aggregated data:
    - Total tokens
    - Breakdown by model
    - Breakdown by request type
    - Total cost
  - Support filtering by user/API key
- [ ] Add quota enforcement:
  - Check current period usage
  - Compare to quota limit
  - Reject request if exceeded (HTTP 429)
  - Include quota info in response headers

**Acceptance Criteria**:
- All LLM requests logged
- No sensitive data in logs
- Stats API returns accurate data
- Quota enforcement works

---

### FE-004: Usage Dashboard
**Priority**: P1 (High)
**Effort**: 4 days
**Dependencies**: BE-006

**Tasks**:
- [ ] Create `frontend/src/pages/settings/UsagePage.tsx`:
  - Date range selector (last 7 days, 30 days, custom)
  - Summary cards:
    - Total tokens used
    - Total cost (if applicable)
    - Requests made
    - Average tokens per request
  - Charts (using recharts or similar):
    - Token usage over time (line chart)
    - Breakdown by model (pie chart)
    - Breakdown by request type (bar chart)
  - Usage table:
    - Columns: Date, Request Type, Model, Tokens, Cost
    - Pagination
    - Export to CSV button
- [ ] Add to [frontend/src/components/SettingsLayout.tsx](frontend/src/components/SettingsLayout.tsx):
  - New tab: "Usage"
- [ ] Create usage API client:
  - `frontend/src/lib/usage.ts`
  - `fetchUsageStats(start, end, groupBy)`
  - `exportUsageCSV(start, end)`
- [ ] Display quota warnings:
  - If approaching limit (> 80%): Yellow banner
  - If exceeded: Red banner with "Upgrade" link

**Acceptance Criteria**:
- Dashboard displays usage data
- Charts render correctly
- CSV export works
- Quota warnings visible

---

### FE-005: Privacy Transparency UI
**Priority**: P1 (High)
**Effort**: 2 days
**Dependencies**: None

**Tasks**:
- [ ] Create `frontend/src/pages/PrivacyPage.tsx`:
  - Section: "What We Track"
    - List with icons:
      - ✅ Token usage counts
      - ✅ Request timestamps
      - ✅ Model names used
      - ✅ Request types
  - Section: "What We Never Track"
    - List with icons:
      - ❌ Audio content
      - ❌ Transcripts
      - ❌ Summaries
      - ❌ LLM prompts
      - ❌ LLM responses
      - ❌ User queries
  - Section: "Data Flow Diagram"
    - Visual diagram showing:
      - Audio → Local processing → Database
      - Metadata only → Usage logs
      - Content stays local
  - Section: "Your Rights"
    - Export all data
    - Delete all data
    - Request audit log
  - Section: "Third-Party Services"
    - List providers (OpenRouter, etc.)
    - Link to their privacy policies
    - Opt-out options (use self-hosted)
- [ ] Add privacy link to footer:
  - "Privacy Policy" → `/privacy`
- [ ] Create data export functionality:
  - Button: "Export My Data"
  - Generate ZIP with:
    - Database dump (user's data only)
    - Usage logs
    - Configuration
  - Download via browser

**Acceptance Criteria**:
- Privacy page clear and comprehensive
- Data flow diagram accurate
- Export functionality works
- Linked from footer

---

### DOC-005: Privacy Policy Document
**Priority**: P0 (Critical)
**Effort**: 2 days
**Dependencies**: BE-006

**Tasks**:
- [ ] Write formal privacy policy:
  - Introduction and scope
  - Data collection (what, why, how)
  - Data usage (processing, analytics)
  - Data storage (where, how long)
  - Data sharing (third parties)
  - User rights (access, deletion, portability)
  - Security measures
  - Updates to policy
  - Contact information
- [ ] Legal review (if possible):
  - GDPR compliance check
  - CCPA compliance check
  - Consult with legal advisor
- [ ] Publish as `docs/PRIVACY_POLICY.md`
- [ ] Add acceptance flow:
  - On first run, show privacy policy
  - Checkbox: "I accept the privacy policy"
  - Required to continue
  - Store acceptance in database

**Acceptance Criteria**:
- Privacy policy complete
- Legally reviewed (if possible)
- Acceptance flow implemented
- Accessible from UI

---

## Phase 5: Data Processing & Artifacts System (Weeks 11-13)

### BE-007: Processing Request System
**Priority**: P0 (Critical)
**Effort**: 5 days
**Dependencies**: BE-004

**Tasks**:
- [ ] Create `processing_jobs` MongoDB collection:
  - Schema:
    ```json
    {
      "_id": ObjectId,
      "user_id": ObjectId,
      "type": "summary|tasks|meeting|therapy|custom",
      "status": "queued|processing|completed|failed",
      "created_at": ISODate,
      "started_at": ISODate,
      "completed_at": ISODate,
      "source_period": {
        "start": ISODate,
        "end": ISODate
      },
      "model": "medium",
      "instructions": "Extract action items...",
      "template": "tasks.yaml",
      "result_artifact_id": ObjectId,
      "error": "...",
      "progress": 0.75
    }
    ```
- [ ] Create `POST /api/processing/create` endpoint:
  - Accept job parameters
  - Validate inputs
  - Create job record
  - Add to BullMQ queue
  - Return job ID
- [ ] Set up BullMQ job queue:
  - Install and configure BullMQ
  - Create worker process
  - Job handler:
    - Fetch audio chunks for period
    - Load transcripts
    - Apply processing template
    - Call LLM
    - Parse result
    - Create artifact
    - Update job status
  - Error handling and retries
- [ ] Create `GET /api/processing/job/:id` endpoint:
  - Return job status and progress
  - Include partial results if available
- [ ] Create `POST /api/processing/cancel/:id` endpoint:
  - Cancel queued or running job
  - Clean up resources
- [ ] Create WebSocket for job progress:
  - Emit progress updates
  - Frontend listens and updates UI

**Acceptance Criteria**:
- Jobs queued and processed
- Progress tracked accurately
- Results stored as artifacts
- Error handling robust

---

### BE-008: Processing Templates System
**Priority**: P0 (Critical)
**Effort**: 4 days
**Dependencies**: BE-007

**Tasks**:
- [ ] Create `templates/` directory:
  - YAML files for each processing type
- [ ] Create `templates/summary.yaml`:
  - Template for general summarization
  - Variables: `{start}`, `{end}`, `{transcript}`, `{context}`
  - Prompt structure
  - Expected output format (JSON)
- [ ] Create `templates/tasks.yaml`:
  - Extract TODO items, action items
  - Structure: `{ task, priority, due_date, assigned_to }`
- [ ] Create `templates/meeting.yaml`:
  - Meeting notes format
  - Sections: Attendees, Topics, Decisions, Action Items
- [ ] Create `templates/therapy.yaml`:
  - Psychological session analysis
  - Sections: Themes, Insights, Goals, Progress
- [ ] Create `templates/custom.yaml`:
  - User-defined template
  - Allows custom instructions
- [ ] Create template renderer:
  - Load YAML template
  - Substitute variables
  - Compile final prompt
  - Parse LLM response to structured data
- [ ] Create `GET /api/processing/templates` endpoint:
  - Return list of available templates
  - Include descriptions and expected outputs
- [ ] Create `POST /api/processing/templates/custom` endpoint:
  - Allow users to upload custom templates
  - Validate YAML structure
  - Store in database

**Acceptance Criteria**:
- 5+ templates available
- Variables substituted correctly
- LLM responses parsed to structured data
- Custom templates supported

---

### BE-009: Artifacts Database Schema
**Priority**: P0 (Critical)
**Effort**: 2 days
**Dependencies**: BE-007, BE-008

**Tasks**:
- [ ] Create `artifacts` MongoDB collection:
  - Schema (as designed in roadmap):
    ```json
    {
      "_id": ObjectId,
      "type": "summary|tasks|meeting|therapy|custom",
      "created_at": ISODate,
      "source_period": {
        "start": ISODate,
        "end": ISODate
      },
      "model": "gpt-4o",
      "processing_request": {
        "type": "summary",
        "instructions": "...",
        "template": "summary.yaml"
      },
      "result": {
        "text": "...",
        "structured_data": {...}
      },
      "metadata": {
        "token_count": 1234,
        "processing_time_ms": 5000,
        "source_chunks": [ObjectId, ...]
      },
      "visibility": "visible|hidden|archived",
      "tags": ["work", "personal"],
      "user_id": ObjectId
    }
    ```
  - Indexes: `created_at`, `type`, `visibility`, `user_id`, `tags`
- [ ] Create `POST /api/artifacts` endpoint:
  - Create new artifact
  - Validate schema
  - Return artifact ID
- [ ] Create `GET /api/artifacts` endpoint:
  - List artifacts
  - Filters: type, date range, visibility, tags
  - Pagination
  - Sort by created_at (desc)
- [ ] Create `GET /api/artifacts/:id` endpoint:
  - Return full artifact details
- [ ] Create `PATCH /api/artifacts/:id` endpoint:
  - Update visibility, tags
- [ ] Create `DELETE /api/artifacts/:id` endpoint:
  - Soft delete (mark as deleted)
  - Optional: Hard delete

**Acceptance Criteria**:
- Schema implemented correctly
- CRUD endpoints functional
- Filtering and pagination work
- Soft delete supported

---

### FE-006: Processing Request UI
**Priority**: P0 (Critical)
**Effort**: 5 days
**Dependencies**: BE-007, BE-008

**Tasks**:
- [ ] Create `frontend/src/pages/ProcessingRequestPage.tsx`:
  - Form fields:
    - Time period selector (DateTimePicker for start/end)
    - Processing type dropdown (Summary, Tasks, Meeting, Therapy, Custom)
    - Model selector (Small, Medium, Large, or specific model)
    - Instructions textarea (for custom or additional context)
    - Tags input (optional)
  - Form validation with Zod
  - Submit button → `POST /api/processing/create`
  - Redirect to artifacts list on submit
- [ ] Create modal/dialog for quick processing:
  - Trigger from timeline view
  - Pre-fill time period from selected range
  - Quick options (Summary, Tasks)
  - "Process" button
- [ ] Create processing job progress UI:
  - Show active jobs in header/sidebar
  - Progress bar (0-100%)
  - Status text ("Processing...", "Completed", "Failed")
  - Click to view details
  - Cancel button (for queued/in-progress jobs)
- [ ] Add WebSocket listener:
  - Connect to job progress WebSocket
  - Update UI in real-time
  - Show notification on completion
- [ ] Add shortcut from timeline:
  - Button: "Process selected period"
  - Opens processing modal with pre-filled dates

**Acceptance Criteria**:
- Form submits correctly
- Progress updates in real-time
- Can cancel jobs
- Shortcuts accessible from timeline

---

### FE-007: Artifacts List & Detail Pages
**Priority**: P0 (Critical)
**Effort**: 5 days
**Dependencies**: BE-009

**Tasks**:
- [ ] Create `frontend/src/pages/ArtifactsPage.tsx`:
  - List view (table or cards):
    - Columns: Icon (type), Title/Preview, Date, Period, Model, Tags, Actions
    - Actions: View, Hide, Archive, Delete
    - Batch selection (checkboxes)
    - Batch actions toolbar
  - Filters sidebar:
    - Type (checkboxes)
    - Date range
    - Model
    - Visibility
    - Tags
  - Search box (full-text if supported)
  - Sort options (date, type)
  - Pagination (20 per page)
- [ ] Create `frontend/src/pages/ArtifactDetailPage.tsx`:
  - Header:
    - Type icon and name
    - Date created
    - Tags (editable)
    - Actions dropdown: Hide, Archive, Re-process, Export, Delete
  - Section: Result
    - Display `result.text` (markdown rendering)
    - Display `result.structured_data` (formatted JSON or custom UI)
  - Section: Processing Details
    - Source period (start → end)
    - Model used
    - Processing template
    - Instructions
    - Token count
    - Processing time
  - Section: Source Data
    - List of source audio chunks (links)
    - Total audio duration
    - Transcripts preview
  - Button: "Re-process with different settings"
    - Opens processing form with pre-filled data
- [ ] Create artifact export functionality:
  - Format options: Markdown, JSON, PDF (optional)
  - Download file
- [ ] Create artifact type icons:
  - Summary: 📝
  - Tasks: ✅
  - Meeting: 💼
  - Therapy: 🧠
  - Custom: ⚙️
- [ ] Add artifacts link to main navigation:
  - "Artifacts" menu item

**Acceptance Criteria**:
- List displays all artifacts
- Filters and search work
- Detail page shows all info
- Export functional
- Navigation accessible

---

### FE-008: Re-processing System
**Priority**: P1 (High)
**Effort**: 3 days
**Dependencies**: FE-006, FE-007

**Tasks**:
- [ ] Add "Re-process" button to artifact detail:
  - Opens processing request form
  - Pre-fill fields from original request:
    - Time period
    - Type
    - Instructions
  - User can modify:
    - Model
    - Instructions
    - Tags
  - Submit → creates new artifact
  - Link to original artifact in metadata
- [ ] Create artifact comparison view (optional):
  - Side-by-side comparison of two artifacts
  - Diff highlighting for text
  - Useful for comparing models or prompts
- [ ] Add "Variations" section to artifact detail:
  - List other artifacts from same source period
  - Link to comparison view

**Acceptance Criteria**:
- Re-processing creates new artifact
- Original preserved
- Can compare variations

---

## Phase 6: Advanced Features (Weeks 14-16)

### PY-001: Audio Source Auto-Discovery
**Priority**: P2 (Medium)
**Effort**: 3 days
**Dependencies**: FE-001

**Tasks**:
- [ ] Enhance setup wizard with audio source detection:
  - Add step: "Configure Audio Sources"
  - Auto-detect available sources:
    - Check for Apple Voice Memos database
    - Check for Google Drive folder
    - Check for local audio folder
  - Display detected sources with checkboxes
  - For each source:
    - Show path
    - Show sample count (if accessible)
    - Enable/disable toggle
    - Test button
- [ ] Create backend endpoint `GET /api/sources/detect`:
  - Run discovery logic from `python/discovery.py`
  - Return list of found sources
  - Include metadata (path, count, last modified)
- [ ] Add to settings UI:
  - "Data Sources" settings page
  - List configured sources
  - Add/remove/edit sources
  - Test connection
  - Manual sync button
- [ ] Update `python/daemon.py`:
  - Read source configuration from database
  - Enable/disable sources dynamically
  - Log discovery events

**Acceptance Criteria**:
- Setup wizard detects sources
- Users can enable/disable sources
- Configuration persisted
- Daemon respects configuration

---

### BE-010: Batch Operations API
**Priority**: P2 (Medium)
**Effort**: 2 days
**Dependencies**: BE-009

**Tasks**:
- [ ] Create `POST /api/artifacts/batch` endpoint:
  - Accept array of artifact IDs
  - Action: hide, archive, delete, tag, re-process
  - Apply action to all
  - Return results
- [ ] Create scheduled processing:
  - Allow users to schedule recurring jobs
  - Example: "Daily summary at 9 PM"
  - Cron-like scheduling
  - Store in `scheduled_jobs` collection
  - BullMQ recurring jobs

**Acceptance Criteria**:
- Batch operations work correctly
- Scheduled jobs run on time
- UI for scheduling created

---

### FE-009: Batch Operations UI
**Priority**: P2 (Medium)
**Effort**: 2 days
**Dependencies**: BE-010

**Tasks**:
- [ ] Add batch selection to artifacts list:
  - Checkboxes for each artifact
  - "Select All" checkbox
  - Toolbar appears when items selected:
    - Hide selected
    - Archive selected
    - Delete selected
    - Add tags
    - Re-process selected
  - Confirmation dialogs
- [ ] Create scheduled processing UI:
  - "Scheduled Jobs" settings page
  - List active schedules
  - Add new schedule form:
    - Cron expression or simple picker (daily, weekly, etc.)
    - Processing type
    - Model
    - Instructions
  - Enable/disable toggle
  - Delete schedule

**Acceptance Criteria**:
- Batch operations functional
- Scheduled jobs manageable via UI
- Confirmations prevent accidents

---

### BE-011: Sharing System
**Priority**: P3 (Low)
**Effort**: 4 days
**Dependencies**: BE-009

**Tasks**:
- [ ] Create `shared_links` MongoDB collection:
  - Schema:
    ```json
    {
      "_id": ObjectId,
      "artifact_id": ObjectId,
      "token": "random-string",
      "created_by": ObjectId,
      "created_at": ISODate,
      "expires_at": ISODate,
      "password_hash": "...",
      "view_count": 0,
      "max_views": 10
    }
    ```
- [ ] Create `POST /api/artifacts/:id/share` endpoint:
  - Generate random token
  - Set expiration (optional)
  - Set password (optional)
  - Set max views (optional)
  - Return shareable URL
- [ ] Create `GET /share/:token` endpoint:
  - Verify token exists and not expired
  - Check password if set
  - Increment view count
  - Check max views
  - Return artifact data (read-only)
- [ ] Create `DELETE /api/shared_links/:id` endpoint:
  - Revoke shared link

**Acceptance Criteria**:
- Shareable links generated
- Expiration enforced
- Password protection works
- View counts tracked

---

### FE-010: Sharing UI
**Priority**: P3 (Low)
**Effort**: 3 days
**Dependencies**: BE-011

**Tasks**:
- [ ] Add "Share" button to artifact detail:
  - Opens share dialog
  - Options:
    - Expiration (1 hour, 1 day, 1 week, never)
    - Password (optional)
    - Max views (optional)
  - Generate button → call API
  - Display shareable URL with copy button
  - List existing shared links
  - Revoke buttons
- [ ] Create public share page:
  - `frontend/src/pages/SharePage.tsx`
  - Route: `/share/:token`
  - Password prompt if required
  - Display artifact (read-only)
  - No navigation or editing
  - Simple, clean design

**Acceptance Criteria**:
- Share dialog functional
- Public page accessible
- Password prompt works
- Links can be revoked

---

### OPS-007: Backup & Export System
**Priority**: P2 (Medium)
**Effort**: 4 days
**Dependencies**: None

**Tasks**:
- [ ] Create `scripts/backup.sh`:
  - Use `mongodump` to export database
  - Export to timestamped directory
  - Optionally compress (tar.gz)
  - Upload to S3 or local storage
- [ ] Create `scripts/restore.sh`:
  - Use `mongorestore` to import backup
  - Verify data integrity
  - Display summary
- [ ] Create `POST /api/backup/create` endpoint:
  - Trigger backup job
  - Return job ID and status
- [ ] Create `GET /api/backup/list` endpoint:
  - List available backups
  - Include size, date, location
- [ ] Create `POST /api/backup/restore/:id` endpoint:
  - Restore from backup
  - Requires confirmation and admin auth
- [ ] Add scheduled backups:
  - Cron job or BullMQ recurring job
  - Daily backups (configurable)
  - Retention policy (keep last 7 days)

**Acceptance Criteria**:
- Manual backups work
- Restore tested and functional
- Scheduled backups run automatically
- Retention policy enforced

---

### FE-011: Backup & Export UI
**Priority**: P2 (Medium)
**Effort**: 2 days
**Dependencies**: OPS-007

**Tasks**:
- [ ] Create `frontend/src/pages/settings/BackupPage.tsx`:
  - Section: Manual Backup
    - Button: "Create Backup Now"
    - Progress indicator
    - Download link on completion
  - Section: Scheduled Backups
    - Toggle: Enable/Disable
    - Frequency selector (daily, weekly)
    - Retention setting (days to keep)
  - Section: Restore
    - Upload backup file
    - Or select from list
    - Restore button (with warning)
  - Section: Data Export
    - Export user data (artifacts, audio metadata, etc.)
    - Format: JSON or ZIP
    - Download button
- [ ] Add to settings navigation:
  - "Backup & Export" tab

**Acceptance Criteria**:
- UI triggers backup/restore
- Scheduled backups configurable
- Export downloads correctly

---

### OPS-008: Performance Optimization
**Priority**: P1 (High)
**Effort**: 5 days
**Dependencies**: All previous phases

**Tasks**:
- [ ] Frontend optimizations:
  - Lazy load routes with React.lazy
  - Virtualize long lists (artifacts, audio chunks)
  - Optimize timeline rendering (canvas throttling)
  - Reduce bundle size (analyze with vite-bundle-analyzer)
  - Add service worker for caching (optional)
- [ ] Backend optimizations:
  - Add Redis caching for frequent queries
  - Optimize MongoDB queries (explain plans)
  - Add compound indexes where needed
  - Enable connection pooling
  - Add request rate limiting
- [ ] Database optimizations:
  - Review and optimize indexes
  - Add materialized views for aggregations (if supported)
  - Archive old data (e.g., > 1 year)
  - Set up MongoDB Atlas search (if using)
- [ ] Profiling and monitoring:
  - Add performance metrics to OpenTelemetry
  - Monitor query performance
  - Set up alerts for slow queries
  - Use Deno's built-in profiler
- [ ] Load testing:
  - Simulate 100+ concurrent users
  - Test timeline with 1 year of audio data
  - Test artifact processing queue under load
  - Identify bottlenecks

**Acceptance Criteria**:
- Frontend loads in < 2s
- Timeline renders 1 month in < 1s
- API responses < 200ms (p95)
- No memory leaks
- Load test passes

---

## Summary by Component

### Backend (Deno/TypeScript)
- OPS-001, OPS-002, OPS-003, BE-001: Docker + initialization (10 days)
- BE-002: Setup wizard API (3 days)
- BE-003: Invite system (4 days)
- BE-004, BE-005: LLM management (5 days)
- BE-006: Usage tracking (3 days)
- BE-007, BE-008, BE-009: Processing & artifacts (11 days)
- BE-010: Batch operations (2 days)
- BE-011: Sharing (4 days)
- **Total Backend**: ~42 days (8.5 weeks)

### Frontend (React/TypeScript)
- FE-001: Setup wizard UI (5 days)
- FE-002: Inference settings (3 days)
- FE-003: LLM settings (4 days)
- FE-004, FE-005: Usage & privacy (6 days)
- FE-006, FE-007, FE-008: Processing & artifacts (13 days)
- FE-009: Batch operations (2 days)
- FE-010: Sharing (3 days)
- FE-011: Backup UI (2 days)
- **Total Frontend**: ~38 days (7.5 weeks)

### Python (Processing Pipeline)
- PY-001: Audio source discovery (3 days)
- **Total Python**: ~3 days

### DevOps/Infrastructure
- OPS-001, OPS-002, OPS-003: Foundation (10 days)
- OPS-004: CLI wizard (3 days)
- OPS-005: Inference stack (5 days)
- OPS-006: Local LLM (2 days)
- OPS-007: Backup system (4 days)
- OPS-008: Performance (5 days)
- **Total DevOps**: ~29 days (6 weeks)

### Documentation
- DOC-001: Quick start (2 days)
- DOC-002: Video (2 days)
- DOC-003: Privacy & self-hosting (2 days)
- DOC-004: Model selection (3 days)
- DOC-005: Privacy policy (2 days)
- **Total Documentation**: ~11 days (2 weeks)

---

## Prioritization Guide

### Must-Have (P0)
All Phase 0, Phase 1, Phase 5 core functionality

### Should-Have (P1)
Phase 2, Phase 3, Phase 4 core features

### Nice-to-Have (P2)
Phase 6 except sharing

### Future (P3)
Sharing system, advanced analytics

---

## Dependencies Graph

```
Phase 0 (Foundation)
  ↓
Phase 1 (Onboarding) ← depends on Phase 0
  ↓
Phase 2 (Inference) ← can run parallel to Phase 1
  ↓
Phase 3 (LLM) ← depends on Phase 2
  ↓
Phase 4 (Privacy) ← depends on Phase 3
  ↓
Phase 5 (Artifacts) ← depends on Phase 3, Phase 4
  ↓
Phase 6 (Advanced) ← depends on Phase 5
```

---

## Tracking & Reporting

**Recommended Tools**:
- GitHub Projects (Kanban board)
- Weekly sprint planning
- Bi-weekly demos
- Daily standups (async)

**Metrics to Track**:
- Tasks completed vs. planned
- Blockers and dependencies
- Test coverage
- Performance benchmarks
- User feedback (once released)

---

**Document Owner**: Engineering Team
**Review Cycle**: Weekly during implementation
**Last Updated**: 2025-11-27
