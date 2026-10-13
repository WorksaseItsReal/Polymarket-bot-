#!/usr/bin/env bash
# Sauvegarde du registre papier avant toute relance du bot sur un autre code : le nouveau code
# peut migrer le registre au démarrage (fv-ledger.json → fv-ledger.jsonl), et une migration
# ratée ne doit jamais coûter l'historique.
#
# Chargé par scripts/update.sh (`. scripts/lib/backup-ledger.sh`), ou
# lancé seul : bash scripts/lib/backup-ledger.sh [sha court du code qui a écrit le registre]
#
# Copie (cp -p) fv-ledger.json, fv-ledger.jsonl et fv-guard*.json, ceux qui existent, dans
#   <données>/backups/ledger-<UTC AAAAMMJJ-HHMMSS>-<sha>/
# puis ne garde que les LEDGER_BACKUP_KEEP (10) dossiers les plus récents de CE motif — rien
# d'autre n'est jamais supprimé. Code de retour non nul si la copie échoue : l'appelant ne
# relance alors pas le bot.
#
# Fonctions écrites pour être appelées dans un `if` (où `set -e` ne s'applique pas) : chaque
# étape vérifie elle-même son code de retour.

LEDGER_BACKUP_KEEP="${LEDGER_BACKUP_KEEP:-10}"
LEDGER_BACKUP_RE='^ledger-[0-9]{8}-[0-9]{6}-[0-9a-z]+(-[0-9]+)?$'

# Dossier de données du bot, résolu comme src/bot/config.ts (dataDir) : `$HOME/.polymarket`,
# HOME vide ou blanc → dossier personnel du compte (comme os.homedir()).
ledger_data_dir() {
  local home="${HOME:-}"
  home="${home#"${home%%[![:space:]]*}"}"
  home="${home%"${home##*[![:space:]]}"}"
  [ -n "$home" ] || home="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$home" ] || return 1
  printf '%s/.polymarket\n' "$home"
}

# ledger_backup_rotate <dossier backups> : supprime les plus anciens dossiers `ledger-…` au-delà
# de LEDGER_BACKUP_KEEP. Seuls les dossiers (pas les liens) au nom exact du motif sont comptés.
ledger_backup_rotate() {
  local dir="$1" names=() name i excess
  mapfile -t names < <(
    cd "$dir" 2>/dev/null || exit 0
    for name in ledger-*; do
      [ -d "$name" ] && [ ! -L "$name" ] && [[ $name =~ $LEDGER_BACKUP_RE ]] && printf '%s\n' "$name"
    done | LC_ALL=C sort
  )
  excess=$(( ${#names[@]} - LEDGER_BACKUP_KEEP ))
  for (( i = 0; i < excess; i++ )); do
    rm -rf -- "${dir:?}/${names[$i]}" || echo "   ⚠️ ancienne sauvegarde non supprimée : $dir/${names[$i]}" >&2
  done
  return 0
}

# backup_ledger [sha] : sauvegarde du registre (voir en tête). Rien à copier → succès.
backup_ledger() {
  local sha="${1:-inconnu}" data dest base n=1 f files=()
  [[ $sha =~ ^[0-9a-z]+$ ]] || sha=inconnu
  if ! data="$(ledger_data_dir)"; then
    echo "   ❌ Dossier de données introuvable (HOME vide et compte sans dossier personnel)." >&2
    return 1
  fi
  for f in "$data/fv-ledger.json" "$data/fv-ledger.jsonl" "$data"/fv-guard*.json; do
    [ -f "$f" ] && files+=("$f")
  done
  if [ "${#files[@]}" -eq 0 ]; then
    echo "   Aucun registre dans $data : rien à sauvegarder."
    return 0
  fi
  if ! mkdir -p "$data/backups"; then
    echo "   ❌ Impossible de créer $data/backups." >&2
    return 1
  fi
  base="$data/backups/ledger-$(date -u +%Y%m%d-%H%M%S)-$sha"
  dest="$base"
  # Deux sauvegardes dans la même seconde : suffixe -2, -3… (jamais d'écrasement).
  until mkdir "$dest" 2>/dev/null; do
    if [ ! -e "$dest" ] || [ "$n" -ge 100 ]; then
      echo "   ❌ Impossible de créer $dest." >&2
      return 1
    fi
    n=$(( n + 1 ))
    dest="$base-$n"
  done
  if ! cp -p -- "${files[@]}" "$dest/"; then
    rm -rf -- "$dest"
    echo "   ❌ Copie du registre impossible vers $dest (place disque ? droits ?)." >&2
    return 1
  fi
  echo "   Registre sauvegardé : $dest (${files[*]##*/})"
  ledger_backup_rotate "$data/backups"
}

# Lancé seul (et non chargé par `.`) : une sauvegarde, code de retour de backup_ledger.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  backup_ledger "$@"
fi
