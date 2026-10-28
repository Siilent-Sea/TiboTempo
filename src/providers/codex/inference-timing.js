// Diagnostic timing only. Qualified rows may feed the separately reviewed
// daily performance projection, never accounting or transport authority.
import { createHmac } from 'node:crypto';

export const METHOD = 2;
// Parsing semantics can advance without changing stable timing HMAC identities.
// v22 admits forked sources by per-turn session-identity provenance instead of
// discarding the whole source; the version bump forces the reviewed replay so a
// previously blocked fork is measured rather than left permanently empty.
export const INFERENCE_TIMING_PARSER_VERSION = 22;
export const MAX_STATE_BYTES = 128 * 1024;
const MAX_TIER_EVENTS = 512;
const MAX_CONTEXT_HISTORY = 512;
const MODELS = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex',
  'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.2', 'auto-review']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
// Response items dominate source bytes; avoid scanning each payload for every
// other event name before finding its top-level type.
const NEEDLES = ['response_item', 'token_count', 'session_meta', 'turn_context', 'item_completed',
  'token_usage_record', 'task_started', 'task_complete', 'turn_aborted', 'compacted',
  'thread_settings_applied'].map(x => Buffer.from(x));
const TIER_NEEDLE = Buffer.from('thread_settings_applied');
const MODES = new Set(['standard', 'fast', 'ultrafast', 'unknown', 'other']);
const MODE_SOURCES = new Set([
  'rollout_thread_settings', 'turn_context_service_tier', 'unobserved',
]);
export const digest = (key, domain, value) => createHmac('sha256', key)
  .update(`tibotattle-timing-experiment/${METHOD}/${domain}\0`).update(value).digest('hex');
const integer = x => Number.isSafeInteger(x) && x >= 0;
const stamp = x => typeof x === 'string' ? Date.parse(x) : NaN;
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const TIER_RAW = /^[A-Za-z0-9._:-]{1,64}$/u;
const HASH = /^[0-9a-f]{64}$/u;
// Fork provenance is decided per turn from the only evidence a single rollout
// can carry: the owner session identity written on a record. An inline fork
// replays the parent's whole history into its own file, so a record that names
// the parent session is copied evidence, and a record that names this file's
// own session cannot be — the parent's history predates that identity.
const TURN_PROVENANCE = new Set(['own', 'inherited', 'conflict']);
// Metadata timestamps can have small write-time skew; this tolerance applies
// only to the nested header, never to admitting a turn before the fork.
const FORK_HEADER_TIME_TOLERANCE = 2000;

function modeFromRawTier(rawTier, source = 'rollout_thread_settings') {
  if (rawTier === null) return { mode: 'unknown', modeSource: 'unobserved', invalid: false };
  if (typeof rawTier !== 'string' || !TIER_RAW.test(rawTier)) {
    return { mode: 'unknown', modeSource: 'unobserved', invalid: true };
  }
  const normalized = rawTier.toLowerCase();
  return {
    mode: ['priority', 'fast'].includes(normalized) ? 'fast'
      : ['default', 'standard'].includes(normalized) ? 'standard'
        : normalized === 'ultrafast' ? 'ultrafast' : 'other',
    modeSource: source,
    invalid: false,
  };
}

function defaultContextMode() {
  return { modeOverride: false, mode: 'unknown', modeSource: 'unobserved', modeInvalid: false };
}

function contextModeFromRawTier(rawTier) {
  const normalized = modeFromRawTier(rawTier, 'turn_context_service_tier');
  return {
    modeOverride: true,
    mode: normalized.mode,
    modeSource: normalized.modeSource,
    modeInvalid: normalized.invalid,
  };
}

function savedContextMode(entry) {
  const hasMode = Object.hasOwn(entry, 'modeOverride')
    || Object.hasOwn(entry, 'mode')
    || Object.hasOwn(entry, 'modeSource')
    || Object.hasOwn(entry, 'modeInvalid');
  if (!hasMode) return defaultContextMode();
  const modeOverride = entry.modeOverride;
  const mode = entry.mode;
  const modeSource = entry.modeSource;
  const modeInvalid = entry.modeInvalid;
  if (typeof modeOverride !== 'boolean' || !MODES.has(mode)
      || !MODE_SOURCES.has(modeSource) || typeof modeInvalid !== 'boolean'
      || (modeSource === 'unobserved' && mode !== 'unknown')
      || (modeInvalid && (mode !== 'unknown' || modeSource !== 'unobserved'))) {
    return null;
  }
  return { modeOverride, mode, modeSource, modeInvalid };
}

function defaultTierState() {
  return { timeline: [], lastAt: null, invalid: false };
}

function normalizeSavedContextHistory(value) {
  if (value === undefined) return { entries: {}, invalid: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { entries: {}, invalid: true };
  }
  const wrapped = Object.hasOwn(value, 'entries');
  const rawEntries = wrapped ? value.entries : value;
  if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)
      || (wrapped && Object.hasOwn(value, 'invalid') && typeof value.invalid !== 'boolean')) {
    return { entries: {}, invalid: true };
  }
  const entries = {};
  for (const [key, entry] of Object.entries(rawEntries)) {
    const mode = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? savedContextMode(entry) : null;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !integer(entry.at)
        || (entry.model !== null && !MODELS.has(entry.model))
        || (entry.effort !== null && !EFFORTS.has(entry.effort))
        || typeof entry.invalid !== 'boolean' || mode === null) {
      return { entries: {}, invalid: true };
    }
    entries[key] = {
      at: entry.at,
      model: entry.model,
      effort: entry.effort,
      invalid: entry.invalid,
      ...mode,
    };
  }
  if (Object.keys(entries).length > MAX_CONTEXT_HISTORY) {
    return { entries: {}, invalid: true };
  }
  return {
    entries,
    invalid: wrapped && value.invalid === true,
  };
}

function normalizeSavedTierState(value) {
  if (value === undefined) return defaultTierState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { timeline: [], lastAt: null, invalid: true };
  }
  if (!Object.hasOwn(value, 'timeline') || !Array.isArray(value.timeline)
      || (Object.hasOwn(value, 'invalid') && typeof value.invalid !== 'boolean')) {
    return { timeline: [], lastAt: null, invalid: true };
  }
  const timeline = value.timeline;
  if (timeline.length > MAX_TIER_EVENTS) return { timeline: [], lastAt: null, invalid: true };
  let previous = null;
  const clean = [];
  for (const entry of timeline) {
    const validModeSource = entry?.source === 'unobserved'
      ? entry?.mode === 'unknown'
      : entry?.mode !== 'unknown';
    if (!entry || typeof entry !== 'object' || !integer(entry.at)
        || !MODES.has(entry.mode)
        || !['rollout_thread_settings', 'unobserved'].includes(entry.source)
        || !validModeSource
        || (Object.hasOwn(entry, 'own') && typeof entry.own !== 'boolean')
        || (previous !== null && entry.at < previous)) {
      return { timeline: [], lastAt: null, invalid: true };
    }
    previous = entry.at;
    // A checkpoint written before fork provenance existed cannot prove that a
    // declaration belonged to this session. Keep it as ordering evidence only.
    clean.push({ at: entry.at, mode: entry.mode, source: entry.source, own: entry.own === true });
  }
  const hasLastAt = Object.hasOwn(value, 'lastAt');
  if (!hasLastAt) {
    return { timeline: [], lastAt: null, invalid: true };
  }
  if (timeline.length > 0 && (!hasLastAt || value.lastAt === null)) {
    return { timeline: [], lastAt: null, invalid: true };
  }
  if (timeline.length === 0 && value.lastAt !== null && value.lastAt !== undefined) {
    return { timeline: [], lastAt: null, invalid: true };
  }
  if (hasLastAt && value.lastAt !== null && value.lastAt !== undefined && !integer(value.lastAt)) {
    return { timeline: [], lastAt: null, invalid: true };
  }
  const lastAt = value.lastAt === null || value.lastAt === undefined
    ? previous
    : value.lastAt;
  if (lastAt !== null && previous !== null && lastAt !== previous) {
    return { timeline: [], lastAt: null, invalid: true };
  }
  return {
    timeline: clean,
    lastAt,
    invalid: value.invalid === true,
  };
}

function modeAt(tier, at, ownOnly = false) {
  if (tier.invalid || !integer(at) || (tier.lastAt !== null && tier.lastAt > at)) {
    return { mode: 'unknown', source: 'unobserved', invalid: true };
  }
  let result = null;
  for (const entry of tier.timeline) {
    if (entry.at > at) break;
    // A fork's copied declarations are inherited or unproven evidence. They
    // order the timeline but can never label the child's own turn.
    if (ownOnly && entry.own !== true) continue;
    result = entry;
  }
  return result === null
    ? { mode: 'unknown', source: 'unobserved', invalid: false }
    : { mode: result.mode, source: result.source, invalid: false };
}

function markModeEvidenceInvalid(state) {
  state.tier.invalid = true;
  for (const turn of Object.values(state.turns)) turn.modeInvalid = true;
}

function modeForTurn(turn) {
  if (turn.modeInvalid) return { speed_mode: 'unknown', speed_mode_source: 'unobserved' };
  if (turn.modeMixed) return { speed_mode: 'mixed', speed_mode_source: 'mixed' };
  return { speed_mode: turn.mode, speed_mode_source: turn.modeSource };
}

export function createParser(key, saved, onTurn, { toolFree = false } = {}) {
  const s = saved ?? { own: null, blocked: false, model: null, effort: null, turns: {},
    legacyTotal: null,
    diagnostics: { malformed: 0, oversized: 0, orphan: 0, capacity: 0, completed: 0 } };
  const rejectToolFree = () => {
    for (const turn of Object.values(s.turns)) {
      if (turn.toolFree) turn.toolFree.bad = true;
    }
  };
  s.modelAt ??= null;
  // Fork provenance. `forked` records that this source declared a parent;
  // `parent` is the parent session's HMAC, never the raw identifier. A declared
  // fork whose parent hash cannot be restored keeps `parent === null`, which
  // leaves every unproven turn undetermined instead of guessing.
  if (typeof s.forked !== 'boolean') s.forked = s.forked === undefined ? false : true;
  if (s.parent !== undefined && s.parent !== null
      && (typeof s.parent !== 'string' || !HASH.test(s.parent))) s.parent = null;
  s.parent ??= null;
  // The fork's own creation instant. It is a second, independent boundary:
  // a turn that started before the child existed can only be copied history,
  // even if its copied records name the child.
  if (s.forkCreatedAt !== undefined && s.forkCreatedAt !== null && !integer(s.forkCreatedAt)) {
    s.forkCreatedAt = null;
  }
  s.forkCreatedAt ??= null;
  if (typeof s.modelOwn !== 'boolean') s.modelOwn = !s.forked;
  // A fork inlines its parent's history, and this file cannot consult the
  // parent. Two independent facts therefore have to agree before a turn is
  // measured as this fork's own new work: the turn is named by this session,
  // and it did not start before the child rollout was created. Copied parent
  // turns keep the parent's own timestamps (the reviewed accounting boundary
  // reads copied history at parent-era times for the same reason), so the
  // second fact also excludes a copy whose session identity was rewritten.
  if (typeof s.forkInline !== 'boolean') s.forkInline = s.forkInline === undefined ? s.forked : true;
  // Whether this file has shown an attributable copied prefix and this
  // session's own work, and whether the two ever appeared out of order.
  const corruptForkOrder = ['forkInheritedSeen', 'ownWorkSeen', 'forkOrderViolation', 'parentHeaderSeen']
    .some(name => s[name] !== undefined && typeof s[name] !== 'boolean');
  if (corruptForkOrder && s.forked) s.blocked = true;
  if (typeof s.forkInheritedSeen !== 'boolean') s.forkInheritedSeen = false;
  if (typeof s.ownWorkSeen !== 'boolean') s.ownWorkSeen = false;
  if (typeof s.forkOrderViolation !== 'boolean') s.forkOrderViolation = false;
  if (typeof s.parentHeaderSeen !== 'boolean') s.parentHeaderSeen = false;
  s.diagnostics ??= { malformed: 0, oversized: 0, orphan: 0, capacity: 0, completed: 0 };
  for (const counter of ['forkInheritedTurns', 'forkUndeterminedTurns',
    'forkInheritedDeclarations', 'forkUndeterminedDeclarations', 'forkContradictions']) {
    if (!integer(s.diagnostics[counter])) s.diagnostics[counter] = 0;
  }
  const hadContextHistory = Object.hasOwn(s, 'contextHistory');
  const savedContextHistoryInvalid = s.contextHistoryInvalid === true;
  const contextHistory = normalizeSavedContextHistory(s.contextHistory);
  s.contextHistory = contextHistory.entries;
  s.contextHistoryInvalid = contextHistory.invalid || savedContextHistoryInvalid;
  const hadTierState = Object.hasOwn(s, 'tier');
  s.tier = normalizeSavedTierState(s.tier);
  for (const turn of Object.values(s.turns)) {
    if (!turn || typeof turn !== 'object') continue;
    turn.mode ??= 'unknown';
    turn.modeSource ??= 'unobserved';
    turn.modeMixed ??= false;
    // A checkpoint written before fork provenance existed cannot claim that a
    // turn was this session's own work. Leave it unproven rather than letting a
    // resumed fork turn qualify on a value it never recorded.
    if (turn.provenance !== undefined && turn.provenance !== null
        && !TURN_PROVENANCE.has(turn.provenance)) turn.provenance = null;
    turn.provenance ??= null;
    // Older pending checkpoints cannot prove that no output preceded a late
    // initial declaration. A full parser-version replay can establish it.
    turn.modeOutputSeen ??= true;
    turn.modeInitializedAt ??= null;
    if (typeof turn.modeOutputSeen !== 'boolean'
        || turn.modeInitializedAt !== null && (!integer(turn.modeInitializedAt)
          || turn.modeInitializedAt < turn.start)) turn.modeInvalid = true;
    // A pre-performance saved turn has no tier proof. Keep its existing TPS
    // state, but do not upgrade it to a mode-qualified row after restart.
    turn.modeInvalid ??= true;
    turn.modelObserved ??= turn.model !== null;
    turn.stableModel ??= turn.model ?? null;
    turn.modelStable ??= true;
    turn.boundaryInvalid ??= false;
    // Old checkpoints can resume TPS/TTFT, but they did not prove the
    // task-start boundary required by the newer full-turn field. Reparse or a
    // new task start is required before exposing turn_duration.
    turn.turnDurationProof ??= false;
    turn.attributionInvalid ??= !hadContextHistory;
  }
  if (!hadTierState || s.tier.invalid) {
    for (const turn of Object.values(s.turns)) {
      if (!turn || typeof turn !== 'object') continue;
      turn.modeInvalid = true;
    }
  }
  if (s.tier.timeline.length === 0) {
    // An observed mode on an active turn requires its declaration timeline.
    // Keep fresh and explicitly unobserved turns as unknown without turning
    // an empty, valid initial state into a global failure.
    for (const turn of Object.values(s.turns)) {
      if (!turn || typeof turn !== 'object') continue;
      if ((turn.mode !== 'unknown' || turn.modeMixed
          || turn.modeSource !== 'unobserved') && !turn.modeInvalid) {
        turn.modeInvalid = true;
      }
    }
  }
  if (s.contextHistoryInvalid) {
    for (const turn of Object.values(s.turns)) {
      if (!turn || typeof turn !== 'object') continue;
      turn.attributionInvalid = true;
      turn.modelStable = false;
      turn.mixed = true;
    }
  }
  const hash = (domain, value) => digest(key, domain, value);
  // The only per-record session identity a rollout carries is `thread_id`. It
  // is hashed here and never retained. `own` proves this file's session wrote
  // the record; `inherited` proves it is a copy of the declared parent's
  // history. Anything else — an absent field, another session, or a fork whose
  // parent hash did not survive — stays undetermined rather than guessed.
  const identify = payload => {
    if (!id(payload?.thread_id)) return null;
    const observed = hash('session', payload.thread_id);
    if (observed === s.own) return 'own';
    if (s.parent !== null && observed === s.parent) {
      if (s.forked) {
        // A parent record after the child's own output contradicts a copied
        // prefix. Mark the source blocked so the store invalidates any rows
        // already emitted from this source in the same or an earlier pass.
        if (s.ownWorkSeen && !s.forkOrderViolation) {
          s.forkOrderViolation = true;
          s.blocked = true;
          s.diagnostics.forkContradictions++;
        }
        // An inline copy is present in this file, whatever the metadata shape
        // claimed. The stricter copied-prefix rule then has to hold.
        s.forkInheritedSeen = true;
        s.forkInline = true;
      }
      return 'inherited';
    }
    return null;
  };
  // A turn started before the child exists cannot be proven to be child work.
  const atOrAfterFork = start => integer(s.forkCreatedAt) && integer(start)
    && start >= s.forkCreatedAt;
  // Only three facts can prove a forked turn inside a single file. An inline
  // fork that shows an attributable copied prefix before this session's own
  // work is separable, and then a turn named by this session that also started
  // after the child rollout existed is provably new. A file that declares a
  // parent but never names it inline cannot be told apart from a copy whose
  // identities were rewritten, so nothing in it is admitted: an inline copy is
  // the only shape that can re-attribute parent work to this session.
  const forkOwnWork = turn => {
    if (!s.forked) return true;
    if (s.parent === null || turn.provenance !== 'own'
        || s.forkOrderViolation === true || !atOrAfterFork(turn.start)) return false;
    // A paginated continuation references its base rather than inlining it, so
    // there is no copied prefix to attribute.
    if (s.forkInline !== true) return true;
    return s.forkInheritedSeen === true && atOrAfterFork(turn.start);
  };
  const recordProvenance = (turn, provenance) => {
    if (!turn || provenance === null) return;
    if (s.forked && provenance === 'own') s.ownWorkSeen = true;
    // A copied prefix precedes the child's own records, so the two identities
    // must never describe the same turn. If they do, they cannot separate the
    // replay in this file and the turn becomes unproven rather than one or the
    // other being chosen.
    if (turn.provenance !== null && turn.provenance !== provenance) {
      s.diagnostics.forkContradictions++;
      turn.provenance = 'conflict';
      return;
    }
    if (turn.provenance === 'conflict') return;
    turn.provenance = provenance;
  };
  const bad = (t, reason) => {
    t.bad = true; t.problem ??= reason; t.windowBad = true;
    if (!['unreadable_evidence', 'item_interval', 'window_endpoint'].includes(reason)) t.fatal = true;
  };
  // Late initialization requires proof of no earlier output. Missing identity,
  // unreadable records or delayed earlier output revoke only that turn's late
  // inference, without discarding independent timings or future tier evidence.
  const observeModeOutput = (turn = null, at = null) => {
    for (const active of turn ? [turn] : Object.values(s.turns)) {
      active.modeOutputSeen = true;
      if (active.modeInitializedAt !== null
          && (!turn || !integer(at) || at < active.modeInitializedAt)) active.modeInvalid = true;
    }
  };
  const invalidate = () => {
    observeModeOutput();
    for (const t of Object.values(s.turns)) { bad(t, 'unreadable_evidence'); t.legacy.windowBad = true; }
    rejectToolFree();
    s.legacyTotal = null;
  };
  const resetLegacy = (t, at) => {
    Object.assign(t.legacy, { first: null, lastItem: null, end: null, windowBad: false, toolSeen: false, previous: at });
  };
  function markContextEvidenceInvalid(turnId = null) {
    if (turnId && s.turns[turnId]) {
      s.turns[turnId].attributionInvalid = true;
      s.turns[turnId].modelStable = false;
      s.turns[turnId].mixed = true;
      return;
    }
    if (turnId) return;
    s.contextHistoryInvalid = true;
    for (const turn of Object.values(s.turns)) {
      turn.attributionInvalid = true;
      turn.modelStable = false;
      turn.mixed = true;
    }
  }
  function applyContextMode(turn, at, evidence) {
    if (!evidence.modeOverride) return;
    if (evidence.modeInvalid || !integer(at) || at < turn.start) {
      turn.modeInvalid = true;
      return;
    }
    // The per-turn context is authoritative when it is the task boundary.
    // Once the turn is underway, a different declaration is contradictory
    // evidence rather than a safe relabel of an already-started turn.
    if (at !== turn.start) {
      if (turn.mode !== evidence.mode || turn.modeSource !== evidence.modeSource) {
        turn.modeMixed = true;
      }
      return;
    }
    turn.mode = evidence.mode;
    turn.modeSource = evidence.modeSource;
  }
  function recordTurnContext(payload, at, turnId) {
    const hasModel = Object.hasOwn(payload, 'model');
    const hasServiceTier = Object.hasOwn(payload, 'service_tier');
    const malformed = !integer(at) || !hasModel
      || (payload.model !== null && typeof payload.model !== 'string')
      || (Object.hasOwn(payload, 'effort')
        && payload.effort !== null && typeof payload.effort !== 'string');
    const model = MODELS.has(payload.model) ? payload.model : null;
    const effort = EFFORTS.has(payload.effort) ? payload.effort : null;
    const previous = turnId ? s.contextHistory[turnId] : null;
    const modeEvidence = hasServiceTier
      ? contextModeFromRawTier(payload.service_tier)
      : previous ? {
        modeOverride: previous.modeOverride === true,
        mode: previous.mode ?? 'unknown',
        modeSource: previous.modeSource ?? 'unobserved',
        modeInvalid: previous.modeInvalid === true,
      } : defaultContextMode();
    const globalRegressed = s.modelAt !== null && (!integer(at) || at < s.modelAt);
    const regressed = previous && (!integer(at) || at < previous.at);
    const equalConflict = previous && integer(at) && at === previous.at
      && (model !== previous.model || effort !== previous.effort
        || hasServiceTier && (previous.modeOverride !== modeEvidence.modeOverride
          || previous.mode !== modeEvidence.mode || previous.modeSource !== modeEvidence.modeSource
          || previous.modeInvalid !== modeEvidence.modeInvalid));
    if (malformed || globalRegressed || regressed || equalConflict || previous?.invalid) {
      if (turnId) {
        s.contextHistory[turnId] = {
          at: integer(at) ? at : previous?.at ?? 0,
          model,
          effort,
          invalid: true,
          ...modeEvidence,
        };
      }
      markContextEvidenceInvalid(turnId);
      return;
    }
    if (turnId) {
      s.contextHistory[turnId] = { at, model, effort, invalid: false, ...modeEvidence };
      if (Object.keys(s.contextHistory).length > MAX_CONTEXT_HISTORY) {
        const current = s.contextHistory[turnId];
        s.contextHistory = { [turnId]: current };
        for (const active of Object.values(s.turns)) {
          active.attributionInvalid = true;
          active.modelStable = false;
          active.mixed = true;
        }
        return;
      }
    }
    s.model = model;
    s.effort = effort;
    s.modelAt = at;
    // Config records are state updates and usually carry no session identity.
    // In a fork that makes the carried model the copied parent's until this
    // file proves otherwise, so the carry is only usable once it is attributable
    // to this session: the record names it, or the turn it belongs to is already
    // proven this session's own work.
    const identity = identify(payload);
    s.modelOwn = !s.forked
      || identity === 'own'
      || (turnId !== null && s.turns[turnId]?.provenance === 'own');
    const turn = turnId ? s.turns[turnId] : null;
    if (turn) {
      if ((turn.responses || turn.first !== null || turn.legacy.observed || turn.legacy.first !== null || turn.legacy.end !== null)
        && (turn.model !== s.model || turn.effort !== s.effort)) turn.mixed = true;
      if (!turn.modelObserved) {
        if (s.model !== null) {
          const responseEvidenceSeen = turn.responses > 0 || turn.first !== null
            || turn.legacy.first !== null || turn.legacy.end !== null;
          if (responseEvidenceSeen) turn.modelStable = false;
          else {
            turn.modelObserved = true;
            turn.stableModel = s.model;
          }
        }
      } else if (turn.stableModel !== s.model) {
        turn.modelStable = false;
      }
      turn.model = s.model;
      turn.effort = s.effort;
      applyContextMode(turn, at, modeEvidence);
      return;
    }
    // An unattributed settings change cannot silently leave a pending window
    // labelled with a previous model.
    for (const active of Object.values(s.turns)) {
      if (active.model !== s.model || active.effort !== s.effort) active.mixed = true;
      if (active.modelObserved && active.stableModel !== s.model) active.modelStable = false;
      if (hasServiceTier) active.modeInvalid = true;
    }
  }
  function setTierEvent(payload, at) {
    const settings = payload?.thread_settings;
    // In a fork, a declaration is usable for this session only when the event
    // names this session. The declared parent's declaration is copied history,
    // and one with no identity is neither. Both are still kept as ordering
    // evidence but never qualify this session's turn. Because the parent's
    // declaration cannot describe the child's later switch, a malformed
    // inherited declaration also cannot poison the child's own evidence.
    const declaration = identify(payload);
    if (s.forked) {
      if (declaration === 'inherited') s.diagnostics.forkInheritedDeclarations++;
      else if (declaration !== 'own') s.diagnostics.forkUndeterminedDeclarations++;
    }
    const qualifies = !s.forked || declaration === 'own';
    const invalidateMode = () => {
      if (declaration !== 'inherited') markModeEvidenceInvalid(s);
    };
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      invalidateMode();
      return;
    }
    // A settings event without a service tier is a model/settings update, not
    // evidence about speed. It must not manufacture a mode or reset the last
    // observed tier.
    if (!Object.hasOwn(settings, 'service_tier')) return;
    const rawTier = settings.service_tier;
    if (!integer(at) || (rawTier !== null && typeof rawTier !== 'string')) {
      invalidateMode();
      if (integer(at) && (s.tier.lastAt === null || at >= s.tier.lastAt)) s.tier.lastAt = at;
      return;
    }
    // A raw token outside the bounded provider classification is not retained
    // and cannot establish a usable mode. Bounded but unrecognised values are
    // explicitly `other`, preserving the distinction without retaining the
    // provider token.
    if (rawTier !== null && !TIER_RAW.test(rawTier)) {
      invalidateMode();
      if (s.tier.lastAt === null || at >= s.tier.lastAt) s.tier.lastAt = at;
      return;
    }
    if (s.tier.lastAt !== null && at < s.tier.lastAt) {
      invalidateMode();
      return;
    }
    const normalized = modeFromRawTier(rawTier);
    const active = Object.values(s.turns);
    const firstDeclaration = !s.tier.invalid && s.tier.timeline.length === 0
      && id(payload.thread_id) && hash('session', payload.thread_id) === s.own
      && active.length === 1;
    if (s.tier.timeline.length >= MAX_TIER_EVENTS) {
      // A completed declaration is sufficient for future task-start lookup;
      // active turns already captured their mode. Keep the newest prior
      // declaration plus this event instead of poisoning all later rows.
      s.tier.timeline = s.tier.timeline.slice(-1);
    }
    for (const turn of active) {
      if (at < turn.start) {
        turn.modeInvalid = true;
        markModeEvidenceInvalid(s);
      } else if (qualifies && firstDeclaration && !turn.modeInvalid && !turn.modeMixed
          && turn.mode === 'unknown' && turn.modeSource === 'unobserved'
          && ['standard', 'fast', 'ultrafast'].includes(normalized.mode)
          && !turn.modeOutputSeen && !turn.modernSeen && turn.responses === 0
          && turn.legacy.observed === 0 && turn.legacy.first === null
          && turn.legacy.end === null) {
        // Codex may write its initial settings after task_started, before the
        // first inference output. This is initialization, not a mode switch.
        // Keep the declaration instant so delayed output/TTFT can disprove it.
        turn.mode = normalized.mode;
        turn.modeSource = normalized.modeSource;
        turn.modeInitializedAt = at;
      } else if (qualifies && at >= turn.start && normalized.mode !== turn.mode) {
        turn.modeMixed = true;
      }
    }
    s.tier.timeline.push({ at, mode: normalized.mode, source: normalized.modeSource,
      own: qualifies });
    s.tier.lastAt = at;
  }
  function legacyCount(p, at) {
    const total = p.info?.total_token_usage, last = p.info?.last_token_usage;
    const before = s.legacyTotal;
    s.legacyTotal = integer(total?.output_tokens) && integer(total?.reasoning_output_tokens)
      && total.reasoning_output_tokens <= total.output_tokens
      ? { output: total.output_tokens, reasoning: total.reasoning_output_tokens } : null;
    const active = Object.values(s.turns);
    if (!s.legacyTotal || !before) {
      if (p.info != null && (!s.legacyTotal || s.legacyTotal.output !== 0
          || !integer(last?.output_tokens) || last.output_tokens !== 0
          || !integer(last?.reasoning_output_tokens) || last.reasoning_output_tokens > last.output_tokens)) {
        observeModeOutput();
      }
      rejectToolFree();
      for (const t of active) {
        if (integer(last?.output_tokens) && last.output_tokens > 0) t.legacy.observed++;
        resetLegacy(t, at); t.legacy.windowBad = !integer(at);
      }
      return;
    }
    const n = s.legacyTotal.output - before.output, reasoning = s.legacyTotal.reasoning - before.reasoning;
    if (n === 0 && reasoning === 0) return; // Repeated snapshots are not responses.
    const matched = integer(n) && n > 0 && integer(reasoning) && reasoning <= n
      && n === last?.output_tokens && reasoning === last?.reasoning_output_tokens;
    const turn = active.length === 1 ? active[0] : null;
    const sameThread = p.thread_id === undefined || id(p.thread_id) && hash('session', p.thread_id) === s.own;
    const sameTurn = p.turn_id === undefined || id(p.turn_id) && s.turns[hash('turn', `${s.own}/${p.turn_id}`)] === turn;
    observeModeOutput(matched && sameThread && sameTurn ? turn : null, at);
    if (active.length !== 1) {
      rejectToolFree();
      for (const t of active) { resetLegacy(t, at); t.legacy.windowBad = true; }
      return;
    }
    const t = active[0], l = t.legacy;
    if (++l.observed > 512) { bad(t, 'response_limit'); return; }
    if (t.toolFree) {
      if (!matched) t.toolFree.bad = true;
      else {
        t.toolFree.counts++;
        t.toolFree.tokens += n;
        t.toolFree.reasoning += reasoning;
      }
    }
    if (matched && !l.windowBad && integer(at) && l.first !== null && l.end > l.first
      && l.lastItem <= l.end && l.end <= at && l.first >= l.previous) {
      l.tokens += n; l.reasoning += reasoning; l.duration += l.end - l.first; l.covered++;
    }
    resetLegacy(t, at);
  }
  function line(bytes, offset, partial) {
    if (s.blocked) return;
    if (partial) {
      observeModeOutput();
      rejectToolFree();
      s.diagnostics.oversized++;
      // Only a verified top-level header can establish irrelevance. In
      // particular, a tool result mentioning a timing event is not that event.
      const header = bytes.subarray(0, 512).toString('utf8');
      if (/^\s*\{\s*"timestamp"\s*:\s*"[^"\\]*"\s*,\s*"type"\s*:\s*"response_item"\s*,/.test(header)) {
        // Receipt timing does not consume response-item content. Legacy endpoints
        // do; an unreadable model/tool record makes that legacy window uncertain.
        for (const t of Object.values(s.turns)) t.legacy.windowBad = true;
        return;
      }
      if (bytes.includes(TIER_NEEDLE)) markModeEvidenceInvalid(s);
      invalidate(); return;
    }
    const relevant = NEEDLES.some(n => bytes.includes(n));
    // The timing fast path cannot prove that an unreadable, unclassified line
    // contains no output while a turn still depends on that proof.
    if (!toolFree && !relevant && !Object.values(s.turns).some(turn => !turn.modeInvalid
      && (turn.modeInitializedAt !== null || !turn.modeOutputSeen && turn.mode === 'unknown'))) return;
    let r;
    try { r = JSON.parse(bytes.toString('utf8')); } catch {
      observeModeOutput();
      if (!toolFree && !relevant) return;
      s.diagnostics.malformed++;
      rejectToolFree();
      if (bytes.includes(TIER_NEEDLE)) markModeEvidenceInvalid(s);
      invalidate(); return;
    }
    if (!r || typeof r !== 'object' || Array.isArray(r)) { observeModeOutput(); rejectToolFree(); return; }
    const p = r.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) { observeModeOutput(); rejectToolFree(); return; }
    if (typeof r.type !== 'string' || r.type.length === 0
        || r.type === 'event_msg' && (typeof p.type !== 'string' || p.type.length === 0)) {
      observeModeOutput(); rejectToolFree(); return;
    }
    const at = stamp(r.timestamp);
    if (r.type === 'session_meta') {
      if (s.own) {
        // Paginated fork logs can embed the immediate parent's metadata header
        // before the child's own work. Accept that one identified header only;
        // a second, unrelated, late or temporally incompatible header remains
        // a source-level ambiguity and invalidates its measurements.
        const identifiedParentHeader = s.forked && s.parent !== null && id(p.id)
          && hash('session', p.id) === s.parent && !s.parentHeaderSeen
          && !s.ownWorkSeen && Object.keys(s.turns).length === 0
          && integer(at) && integer(s.forkCreatedAt)
          && at <= s.forkCreatedAt + FORK_HEADER_TIME_TOLERANCE;
        if (identifiedParentHeader) {
          s.parentHeaderSeen = true;
          s.forkInheritedSeen = true;
          s.forkInline = true;
          return;
        }
        s.blocked = true; s.turns = {}; return;
      }
      if (!id(p.id)) { s.blocked = true; s.turns = {}; return; }
      // An inline fork copies its declared parent's history into this file
      // before its own first turn. The sidecar keeps its deliberately narrower
      // whole-source refusal, but the primary parser admits the source and
      // separates copied from new work per turn. A fork whose parent identity
      // is not a usable session id cannot be separated at all, so it stays
      // refused rather than measured as if every turn were new.
      if (Object.hasOwn(p, 'forked_from_id') && p.forked_from_id !== null
          && p.forked_from_id !== undefined) {
        // A file that declares itself as its own parent cannot separate copied
        // from new work at all: every record would satisfy both identities.
        if (!id(p.forked_from_id) || p.forked_from_id === p.id || toolFree) {
          s.blocked = true; s.turns = {}; return;
        }
        s.forked = true;
        s.parent = hash('session', p.forked_from_id);
        // Only the legacy shape writes the parent's records into this file.
        // A `paginated` continuation references its base instead, which the
        // reviewed accounting boundary already reads the same way.
        s.forkInline = p.history_mode !== 'paginated';
        // The child rollout's own metadata timestamp is the fork instant: the
        // parent's copied history was written before it.
        s.forkCreatedAt = integer(at) ? at : null;
      }
      s.own = hash('session', p.id); return;
    }
    if (!s.own) return;
    if (r.type === 'compacted') { invalidate(); return; }
    const tid = id(p.turn_id) ? hash('turn', `${s.own}/${p.turn_id}`) : null;
    if (toolFree) {
      // Tool-free admission remains an intentionally narrower sidecar. New
      // timing declarations are not proof of a tool-free turn and therefore
      // invalidate the sidecar while leaving the primary parser independent.
      const response = r.type === 'response_item';
      const output = response && (p.type === 'reasoning' || p.type === 'message' && p.role === 'assistant');
      const input = response && p.type === 'message' && ['user', 'system', 'developer'].includes(p.role);
      const event = r.type === 'event_msg';
      const allowed = response ? output || input : r.type === 'turn_context'
        || r.type === 'token_usage_record' || event && ['task_started', 'task_complete',
          'turn_aborted', 'token_count', 'item_completed', 'agent_message', 'user_message',
          'thread_goal_updated'].includes(p.type);
      if (!allowed || event && p.type === 'item_completed'
        && !['Reasoning', 'AgentMessage', 'UserMessage'].includes(p.item?.type)) rejectToolFree();
      for (const [turnKey, turn] of Object.entries(s.turns)) {
        const f = turn.toolFree;
        if (!f) continue;
        if (!integer(at) || at < f.lastAt) f.bad = true;
        else f.lastAt = at;
        if (input || event && (p.type === 'user_message'
          || p.type === 'item_completed' && p.item?.type === 'UserMessage')) {
          if (f.outputSeen || f.counts || turn.responses) f.bad = true;
        }
        if (output) {
          if (f.counts > 0 || turn.responses > 0) f.bad = true;
          const sourceTurn = p.internal_chat_message_metadata_passthrough?.turn_id;
          if (sourceTurn !== undefined && (!id(sourceTurn)
            || hash('turn', `${s.own}/${sourceTurn}`) !== turnKey)) f.bad = true;
          f.outputSeen = true;
        }
        if ((event && p.type === 'item_completed' || r.type === 'token_usage_record')
          && tid !== turnKey) f.bad = true;
        if (r.type === 'turn_context' && f.outputSeen
          && (p.model !== turn.model || p.effort !== turn.effort)) f.bad = true;
      }
    }
    if (r.type === 'event_msg' && p.type === 'thread_settings_applied') {
      if (toolFree) { rejectToolFree(); return; }
      setTierEvent(p, at);
      return;
    }
    if (r.type === 'turn_context') {
      recordTurnContext(p, at, tid);
      return;
    }
    if (r.type === 'event_msg' && ['agent_message', 'agent_reasoning', 'agent_reasoning_raw_content',
      'agent_message_delta', 'agent_reasoning_delta', 'agent_reasoning_raw_content_delta'].includes(p.type)) {
      const identity = identify(p);
      recordProvenance(s.turns[tid], identity);
      const sameThread = identity === 'own' || p.thread_id === undefined && !s.forked;
      observeModeOutput(sameThread ? s.turns[tid] : null, at);
      return;
    }
    if (r.type === 'response_item') {
      if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        observeModeOutput();
        for (const t of Object.values(s.turns)) t.legacy.toolSeen = true;
        return;
      }
      if (p.type === 'compaction') { invalidate(); return; }
      if (!['reasoning', 'function_call', 'custom_tool_call'].includes(p.type)
        && !(p.type === 'message' && p.role === 'assistant')) {
        if (!(p.type === 'message' && ['user', 'system', 'developer'].includes(p.role))) observeModeOutput();
        if (p.type !== 'agent_message' && !(p.type === 'message' && ['user', 'system', 'developer'].includes(p.role)))
          for (const t of Object.values(s.turns)) t.legacy.windowBad = true;
        return;
      }
      const meta = p.internal_chat_message_metadata_passthrough;
      const target = id(meta?.turn_id) ? hash('turn', `${s.own}/${meta.turn_id}`) : null;
      const t = s.turns[target];
      observeModeOutput(t, at);
      if (!t) {
        for (const a of Object.values(s.turns)) {
          a.legacy.windowBad = true;
        }
        return;
      }
      const l = t.legacy;
      if (!integer(at) || at < l.previous || l.toolSeen || (l.end !== null && at < l.end)) l.windowBad = true;
      else l.end = at;
      return;
    }
    if (r.type === 'event_msg' && p.type === 'token_count') { legacyCount(p, at); return; }
    if (r.type === 'token_usage_record' || r.type === 'event_msg'
        && p.type === 'item_completed' && p.item?.type !== 'UserMessage') {
      const identity = identify(p);
      recordProvenance(s.turns[tid], identity);
      observeModeOutput(identity === 'own' ? s.turns[tid] : null,
        r.type === 'token_usage_record' ? at : p.started_at_ms);
    }
    if (!tid) {
      if (r.type === 'token_usage_record') for (const t of Object.values(s.turns)) t.modernSeen = true;
      if (r.type === 'event_msg' && p.type === 'item_completed')
        for (const t of Object.values(s.turns)) {
          t.legacy.windowBad = true;
          if (['Reasoning', 'AgentMessage'].includes(p.item?.type)) bad(t, 'unreadable_evidence');
        }
      return;
    }
    if (r.type === 'event_msg' && p.type === 'task_started') {
      if (s.turns[tid]) {
        // A repeated start makes the task boundary ambiguous even when the
        // later completion has numerically consistent timestamps. Keep the
        // independent turn-duration measurement fail-closed in that case.
        s.turns[tid].boundaryInvalid = true;
        bad(s.turns[tid], 'duplicate_start');
        return;
      }
      if (Object.keys(s.turns).length >= 8) { s.diagnostics.capacity++; invalidate(); return; }
      if (!integer(at)) return;
      const concurrent = Object.keys(s.turns).length > 0;
      if (concurrent) {
        rejectToolFree();
        for (const t of Object.values(s.turns)) t.legacy.windowBad = true;
      }
      const context = s.contextHistory[tid];
      const contextAtStart = !s.contextHistoryInvalid && context?.at === at
        && context.invalid === false;
      const mode = contextAtStart && context.modeOverride
        ? { mode: context.mode, source: context.modeSource, invalid: context.modeInvalid }
        // A fork's timeline may hold the copied parent's declarations; only
        // this session's own declaration may label its own turn.
        : modeAt(s.tier, at, s.forked);
      // The carried model/effort belong to whoever wrote the last context,
      // which in a fork can be the copied parent. Per-turn context is always
      // this turn's own evidence, and so is a carry the file established after
      // its own work had already begun — the copied prefix is contiguous at the
      // head of the file, so it cannot be. Anything else stays unknown.
      const carryProven = !s.forked || s.modelOwn === true;
      const startModel = contextAtStart ? context.model : carryProven ? s.model : null;
      const startEffort = contextAtStart ? context.effort : carryProven ? s.effort : null;
      const modelKnownAtStart = contextAtStart && startModel !== null;
      s.turns[tid] = { start: at, model: startModel, effort: startEffort, mixed: false,
        provenance: null,
        modelObserved: modelKnownAtStart, stableModel: modelKnownAtStart ? startModel : null, modelStable: true,
        mode: mode.mode, modeSource: mode.source, modeMixed: false, modeInvalid: mode.invalid,
        modeOutputSeen: false, modeInitializedAt: null,
        boundaryInvalid: false, turnDurationProof: true,
        attributionInvalid: !modelKnownAtStart && (s.contextHistoryInvalid || context?.invalid === true),
        ...(toolFree ? {
          toolFree: { bad: concurrent, outputSeen: false, lastAt: at, counts: 0, tokens: 0, reasoning: 0 },
        } : {}),
        bad: false, fatal: false, windowBad: false, first: null, lastItem: null, previous: at, tokens: 0, reasoning: 0,
        finalTokens: null, finalReasoning: null, duration: 0, responses: 0,
        covered: 0, coveredTokens: 0, coveredReasoning: 0, seen: {}, modernSeen: false,
        legacy: { first: null, lastItem: null, end: null, windowBad: concurrent, toolSeen: false,
          previous: at, tokens: 0, reasoning: 0, duration: 0, covered: 0, observed: 0 } };
      return;
    }
    const t = s.turns[tid];
    if (!t) {
      if (r.type === 'token_usage_record') {
        s.diagnostics.orphan++;
        for (const a of Object.values(s.turns)) a.modernSeen = true;
      }
      if (r.type === 'event_msg' && p.type === 'item_completed')
        for (const a of Object.values(s.turns)) {
          a.legacy.windowBad = true;
          if (['Reasoning', 'AgentMessage'].includes(p.item?.type)) bad(a, 'unreadable_evidence');
        }
      return;
    }
    if (r.type === 'event_msg' && p.type === 'turn_aborted') {
      delete s.turns[tid];
      delete s.contextHistory[tid];
      return;
    }
    if (r.type === 'event_msg' && p.type === 'item_completed') {
      const identity = identify(p);
      recordProvenance(t, identity);
      // A record that names the declared parent is copied history: it proves
      // this turn is not this session's work and must not accumulate a window
      // that the row would later report as new inference.
      if (identity === 'inherited') return;
      if (identity !== 'own') { bad(t, 'identity'); return; }
      if (!['Reasoning', 'AgentMessage'].includes(p.item?.type)) return;
      const a = p.started_at_ms, b = p.completed_at_ms;
      const l = t.legacy;
      if (!integer(a) || !integer(b) || b < a || a < l.previous || l.toolSeen) l.windowBad = true;
      else {
        l.first = l.first === null ? a : Math.min(l.first, a);
        l.lastItem = l.lastItem === null ? b : Math.max(l.lastItem, b);
      }
      if (!integer(a) || !integer(b) || b < a || a < t.start - 2000 || a < t.previous) {
        bad(t, 'item_interval'); return;
      }
      t.first = t.first === null ? a : Math.min(t.first, a);
      t.lastItem = t.lastItem === null ? b : Math.max(t.lastItem, b);
      return;
    }
    if (r.type === 'token_usage_record') {
      t.modernSeen = true;
      const identity = identify(p);
      recordProvenance(t, identity);
      // Copied parent usage is never this session's measurement. It also cannot
      // establish the reconciliation totals of this session's own turn.
      if (identity === 'inherited') return;
      if (identity !== 'own' || !id(p.response_id)) { bad(t, 'identity'); return; }
      const response = hash('response', p.response_id);
      if (t.seen[response]) { bad(t, 'duplicate_response'); t.first = null; t.lastItem = null; return; }
      if (t.responses >= 512) { bad(t, 'response_limit'); s.diagnostics.capacity++; return; }
      t.seen[response] = 1;
      const n = p.usage?.output_tokens, reasoning = p.usage?.reasoning_output_tokens;
      t.responses++;
      if (!integer(n) || !integer(reasoning) || reasoning > n || !integer(at) || at < t.previous) {
        bad(t, 'usage_interval'); return;
      }
      t.tokens += n; t.reasoning += reasoning;
      t.finalTokens = p.turn_token_usage?.output_tokens ?? null;
      t.finalReasoning = p.turn_token_usage?.reasoning_output_tokens ?? null;
      if (!t.windowBad && t.first !== null && at > t.first && t.lastItem <= at) {
        t.duration += at - t.first; t.covered++;
        t.coveredTokens += n; t.coveredReasoning += reasoning;
      } else bad(t, 'window_endpoint');
      t.previous = at; t.first = null; t.lastItem = null; t.windowBad = false;
      return;
    }
    if (r.type === 'event_msg' && p.type === 'task_complete') {
      // Fork admission is decided per turn, never per source. Two independent
      // proofs must agree before a forked turn is measured as this session's
      // own work: its records name this session, and it started after the child
      // rollout existed. A turn named by the declared parent is the replayed
      // parent turn. Anything else — no identity at all, conflicting identities,
      // or a name that contradicts the fork instant — cannot be separated here,
      // so it stays unmeasured and is counted rather than being counted twice
      // or silently dropped.
      if (s.forked) {
        const own = forkOwnWork(t);
        if (!own) {
          // Proven copied history, or a turn this file cannot separate.
          s.diagnostics[t.provenance === 'inherited' || !atOrAfterFork(t.start)
            ? 'forkInheritedTurns' : 'forkUndeterminedTurns']++;
          delete s.turns[tid];
          delete s.contextHistory[tid];
          return;
        }
      }
      const elapsed = p.duration_ms;
      const boundary = integer(at) && integer(elapsed) && elapsed > 0
        && Math.abs(at - t.start - elapsed) <= 2000 && t.previous <= at + 1000;
      // The historical timing window tolerates small endpoint skew in either
      // direction. A full-turn duration must still never claim completion
      // before the task start itself.
      const turnBoundary = boundary && !t.boundaryInvalid && at >= t.start;
      const turnDuration = turnBoundary && !p.error && t.modelObserved && t.modelStable
        && !t.attributionInvalid && t.turnDurationProof ? elapsed : null;
      const reconciled = integer(t.finalTokens) && t.tokens === t.finalTokens
        && t.reasoning === t.finalReasoning && Number.isSafeInteger(t.tokens);
      const attributionInvalid = t.mixed || t.attributionInvalid;
      const valid = boundary && reconciled && !t.bad && !attributionInvalid && !p.error
        && t.responses > 0 && t.covered === t.responses && t.duration > 0
        && t.first === null && t.duration <= elapsed + 2000;
      const ttft = boundary && !p.error && !attributionInvalid && integer(p.time_to_first_token_ms)
        && p.time_to_first_token_ms <= elapsed ? p.time_to_first_token_ms : null;
      // An absent or earlier first-token observation cannot prove that all
      // measured inference followed this late initial declaration.
      if (t.modeInitializedAt !== null
          && (ttft === null || t.start + ttft < t.modeInitializedAt)) t.modeInvalid = true;
      const sampled = boundary && reconciled && !t.fatal && !attributionInvalid && !p.error
        && t.covered > 0 && t.duration > 0 && t.duration <= elapsed + 2000;
      const legacy = boundary && !t.modernSeen && !t.fatal && !attributionInvalid && !p.error
        && t.legacy.covered > 0 && t.legacy.duration > 0 && t.legacy.duration <= elapsed + 2000
        && Number.isSafeInteger(t.legacy.tokens) && Number.isSafeInteger(t.legacy.reasoning);
      const mode = modeForTurn(t);
      const f = t.toolFree;
      const single = t.modernSeen ? reconciled && t.responses === 1 && t.tokens > 0
        : f?.counts === 1 && f.tokens > 0 && integer(f.tokens) && integer(f.reasoning);
      const throughput = toolFree && f && !f.bad && f.outputSeen && single
        && turnBoundary && !t.fatal && !attributionInvalid && !p.error && t.model !== null;
      // A fresh allowlist; never spread provider records into retained data.
      if (integer(at)) onTurn({ key: tid, offset, at, model: attributionInvalid ? null : t.model,
        effort: attributionInvalid ? null : t.effort, tokens: reconciled ? t.tokens : null,
        reasoning: reconciled ? t.reasoning : null, duration: valid ? t.duration : null,
        turn_duration: turnDuration, ...mode, api_service_tier: 'unknown',
        ttft, responses: t.responses, covered: t.covered,
        sample_tokens: sampled ? t.coveredTokens : legacy ? t.legacy.tokens : null,
        sample_reasoning: sampled ? t.coveredReasoning : legacy ? t.legacy.reasoning : null,
        sample_duration: sampled ? t.duration : legacy ? t.legacy.duration : null,
        sample_responses: sampled ? t.covered : legacy ? t.legacy.covered : 0,
        sample_total_responses: t.modernSeen ? t.responses : t.legacy.observed,
        sample_method: sampled ? 'receipt' : legacy ? 'legacy' : null,
        quality: valid ? 'complete' : !boundary ? 'invalid_boundary' : !reconciled ? 'usage_mismatch'
            : t.attributionInvalid ? 'invalid_attribution' : t.mixed ? 'mixed_model'
            : t.bad ? t.problem ?? 'invalid_evidence' : 'missing_window',
        ...(toolFree ? {
          sample_tokens: throughput ? t.modernSeen ? t.tokens : f.tokens : null,
          sample_reasoning: throughput ? t.modernSeen ? t.reasoning : f.reasoning : null,
          sample_duration: throughput ? elapsed : null,
          sample_responses: throughput ? 1 : 0,
          sample_total_responses: throughput ? 1 : 0,
          sample_method: throughput ? 'tool_free' : null,
        } : {}),
      });
      delete s.turns[tid];
      delete s.contextHistory[tid];
      s.diagnostics.completed++;
    }
  }
  return { line, state: () => {
    if (Buffer.byteLength(JSON.stringify(s)) > MAX_STATE_BYTES) {
      s.diagnostics.capacity++; s.turns = {};
    }
    return s;
  } };
}

// Separate pending-state format and store version; the primary method remains
// compatible with the existing timing database while the additive sidecar has
// its own method and correlation key.
export const TOOL_FREE_METHOD = 3;
export const createToolFreeParser = (key, saved, onTurn) =>
  createParser(key, saved, onTurn, { toolFree: true });
