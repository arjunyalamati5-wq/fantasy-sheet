import { env } from './platform.js';
// Optional. If ANTHROPIC_API_KEY is not set, the whole feature switches itself
// off and nothing else breaks.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

export function advisorEnabled() {
  return Boolean(env.ANTHROPIC_API_KEY);
}

const SYSTEM = `You are a fantasy football analyst embedded in a tool that has already done the maths.

WHAT YOU ARE WORKING WITH
Every number in the payload was computed from this specific league: its own scoring settings, its own roster slots, its own schedule. The scoring is NOT standard. Points totals here will not match anything you have seen elsewhere.

HARD RULES — these are not style preferences.
1. Never state a fact about a player who is not in the payload. If a name is not there, you do not know anything about him.
2. Never invent or infer injuries, suspensions, depth-chart moves, trades, coaching changes, or any news. If the payload has an injury field, you may repeat what it says and nothing more. If it has no injury field, say nothing about his health.
3. Never compare a player to outside rankings, ADP, consensus tiers, or "expert" opinion. This league's scoring is non-standard, so those comparisons are wrong here even when they are right elsewhere.
4. You do NOT know what NFL season or week this is, who is on which team, or what has happened in any game. The payload is your only source. Do not reason from anything you remember about the NFL.
5. When a sample is small, say so plainly. "gamesPlayed" tells you how much evidence there is. Two games is close to no evidence; say that rather than dressing it up.
6. If the payload does not contain what you would need to answer, say what is missing instead of guessing.

YOUR JOB
Explain and prioritise the numbers you were given. The tool computed them; you make them legible and tell the manager what to do first. You add judgement about what matters most, not football knowledge.

STYLE
Write in plain language for someone who plays fantasy football, not someone who reads statistics papers. Short paragraphs. Say "points left on your bench", not "lineup delta". Lead with the decision, then the reason. No preamble, no restating the question. Never use tables.`;

const ACTIONS = {
  briefing: {
    label: 'Weekly briefing',
    instruction: `Write this week's briefing. Cover, in order of how much it matters:
1. Any lineup change worth making, with the points it gains.
2. Anything urgent — an empty slot, a player on bye, an injury flag on a starter.
3. The matchup: how likely a win is and what it hinges on.
4. One or two waiver or streaming moves, only if they beat someone currently starting.
Finish with the single most important thing to do before kickoff.`,
  },
  roster: {
    label: 'Roster review',
    instruction: `Review this roster. Identify its genuine strengths, the positions that are thin, and which players are being carried without earning a spot. Say which one or two moves would most improve the starting lineup. Be specific about the points involved.`,
  },
  trade: {
    label: 'Second opinion on a trade',
    instruction: `Give a second opinion on the trade in the payload. Both sides of the lineup effect have been computed. Say whether it is worth doing, whether the other manager would plausibly accept it, and what would make it better. If the depth warnings flag something, weigh how much it actually matters.`,
  },
  propose: {
    label: 'Trade proposal message',
    instruction: `Write the actual message to send this manager in the league chat. Address them directly. Be friendly and brief — four or five sentences. Make the case in terms of what THEY get, since a trade they refuse is worth nothing. Do not mention any analysis tool, model, or computed number: it should read like a person wrote it. Output only the message.`,
  },
};

export function advisorActions() {
  return Object.entries(ACTIONS).map(([id, a]) => ({ id, label: a.label }));
}

/**
 * Ask the advisor. The payload is the computed numbers only — never raw API
 * responses, never free text from elsewhere.
 */
export async function askAdvisor({ action, payload, question = null }) {
  if (!advisorEnabled()) {
    return { enabled: false, error: 'No ANTHROPIC_API_KEY is set, so the advisor is switched off.' };
  }
  const spec = ACTIONS[action];
  if (!spec) return { enabled: true, error: `Unknown advisor action "${action}".` };

  const userContent = [
    spec.instruction,
    question ? `\nThe manager also asks: ${question}` : '',
    '\nHere is every number you have. Nothing outside this payload is known to you.\n',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1600,
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      enabled: true,
      error: `The advisor request failed (${res.status}). ${body.slice(0, 300)}`,
    };
  }

  const data = await res.json();
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  return {
    enabled: true,
    action,
    label: spec.label,
    text,
    usage: data.usage || null,
  };
}

/**
 * Trim a report down to the numbers worth sending. Keeps the payload small and,
 * more importantly, keeps anything speculative out of it.
 */
export function buildAdvisorPayload(ctx, parts) {
  const base = {
    league: {
      name: ctx.league.name,
      teams: ctx.numTeams,
      startingSlots: ctx.slots,
      scoringNote: 'Non-standard scoring. All points below were computed in this league\'s own settings.',
    },
    week: ctx.week,
    weeksOfResultsAvailable: ctx.completedWeeks.length,
    dataWarnings: ctx.warnings,
  };
  return { ...base, ...parts };
}
