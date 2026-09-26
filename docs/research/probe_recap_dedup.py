#!/usr/bin/env python3
"""Vérifie le fix de dédup + le nouveau « à battre » (= ouverture du round).

Mirroir EXACT de main() : aucune écriture, aucun envoi.
"""
import importlib.util, os, re, time

HOME = os.path.expanduser("~")
spec = importlib.util.spec_from_file_location("recap", "/root/.hermes/scripts/paperbot-recap.py")
recap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recap)
VOL = recap.VOL

def key_of(raw):
    keep = [ln for ln in raw.splitlines() if not ln.startswith(VOL)]
    keep = [ln for ln in keep if not ln.startswith("🔁 Round:")]
    return re.sub(r"🕐 <b>\d{2}:\d{2}</b>", "🕐 <b>--</b>", "\n".join(keep))

raw1 = recap.build_message()
k1 = key_of(raw1)

print("=== 1) fuites de prix dans la cle (doit etre vide) ===")
leaks = [ln for ln in k1.splitlines() if re.search(r"\$\d", ln)
         and any(w in ln for w in ("bitcoin", "ethereum", "solana", "xrp", "doge", "Dogecoin"))
         or ln.strip().startswith("à battre")]
leaks = [ln for ln in k1.splitlines() if ("à battre" in ln or "Bitcoin" in ln or "Ethereum" in ln
         or "Solana" in ln or "XRP" in ln or "Dogecoin" in ln)]
print("  fuites :", leaks if leaks else "AUCUNE ✅")

time.sleep(4)
k2 = key_of(recap.build_message())
print()
print("=== 2) stabilite de la cle (2 cycles a 4s d'ecart) ===")
print("  cle1 == cle2 :", k1 == k2, "✅" if k1 == k2 else "❌ TOUJOURS CASSE")
if k1 != k2:
    import difflib
    for d in difflib.unified_diff(k1.splitlines(), k2.splitlines(), lineterm=""):
        if d.startswith(("+", "-")) and not d.startswith(("+++", "---")):
            print("   ", d)

print()
print("=== 3) cle de dedup (contenu) ===")
print(k1)

print()
print("=== 4) message ENVOYE (nouveau format « à battre ») ===")
print(raw1.replace(VOL, ""))
