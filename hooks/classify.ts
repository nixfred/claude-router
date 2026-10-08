// Claude Router v4 - prompt classifier.
//
// Pure functions, no `$`: the patterns are the v3.2 set (tuned on real use),
// ported from the old classify-prompt.py. The classifier only names the kind
// of work; policy.ts turns that into a model.

export type Route =
  | 'deep' // architecture, security, trade-offs: the top tier
  | 'standard' // ordinary coding work: Sonnet
  | 'lookup' // find / where-is / list-every: Haiku-grade sweeps
  | 'fast' // short factual questions, formatting, syntax
  | 'gpu' // bulk text work the local GPU should do
  | 'skip' // slash commands, empty continuations: leave the turn alone

export type Classification = {
  route: Route
  signals: string[]
  security: boolean
  followUp: boolean
}

const DEEP = [
  /\b(architect|architecture|design pattern|system design)\b/,
  /\bscalable?\b/,
  /\b(security|vulnerab|audit|penetration|exploit)\w*/,
  /\brefactor.{0,20}(codebase|project|entire)\b/,
  /\b(trade-?off|compare|pros? (and|&) cons?)\b/,
  /\b(analyze|evaluate|assess).{0,30}(option|approach|strateg)/,
  /\b(complex|intricate|sophisticated)\b/,
  /\boptimiz(e|ation).{0,20}(performance|speed|memory)\b/,
  /\b(multi-?phase|extraction|standalone repo|migration)\b/,
]

const SECURITY = /secur|vulnerab|audit|penetration|exploit/

const TOOL_INTENSIVE = [
  /\b(find|search|locate) (all|every|each)/,
  /\bacross (the )?(codebase|project|repo)/,
  /\b(all|every) (file|instance|usage|reference)/,
  /\bwhere is .+ (used|called|defined)/,
  /\b(scan|explore|traverse) (the )?(codebase|project)/,
  /\b(update|change|modify|rename|replace) .{0,20}(all|every|multiple) files?/,
  /\bglobal (search|replace|rename)/,
  /\brefactor.{0,30}(across|throughout|entire)/,
  /\brun (all |the )?(tests?|specs?|suite)/,
  /\bbuild (the )?(project|app)/,
  /\b(dependency|import) (tree|graph|analysis)/,
  /\bwhat (depends on|imports|uses)/,
]

const ORCHESTRATION = [
  /\b(step by step|sequentially|in order)\b/,
  /\bfor each (file|component|module)\b/,
  /\bacross the (entire|whole) (codebase|project)/,
  /\band (also|then)\b.{0,50}\band (also|then)\b/,
  /\b(multiple|several|many) (tasks?|steps?|operations?)\b/,
]

const FAST = [
  /^what (is|are|does) /,
  /^how (do|does|to) /,
  /^(show|list|get) .{0,30}$/,
  /\b(format|lint|prettify|beautify)\b/,
  /\bgit (status|log|diff|add|commit|push|pull)\b/,
  /\b(json|yaml|yml)\b.{0,20}$/,
  /\bregex\b/,
  /\bsyntax (for|of)\b/,
  /^(what|how).{0,50}\?$/,
]

const GPU = [
  /\b(summari[sz]e|summary of|tl;?dr|recap|condense|digest|gist of)\b/,
  /\b(extract|pull out|list|count|find) (every|all|the) .{0,30}(error|warning|name|url|date|field|fact|email|todo|number|ip|path|key)s?\b/,
  /\b(classify|categori[sz]e|tag|label|sort|group|rank) (these|this|each|every|the)\b/,
  /\b(draft|write|suggest) (a |the )?(commit (message|subject)|changelog( entry| line)?|release notes?|pr (title|description))\b/,
  /\b(reformat|convert|turn) (this|these|the|it) .{0,30}(to|into) (json|yaml|csv|markdown|a table|a list|bullets)\b/,
  /\bwhat does (this|the) (log|diff|transcript|output|error|stack ?trace) (say|show|mean)\b/,
  /\b(explain|interpret) (this|the|these) (log|output|error|stack ?trace|diff|message)s?\b/,
  /\b(rewrite|reword|rephrase|proofread|spell-?check|fix the (grammar|typos)|translate|simplify) (this|the|these|it|my)\b/,
  /\b(name|title) (this|these|the) (file|note|session|branch|project)s?\b/,
  /\bcompare (these|the) (two )?(files|texts|logs|outputs|versions)\b/,
]

const GPU_SUBJECT = [
  /\b(file|log|logs|diff|transcript|output|readme|doc|docs|notes|email|thread|article|page|changes|commits?|error|stack ?trace|config|csv|json|yaml|paragraph|text|message|this|these|below|following|attached|pasted)\b/,
  /[\w./~-]+\.(md|txt|log|json|ya?ml|csv|ts|py|sh|qml|html|conf|toml|ini)\b/,
]

const LOOKUP = [
  /\b(find|search|locate|grep) (for |all |every |the |where )/,
  /\bwhere (is|are|does|do) .{1,60}(defined|used|called|set|live|configured|declared)\b/,
  /\b(list|show) (all|every|the) .{0,30}(files?|functions?|callers?|usages?|references?|imports?|hooks?|skills?|agents?|todos?)\b/,
  /\bwhich (file|files|module|function) .{0,40}\b/,
  /\bwhat (depends on|imports|uses|calls)\b/,
]

const FOLLOW_UP = [
  /^(and |also |now |next |then |but )/,
  /^(what about|how about|can you also|could you also)/,
  /^(yes|no|ok|okay|sure|right|great|perfect|thanks|yep|yup|do it)\b/,
  /^(do that|go ahead|proceed|continue|keep going|carry on|ship it)/,
  /^(actually|wait|instead|rather)/,
]

/** A long paste is subject enough for the GPU tier on its own. */
export const GPU_MIN_PASTE = 800

const hits = (patterns: readonly RegExp[], text: string, cap = 4): string[] => {
  const found: string[] = []
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) {
      found.push(match[0])
      if (found.length >= cap) break
    }
  }
  return found
}

export const isFollowUp = (text: string): boolean => {
  const lower = text.trim().toLowerCase()
  return FOLLOW_UP.some(pattern => pattern.test(lower))
}

/**
 * Names the kind of work a prompt asks for.
 *
 * Deep needs 2+ deep signals, except security, where one is enough and is
 * never demoted. GPU work needs both a bulk-text verb and a subject (a file,
 * log, paste...) and only counts on hosts that have the `gpu` command.
 */
export const classify = (text: string, options: { gpu: boolean }): Classification => {
  const trimmed = text.trim()
  const followUp = isFollowUp(trimmed)
  if (trimmed === '' || trimmed.startsWith('/')) {
    return { route: 'skip', signals: [], security: false, followUp }
  }

  const lower = trimmed.toLowerCase()
  const deep = hits(DEEP, lower, 3)
  const security = deep.some(signal => SECURITY.test(signal))

  if (security || deep.length >= 2) {
    return { route: 'deep', signals: deep, security, followUp }
  }

  if (options.gpu) {
    const verbs = hits(GPU, lower, 3)
    const subject = trimmed.length >= GPU_MIN_PASTE || GPU_SUBJECT.some(p => p.test(lower))
    if (verbs.length > 0 && subject) {
      return { route: 'gpu', signals: verbs, security, followUp }
    }
  }

  const lookup = hits(LOOKUP, lower, 3)
  if (lookup.length > 0) {
    return { route: 'lookup', signals: lookup, security, followUp }
  }

  const tool = hits(TOOL_INTENSIVE, lower, 3)
  const orchestration = hits(ORCHESTRATION, lower, 3)
  if (tool.length > 0 || orchestration.length > 0 || deep.length === 1) {
    return { route: 'standard', signals: [...deep, ...tool, ...orchestration].slice(0, 4), security, followUp }
  }

  const fast = hits(FAST, lower, 3)
  if (fast.length > 0) {
    return { route: 'fast', signals: fast, security, followUp }
  }

  return { route: 'standard', signals: ['no strong signal'], security, followUp }
}
