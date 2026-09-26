/**
 * (3) CLÉ DE DÉDUP DU RECAP TELEGRAM — exerce le VRAI main() de paperbot-recap.py.
 *
 * Bug historique : la clé de dédup incluait des lignes VOLATILES (prix live,
 * probas, id de round) → elle changeait à chaque cycle et le recap repartait
 * toutes les 5 min. Correctif : les lignes préfixées par le marqueur interne
 * `VOL` (\x00) et la ligne `🔁 Round:` sont EXCLUES de la clé.
 *
 * On observe le fichier `last_msg` réellement écrit (redirigé vers un dossier
 * jetable via HOME) et on compte les envois effectifs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pySourcesAvailable, runHarness } from './harness.ts';

type Dedup = {
  sent_apres_appel_1: number;
  sent_apres_appel_2_prix_bouges: number;
  sent_apres_appel_3_evenement: number;
  cle_identique: boolean;
  cle_contient_marqueur: boolean;
  cle_contient_ligne_round: boolean;
  cle_contient_prix_live: boolean;
  message_envoye_contient_marqueur: boolean;
  cle_extrait: string;
};

const skip = pySourcesAvailable ? false : 'sources réelles absentes — test skippé';

let r: Dedup;
test('préparation : un cycle de dédup sur le vrai main()', { skip }, () => {
  r = runHarness<Dedup>('dedup');
  assert.equal(r.sent_apres_appel_1, 1, 'le 1er cycle envoie le recap');
});

test('la clé est IDENTIQUE sur deux appels consécutifs malgré des prix live qui bougent', { skip }, () => {
  assert.equal(r.cle_identique, true, 'la clé ne doit pas dépendre des prix live');
  assert.equal(
    r.sent_apres_appel_2_prix_bouges, 1,
    'aucun nouvel envoi : 1 seul message après 2 cycles (prix différents)',
  );
});

test('la clé ne contient JAMAIS le marqueur interne (ni le message envoyé)', { skip }, () => {
  assert.equal(r.cle_contient_marqueur, false, 'la clé ne contient pas \\x00');
  assert.equal(r.message_envoye_contient_marqueur, false, 'le message Telegram est nettoyé du marqueur');
  assert.equal(r.cle_contient_ligne_round, false, 'la ligne « 🔁 Round: » est exclue de la clé');
  assert.equal(r.cle_contient_prix_live, false, 'aucun prix live ne figure dans la clé');
});

test('un ÉVÉNEMENT réel relance bien l’envoi (la dédup n’est pas un blocage permanent)', { skip }, () => {
  assert.equal(
    r.sent_apres_appel_3_evenement, 2,
    'changement d’état → nouvel envoi (le recap ne se fige pas pour toujours)',
  );
});
