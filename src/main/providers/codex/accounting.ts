import { createHash } from 'node:crypto';

/** Provider input includes cache reads; provider output includes reasoning. */
export type TokenVector = [number, number, number, number];
export const CODEX_RECENT_OBSERVATIONS = 128;

export interface CodexAccountingState {
  version: 2;
  generation: number;
  lastEntryId: string | null;
  notificationTotal: TokenVector | null;
  sessionId: string;
  createdMs: number;
  forked: boolean;
  turnId: string;
  inherited: boolean;
  mode: 'unset' | 'single' | 'cumulative';
  total: TokenVector | null;
  segment: number;
  /** Local output evidence can establish a new last-usage after a reset. */
  freshOutput: boolean;
  recent: string[];
}

export interface CodexUsageDecision {
  kind: 'usage' | 'alias';
  requestId: string;
  identityKey: string;
  identityOrigin: string;
  usage: TokenVector;
  observationKey?: string;
  responseKey?: string;
}

export function newCodexAccountingState(generation = 0): CodexAccountingState {
  return { version: 2, generation, lastEntryId: null, notificationTotal: null, sessionId: '', createdMs: 0, forked: false, turnId: '',
    inherited: false, mode: 'unset', total: null, segment: 0, freshOutput: false, recent: [] };
}

export function usageVector(value: unknown): TokenVector | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const values = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']
    .map(key => v[key] ?? 0);
  if (values.some(n => typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)) return null;
  const result = values as TokenVector;
  result[1] = Math.min(result[0], result[1]);
  result[3] = Math.min(result[2], result[3]);
  return result;
}

const same = (a: TokenVector, b: TokenVector): boolean => a.every((n, i) => n === b[i]);
const nonzero = (a: TokenVector | null): a is TokenVector => !!a && a[0] + a[2] > 0;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Decide quantities once. Extractors and projections must use this vector, not last_token_usage. */
export function codexUsageDecision(
  state: CodexAccountingState,
  object: Record<string, unknown>,
  sourceId: string,
  physicalId: string,
  identitySource: (key: string) => string | undefined = () => undefined,
): CodexUsageDecision | null {
  const p = object.payload as Record<string, unknown> | undefined;
  if (!p) return null;
  if (object.type === 'session_meta') {
    if (!state.sessionId) {
      state.sessionId = typeof p.id === 'string' && p.id ? p.id : sourceId;
      const created = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
      state.createdMs = Number.isFinite(created) ? created : 0;
      state.forked = typeof p.forked_from_id === 'string' && !!p.forked_from_id;
      state.inherited = state.forked;
    }
    return null;
  }
  if (object.type === 'event_msg' && p.type === 'task_started') {
    state.turnId = typeof p.turn_id === 'string' ? p.turn_id : '';
    const started = typeof p.started_at === 'number' ? p.started_at * 1000 : Date.parse(String(object.timestamp ?? ''));
    if (state.forked) {
      state.inherited = Number.isFinite(started) && state.createdMs > 0
        ? started < Math.floor(state.createdMs / 1000) * 1000 : false;
    }
    return null;
  }
  if (object.type === 'response_item' && !state.inherited
    && (p.role === 'assistant' || p.type === 'function_call' || p.type === 'custom_tool_call')) {
    state.freshOutput = true;
    return null;
  }
  const structured = object.type === 'token_usage_record';
  if (!structured && !(object.type === 'event_msg' && p.type === 'token_count')) return null;
  const info = p.info as Record<string, unknown> | undefined;
  const last = usageVector(structured ? p.usage : info?.last_token_usage);
  const total = usageVector(structured ? p.thread_token_usage : info?.total_token_usage);
  const responseId = structured && typeof p.response_id === 'string' && p.response_id
    ? 'codex:response:' + p.response_id : null;
  const origin = 'codex:session:' + (state.sessionId || sourceId);
  // This identifies a replayed provider observation, not equal-sized independent single requests.
  const observedTime = typeof object.timestamp === 'string' && Number.isFinite(Date.parse(object.timestamp))
    ? object.timestamp : null;
  const observationKey = total && observedTime
    ? 'codex:observation:' + hash([state.sessionId || sourceId, observedTime, total]) : undefined;
  const repeated = (key: string | undefined): boolean => !!key && (state.recent.includes(key) || !!identitySource(key));
  const remember = (key: string | undefined): void => {
    if (!key || state.recent.includes(key)) return;
    state.recent.push(key);
    if (state.recent.length > CODEX_RECENT_OBSERVATIONS) state.recent.shift();
  };
  // An explicit child execution at or after creation ends the inherited prefix locally.
  if (state.inherited && structured && p.thread_id === state.sessionId && observedTime
    && state.createdMs > 0 && Date.parse(observedTime) >= state.createdMs) {
    state.inherited = false;
    state.freshOutput = true;
  }
  // Inherited records establish context only, even without the parent file.
  if (state.inherited) {
    if (total) { state.total = total; state.mode = 'cumulative'; }
    remember(observationKey);
    return null;
  }
  const link = (target: string): CodexUsageDecision => {
    remember(observationKey); remember(responseId ?? undefined);
    return { kind: 'alias', requestId: target, identityKey: target, identityOrigin: origin,
      usage: [0, 0, 0, 0], ...(observationKey ? { observationKey } : {}), ...(responseId ? { responseKey: responseId } : {}) };
  };
  // A late detail can name a previously counted observation without charging it again.
  const observationOwner = observationKey ? identitySource(observationKey) : undefined;
  if (!structured && total && state.total && repeated(observationKey)
    && total[0] <= state.total[0] && total[2] <= state.total[2]
    && (!state.notificationTotal || total[0] >= state.notificationTotal[0] && total[2] >= state.notificationTotal[2])) {
    state.notificationTotal = total;
  }
  if (observationOwner && observationKey) {
    if (total && (!state.total || identitySource(state.lastEntryId ?? '') !== sourceId)
      && (!state.total || total[0] >= state.total[0] && total[2] >= state.total[2])) {
      state.total = total; state.mode = 'cumulative'; state.lastEntryId = observationKey;
    }
    return responseId ? link(observationKey) : null;
  }
  if (!responseId && repeated(observationKey)) return null;
  const responseOwner = responseId ? identitySource(responseId) : undefined;
  const alreadyExecuted = !!responseId && (state.recent.includes(responseId) || !!responseOwner);
  if (responseOwner && responseOwner !== sourceId) {
    // A copied execution advances only a forward baseline; it never adds the same usage twice.
    if (total && (!state.total || total[0] >= state.total[0] && total[2] >= state.total[2])) {
      state.total = total; state.mode = 'cumulative'; state.lastEntryId = responseId;
    }
    remember(observationKey); remember(responseId ?? undefined);
    return null;
  }
  if (alreadyExecuted && total && state.total && (total[0] < state.total[0] || total[2] < state.total[2]
    || responseOwner && !state.recent.includes(responseId!))) {
    remember(observationKey); return null;
  }
  let usage: TokenVector | null = null;
  let id = responseId ?? physicalId;
  if (total) {
    const previous = state.total;
    const previousMode = state.mode;
    const notificationPrevious = state.notificationTotal;
    // The two cumulative views may arrive at different times. A delayed secondary view
    // cannot rewind a counted interval; primary progress is tracked independently.
    if (previous && state.lastEntryId) {
      const covered = total[0] <= previous[0] && total[2] <= previous[2];
      const primaryProgress = !notificationPrevious
        || total[0] >= notificationPrevious[0] && total[2] >= notificationPrevious[2];
      if (covered && (structured && notificationPrevious || !structured && primaryProgress && !state.freshOutput)) {
        if (!structured) state.notificationTotal = total;
        return link(state.lastEntryId);
      }
    }
    if (!structured) state.notificationTotal = total;
    if (previous && same(previous, total)) {
      if (responseId && state.lastEntryId) return link(state.lastEntryId);
      if (responseId && !alreadyExecuted && nonzero(last)) usage = last;
      else { remember(observationKey); return null; }
    } else {
      state.mode = 'cumulative';
      state.total = total;
      if (!previous || previousMode !== 'cumulative') {
        state.lastEntryId = null;
        if (previousMode === 'unset' && nonzero(last) && !alreadyExecuted
          && (same(total, last) || !!responseId || state.freshOutput)) usage = last;
      } else {
        const delta = total.map((n, i) => n - previous[i]) as TokenVector;
        if (delta[0] < 0 || delta[2] < 0) {
          state.segment += 1; state.lastEntryId = null; state.recent = [];
          if (nonzero(last) && !alreadyExecuted && (!!responseId || state.freshOutput)) usage = last;
        } else {
          delta[1] = Math.min(delta[0], Math.max(0, delta[1]));
          delta[3] = Math.min(delta[2], Math.max(0, delta[3]));
          usage = delta;
        }
      }
    }
    id = 'codex:counter:' + hash([state.sessionId || sourceId, state.generation, state.segment, total]);
  } else if (state.mode !== 'cumulative' && nonzero(last)) {
    state.mode = 'single';
    usage = last;
  }
  remember(observationKey);
  remember(responseId ?? undefined);
  state.freshOutput = false;
  if (!nonzero(usage)) return null;
  state.lastEntryId = id;
  return { kind: 'usage', requestId: id, identityKey: id, identityOrigin: origin, usage,
    ...(observationKey ? { observationKey } : {}),
    ...(responseId && !alreadyExecuted ? { responseKey: responseId } : {}) };
}
