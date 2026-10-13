/**
 * tests/llm-schema.test.ts — validation stricte des réponses des agents (stratégie llm,
 * papier) : lecture du JSON, clés exactes, bornes, cohérence prix/probabilité, sécurité qui
 * ne peut que réduire la mise, assemblage final par le code, schémas JSON équivalents.
 * Exécution : `npx tsx --test tests/llm-schema.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSE_JSON_SCHEMA,
  DECISION_JSON_SCHEMA,
  SCHEMA_VERSION,
  SECURITE_JSON_SCHEMA,
  assembleFinal,
  expectedKeys,
  feePerShare,
  jsonSchemaFor,
  parseAgentJson,
  validateAnalyse,
  validateDecision,
  validateSecurite,
  type Analyse,
  type Decision,
  type Securite,
} from '../src/strategy/llm/schema.ts';
import { buildSnapshot } from '../src/strategy/llm/snapshot.ts';
import { abstentionDecision, baseInput, validAnalyse, validDecision, validSecurite } from './fixtures/llm-fixtures.ts';

const FEE = 0.07;

function code(c: { ok: boolean; code?: string }): string {
  return c.ok ? 'ok' : (c as { code: string }).code;
}

test('lecture : un objet JSON seul, éventuellement dans un bloc ```json ; sinon json_invalide', () => {
  const obj = { a: 1 };
  assert.deepEqual(parseAgentJson('{"a":1}', null), { ok: true, value: obj });
  assert.deepEqual(parseAgentJson('  {"a":1}\n', null), { ok: true, value: obj });
  assert.deepEqual(parseAgentJson('```json\n{"a":1}\n```', null), { ok: true, value: obj });
  assert.deepEqual(parseAgentJson('```\n{"a":1}\n```', null), { ok: true, value: obj });
  for (const bad of ['', 'Je recommande d\'acheter Up.', 'Voici : {"a":1}', '{"a":1} merci', '[{"a":1}]', '{"a":1}{"b":2}', 'null', '{"a":', '```js\n{"a":1}\n```', 'texte ```json\n{"a":1}\n```']) {
    assert.equal(code(parseAgentJson(bad, null)), 'json_invalide', bad);
  }
  assert.equal(code(parseAgentJson(undefined, null)), 'json_invalide');
});

test('lecture : la sortie structurée prime sur le texte ; elle doit être un objet', () => {
  assert.deepEqual(parseAgentJson('pas du JSON', { a: 2 }), { ok: true, value: { a: 2 } });
  assert.equal(code(parseAgentJson('{"a":1}', [1, 2])), 'json_invalide');
  assert.equal(code(parseAgentJson('{"a":1}', 'texte')), 'json_invalide');
  assert.deepEqual(parseAgentJson('{"a":1}', null), { ok: true, value: { a: 1 } }, 'null : on lit le texte');
});

test('analyste : réponse valide ; clé manquante, clé en trop (dont toute recommandation), valeurs invalides', () => {
  assert.equal(code(validateAnalyse(validAnalyse())), 'ok');
  assert.equal(code(validateAnalyse({ ...validAnalyse(), proba_carnet_up: null, spread_up: null, spread_down: null, risques: [] })), 'ok');

  const missing = validAnalyse();
  delete missing.observations;
  assert.equal(code(validateAnalyse(missing)), 'champ_manquant');

  for (const k of ['recommandation', 'action', 'pari', 'cote_conseille', '__proto__']) {
    const extra = validAnalyse();
    Object.defineProperty(extra, k, { value: 'acheter_up', enumerable: true, configurable: true, writable: true });
    assert.equal(code(validateAnalyse(extra)), 'champ_inattendu', k);
  }
  // Une clé en trop prime sur une clé manquante (clé renommée).
  const renamed = validAnalyse();
  delete renamed.z;
  renamed.Z = 0.6;
  assert.equal(code(validateAnalyse(renamed)), 'champ_inattendu');

  const bad: Array<[string, unknown]> = [
    ['tendance', 'monte'],
    ['ecart_relatif', '0.0004'],
    ['z', null],
    ['proba_formule_up', 1.2],
    ['proba_formule_up', -0.01],
    ['proba_carnet_up', 2],
    ['liquidite', 'moyenne'],
    ['spread_up', 'x'],
    ['risques', ['a', 'b', 'c', 'd', 'e', 'f']],
    ['risques', ['x'.repeat(151)]],
    ['risques', [1]],
    ['risques', 'un risque'],
    ['observations', 'é'.repeat(301)],
    ['observations', null],
  ];
  for (const [k, v] of bad) assert.equal(code(validateAnalyse({ ...validAnalyse(), [k]: v })), 'valeur_invalide', `${k} = ${JSON.stringify(v)}`);
  assert.equal(code(validateAnalyse({ ...validAnalyse(), observations: 'é'.repeat(300) })), 'ok', '300 caractères (pas octets) : accepté');
  assert.equal(code(validateAnalyse([validAnalyse()])), 'json_invalide');
});

test('décideur : achat et abstention valides ; P(Up) hors [0, 1], prix limite hors ]0, 1[, mise ≤ 0 → valeur_invalide', () => {
  assert.equal(code(validateDecision(validDecision(), FEE)), 'ok');
  assert.equal(code(validateDecision(abstentionDecision(), FEE)), 'ok');
  assert.equal(code(validateDecision(validDecision({ action: 'acheter_down', proba_estimee: 0.2, prix_limite: 0.7 }), FEE)), 'ok');
  assert.equal(code(validateDecision(validDecision({ desaccord_formule: 'Le carnet contredit la formule.' }), FEE)), 'ok');

  for (const [k, v] of [
    ['proba_estimee', 1.2], ['proba_estimee', -0.1], ['proba_estimee', null], ['proba_estimee', '0.8'],
    ['prix_limite', 1], ['prix_limite', 0], ['prix_limite', 1.01],
    ['mise_usd', 0], ['mise_usd', -1], ['mise_usd', '1.5'],
    ['action', 'acheter'], ['action', 'ACHETER_UP'],
    ['raison', 'x'.repeat(301)], ['raison', null], ['desaccord_formule', 'x'.repeat(301)],
  ] as Array<[string, unknown]>) {
    assert.equal(code(validateDecision(validDecision({ [k]: v }), FEE)), 'valeur_invalide', `${k} = ${JSON.stringify(v)}`);
  }
  const missing = validDecision();
  delete missing.desaccord_formule;
  assert.equal(code(validateDecision(missing, FEE)), 'champ_manquant');
  assert.equal(code(validateDecision(validDecision({ confiance: 0.9 }), FEE)), 'champ_inattendu');
});

test('décideur : cohérence — abstention sans prix ni mise, achat avec les deux, prix limite + frais ≤ probabilité du côté', () => {
  assert.equal(code(validateDecision(abstentionDecision({ mise_usd: 1 }), FEE)), 'incoherence');
  assert.equal(code(validateDecision(abstentionDecision({ prix_limite: 0.5 }), FEE)), 'incoherence');
  assert.equal(code(validateDecision(validDecision({ mise_usd: null }), FEE)), 'incoherence');
  assert.equal(code(validateDecision(validDecision({ prix_limite: null }), FEE)), 'incoherence');

  // Up : 0,79 + 0,07·0,79·0,21 = 0,8016 > 0,80.
  assert.equal(code(validateDecision(validDecision({ prix_limite: 0.79 }), FEE)), 'incoherence');
  // Sans frais, le même prix passerait : les frais comptent.
  assert.equal(code(validateDecision(validDecision({ prix_limite: 0.79 }), 0)), 'ok');
  // Limite exacte : prix + frais = probabilité → accepté.
  const p = 0.7;
  const exact = p + feePerShare(p, FEE);
  assert.equal(code(validateDecision(validDecision({ prix_limite: p, proba_estimee: exact }), FEE)), 'ok');
  // Down : la probabilité du côté est 1 − P(Up).
  assert.equal(code(validateDecision(validDecision({ action: 'acheter_down', proba_estimee: 0.8, prix_limite: 0.25 }), FEE)), 'incoherence');
  assert.equal(code(validateDecision(validDecision({ action: 'acheter_down', proba_estimee: 0.6, prix_limite: 0.35 }), FEE)), 'ok');
  // Taux de frais invalide : échoue fermé.
  assert.equal(code(validateDecision(validDecision(), Number.NaN)), 'incoherence');
});

test('sécurité : verdicts valides ; mise ajustée supérieure → incoherence (on ne peut que réduire)', () => {
  const dec = { mise_usd: 1.5 };
  assert.equal(code(validateSecurite(validSecurite(), dec)), 'ok');
  assert.equal(code(validateSecurite(validSecurite({ verdict: 'veto', motifs: ['risque bloqué'] }), dec)), 'ok');
  assert.equal(code(validateSecurite(validSecurite({ mise_ajustee: 1 }), dec)), 'ok');
  assert.equal(code(validateSecurite(validSecurite({ mise_ajustee: 1.5 }), dec)), 'ok', 'égale : pas une hausse');
  assert.equal(code(validateSecurite(validSecurite({ mise_ajustee: 1.51 }), dec)), 'incoherence');
  assert.equal(code(validateSecurite(validSecurite({ mise_ajustee: 1 }), { mise_usd: null })), 'incoherence');
  assert.equal(code(validateSecurite(validSecurite({ mise_ajustee: 0 }), dec)), 'valeur_invalide');
  assert.equal(code(validateSecurite(validSecurite({ verdict: 'approuve' }), dec)), 'valeur_invalide');
  assert.equal(code(validateSecurite(validSecurite({ motifs: ['x'.repeat(201)] }), dec)), 'valeur_invalide');
  assert.equal(code(validateSecurite(validSecurite({ motifs: ['a', 'b', 'c', 'd', 'e', 'f'] }), dec)), 'valeur_invalide');
  assert.equal(code(validateSecurite(validSecurite({ nouvelle_mise: 3 }), dec)), 'champ_inattendu');
  const missing = validSecurite();
  delete missing.motifs;
  assert.equal(code(validateSecurite(missing, dec)), 'champ_manquant');
});

test('assemblage final par le code : achat approuvé, mise réduite, veto → abstention (proba gardée), sécurité absente → abstention', () => {
  const snap = buildSnapshot(baseInput());
  const a = validAnalyse() as unknown as Analyse;
  const d = validDecision() as unknown as Decision;
  const ok = assembleFinal(snap, a, d, validSecurite() as unknown as Securite);
  assert.deepEqual(ok, {
    round_id: snap.round_id,
    actif: 'BTC',
    action: 'acheter_up',
    proba_estimee: 0.8,
    prix_limite: 0.72,
    mise_usd: 1.5,
    raison: d.raison,
    analyse: a,
    securite: { verdict: 'ok', motifs: ['contrôles passés'], mise_ajustee: null },
  });
  assert.equal(assembleFinal(snap, a, d, validSecurite({ mise_ajustee: 1 }) as unknown as Securite).mise_usd, 1);

  const veto = assembleFinal(snap, a, d, validSecurite({ verdict: 'veto', motifs: ['doute'], mise_ajustee: 1 }) as unknown as Securite);
  assert.equal(veto.action, 'abstention');
  assert.equal(veto.proba_estimee, 0.8, 'probabilité gardée pour le Brier');
  assert.equal(veto.prix_limite, null);
  assert.equal(veto.mise_usd, null);
  assert.equal(veto.securite?.verdict, 'veto');

  const noSec = assembleFinal(snap, a, d, null);
  assert.equal(noSec.action, 'abstention', 'jamais d\'achat sans verdict de sécurité');
  assert.equal(noSec.mise_usd, null);
  assert.equal(noSec.securite, null);
});

test('schémas JSON draft-07 : mêmes clés que les validateurs, toutes requises, aucune clé en plus', () => {
  assert.match(SCHEMA_VERSION, /^sch-\d+$/);
  const samples = { analyste: validAnalyse(), decideur: validDecision(), securite: validSecurite() } as const;
  for (const role of ['analyste', 'decideur', 'securite'] as const) {
    const s = jsonSchemaFor(role) as { $schema: string; type: string; additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
    assert.equal(s.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(s.type, 'object');
    assert.equal(s.additionalProperties, false);
    assert.deepEqual([...s.required].sort(), Object.keys(samples[role]).sort());
    assert.deepEqual(Object.keys(s.properties).sort(), Object.keys(samples[role]).sort());
    assert.deepEqual(expectedKeys(role).sort(), Object.keys(samples[role]).sort());
  }
  assert.equal(jsonSchemaFor('analyste'), ANALYSE_JSON_SCHEMA);
  assert.equal(jsonSchemaFor('decideur'), DECISION_JSON_SCHEMA);
  assert.equal(jsonSchemaFor('securite'), SECURITE_JSON_SCHEMA);
  const props = DECISION_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(props.proba_estimee, { type: 'number', minimum: 0, maximum: 1 });
  assert.deepEqual(props.prix_limite, { type: ['number', 'null'], exclusiveMinimum: 0, exclusiveMaximum: 1 });
  assert.deepEqual(props.action, { type: 'string', enum: ['acheter_up', 'acheter_down', 'abstention'] });
  const aProps = ANALYSE_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(aProps.risques, { type: 'array', items: { type: 'string', maxLength: 150 }, maxItems: 5 });
});
