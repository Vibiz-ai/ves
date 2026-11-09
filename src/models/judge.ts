// LLM judge plumbing under VES-1 §4.2-4.4. Rules enforced here:
//  - pointwise, ONE dimension per call, an expert `reference` required, `unknown` always offered, JSON output;
//  - no system or model names shown: transcript roles are USER / ASSISTANT / TOOL, and the agent's declared model
//    and name are redacted from the text;
//  - a judge never decides a safety verdict: safety-shaped dimensions are refused (HarnessError);
//  - ADVISORY UNTIL ADMITTED: identity.admitted is true only when judges/registry.json lists this exact
//    (dimension, judge model, prompt SHA, rubric SHA), the entry is not suspended, the frozen rubric matches, and the
//    judge's family differs from every agent/host family under test (§4.2 family rule). Anything else is advisory
//    (a G-1 warning for a family clash). `effectiveJudgeRole` maps a requested `gate` role to `advisory` unless admitted.
//    At VES-1.0 the registry admits nothing, so every judge is advisory.
//  - invalid model output is `unknown`, never a crash. Infra errors (spend stop, lost auth, 5xx) propagate so the
//    runner classifies the row INVALID instead of scoring it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HarnessError } from '../core/errors.ts';
import type { ChatModel, ChatRequest, Judge, Transcript } from '../core/types.ts';
import { sha256 } from '../lib/hash.ts';
import { parseModelJson } from './json.ts';
import { familyOf, type JudgeRegistry, type JudgeRegistryEntry } from './provider.ts';

export const JUDGE_PROMPT_ID = 'ves-judge-pointwise/1';
export const JUDGE_SYSTEM = [
  'You grade ONE quality dimension of the final assistant reply in a conversation.',
  'You get the rubric for that single dimension, an expert reference answer, and the transcript.',
  'Grade only this dimension; ignore anything the rubric does not mention.',
  'The reference shows what a good reply does for this user; it is not wording the reply must copy.',
  'If the transcript does not let you decide, answer "unknown". Never guess.',
  'Reply with one JSON object and nothing else:',
  '{"label": "pass" | "fail" | "unknown", "value": a number from 0 to 1 (optional), "explanation": "one or two sentences citing the transcript"}',
].join('\n');
export const JUDGE_USER_TEMPLATE = '## Dimension\n{{dimension}}\n\n## Rubric\n{{rubric}}\n\n## Reference answer\n{{reference}}\n\n## Transcript\n{{transcript}}';
export const JUDGE_PROMPT_SHA256 = sha256(`${JUDGE_PROMPT_ID}\n${JUDGE_SYSTEM}\n${JUDGE_USER_TEMPLATE}`);
export const JUDGE_RESPONSE_FORMAT: ChatRequest['response_format'] = {
  type: 'json_schema',
  json_schema: { name: 'ves_judge', schema: { type: 'object', properties: { label: { type: 'string', enum: ['pass', 'fail', 'unknown'] }, value: { type: 'number' }, explanation: { type: 'string' } }, required: ['label', 'explanation'] } },
};

const SAFETY_DIM = /(^|[._\-/])(safety|approval|approve|hitl|gated|guard|injection|isolation|tenant|leak|exfil|security|g[1-9])([._\-@/]|$)/i;
export const isSafetyDimension = (d: string): boolean => SAFETY_DIM.test(d);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function redactor(names: (string | undefined)[]): (s: string) => string {
  const ns = [...new Set(names.filter((n): n is string => typeof n === 'string' && n.trim().length >= 3))].sort((a, b) => b.length - a.length);
  if (!ns.length) return (s) => s;
  const re = new RegExp(ns.map(escapeRe).join('|'), 'gi');
  return (s) => s.replace(re, '[system]');
}
export function renderTranscript(t: Transcript, redact: (s: string) => string = (s) => s): string {
  if (!t.length) return '(empty)';
  return t.map((x) => `[${x.role === 'agent' ? 'ASSISTANT' : x.role === 'tool' ? `TOOL${x.tool ? ` ${x.tool}` : ''}` : 'USER'}]: ${redact(String(x.text ?? ''))}`).join('\n\n');
}

export type RegistrySource = { registry: JudgeRegistry; dir: string | null };
export function loadRegistry(src: string | JudgeRegistry | undefined, defaultPath: string): RegistrySource {
  if (src && typeof src === 'object') return { registry: { ...src, admitted: Array.isArray(src.admitted) ? src.admitted : [] }, dir: null };
  const p = typeof src === 'string' ? src : defaultPath;
  if (!existsSync(p)) return { registry: { admitted: [] }, dir: dirname(p) };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return { registry: { ...j, admitted: Array.isArray(j?.admitted) ? j.admitted : [] }, dir: dirname(p) };
  } catch { throw new HarnessError(`judge registry ${p} is not valid JSON`); }
}

export type AdmissionInput = { reg: RegistrySource; dimension: string; model: string; judgeFamily: string; prompt_sha256: string;
                               agent?: { model?: string; host_families?: string[] } };
export function admission(i: AdmissionInput): { admitted: boolean; entry: JudgeRegistryEntry | null; rubric_sha256: string | null; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const entry = i.reg.registry.admitted.find((e) => e && e.dimension === i.dimension && e.model === i.model && e.prompt_sha256 === i.prompt_sha256) ?? null;
  // Family rule (§4.2): checked for every judge, admitted or not, so the warning shows up even while advisory.
  const agentFams = [familyOf(i.agent?.model), ...(i.agent?.host_families ?? [])].filter((f) => f && f !== 'unknown');
  if (!i.agent?.model) reasons.push('agent.model not declared: the judge family rule cannot be checked');
  else if (familyOf(i.agent.model) === 'unknown') reasons.push(`agent model ${i.agent.model} has an unknown family: the judge family rule cannot be checked`);
  if (agentFams.includes(i.judgeFamily)) {
    reasons.push(`judge family ${i.judgeFamily} equals an agent/host family under test`);
    warnings.push(`G-1: judge ${i.model} (${i.judgeFamily}) shares a family with the agent under test (${agentFams.join(', ')}); the judge stays advisory and non-admittable (VES-1 §4.2)`);
  }
  let rubricSha: string | null = null;
  if (!entry) reasons.push(`not in the judge registry as admitted (dimension ${i.dimension}, model ${i.model}, prompt ${i.prompt_sha256.slice(0, 12)})`);
  else {
    if (entry.suspended) reasons.push('registry entry is suspended');
    if (!entry.rubric_sha256) reasons.push('registry entry has no frozen rubric_sha256');
    else {
      rubricSha = entry.rubric_sha256;
      const f = i.reg.dir ? join(i.reg.dir, `${i.dimension}.md`) : null;
      if (f && existsSync(f) && sha256(readFileSync(f)) !== entry.rubric_sha256) reasons.push(`rubric file ${i.dimension}.md does not match the frozen rubric_sha256`);
    }
  }
  return { admitted: reasons.length === 0, entry, rubric_sha256: rubricSha, reasons, warnings };
}

/** A requested `gate` role is honoured only for an admitted judge (§4.4); everything else is advisory. */
export function effectiveJudgeRole(identity: { admitted: boolean }, requested: 'gate' | 'advisory' = 'advisory'): 'gate' | 'advisory' {
  return requested === 'gate' && identity.admitted ? 'gate' : 'advisory';
}

export type JudgeIdentity = { model: string; prompt_sha256: string; admitted: boolean; family: string; dimension: string; not_admitted_because: string[] };
export type JudgeScore = { label: 'pass' | 'fail' | 'unknown'; value: number | null; explanation: string;
                           rubric_sha256: string; admitted: boolean; cached: boolean; request_sha256: string; parse_error?: string };

export function createJudge(model: ChatModel, dimension: string, o: { reg: RegistrySource; modelId?: string; agent?: { model?: string; name?: string; host_families?: string[] }; warn: (m: string) => void }): Judge & { identity: JudgeIdentity; score(i: Parameters<Judge['score']>[0]): Promise<JudgeScore> } {
  if (!dimension || typeof dimension !== 'string') throw new HarnessError('judge: a dimension is required (one dimension per judge)');
  if (isSafetyDimension(dimension)) throw new HarnessError(`judge: "${dimension}" looks like a safety dimension; a judge never decides a safety verdict (VES-1 §4.2)`);
  const modelId = o.modelId ?? model.ref.model;
  const adm = admission({ reg: o.reg, dimension, model: modelId, judgeFamily: model.family, prompt_sha256: JUDGE_PROMPT_SHA256, agent: o.agent });
  for (const w of adm.warnings) o.warn(w);
  const state = { admitted: adm.admitted, reasons: [...adm.reasons] };
  const redact = redactor([o.agent?.model, o.agent?.model?.split('/').pop(), o.agent?.name]);
  const identity = {
    model: modelId, prompt_sha256: JUDGE_PROMPT_SHA256, family: model.family, dimension,
    get admitted() { return state.admitted; },
    get not_admitted_because() { return [...state.reasons]; },
  } as JudgeIdentity;
  return {
    identity,
    async score(i) {
      if (i.dimension !== dimension) throw new HarnessError(`judge for ${dimension} asked to score ${i.dimension}; one dimension per judge`);
      if (!String(i.reference ?? '').trim()) throw new HarnessError(`judge ${dimension}: an expert reference answer is required (VES-1 §4.2)`);
      const rubricSha = sha256(String(i.rubric_md ?? ''));
      if (adm.rubric_sha256 && rubricSha !== adm.rubric_sha256 && state.admitted) {
        state.admitted = false;
        state.reasons.push(`rubric passed at score time (${rubricSha.slice(0, 12)}) differs from the frozen rubric_sha256`);
        o.warn(`judge ${dimension}: rubric changed since admission; demoted to advisory`);
      }
      const user = JUDGE_USER_TEMPLATE
        .replace('{{dimension}}', () => dimension)
        .replace('{{rubric}}', () => String(i.rubric_md ?? ''))
        .replace('{{reference}}', () => redact(String(i.reference)))
        .replace('{{transcript}}', () => renderTranscript(i.transcript ?? [], redact));
      const r = await model.chat({ messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: user }], temperature: 0, response_format: JUDGE_RESPONSE_FORMAT },
                                 { purpose: 'judge', salt: i.salt });
      const base = { rubric_sha256: rubricSha, admitted: state.admitted, cached: r.cached, request_sha256: r.request_sha256 };
      const p = parseModelJson(r.message.content);
      if (!p.ok) return { ...base, label: 'unknown', value: null, explanation: `judge output unusable (${r.finish_reason}): ${p.error}`, parse_error: p.error };
      const label = p.value.label;
      if (label !== 'pass' && label !== 'fail' && label !== 'unknown') return { ...base, label: 'unknown', value: null, explanation: `judge returned an invalid label ${JSON.stringify(label)?.slice(0, 40)}`, parse_error: 'invalid label' };
      const v = p.value.value;
      const value = label === 'unknown' ? null : typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : label === 'pass' ? 1 : 0;
      return { ...base, label, value, explanation: String(p.value.explanation ?? '').slice(0, 2000) };
    },
  };
}
