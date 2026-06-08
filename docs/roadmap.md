# Roadmap

## Completed

### v3.0.0: Rate-limit survival, honesty, self-heal
- Repurposed around surviving Max/Pro 5-hour limits instead of chasing dollar savings
- Removed all dollar estimation; counts real "kept off Opus" events (v3.0 stats schema)
- Conservative Opus routing; Sonnet is the default when uncertain (fixes the old default-to-Haiku bias)
- Status-line tally (⇩ today·week) plus a CR⚠ liveness alarm
- `cr-doctor` self-heal at every session boot, a daily cron backstop, and a `/cr-doctor` skill
- Softer routing directive and bare subagent names

### Phase 1: Rule-based Classification
- Zero-latency pattern matching (~0ms)
- Zero cost (no API calls)
- Three-tier routing: fast, standard, deep

### Phase 2: Hybrid Classification
- Rules + Haiku LLM fallback for low-confidence cases
- Improved accuracy on ambiguous queries

### Phase 3: Standalone Repository
- Separated from monorepo
- Independent versioning

### Phase 4: Usage Statistics & Plugin Distribution (v1.1.0)
- `/router-stats` command with multiple value metrics
- `/route <model>` command for manual model override
- Plugin marketplace distribution
- Subscriber benefits (extended limits, longer sessions)

### Phase 5: Tool-Aware Routing & Hybrid Delegation (v1.2.0)
- Tool-intensity pattern detection (file scanning, multi-file edits, test runs)
- Opus Orchestrator mode for complex multi-step tasks
- Smart delegation: Opus handles strategy, spawns Haiku/Sonnet for subtasks
- Escalation paths: Sonnet can recommend Opus for architectural decisions
- Enhanced delegation metrics for orchestrated tasks

### Phase 6: Knowledge System (v1.4.0)
- Persistent knowledge base that survives session boundaries and context compaction
- `/learn` command for extracting insights from conversations
- `/learn-on` / `/learn-off` for continuous learning mode
- `/knowledge` to view accumulated project intelligence
- Captures patterns, quirks, and decisions specific to each project

### Phase 7: Performance, Context Forking & Multi-Turn Awareness (v2.0.0)
- **Performance optimizations**: Pre-compiled regex (~10-15% faster), keyword caching, early exit, in-memory LRU cache
- **Context forking**: `/orchestrate` for clean subtask isolation, `/router-analytics` for dashboard generation
- **Multi-turn awareness**: Session state tracking, follow-up detection, context-aware confidence boost
- **Error recovery**: `/retry` command for model escalation when queries fail or need more depth
- **Plugin integration**: Optional integrations with official plugins (hookify, ralph-loop, code-review, feature-dev)
- **Analytics dashboard**: `/router-analytics` generates interactive HTML charts

---

## Coming Soon

### Phase 8: Hookify Integration (v2.1.0)

Dynamic routing rule creation via hookify:

- **Dual autonomy**: Both user and Claude can create rules
- **User-created rules**: `/hookify "Always route auth questions to deep"`
- **Claude-suggested rules**: Auto-suggest based on repeated escalation patterns
- **Learning-to-rules conversion**: Transform quirks into hookify rules

---

## Why Anthropic Should Care

1. **Validates their model lineup** - Proves Haiku/Sonnet/Opus tiering works in practice
2. **Real usage data** - What % of coding queries actually need Opus?
3. **Adoption driver** - longer working sessions before hitting rate limits
4. **Reference implementation** - Could inform native routing features
5. **Community showcase** - Open source tool built *for* their ecosystem

---

## What Makes People Use It

1. **Zero-config start** - Works immediately with sensible defaults
2. **Visible impact** - Use `/router-stats` to see prompts kept off Opus
3. **Trust through transparency** - Every routing decision is explained
4. **Easy override** - `/route <model>` to force any model when needed
5. **Learns from feedback** - Future: adjust routing based on user overrides
