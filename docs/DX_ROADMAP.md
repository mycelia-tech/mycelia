<!-- historical-plan -->
# Mycelia Developer Experience Roadmap

Historical proposal, not a completion report. See [current documentation](README.md).

**Version**: 1.0
**Last Updated**: 2025-11-29
**Status**: Draft

---

## Executive Summary

This roadmap outlines the evolution of Mycelia's developer experience from current state to a frictionless, sovereignty-first onboarding system. The primary goal: **make trying Mycelia effortless** while preserving full user control.

**Core Philosophy**: `clone → run → test immediately`

---

## Current State Analysis

### What Exists Today

**Infrastructure**:
- ✅ Docker Compose for database layer (MongoDB, MongoDB Search, Redis)
- ✅ Deno backend with resource-based architecture
- ✅ React frontend with timeline visualization
- ✅ Python processing pipeline (ingestion, VAD, STT, conversation extraction)
- ✅ JWT & OAuth2 authentication
- ✅ API key generation via CLI
- ✅ GridFS file storage
- ✅ MCP (Model Context Protocol) integration

**Developer Setup Required**:
- Manual dependency installation (Deno, Python, uv, ffmpeg, portaudio)
- Manual `.env` configuration
- Manual token generation
- Separate backend/frontend/Python process management
- Manual Whisper server setup
- Manual LLM configuration

**Pain Points**:
- No single-command startup
- Configuration scattered across multiple `.env` files
- Backend and frontend not containerized by default
- Python environment requires system dependencies
- No guided setup flow
- LLM configuration requires manual database insertion or UI setup
- Inference server setup completely manual

---

## Vision: Frictionless Developer Experience

### Target State

```bash
git clone https://github.com/mycelia-tech/mycelia
cd mycelia
docker compose up
```

**Result**: Complete working environment in < 5 minutes:
- ✅ Database initialized
- ✅ Keys auto-generated
- ✅ Backend running
- ✅ Frontend accessible
- ✅ Web interface at `http://localhost:3001`
- ✅ Sample data loaded (optional)
- ✅ Interactive setup wizard available

---

## Roadmap Phases

### Phase 0: Foundation (Weeks 1-2)

**Goal**: Consolidate Docker Compose setup for full stack

#### Milestones
1. **Unified Docker Compose Configuration** (Main Stack)
   - Add backend service (Deno container)
   - Add frontend service (Vite production build)
   - Add Python pipeline service
   - Network all services properly
   - Volume mounts for persistent data

2. **Inference Stack Docker Compose** (Separate, Optional)
   - Create `docker-compose.inference.yml`:
     - Whisper STT service (large-v3 model)
     - Diarization service (pyannote or custom)
     - Ollama service (optional, for local LLM)
   - Auto-detection of GPU availability
   - CPU fallback configuration
   - Model download automation on first run
   - Can run on same machine or separate inference server
   - Health checks for all inference services
   - Resource requirements documentation

3. **Auto-initialization Scripts**
   - Database schema initialization
   - API key auto-generation on first run
   - Secret key generation
   - Default admin user creation
   - Health check endpoints for all services

4. **Environment Consolidation**
   - Single `.env` file at root
   - Template with sensible defaults
   - Auto-copy `.env.example` → `.env` if missing
   - Environment variable validation on startup
   - Include inference server URLs (configurable for remote)

**Deliverables**:
- `docker-compose.yml` with main services
- `docker-compose.inference.yml` for inference stack
- `scripts/init.sh` for first-time setup
- `scripts/start-inference.sh` for inference stack
- Unified `.env.example`
- Health check dashboard
- Self-hosting inference guide (basic)

---

### Phase 1: Developer Onboarding Experience (Weeks 3-4)

**Goal**: Interactive setup wizard for first-time users

#### Milestones
1. **Interactive CLI Setup Wizard**
   - Detect first run (no `.env` or empty database)
   - Welcome screen with project overview
   - Configuration prompts:
     - Generate secrets (Y/n)
     - Import sample data (Y/n)
     - Configure audio sources (later)
     - Choose inference mode (Mycelia managed / self-hosted)
   - Save configuration to `.env`
   - Display access URLs and credentials

2. **Web-based Setup Flow**
   - First-visit detection in frontend
   - Step-by-step configuration UI:
     1. Welcome & overview
     2. API key generation
     3. Inference server selection
     4. LLM model configuration
     5. Audio source setup (optional)
     6. Ready to use!
   - Progress indicator
   - Skip to dashboard option
   - Save configuration to localStorage + backend

3. **Documentation Improvements**
   - Quick Start guide (< 5 minutes to running)
   - Architecture overview
   - Docker troubleshooting
   - Developer setup for contributors
   - Video walkthrough

**Deliverables**:
- `scripts/setup-wizard.ts` (CLI)
- `frontend/src/pages/SetupWizardPage.tsx`
- Updated README with Quick Start section
- Architecture diagram
- Setup video

---

### Phase 2: Inference Server Configuration & UI (Weeks 5-6)

**Goal**: Seamless choice between managed and self-hosted inference with user-friendly configuration

**Note**: Self-hosted Docker infrastructure created in Phase 0. This phase focuses on the managed option and configuration UI.

#### Milestones
1. **Mycelia Managed Infrastructure Option**
   - Design invite system backend
   - API key provisioning service
   - Usage tracking (token count only, no content)
   - Quota management
   - Waitlist UI
   - Email notifications (optional)
   - Documentation: privacy policy, usage limits

2. **Configuration UI & Connection Management**
   - Settings page: Inference section
   - Toggle: Managed / Self-hosted
   - For managed:
     - Display invite request form
     - API key input
     - Connection test
     - Usage quota display
   - For self-hosted:
     - Server URL inputs (STT, diarization)
     - Support remote server configuration
     - Connection test
     - Model selection
     - GPU detection status
   - Save and apply
   - Connection status indicators

3. **Remote Inference Server Support**
   - Allow self-hosted stack to run on separate machine
   - Environment variables for remote URLs:
     - `STT_SERVER_URL` (can point to remote host)
     - `DIARIZATION_SERVER_URL` (can point to remote host)
   - Network configuration guide
   - Security considerations (API keys, SSL/TLS)

**Deliverables**:
- Invite system backend API
- Frontend inference settings page
- Connection testing utilities
- Remote server configuration guide
- Privacy policy document (expanded)
- Updated self-hosting guide with remote setup

---

### Phase 3: LLM Provider & Model Management (Weeks 7-8)

**Goal**: Flexible, user-controlled LLM routing with sensible defaults

#### Milestones
1. **Default LLM Configuration**
   - Pre-configure OpenRouter integration
   - Model aliases:
     - `small`: GPT-4o-mini or Claude 3.5 Haiku
     - `medium`: GPT-4o or Claude 3.5 Sonnet
     - `large`: Claude 3.5 Opus or o1
   - Use Mycelia's OpenRouter key by default (with rate limits)
   - Clear messaging: "Using Mycelia's LLM quota"

2. **User LLM Configuration Options**
   - Settings UI improvements:
     - Add LLM provider form (OpenRouter, OpenAI, Anthropic, custom)
     - API key input (encrypted storage)
     - Model selection dropdown
     - Alias assignment (small/medium/large)
     - Test connection button
   - Support multiple providers simultaneously
   - Priority/fallback logic

3. **Local LLM Configuration** (Ollama setup in Phase 0)
   - Backend integration with Ollama (already in docker-compose.inference.yml)
   - Model recommendations (LLaMA 3, Mistral, etc.)
   - Performance expectations
   - Model download UI or CLI tools

4. **Model Selection Wiki**
   - Comparison table (cost, speed, quality)
   - Use case recommendations
   - Performance benchmarks
   - Privacy considerations
   - Self-hosting vs. managed trade-offs

**Deliverables**:
- Default LLM configuration in database seed
- Enhanced LLM settings UI
- Ollama integration documentation (updated from Phase 0)
- Model selection wiki page
- LLM provider abstraction layer

---

### Phase 4: Privacy & Transparency (Weeks 9-10)

**Goal**: Clear communication of data handling and usage tracking

#### Milestones
1. **Usage Tracking Implementation**
   - Track per request:
     - Timestamp
     - Model used
     - Token count (input/output)
     - User/API key ID
     - Request type (transcription, conversation extraction, chat, etc.)
   - **Never log**:
     - Audio content
     - Transcripts
     - Summaries
     - User queries
     - LLM responses

2. **Privacy Dashboard**
   - Usage statistics page:
     - Token usage over time (chart)
     - Breakdown by model
     - Breakdown by request type
     - Cost estimate (if using managed)
   - Data handling transparency:
     - What we track
     - What we never track
     - Data retention policy
     - Export/delete options

3. **Privacy Documentation**
   - Privacy policy page
   - Data flow diagram
   - Third-party services disclosure
   - GDPR compliance notes (if applicable)
   - Self-hosting privacy benefits

**Deliverables**:
- Usage tracking service
- `usage_logs` MongoDB collection
- Frontend usage dashboard
- Privacy policy document
- Data flow diagram

---

### Phase 5: Data Processing & Artifacts System (Weeks 11-13)

**Goal**: Modular, auditable processing with persistent artifacts

#### Milestones
1. **Processing Request System**
   - UI for creating processing jobs:
     - Time period selector (date range)
     - Model selector (small/medium/large or specific)
     - Processing type selector:
       - Summary
       - Task extraction (TODOs)
       - Meeting analysis
       - Psychological session analysis
       - Custom instruction
     - Context/instructions input
   - Job queue management
   - Progress tracking
   - Cancel/pause functionality

2. **Modular Processing Layers**
   - Refactor conversation extraction to be configurable
   - Processing templates:
     - `summary.yaml` - General summary
     - `tasks.yaml` - TODO extraction
     - `meeting.yaml` - Meeting notes
     - `therapy.yaml` - Session analysis
     - `custom.yaml` - User-defined
   - Template variables: `{start}`, `{end}`, `{context}`, etc.
   - Prompt composition from templates

3. **Artifacts Database Schema**
   - New collection: `artifacts`
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
       "tags": ["work", "personal"]
     }
     ```

4. **Artifacts UI**
   - List view:
     - Date created
     - Type (with icon)
     - Source period
     - Model used
     - Preview
     - Actions (view, hide, archive, re-process, delete)
   - Detail view:
     - Full result display
     - Processing request details
     - Source data links
     - Re-process with different model/instructions
     - Export (markdown, JSON)
   - Filters:
     - By type
     - By date range
     - By model
     - By visibility

5. **Re-processing System**
   - "Re-process" button on artifact
   - Pre-fill form with original request
   - Allow modifications
   - Create new artifact (preserve original)
   - Comparison view (optional)

**Deliverables**:
- Processing job queue (BullMQ or similar)
- Processing templates system
- `artifacts` collection schema
- Frontend processing request UI
- Artifacts list/detail pages
- Re-processing functionality
- Export system

---

### Phase 6: Advanced Features (Weeks 14-16)

**Goal**: Polish and advanced capabilities

#### Milestones
1. **Audio Source Auto-Discovery**
   - Setup wizard step for audio sources
   - Detect and offer to enable:
     - Apple Voice Memos
     - Google Drive
     - Local folder
     - Future: Otter.ai, Zoom, etc.
   - Permission requests
   - Test import

2. **Batch Operations**
   - Bulk artifact operations (hide, archive, delete)
   - Bulk re-processing
   - Scheduled processing (daily summary, weekly review)

3. **Sharing System (Optional)**
   - Generate shareable links for artifacts
   - Expiration settings
   - Password protection
   - View-only mode

4. **Backup & Export**
   - One-click database export
   - Scheduled backups
   - Import from backup
   - Data portability

5. **Performance Optimization**
   - Frontend lazy loading
   - Backend caching improvements
   - Database query optimization
   - Timeline rendering performance

**Deliverables**:
- Audio source discovery wizard
- Batch operations UI
- Sharing system (if prioritized)
- Backup/restore functionality
- Performance improvements

---

## Timeline Summary

| Phase | Duration | Focus | Status |
|-------|----------|-------|--------|
| Phase 0 | Weeks 1-2 | Foundation (Docker Compose) | Not Started |
| Phase 1 | Weeks 3-4 | Onboarding Experience | Not Started |
| Phase 2 | Weeks 5-6 | Inference Configuration | Not Started |
| Phase 3 | Weeks 7-8 | LLM Management | Not Started |
| Phase 4 | Weeks 9-10 | Privacy & Transparency | Not Started |
| Phase 5 | Weeks 11-13 | Artifacts System | Not Started |
| Phase 6 | Weeks 14-16 | Advanced Features | Not Started |

**Total Duration**: 16 weeks (4 months)

---

## Success Metrics

### Phase 0
- ✅ Single command startup (`docker compose up`)
- ✅ All services healthy within 2 minutes
- ✅ Zero manual configuration required

### Phase 1
- ✅ First-time user to working dashboard < 5 minutes
- ✅ Setup wizard completion rate > 80%
- ✅ Documentation clarity (user feedback)

### Phase 2
- ✅ Managed infrastructure invite system live
- ✅ Self-hosted inference setup < 15 minutes
- ✅ Connection test success rate > 95%

### Phase 3
- ✅ Default LLM working out of box
- ✅ User can add custom LLM in < 3 minutes
- ✅ Support for 3+ LLM providers

### Phase 4
- ✅ Usage dashboard shows accurate data
- ✅ Privacy policy published
- ✅ Zero content logged (verified)

### Phase 5
- ✅ Users can create artifacts in < 2 minutes
- ✅ Re-processing works reliably
- ✅ 5+ processing templates available

### Phase 6
- ✅ Audio source auto-discovery > 90% success
- ✅ Backup/restore tested and documented
- ✅ Performance: timeline renders < 1s for 1 month of data

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Docker Compose complexity | High | Extensive testing, health checks, clear error messages |
| Inference server resource requirements | Medium | CPU fallback, cloud option, clear documentation |
| LLM provider API changes | Medium | Abstraction layer, multiple provider support |
| Data migration for artifacts | High | Careful schema design, migration scripts, backups |
| Privacy compliance | High | Legal review, transparent documentation, minimal logging |
| Performance degradation | Medium | Profiling, optimization phase, lazy loading |

---

## Dependencies

### External
- Docker & Docker Compose (user-installed)
- Deno runtime (containerized)
- Python + uv (containerized)
- LLM provider APIs (OpenRouter, OpenAI, etc.)

### Internal
- Current codebase refactoring
- Database schema migrations
- Frontend component library
- Backend resource system

---

## Team Requirements

Recommended team composition:
- 1x Full-stack engineer (Docker, Deno, React)
- 1x Backend engineer (Python, ML inference)
- 1x Frontend engineer (React, UX)
- 1x DevOps/Infrastructure (Docker, deployment)
- 0.5x Designer (setup wizard, artifacts UI)
- 0.5x Technical writer (documentation)

---

## Next Steps

1. **Approve roadmap** - Review and sign off on phases
2. **Phase 0 kickoff** - Begin Docker Compose consolidation
3. **Create detailed task breakdown** - Break phases into sprints
4. **Set up project tracking** - GitHub Projects or similar
5. **Begin development** - Start with Phase 0 Foundation

---

## Appendix: Alternative Approaches Considered

### Approach A: Native Installers
**Pros**: No Docker requirement, native OS integration
**Cons**: Complex build process, platform-specific maintenance
**Decision**: Rejected - Docker provides better consistency

### Approach B: Cloud-First
**Pros**: Zero local setup, instant access
**Cons**: Privacy concerns, ongoing hosting costs, vendor lock-in
**Decision**: Rejected - Conflicts with sovereignty principle

### Approach C: Gradual Migration
**Pros**: Lower risk, incremental improvements
**Cons**: Longer time to value, fragmented experience
**Decision**: Rejected - Users need immediate friction reduction

---

## Known Issues & Near Features

This section tracks bugs, technical debt, and near-term improvements that don't fit into the major phases above.

### Bugs / Technical Debt

| Issue | Description | Status | Priority |
|-------|-------------|--------|----------|
| **Stuck diarization claims** | When diarization workers crash or are killed, they leave `processing_by` claims on audio chunks that are never released. Requires manual cleanup using `python/debug/cleanup_claims.py`. [#12](https://github.com/mycelia-tech/mycelia/issues/12) | Open | High |

#### Stuck Diarization Claims - Details

**Problem**: The diarization worker claims audio chunks by setting `processing_by` and `claimed_at` fields in `audio_chunks` collection. If a worker crashes, gets killed, or times out without completing, these claims remain indefinitely, blocking the chunks from being processed.

**Current Workaround**: Use the debug script:
```bash
uv run python/debug/cleanup_claims.py           # inspect current claims
uv run python/debug/cleanup_claims.py --clean   # clear claims (checks for running workers)
uv run python/debug/cleanup_claims.py --clean --force  # force clear
```

**Proper Fix Needed**:
- Implement automatic claim timeout (e.g., release claims older than 30 minutes)
- Add periodic cleanup job that releases stale claims
- Consider heartbeat mechanism for long-running workers
- Make cleanup script obsolete by design

---

### Near Features

| Feature | Description | Status | Priority |
|---------|-------------|--------|----------|
| *Add items here* | - | - | - |

---

**Document Owner**: Developer Experience Team
**Review Cycle**: Bi-weekly during implementation
**Feedback**: [GitHub Issues](https://github.com/mycelia-tech/mycelia/issues)
