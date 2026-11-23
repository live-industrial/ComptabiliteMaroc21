# Comptabilité Maroc PRO 2.5

Application web locale (Node.js / Express / SQLite), interface française. Version 2.3 = refonte UX + moteur comptable professionnel.

## Démarrage
- **Windows** : installer Node.js 22 LTS, double-cliquer `DEMARRER.bat`, ouvrir http://localhost:3000, créer l'administrateur.
- **Docker** : `cp .env.example .env` (changer `JWT_SECRET`), puis `docker compose up -d --build`.
- **Tests** : `npm test` (démarre le serveur sur une base temporaire et vérifie le flux comptable complet).

## Nouveautés 2.3
**Moteur comptable**
- Factures et règlements **génèrent automatiquement leurs écritures** (partie double), liées à la pièce d'origine.
- Numérotation **continue** des écritures par journal et exercice (`VEN/2026/00001`) et des factures (`FA-2026-0001`).
- **Contre-passation** guidée ; annulation de facture (écriture inversée). Une écriture validée n'est jamais modifiée.
- **Exercices** : saisie refusée hors exercice ou sur exercice **clôturé** ; clôture/réouverture tracées.
- Calculs en **décimal exact** (plus de flottants), arrondi par ligne, avoirs correctement signés.
- Paramétrage des comptes/journaux de comptabilisation par dossier.

**États & rapports** : balance, grand livre (avec soldes cumulés), journal, TVA collectée/déductible, compte de résultat, bilan simplifié (contrôle actif = passif + résultat), balance âgée clients/fournisseurs ; export CSV ; impression.

**Sécurité & administration** : rôles par dossier (administrateur / comptable / lecteur en lecture seule), gestion des utilisateurs, limitation des tentatives de connexion, CSP stricte, sauvegarde/export réservés aux administrateurs, sauvegarde **automatique quotidienne** avec rotation, écriture atomique de la base, journal d'audit.

**UX** : thème clair/sombre, navigation groupée, menu mobile, palette de commandes (`Ctrl+K`), tableau de bord avec graphique animé, facture multi-lignes avec totaux en direct, impression de facture (ICE/IF/RC), notifications, filtres, animations (désactivées si le système le demande).

**Corrigés** : formulaire de saisie multi-lignes (plantait), virements internes (erreur SQL), pages Rapports et Paramètres (inexistantes), règlements d'avoirs (sens inversé), tableau de bord (avoirs ajoutés au lieu de soustraits), sauvegarde exposée à tout utilisateur connecté.

## Interface (mise à jour visuelle)
Couleur principale **#7e306e** (violet), navigation **en haut** avec méga-menus par groupe, indicateur animé, fil d'Ariane, bouton « Créer » (raccourcis facture, OCR, règlement, écriture…), thème clair/sombre, et sur mobile une barre flottante en bas + menu plein écran. Aucune fonction métier n'a été modifiée.

## Double authentification (2FA) — Google Authenticator
Menu compte (avatar en haut à droite) → **Sécurité & 2FA** → scanner le QR code avec Google Authenticator, Microsoft Authenticator ou Authy, saisir le code, puis **conserver les 10 codes de secours** (usage unique, affichés une seule fois).
- Connexion en 2 étapes : mot de passe, puis code à 6 chiffres. Un code ne peut pas être réutilisé (anti-rejeu) ; 5 codes faux = blocage 15 min.
- Secret TOTP **chiffré** en base (AES-256-GCM, clé dérivée de `JWT_SECRET`, ou de `TOTP_KEY` si défini). **Ne changez jamais `JWT_SECRET`/`TOTP_KEY` après activation** : les 2FA existantes deviendraient inutilisables (l'administrateur peut alors les réinitialiser : Utilisateurs → Réinit. 2FA).
- Téléphone perdu : utilisez un code de secours ; sinon un administrateur réinitialise votre 2FA. **Si l'unique administrateur perd téléphone ET codes de secours**, la récupération passe par la base de données : gardez vos codes et vos sauvegardes.
- L'heure du téléphone doit être exacte (réglage automatique).

## Nouveautés 2.4
- **OCR de factures fournisseur** (Factures → « Scanner une facture ») : photo/scan PNG-JPG ou PDF avec texte. Lecture **100 % locale** (Tesseract, hors-ligne). Extraction de l'ICE, IF, n°, dates, HT/TVA/TTC avec contrôle de cohérence, reconnaissance du fournisseur (par ICE puis par nom), alerte de doublon, création du fournisseur en un clic. **Vous validez toujours avant enregistrement** ; l'image est conservée en pièce jointe.
- **Pièces jointes** sur factures et écritures (PNG/JPG/WEBP/PDF, 10 Mo, contrôle du type réel du fichier).
- **Plan comptable** : plan de référence indicatif (~90 comptes inspirés du CGNC) et **import CSV** de votre propre plan (Paramètres).
- **États par rubriques CGNC** : CPC (exploitation → financier → courant → non courant → impôts → résultat net) et bilan par masses avec contrôle d'équilibre.
- **Pointage bancaire** : import de relevés CSV (colonnes Date / Libellé / Débit / Crédit ou Montant), anti-doublons, **propositions de rapprochement** (montant, date, n° de facture) et création du règlement en un clic.
- **Amortissements** : catégories d'immobilisations avec comptes, échéancier linéaire au prorata des mois, **comptabilisation des dotations** (une fois par an et par bien).

## Limites supplémentaires (2.4)
- OCR : PDF scannés = à exporter en image ; écriture manuscrite non fiable ; factures à plusieurs taux de TVA = saisie des lignes à la main. Toujours relire.
- Le plan de référence et les rubriques CGNC sont **indicatifs, non officiels** : faites-les valider. Liasse fiscale, ETIC, états de synthèse officiels et fichiers DGI **ne sont pas** générés.
- Import bancaire : formats CSV variables selon les banques ; vérifiez le premier import.
- Amortissements : cessions/mises au rebut non gérées ; convention de prorata à valider.
- Au premier lancement après mise à jour, `npm install` télécharge les modules OCR (connexion Internet requise une seule fois).

## Limites — à lire avant usage réel
- Le plan de comptes fourni est **un modèle de départ**, pas le CGNC complet ; vérifiez codes, libellés et comptes de TVA avec un professionnel.
- Bilan/CPC **simplifiés**, non conformes aux états officiels ; la TVA est **indicative** (calcul sur factures), non prête pour déclaration.
- Pas encore : écritures de clôture/à-nouveaux, TVA prête à déclarer, paie (CNSS/AMO/IR), devis/bons de commande, relances, analytique, stock, 2FA, PostgreSQL, multi-devises.
- Application conçue pour un réseau local de confiance : **ne pas l'exposer à Internet** sans reverse proxy HTTPS.
- Le logiciel n'est pas certifié ; faites valider les règles comptables et fiscales par un expert-comptable.

## Sauvegarde / restauration
Automatique chaque jour dans `backups/auto-AAAA-MM-JJ.sqlite` (30 jours). Manuelle : Paramètres → Sauvegardes, ou `SAUVEGARDE.bat`. Restauration : arrêter le serveur, remplacer `database/comptabilite.sqlite` (`RESTAURATION.bat`).
