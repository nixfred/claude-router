#!/usr/bin/env python3
"""
Claude Router - UserPromptSubmit Hook
Classifies prompts using hybrid approach:
1. Rule-based patterns (instant, free)
2. Haiku LLM fallback for low-confidence cases (~$0.001)

Part of claude-router: https://github.com/0xrdan/claude-router
"""
import json
import sys
import os
import re
import hashlib
from pathlib import Path
from datetime import datetime
# Cross-platform file locking
import platform
if platform.system() == "Windows":
    import msvcrt
    def lock_file(f, exclusive=False):
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK if exclusive else msvcrt.LK_LOCK, 1)
    def unlock_file(f):
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
else:
    import fcntl
    def lock_file(f, exclusive=False):
        fcntl.flock(f.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
    def unlock_file(f):
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)

# Confidence threshold for LLM fallback
CONFIDENCE_THRESHOLD = 0.7

# Stats file location
STATS_FILE = Path.home() / ".claude" / "router-stats.json"

# (v3.0) Dollar math removed by design. On a Max/Pro subscription, per-query
# dollar "savings" are fictional (flat fee regardless). CR now counts real,
# honest "kept off Opus" routing events instead,see log_routing_decision().

# Exception patterns - queries that will be handled by Opus despite classification
# (router meta-questions, slash commands handled in main())
# Pre-compiled for performance
EXCEPTION_PATTERNS = [
    re.compile(r'\brouter\b.*\b(stats?|config|setting|work)'),
    re.compile(r'\brouting\b'),
    re.compile(r'claude.?router'),
    re.compile(r'\bexception\b.*\b(track|detect)'),
    re.compile(r'\bclassif(y|ication)\b.*\b(prompt|query)'),
]

# Classification cache settings
CACHE_MAX_ENTRIES = 100
CACHE_TTL_DAYS = 30

# In-memory cache for extracted learning keywords (mtime-based invalidation)
_KEYWORDS_CACHE = {"keywords": None, "mtime": 0}

# In-memory classification cache (avoids file I/O for repeated queries in same session)
# LRU-style: limited to 50 entries, cleared on process restart
_MEMORY_CACHE = {}
_MEMORY_CACHE_MAX = 50

# Session state file for multi-turn context awareness
SESSION_STATE_FILE = Path.home() / ".claude" / "router-session.json"

# Follow-up query patterns (pre-compiled)
FOLLOW_UP_PATTERNS = [
    re.compile(r"^(and |also |now |next |then |but )"),
    re.compile(r"^(what about|how about|can you also|could you also)"),
    re.compile(r"^(yes|no|ok|okay|sure|right|great|perfect|thanks)[,.]?\s"),
    re.compile(r"^(do that|go ahead|proceed|continue|keep going)"),
    re.compile(r"^(actually|wait|instead|rather)"),
]

# Official plugins that claude-router can integrate with (optional)
SUPPORTED_PLUGINS = ["hookify", "ralph-loop", "code-review", "feature-dev"]


def detect_installed_plugins() -> dict:
    """Check which official plugins are installed."""
    detected = {}
    # Check common plugin locations
    plugin_locations = [
        Path.home() / ".claude" / "plugins",
        Path.home() / ".config" / "claude-code" / "plugins",
    ]
    for plugin in SUPPORTED_PLUGINS:
        detected[plugin] = False
        for loc in plugin_locations:
            if (loc / plugin).exists() or (loc / f"{plugin}.md").exists():
                detected[plugin] = True
                break
    return detected


def get_plugin_integrations() -> dict:
    """Get plugin integration states from knowledge state."""
    state = get_learning_state()
    return state.get("plugin_integrations", {
        plugin: {"enabled": False, "detected": False}
        for plugin in SUPPORTED_PLUGINS
    })


def is_plugin_enabled(plugin_name: str) -> bool:
    """Check if a plugin integration is both detected and enabled."""
    integrations = get_plugin_integrations()
    plugin = integrations.get(plugin_name, {})
    detected = detect_installed_plugins().get(plugin_name, False)
    enabled = plugin.get("enabled", False)
    return detected and enabled


def get_session_state() -> dict:
    """Get the current session state for multi-turn context awareness."""
    try:
        if SESSION_STATE_FILE.exists():
            with open(SESSION_STATE_FILE, 'r') as f:
                state = json.load(f)
                # Check if session is stale (older than 30 minutes)
                last_query = state.get("last_query_time", 0)
                if datetime.now().timestamp() - last_query > 1800:  # 30 min
                    return {"last_route": None, "conversation_depth": 0}
                return state
        return {"last_route": None, "conversation_depth": 0}
    except Exception:
        return {"last_route": None, "conversation_depth": 0}


def update_session_state(route: str, metadata: dict = None):
    """Update session state after a routing decision."""
    try:
        SESSION_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        state = get_session_state()
        state["last_route"] = route
        state["last_query_time"] = datetime.now().timestamp()
        state["conversation_depth"] = state.get("conversation_depth", 0) + 1
        state["last_metadata"] = metadata or {}
        with open(SESSION_STATE_FILE, 'w') as f:
            json.dump(state, f)
    except Exception:
        pass  # Don't fail on state errors


def is_follow_up_query(prompt: str) -> bool:
    """Check if the query appears to be a follow-up to a previous query."""
    prompt_lower = prompt.lower().strip()
    for pattern in FOLLOW_UP_PATTERNS:
        if pattern.match(prompt_lower):
            return True
    return False


def apply_context_boost(result: dict, session_state: dict, is_follow_up: bool) -> dict:
    """Apply confidence boost based on conversation context.

    If this is a follow-up to a deep/complex query, boost confidence toward same route.
    """
    if not is_follow_up:
        return result

    last_route = session_state.get("last_route")
    if not last_route:
        return result

    result["metadata"] = result.get("metadata", {})
    result["metadata"]["follow_up"] = True

    # If last route was deep/standard, boost current toward same
    # (follow-ups to complex queries are often also complex)
    if last_route in ("deep", "standard") and result["route"] == "fast":
        if result["confidence"] < 0.8:
            result["confidence"] = min(0.75, result["confidence"] + 0.15)
            result["metadata"]["context_boost"] = f"follow_up_to_{last_route}"
            # Don't change route, just boost confidence to potentially trigger LLM

    return result


def get_knowledge_dir() -> Path:
    """Get the knowledge directory path (project-local)."""
    # Try to find knowledge/ relative to this script's location
    script_dir = Path(__file__).parent.parent  # Go up from hooks/ to project root
    knowledge_dir = script_dir / "knowledge"
    if knowledge_dir.exists():
        return knowledge_dir
    # Fallback: check current working directory
    cwd_knowledge = Path.cwd() / "knowledge"
    if cwd_knowledge.exists():
        return cwd_knowledge
    return None

def generate_fingerprint(prompt: str) -> str:
    """Generate a fingerprint for a prompt to enable fuzzy cache matching."""
    # Normalize: lowercase, strip, collapse whitespace
    normalized = re.sub(r'\s+', ' ', prompt.lower().strip())

    # Extract key terms (remove common words)
    stop_words = {'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
                  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
                  'would', 'could', 'should', 'may', 'might', 'must', 'can',
                  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
                  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'me', 'my'}

    words = re.findall(r'\b[a-z]+\b', normalized)
    key_terms = [w for w in words if w not in stop_words and len(w) > 2]

    # Sort for consistency and take first 10 terms
    key_terms = sorted(set(key_terms))[:10]
    fingerprint_str = ' '.join(key_terms)

    # Generate hash
    return hashlib.md5(fingerprint_str.encode()).hexdigest()[:12]

def check_classification_cache(prompt: str) -> dict:
    """Check if a similar query exists in the cache.

    Checks in-memory cache first (fastest), then falls back to file cache.
    """
    fingerprint = generate_fingerprint(prompt)

    # Check in-memory cache first (no I/O)
    if fingerprint in _MEMORY_CACHE:
        result = _MEMORY_CACHE[fingerprint].copy()
        result["metadata"] = result.get("metadata", {})
        result["metadata"]["memory_cache_hit"] = True
        return result

    try:
        knowledge_dir = get_knowledge_dir()
        if not knowledge_dir:
            return None

        cache_file = knowledge_dir / "cache" / "classifications.md"
        if not cache_file.exists():
            return None

        with open(cache_file, 'r') as f:
            content = f.read()

        # Look for matching fingerprint section
        pattern = rf'## \[{fingerprint}\].*?(?=\n## \[|$)'
        match = re.search(pattern, content, re.DOTALL)

        if not match:
            return None

        entry = match.group(0)

        # Parse the cached entry
        route_match = re.search(r'\*\*Route:\*\* (\w+)', entry)
        conf_match = re.search(r'\*\*Confidence:\*\* ([\d.]+)', entry)

        if route_match and conf_match:
            result = {
                "route": route_match.group(1),
                "confidence": float(conf_match.group(1)),
                "signals": ["cache_hit"],
                "method": "cache",
                "metadata": {"cache_hit": True, "fingerprint": fingerprint}
            }
            # Populate memory cache for faster subsequent lookups
            _MEMORY_CACHE[fingerprint] = result.copy()
            return result

        return None
    except Exception:
        # Cache errors should never break classification
        return None

def write_classification_cache(prompt: str, result: dict):
    """Write a classification result to the cache.

    Writes to both in-memory cache (fast) and file cache (persistent).
    """
    global _MEMORY_CACHE

    fingerprint = generate_fingerprint(prompt)

    # Write to memory cache first (always, even if file cache fails)
    # Simple LRU: if at max, remove oldest entry
    if len(_MEMORY_CACHE) >= _MEMORY_CACHE_MAX:
        # Remove first (oldest) entry
        oldest_key = next(iter(_MEMORY_CACHE))
        del _MEMORY_CACHE[oldest_key]
    _MEMORY_CACHE[fingerprint] = {
        "route": result["route"],
        "confidence": result["confidence"],
        "signals": result.get("signals", []),
        "method": "cache",
    }

    try:
        knowledge_dir = get_knowledge_dir()
        if not knowledge_dir:
            return

        cache_file = knowledge_dir / "cache" / "classifications.md"
        if not cache_file.exists():
            return

        # fingerprint already generated above for memory cache
        today = datetime.now().strftime("%Y-%m-%d")

        # Read existing cache
        with open(cache_file, 'r') as f:
            content = f.read()

        # Check if this fingerprint already exists
        if f'## [{fingerprint}]' in content:
            # Update last used date and hit count
            pattern = rf'(## \[{fingerprint}\].*?\*\*Last used:\*\* )\d{{4}}-\d{{2}}-\d{{2}}'
            content = re.sub(pattern, rf'\g<1>{today}', content, flags=re.DOTALL)

            hit_pattern = rf'(## \[{fingerprint}\].*?\*\*Hit count:\*\* )(\d+)'
            hit_match = re.search(hit_pattern, content, re.DOTALL)
            if hit_match:
                new_count = int(hit_match.group(2)) + 1
                content = re.sub(hit_pattern, rf'\g<1>{new_count}', content, flags=re.DOTALL)

            with open(cache_file, 'w') as f:
                lock_file(f, exclusive=True)
                f.write(content)
                unlock_file(f)
            return

        # Create new entry
        # Truncate prompt for storage (first 50 chars + pattern type)
        prompt_preview = prompt[:50].replace('\n', ' ')
        if len(prompt) > 50:
            prompt_preview += "..."

        entry = f"""
## [{fingerprint}]
- **Query pattern:** "{prompt_preview}"
- **Route:** {result["route"]}
- **Confidence:** {result["confidence"]:.2f}
- **Last used:** {today}
- **Hit count:** 1
"""

        # Count existing entries
        entry_count = len(re.findall(r'^## \[', content, re.MULTILINE))

        # If at max, evict oldest entry (by last used date)
        if entry_count >= CACHE_MAX_ENTRIES:
            # Find all entries with their dates
            entries = re.findall(r'(## \[[^\]]+\].*?\*\*Last used:\*\* (\d{4}-\d{2}-\d{2}).*?)(?=\n## \[|$)',
                                content, re.DOTALL)
            if entries:
                # Sort by date and remove oldest
                entries_sorted = sorted(entries, key=lambda x: x[1])
                oldest_entry = entries_sorted[0][0]
                content = content.replace(oldest_entry, '')

        # Append new entry
        content = content.rstrip() + '\n' + entry

        # Update frontmatter entry count
        new_count = len(re.findall(r'^## \[', content, re.MULTILINE))
        content = re.sub(r'entry_count: \d+', f'entry_count: {new_count}', content)
        content = re.sub(r'last_updated: .*', f'last_updated: "{datetime.now().isoformat()}"', content)

        with open(cache_file, 'w') as f:
            lock_file(f, exclusive=True)
            f.write(content)
            unlock_file(f)

    except Exception:
        # Cache errors should never break classification
        pass

def get_learning_state() -> dict:
    """Get the current learning state."""
    try:
        knowledge_dir = get_knowledge_dir()
        if not knowledge_dir:
            return {}
        state_file = knowledge_dir / "state.json"
        if state_file.exists():
            with open(state_file, 'r') as f:
                return json.load(f)
        return {}
    except Exception:
        return {}

def extract_learning_keywords() -> dict:
    """Extract keywords from learnings files to inform routing.

    Uses mtime-based caching to avoid re-parsing files on every call.
    """
    global _KEYWORDS_CACHE

    try:
        knowledge_dir = get_knowledge_dir()
        if not knowledge_dir:
            return {"deep_keywords": set(), "fast_keywords": set()}

        # Check file modification times for cache invalidation
        quirks_file = knowledge_dir / "learnings" / "quirks.md"
        patterns_file = knowledge_dir / "learnings" / "patterns.md"

        quirks_mtime = quirks_file.stat().st_mtime if quirks_file.exists() else 0
        patterns_mtime = patterns_file.stat().st_mtime if patterns_file.exists() else 0
        current_mtime = max(quirks_mtime, patterns_mtime)

        # Return cached result if files haven't changed
        if _KEYWORDS_CACHE["keywords"] is not None and _KEYWORDS_CACHE["mtime"] >= current_mtime:
            return _KEYWORDS_CACHE["keywords"]

        deep_keywords = set()
        fast_keywords = set()

        # Parse quirks.md for complexity indicators
        if quirks_file.exists():
            with open(quirks_file, 'r') as f:
                content = f.read().lower()
            # Extract keywords from quirk entries that suggest complexity
            for match in re.findall(r'## quirk:.*?(?=## |$)', content, re.DOTALL):
                if any(word in match for word in ['complex', 'tricky', 'careful', 'unusual', 'non-standard']):
                    # Extract the topic area (location field)
                    loc_match = re.search(r'\*\*location:\*\*\s*([^\n]+)', match)
                    if loc_match:
                        # Extract meaningful words from location
                        words = re.findall(r'\b[a-z]{3,}\b', loc_match.group(1).lower())
                        deep_keywords.update(words)

        # Parse patterns.md for simple patterns
        if patterns_file.exists():
            with open(patterns_file, 'r') as f:
                content = f.read().lower()
            for match in re.findall(r'## pattern:.*?(?=## |$)', content, re.DOTALL):
                if any(word in match for word in ['simple', 'straightforward', 'always', 'standard']):
                    # Extract topic keywords
                    insight_match = re.search(r'\*\*insight:\*\*\s*([^\n]+)', match)
                    if insight_match:
                        words = re.findall(r'\b[a-z]{3,}\b', insight_match.group(1).lower())
                        fast_keywords.update(words)

        result = {"deep_keywords": deep_keywords, "fast_keywords": fast_keywords}

        # Cache the result with current mtime
        _KEYWORDS_CACHE["keywords"] = result
        _KEYWORDS_CACHE["mtime"] = current_mtime

        return result
    except Exception:
        return {"deep_keywords": set(), "fast_keywords": set()}

def apply_learned_adjustments(prompt: str, result: dict) -> dict:
    """Apply learned knowledge to adjust routing confidence (conservative)."""
    try:
        state = get_learning_state()

        # Check if informed routing is enabled
        if not state.get("informed_routing", False):
            return result

        boost = state.get("informed_routing_boost", 0.1)
        keywords = extract_learning_keywords()

        prompt_lower = prompt.lower()
        deep_matches = sum(1 for kw in keywords["deep_keywords"] if kw in prompt_lower)
        fast_matches = sum(1 for kw in keywords["fast_keywords"] if kw in prompt_lower)

        # Only adjust if we have meaningful signal (2+ keyword matches)
        # Conservative: require more evidence for expensive routes
        if deep_matches >= 2 and result["route"] != "deep":
            # Boost toward deep, but cap at 0.1 increase
            result["confidence"] = min(1.0, result["confidence"] + boost)
            if result["confidence"] >= 0.8:
                result["route"] = "deep"
                result["metadata"] = result.get("metadata", {})
                result["metadata"]["learned_boost"] = "deep"

        elif fast_matches >= 2 and result["route"] == "deep":
            # If learned patterns suggest simple, consider downgrading
            # But be conservative - don't downgrade high-confidence deep
            if result["confidence"] < 0.8:
                result["route"] = "standard"
                result["metadata"] = result.get("metadata", {})
                result["metadata"]["learned_boost"] = "downgrade"

        return result
    except Exception:
        return result

def is_exception_query(prompt: str) -> tuple[bool, str]:
    """Check if query matches exception patterns that bypass routing."""
    prompt_lower = prompt.lower()
    for pattern in EXCEPTION_PATTERNS:
        if pattern.search(prompt_lower):  # Pre-compiled patterns use .search()
            return True, "router_meta"
    return False, None

# Classification patterns - Pre-compiled for performance
PATTERNS = {
    "fast": [
        # Simple questions
        re.compile(r"^what (is|are|does) "),
        re.compile(r"^how (do|does|to) "),
        re.compile(r"^(show|list|get) .{0,30}$"),
        # Formatting
        re.compile(r"\b(format|lint|prettify|beautify)\b"),
        # Git simple ops
        re.compile(r"\bgit (status|log|diff|add|commit|push|pull)\b"),
        # JSON/YAML
        re.compile(r"\b(json|yaml|yml)\b.{0,20}$"),
        # Regex
        re.compile(r"\bregex\b"),
        # Syntax questions
        re.compile(r"\bsyntax (for|of)\b"),
        re.compile(r"^(what|how).{0,50}\?$"),
    ],
    "deep": [
        # Architecture
        re.compile(r"\b(architect|architecture|design pattern|system design)\b"),
        re.compile(r"\bscalable?\b"),
        # Security
        re.compile(r"\b(security|vulnerab|audit|penetration|exploit)\b"),
        # (v3.0) Removed the over-eager "(across|multiple|all) files" deep pattern.
        # Mechanical multi-file scope is exploration, not deep reasoning,it is
        # handled by tool_intensive -> Sonnet, keeping grunt work OFF Opus.
        re.compile(r"\brefactor.{0,20}(codebase|project|entire)\b"),
        # Trade-offs
        re.compile(r"\b(trade-?off|compare|pros? (and|&) cons?)\b"),
        re.compile(r"\b(analyze|evaluate|assess).{0,30}(option|approach|strateg)\b"),
        # Complex
        re.compile(r"\b(complex|intricate|sophisticated)\b"),
        re.compile(r"\boptimiz(e|ation).{0,20}(performance|speed|memory)\b"),
        # Planning
        re.compile(r"\b(multi-?phase|extraction|standalone repo|migration)\b"),
    ],
    "tool_intensive": [
        # Codebase exploration
        re.compile(r"\b(find|search|locate) (all|every|each)"),
        re.compile(r"\bacross (the )?(codebase|project|repo)"),
        re.compile(r"\b(all|every) (file|instance|usage|reference)"),
        re.compile(r"\bwhere is .+ (used|called|defined)"),
        re.compile(r"\b(scan|explore|traverse) (the )?(codebase|project)"),
        # Multi-file modifications
        re.compile(r"\b(update|change|modify|rename|replace) .{0,20}(all|every|multiple) files?"),
        re.compile(r"\bglobal (search|replace|rename)"),
        re.compile(r"\brefactor.{0,30}(across|throughout|entire)"),
        # Build/test execution
        re.compile(r"\brun (all |the )?(tests?|specs?|suite)"),
        re.compile(r"\bbuild (the )?(project|app)"),
        re.compile(r"\bnpm (install|build|run)|yarn (install|build)|pip install"),
        # Dependency analysis
        re.compile(r"\b(dependency|import) (tree|graph|analysis)"),
        re.compile(r"\bwhat (depends on|imports|uses)"),
    ],
    "orchestration": [
        # Multi-step workflows
        re.compile(r"\b(step by step|sequentially|in order)\b"),
        re.compile(r"\bfor each (file|component|module)\b"),
        re.compile(r"\bacross the (entire|whole) (codebase|project)"),
        # Explicit multi-task
        re.compile(r"\band (also|then)\b.{0,50}\band (also|then)\b"),
        re.compile(r"\b(multiple|several|many) (tasks?|steps?|operations?)\b"),
    ],
}


def get_api_key():
    """Get API key from environment or common locations."""
    # Try environment first
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        return api_key

    # Try common .env locations
    search_paths = [
        Path.cwd() / ".env",                           # Current directory
        Path.cwd() / "server" / ".env",                # Server subdirectory
        Path.home() / ".anthropic" / "api_key",        # Anthropic config
        Path.home() / ".config" / "anthropic" / "key", # XDG config
    ]

    for env_path in search_paths:
        try:
            with open(env_path, "r") as f:
                content = f.read()
                # Handle both KEY=value and plain value formats
                for line in content.split("\n"):
                    if line.startswith("ANTHROPIC_API_KEY="):
                        return line.strip().split("=", 1)[1].strip('"\'')
                # If file is just the key (no assignment)
                if content.strip().startswith("sk-ant-"):
                    return content.strip()
        except (FileNotFoundError, PermissionError):
            continue

    return None


# (v3.0) calculate_cost() removed,CR no longer estimates dollars.


def _default_stats() -> dict:
    """Fresh v3.0 stats document. No dollar math,counts 'kept off Opus' events."""
    return {
        "version": "3.0",
        "total_queries": 0,
        "routes": {"fast": 0, "standard": 0, "deep": 0, "orchestrated": 0},
        "kept_off_opus_all_time": 0,
        "recent_events": [],   # rolling [{ts, route, kept}] trimmed to last 5h
        "sessions": [],        # per-day, last 30 days
        "last_updated": None,
    }


def log_routing_decision(route: str, confidence: float, method: str, signals: list, metadata: dict = None):
    """Record a routing decision as a COUNT,no dollar math, no fiction.

    A 'kept off Opus' event = routed to fast (Haiku) or standard (Sonnet) AND
    actually delegated. Trivial prompts flagged no_delegate are NOT counted,
    because the Opus hand-off tax cancels the gain (verified design choice).
    The number is a count of routing decisions; the user validates it against
    their own observed usage burn. Honest by construction.
    """
    try:
        STATS_FILE.parent.mkdir(parents=True, exist_ok=True)

        stats = _default_stats()
        if STATS_FILE.exists():
            try:
                with open(STATS_FILE, "r") as f:
                    lock_file(f, exclusive=False)
                    stats = json.load(f)
                    unlock_file(f)
            except (json.JSONDecodeError, IOError):
                pass

        # Migrate any pre-3.0 schema forward; legacy dollar fields are dropped.
        if stats.get("version") != "3.0":
            stats = _default_stats()
        for k, v in _default_stats().items():
            stats.setdefault(k, v)
        stats["routes"].setdefault("orchestrated", 0)

        metadata = metadata or {}
        now = datetime.now()
        ts = now.timestamp()
        today = now.strftime("%Y-%m-%d")

        # "kept off Opus": cheaper tier AND actually delegated
        kept = route in ("fast", "standard") and not metadata.get("no_delegate")

        stats["total_queries"] += 1
        stats["routes"][route] = stats["routes"].get(route, 0) + 1
        if kept:
            stats["kept_off_opus_all_time"] += 1

        # Rolling 5-hour window (trim to last 5h, bound length)
        events = stats.get("recent_events", [])
        events.append({"ts": ts, "route": route, "kept": kept})
        cutoff = ts - 5 * 3600
        stats["recent_events"] = [e for e in events if e.get("ts", 0) >= cutoff][-1000:]

        # Per-day session (last 30 days)
        session = next((s for s in stats["sessions"] if s.get("date") == today), None)
        if session is None:
            session = {"date": today, "queries": 0, "kept_off_opus": 0,
                       "routes": {"fast": 0, "standard": 0, "deep": 0, "orchestrated": 0}}
            stats["sessions"].append(session)
        session["queries"] += 1
        session["routes"][route] = session["routes"].get(route, 0) + 1
        if kept:
            session["kept_off_opus"] += 1
        stats["sessions"] = sorted(stats["sessions"], key=lambda s: s.get("date", ""), reverse=True)[:30]

        stats["last_updated"] = now.isoformat()

        with open(STATS_FILE, "w") as f:
            lock_file(f, exclusive=True)
            json.dump(stats, f, indent=2)
            unlock_file(f)

    except Exception:
        # Never break the hook over stats.
        pass


def classify_by_rules(prompt: str) -> dict:
    """
    Classify prompt using pre-compiled regex patterns.
    Returns route, confidence, signals, and optional metadata.

    Priority order:
    1. deep patterns (architecture, security, complex analysis)
    2. tool_intensive patterns (route to standard, or deep if combined)
    3. orchestration patterns (route to deep with orchestration flag)
    4. fast patterns (simple queries)

    Optimized with early exit when sufficient signals are found.
    """
    prompt_lower = prompt.lower()
    deep_signals = []
    tool_signals = []
    orch_signals = []

    # Check for deep patterns first (highest priority)
    # Pre-compiled patterns use .search() method directly
    for pattern in PATTERNS["deep"]:
        match = pattern.search(prompt_lower)
        if match:
            deep_signals.append(match.group(0))
            # Early exit: if we have 3+ deep signals, no need to check more
            if len(deep_signals) >= 3:
                break

    # Check for tool-intensive patterns
    for pattern in PATTERNS.get("tool_intensive", []):
        match = pattern.search(prompt_lower)
        if match:
            tool_signals.append(match.group(0))
            # Early exit: if we have deep + tool signals, we have enough
            if deep_signals and len(tool_signals) >= 2:
                break

    # Check for orchestration patterns
    for pattern in PATTERNS.get("orchestration", []):
        match = pattern.search(prompt_lower)
        if match:
            orch_signals.append(match.group(0))
            # Early exit: if we have deep + orchestration, we have enough
            if deep_signals:
                break

    # Decision matrix (v3.0,conservative about Opus to protect the 5h budget):
    # Only escalate to deep/Opus when there is STRONG reasoning signal (2+ deep
    # hits). One incidental deep keyword next to tool/orchestration signals is
    # almost always exploration or mechanical multi-file work -> route to Sonnet.
    if len(deep_signals) >= 2 and (tool_signals or orch_signals):
        # Complex task needing orchestration - route to deep with orchestration flag
        combined = deep_signals + tool_signals + orch_signals
        return {
            "route": "deep",
            "confidence": 0.95,
            "signals": combined[:4],
            "method": "rules",
            "metadata": {"orchestration": True, "tool_intensive": bool(tool_signals)}
        }

    if len(deep_signals) >= 2:
        return {"route": "deep", "confidence": 0.9, "signals": deep_signals[:3], "method": "rules"}

    if deep_signals:  # One deep signal
        return {"route": "deep", "confidence": 0.7, "signals": deep_signals, "method": "rules"}

    # Tool-intensive but not architecturally complex - route to standard
    if tool_signals:
        if len(tool_signals) >= 2:
            return {
                "route": "standard",
                "confidence": 0.85,
                "signals": tool_signals[:3],
                "method": "rules",
                "metadata": {"tool_intensive": True}
            }
        return {
            "route": "standard",
            "confidence": 0.7,
            "signals": tool_signals,
            "method": "rules",
            "metadata": {"tool_intensive": True}
        }

    # Orchestration alone (multi-step workflow) - route to standard
    if orch_signals:
        return {
            "route": "standard",
            "confidence": 0.75,
            "signals": orch_signals[:3],
            "method": "rules",
            "metadata": {"orchestration": True}
        }

    # Check for fast patterns
    fast_signals = []
    for pattern in PATTERNS["fast"]:
        match = pattern.search(prompt_lower)
        if match:
            fast_signals.append(match.group(0))
            if len(fast_signals) >= 2:
                return {"route": "fast", "confidence": 0.9, "signals": fast_signals[:3], "method": "rules"}

    if fast_signals:  # One fast signal
        return {"route": "fast", "confidence": 0.7, "signals": fast_signals, "method": "rules"}

    # Default to STANDARD (Sonnet) when uncertain. Sonnet is the capable
    # workhorse that keeps work off Opus without risking a Haiku flub that
    # forces an Opus retry (which would burn the 5-hour budget anyway).
    # This fixes the old default-to-fast bias (96% of traffic fell to Haiku).
    return {"route": "standard", "confidence": 0.5, "signals": ["no strong patterns"], "method": "rules"}


def classify_by_llm(prompt: str, api_key: str) -> dict:
    """
    Classify prompt using Haiku LLM.
    Used as fallback for low-confidence rule-based results.
    """
    try:
        from anthropic import Anthropic
    except ImportError:
        return None

    client = Anthropic(api_key=api_key)

    classification_prompt = f"""Classify this coding query into exactly one route. Return ONLY valid JSON, no other text.

Query: "{prompt}"

Routes:
- "fast": Simple factual questions, syntax lookups, formatting, git status, JSON/YAML manipulation
- "standard": Bug fixes, feature implementation, code review, refactoring, test writing, OR tool-intensive tasks (codebase search, running tests, multi-file edits)
- "deep": Architecture decisions, system design, security audits, multi-file refactors, trade-off analysis, complex debugging, OR orchestration tasks (multi-step workflows)

Tool-intensity indicators (favor "standard" or "deep" over "fast"):
- Searching/scanning entire codebase
- Modifying multiple files
- Running tests or builds
- Dependency analysis
- Large-scale refactoring

Return JSON only:
{{"route": "fast|standard|deep", "confidence": 0.0-1.0, "signals": ["signal1", "signal2"], "tool_intensive": true|false}}"""

    try:
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=100,
            messages=[{"role": "user", "content": classification_prompt}]
        )

        response_text = message.content[0].text.strip()

        # Handle potential markdown code blocks
        if "```" in response_text:
            response_text = response_text.split("```")[1]
            if response_text.startswith("json"):
                response_text = response_text[4:].strip()

        result = json.loads(response_text)
        result["method"] = "haiku-llm"
        return result

    except Exception as e:
        # Log error but don't fail
        print(f"LLM classification error: {e}", file=sys.stderr)
        return None


def classify_hybrid(prompt: str) -> dict:
    """
    Hybrid classification: cache first, then rules, then LLM fallback,
    then learned adjustments, then context boost.
    """
    # Step 0: Check cache for similar query (instant)
    cached = check_classification_cache(prompt)
    if cached:
        return cached

    # Step 1: Rule-based classification (instant, free)
    result = classify_by_rules(prompt)

    # Step 2: Check for multi-turn context (follow-up queries)
    session_state = get_session_state()
    follow_up = is_follow_up_query(prompt)
    if follow_up:
        result = apply_context_boost(result, session_state, follow_up)

    # Step 3: If low confidence and API key available, use LLM
    if result["confidence"] < CONFIDENCE_THRESHOLD:
        api_key = get_api_key()
        if api_key:
            llm_result = classify_by_llm(prompt, api_key)
            if llm_result:
                # Apply learned adjustments (opt-in, conservative)
                llm_result = apply_learned_adjustments(prompt, llm_result)
                # Cache LLM result (more expensive to compute)
                write_classification_cache(prompt, llm_result)
                return llm_result

    # Step 4: Apply learned adjustments (opt-in, conservative)
    result = apply_learned_adjustments(prompt, result)

    # Step 5: Cache the result for future queries
    write_classification_cache(prompt, result)

    return result


def main():
    """Main hook handler."""
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)

    prompt = input_data.get("prompt", "")

    if not prompt or len(prompt) < 10:
        sys.exit(0)

    # Handle slash commands
    stripped = prompt.strip().lower()
    if stripped.startswith("/"):
        # Special handling for /route with explicit model
        if stripped.startswith("/route "):
            route_args = prompt.strip()[7:].strip()  # Get everything after "/route "
            first_word = route_args.split()[0].lower() if route_args.split() else ""

            # Check for explicit model specification
            model_map = {
                "opus": ("deep", "deep-executor", "Opus"),
                "deep": ("deep", "deep-executor", "Opus"),
                "sonnet": ("standard", "standard-executor", "Sonnet"),
                "standard": ("standard", "standard-executor", "Sonnet"),
                "haiku": ("fast", "fast-executor", "Haiku"),
                "fast": ("fast", "fast-executor", "Haiku"),
            }

            if first_word in model_map:
                route, subagent, model = model_map[first_word]
                query = " ".join(route_args.split()[1:])  # Rest after model

                context = f"""[Claude Router] EXPLICIT MODEL OVERRIDE
Route: {route} | Model: {model} | Source: User specified "{first_word}"

USER EXPLICITLY REQUESTED {model.upper()}. This is NOT a suggestion - it is a COMMAND.

CRITICAL: Spawn "{subagent}" with the query below. DO NOT reclassify. DO NOT override.

Query: {query}

Example:
Task(subagent_type="{subagent}", prompt="{query}", description="Route to {model}")"""

                output = {
                    "hookSpecificOutput": {
                        "hookEventName": "UserPromptSubmit",
                        "additionalContext": context
                    }
                }
                print(json.dumps(output))
                sys.exit(0)

        # Special handling for /retry with explicit model
        if stripped.startswith("/retry "):
            retry_args = prompt.strip()[7:].strip().lower()  # Get everything after "/retry "

            retry_model_map = {
                "opus": ("deep", "deep-executor", "Opus"),
                "deep": ("deep", "deep-executor", "Opus"),
                "sonnet": ("standard", "standard-executor", "Sonnet"),
                "standard": ("standard", "standard-executor", "Sonnet"),
            }

            if retry_args in retry_model_map:
                route, subagent, model = retry_model_map[retry_args]

                context = f"""[Claude Router] EXPLICIT RETRY OVERRIDE
Route: {route} | Model: {model} | Source: User specified "/retry {retry_args}"

USER EXPLICITLY REQUESTED {model.upper()} FOR RETRY. This is NOT a suggestion - it is a COMMAND.

CRITICAL: Read the last query from session state (~/.claude/router-session.json) and spawn "{subagent}".
DO NOT auto-escalate. DO NOT choose a different model. Use {model.upper()}.

Example:
Task(subagent_type="{subagent}", prompt="<last query from session>", description="Retry with {model}")"""

                output = {
                    "hookSpecificOutput": {
                        "hookEventName": "UserPromptSubmit",
                        "additionalContext": context
                    }
                }
                print(json.dumps(output))
                sys.exit(0)

        # Skip other slash commands (let skills handle them)
        sys.exit(0)

    # Check for exception queries (router meta-questions)
    is_exception, exception_type = is_exception_query(prompt)

    # Classify using hybrid approach
    result = classify_hybrid(prompt)

    route = result["route"]
    confidence = result["confidence"]
    signals = result["signals"]
    method = result.get("method", "rules")

    # Metadata (tool-intensive / context); track router meta-questions
    metadata = result.get("metadata", {})
    if is_exception:
        metadata["exception_type"] = exception_type

    # ── Delegation policy (v3.0) ──────────────────────────────────────────────
    # CR delegates ONLY the real downgrades,work that moves OFF Opus:
    #     standard          -> Sonnet subagent
    #     substantive fast  -> Haiku  subagent
    # It deliberately does NOT delegate (lets the main loop handle inline):
    #     deep         -> main loop is already Opus; an Opus subagent would just
    #                     add hand-off tax for no model change.
    #     trivial fast -> short, non-tool prompts: the ~300-token Opus hand-off
    #                     tax cancels the gain (confirmed). Answer inline instead.
    # Non-delegated prompts are flagged no_delegate so they are NOT counted as a
    # "kept off Opus" event. The count stays honest.
    prompt_len = len(prompt.strip())
    trivial_fast = (route == "fast" and prompt_len < 60 and not metadata.get("tool_intensive"))
    if route == "deep" or trivial_fast:
        metadata["no_delegate"] = True

    log_routing_decision(route, confidence, method, signals, metadata)
    update_session_state(route, metadata)

    # Nothing to delegate -> stay silent, let the main session handle it.
    if metadata.get("no_delegate"):
        sys.exit(0)

    # Map the downgrade route to its subagent + model (BARE names,the marketplace
    # plugin is deprecated upstream; agents register as plain user agents).
    subagent = {"fast": "fast-executor", "standard": "standard-executor"}[route]
    model = {"fast": "Haiku", "standard": "Sonnet"}[route]

    signals_str = ", ".join(signals)
    flags = ""
    if metadata.get("tool_intensive"):
        flags += " | tool-intensive"
    if metadata.get("follow_up"):
        flags += " | follow-up"

    # Clear, reasoned instruction (Opus 4.x follows this better than the old
    # "CRITICAL: YOU MUST" directive, which modern models treat with suspicion).
    context = f"""[Claude Router] Keep this off Opus to preserve the 5-hour budget. Route it to {model}.
Classified: {route} ({confidence:.0%}, {method}){flags} | signals: {signals_str}

Spawn the {subagent} subagent with the Task tool and answer from its result; do not handle it directly on Opus.

Task(subagent_type="{subagent}", prompt="<the user's full request>", description="Route to {model}")"""

    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context
        }
    }
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    main()
