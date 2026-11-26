# Explora

Navigateur de bureau perso (Windows), fait maison avec [Electron](https://www.electronjs.org/).
Objectif : passer très facilement d'un moteur de recherche ou d'une IA (Claude, etc.) à l'autre.

## Installer / mettre à jour

1. Générer l'installeur (voir ci-dessous) ou récupérer `dist/Explora-Setup-<version>.exe`.
2. Lancer l'installeur. L'installation se fait **pour l'utilisateur courant, sans droits
   administrateur** ; le dossier est modifiable (par défaut
   `%LOCALAPPDATA%ProgramsExplora`). Raccourcis créés sur le Bureau et dans le menu Démarrer.
3. **Windows SmartScreen** peut avertir au premier lancement de l'installeur, car il n'est pas signé
   (usage perso) : cliquer sur **« Informations complémentaires »** puis **« Exécuter quand même »**.

Pour **mettre à jour**, relancer simplement l'installeur d'une version plus récente par-dessus.

Les réglages, onglets et connexions sont dans `%APPDATA%\Explora` : ils sont conservés lors
des mises à jour **et** de la désinstallation (Paramètres Windows > Applications > Explora, ou
`Uninstall Explora.exe` dans le dossier d'installation). Pour repartir de zéro, supprimer ce
dossier à la main après désinstallation. Le même dossier est utilisé par `npm start`.

**Ancien nom « Custom Nav »** : au premier lancement d'Explora, le dossier `%APPDATA%\custom-nav` est
copié vers `%APPDATA%\Explora` (réglages, onglets, favoris, connexions) ; l'ancien dossier est laissé
en place comme sauvegarde. Les anciennes adresses `customnav://…` ouvrent la page `explora://…`
correspondante. L'identifiant de l'app ayant changé, désinstaller « Custom Nav » à la main
(Paramètres Windows > Applications).

### Générer l'installeur

```bash
npm install
npm run dist
```

Résultat : `dist/Explora-Setup-<version>.exe` (NSIS, Windows x64, via
[electron-builder](https://www.electron.build/)). Le dossier `dist/` n'est pas versionné.

Les logos sont dans `assets/brand/` en SVG (sources de référence) et en PNG : versions fond
clair / fond sombre, avec ou sans le texte « Explora ». L'icône de l'app est générée depuis
`assets/brand/logo-fond-clair.svg` : après l'avoir modifié, `npm run icon` régénère
`build/icon.ico` (multi-tailles) et `build/icon.png`. La page d'accueil affiche
`src/internal/img/logo-full-*.svg` (copies des logos complets) selon le thème clair ou sombre.

## Lancer depuis les sources

Prérequis : [Node.js](https://nodejs.org/) 22.12 ou plus récent.

```bash
npm install
npm start
```

`npm install` télécharge aussi le binaire Electron (script `postinstall`).

## Fonctionnalités

- Barre d'onglets : nouvel onglet, fermeture (bouton × ou clic molette), changement d'onglet ; clic droit sur un
  onglet : recharger, dupliquer, fermer, fermer les autres onglets / ceux à droite / ceux à gauche
- Boutons précédent / suivant / recharger (devient « arrêter » pendant le chargement)
- Barre d'adresse : une URL (`github.com`, `https://…`, `localhost:3000`) ou du texte → recherche avec le moteur / l'IA actif
- Les liens `target=_blank` et `window.open` s'ouvrent dans un nouvel onglet
- Connexions conservées entre les lancements (session persistante `persist:main`)
- Page d'accueil interne pour les nouveaux onglets : grande barre de recherche, pastilles moteurs / IA et raccourcis
- Onglets intégrés à la barre de titre, sur la même ligne que les boutons Windows (réduire, agrandir,
  fermer) ; la fenêtre se déplace en tirant la zone vide de la barre d'onglets (double-clic = agrandir)
- Menu **☰** en haut à droite : nouvel onglet, nouvelle fenêtre privée, favoris, extensions, outils de
  développement, paramètres
- Page de réglages (menu ☰ ou `Ctrl+,`) : moteurs / IA, page d'accueil, raccourcis, thème, session
- Navigation privée (menu ☰ ou `Ctrl+Shift+N`), voir ci-dessous
- Barre latérale à gauche : WhatsApp, Discord, Messenger, Telegram, Slack, Spotify… et sites personnalisés, voir ci-dessous
- Historique (`Ctrl+H`, menu ☰ ou lien en bas de la page d'accueil) : pages visitées groupées par jour, recherche, suppression d'une page, d'une sélection ou d'une période. Rien n'est enregistré en navigation privée ; conservé 90 jours dans `history.json`
- Outils de développement (les DevTools de Chrome) ancrés à droite de la page : `F12`, `Ctrl+Shift+I`,
  menu ☰, ou clic droit > « Inspecter l'élément »
- Onglet « Renvoyer » dans les outils de développement : modifier une requête réseau (méthode, URL,
  en-têtes, corps) et la renvoyer, comme « Modifier et renvoyer » de Firefox, voir ci-dessous
- Favoris : étoile dans la barre d'adresse, barre de favoris, dossiers, import depuis Chrome / Edge / Brave, voir ci-dessous
- **Écran partagé** : plusieurs onglets côte à côte dans la fenêtre (jusqu'à 4), par exemple Google
  d'un côté et Google Sheets de l'autre, voir ci-dessous

### Écran partagé

- Bouton **▯▯** de la barre d'outils, `Ctrl+Shift+S` ou menu ☰ > « Écran partagé » : ouvre un nouveau
  panneau à droite de l'onglet courant (la barre d'adresse est prête pour taper l'adresse ou la recherche).
  Même bouton / raccourci pour fermer l'écran partagé : les onglets restent ouverts, séparément.
- Clic droit sur un autre onglet > « Afficher à côté de l'onglet actif » : le met dans l'écran partagé
  (jusqu'à 4 panneaux). Clic droit sur un lien > « Ouvrir le lien dans l'écran partagé ».
- Le panneau actif (entouré d'un liseré) est celui que pilotent la barre d'adresse, Précédent, Recharger,
  les pastilles moteurs / IA… : il suffit de cliquer dans un panneau pour le rendre actif.
- **Séparateur** entre les panneaux : glisser pour redimensionner, double-clic pour des parts égales.
- Dans la barre d'onglets, les onglets d'un écran partagé sont collés et soulignés d'un trait de couleur ;
  cliquer sur l'un d'eux réaffiche tout l'écran partagé. Clic droit : retirer de l'écran partagé,
  inverser les panneaux, fermer l'écran partagé.
- Les écrans partagés (et la taille des panneaux) sont rouverts au lancement suivant avec les onglets.

### Modifier et renvoyer une requête

Les DevTools de Chrome n'ont pas « Modifier et renvoyer » (Firefox l'a) : Explora ajoute un onglet
**Renvoyer** aux outils de développement (`F12`, puis l'onglet « Renvoyer », éventuellement derrière `»`).

- La liste montre les requêtes de la page depuis l'ouverture des outils (rechargez la page pour voir les
  premières). Un clic charge la requête dans l'éditeur ; « Nouvelle » part d'une requête vide.
- Méthode, URL, en-têtes (un par ligne, `Nom: valeur`, `#` pour désactiver une ligne) et corps sont
  modifiables. `Ctrl+Entrée` ou « Envoyer » renvoie la requête ; la réponse (statut, durée, en-têtes,
  corps, JSON mis en forme) s'affiche en dessous.
- **Depuis le navigateur** (par défaut, comme Firefox) : envoyée avec la session de l'onglet, cookies
  compris, sans restriction CORS. Un en-tête `Cookie` saisi remplace les cookies de la session.
  `Host`, `Origin`, `Content-Length`, `Sec-Fetch-*`… restent gérés par le navigateur.
- **Depuis la page** : `fetch()` exécuté dans la page, la requête apparaît dans l'onglet Réseau, mais
  CORS s'applique et les en-têtes interdits aux pages (`Cookie`, `Referer`, `Origin`…) sont ignorés.

Fonctionne aussi en navigation privée (avec les cookies de la fenêtre privée).

### Favoris

- **☆ / `Ctrl+D`** : ajoute la page courante à la barre de favoris, ou l'en retire si elle y est déjà
  (l'étoile devient ★).
- **Barre de favoris** sous la barre d'outils (`Ctrl+Shift+B` pour l'afficher / la masquer) : clic pour
  ouvrir dans l'onglet courant, `Ctrl+clic` ou clic molette pour un nouvel onglet, clic sur un dossier
  pour son menu (sous-dossiers, « Tout ouvrir »), clic droit pour ouvrir / supprimer / gérer. Les favoris
  qui ne tiennent pas dans la largeur passent dans le menu **»**.
- **Gestionnaire** (`Ctrl+Shift+O`, ou « ★ Favoris » sur la page d'accueil, `explora://bookmarks/`) :
  recherche, renommer, changer l'adresse, créer des dossiers (imbriqués), déplacer, réordonner, supprimer.
  Tout est enregistré immédiatement dans `settings.json` (clé `bookmarks`).
- **Import** depuis Google Chrome, Microsoft Edge ou Brave (profil par défaut, s'il est installé) : copie
  leurs favoris dans un dossier « Importés de … », sans rien modifier dans l'autre navigateur. Seules les
  adresses `http://` et `https://` sont reprises.

Les tuiles sous la recherche de la page d'accueil sont des **raccourcis** à part, réglables dans les réglages.

### Bloqueur de publicités intégré

Activé par défaut, dans les fenêtres normales **et** privées. Il repose sur le moteur open source de
[Ghostery](https://github.com/ghostery/adblocker) (`@ghostery/adblocker-electron`, licence MPL-2.0) avec les
listes EasyList, EasyPrivacy, filtres uBlock Origin, Peter Lowe et Liste FR :

- blocage des requêtes de pub et de traqueurs, et masquage des emplacements de pub dans les pages
  (filtres cosmétiques) ;
- le **bouclier** à droite de la barre d'adresse affiche le nombre d'éléments bloqués sur la page ; un clic
  ouvre un menu pour **autoriser les pubs sur ce site** (utile si un site ne s'affiche pas bien ou refuse les
  bloqueurs), désactiver le bloqueur partout, ou ouvrir ses réglages ;
- dans les réglages (section « Bloqueur de publicités ») : activer / désactiver, liste des sites autorisés,
  mise à jour manuelle des listes. Les listes sont téléchargées au premier lancement, compilées et mises en
  cache dans `%APPDATA%\Explora\adblock-engine.bin`, puis rafraîchies tous les 3 jours. Sans réseau, le
  cache existant est utilisé.

Limites : certains sites détectent les bloqueurs et demandent de les désactiver ; les pubs YouTube
dépendent de scripts que YouTube change souvent, le blocage peut y être imparfait.

### Traduction des pages (locale, sans Google)

Traduction intégrée avec [Bergamot](https://browser.mt/), le moteur de **Firefox Translations**
(`@browsermt/bergamot-translator`, licence MPL-2.0) : le texte est traduit **sur le PC**, rien n'est envoyé à
un service en ligne. Seuls les modèles de langue sont téléchargés une fois (25 à 70 Mo par langue, vérifiés par
empreinte SHA-256) dans `%APPDATA%\custom-nav\translation`.

- **Bouton 文A dans la barre d'adresse** : il apparaît quand la page est dans une autre langue que la langue
  choisie (le français par défaut). Un clic ouvre le menu : traduire, afficher la page originale, corriger la
  langue de la page, changer la langue de destination, **toujours traduire** une langue. Pendant la traduction,
  le bouton clignote avec le pourcentage ; une fois la page traduite, il est en surbrillance.
- **Menu ☰ ou clic droit dans la page** : « Traduire la page » / « Afficher la page originale ».
- **Texte sélectionné → clic droit → « Traduire « … » en français »** : la traduction s'affiche dans une bulle
  avec un bouton « Copier ». Si le texte est déjà en français, il est traduit en anglais.
- La page est traduite par petits lots, **la partie visible à l'écran d'abord** ; le contenu ajouté ensuite par
  le site (défilement infini…) est traduit au fur et à mesure. Les liens et boutons gardent leur fonctionnement.
  Le code (`<code>`, `<pre>`), les champs de saisie et les zones marquées `translate="no"` ne sont pas traduits.
- **Réglages > Traduction** : langue de destination, langues traduites automatiquement, télécharger ou supprimer
  le modèle de chaque langue. Un modèle manquant est aussi téléchargé automatiquement à la première traduction.

Langues : allemand, anglais, bulgare, espagnol, estonien, français, italien, néerlandais, polonais, portugais,
russe, tchèque, ukrainien, ainsi que islandais, norvégien et persan (expérimental). Les modèles traduisent vers ou
depuis l'anglais : de l'espagnol vers le français, la traduction passe par l'anglais (deux modèles).
La qualité est un peu en dessous de DeepL ou Google ; la traduction tourne dans un processus séparé (arrêté après
5 minutes d'inactivité pour libérer la mémoire).

### Pilotage par une IA (serveur MCP)

Explora contient un serveur [MCP](https://modelcontextprotocol.io/) pour qu'une IA comme Claude (Claude Code,
Claude Desktop…) puisse piloter le navigateur. **Désactivé par défaut** : Paramètres > « Pilotage par une IA
(MCP) ». Une fois activé, la page affiche la commande à copier pour Claude Code et le bloc de configuration pour
Claude Desktop (via `mcp-remote`, qui nécessite Node.js).

Outils proposés à l'IA : `list_tabs`, `open_tab`, `navigate` (adresse, recherche, back / forward / reload),
`search` (avec un moteur ou une IA de la liste, ex. `duckduckgo`, `perplexity`), `list_engines`, `read_page`
(texte visible et liens), `screenshot`, `click` (sélecteur CSS ou texte du bouton), `type_text` (avec envoi
du formulaire en option), `activate_tab`, `close_tab`.

Sécurité : le serveur n'écoute que sur `127.0.0.1` (port 47823), exige le jeton affiché dans les réglages
(`Authorization: Bearer …`, modifiable avec « Changer le jeton »), refuse les requêtes dont l'en-tête `Host`
n'est pas local, et n'a **jamais accès aux fenêtres privées**. L'IA agit avec tes connexions aux sites :
n'active le serveur que pour une IA en qui tu as confiance.

### Extensions Chrome

Le bouton pièce de puzzle (à droite de la barre d'adresse) ouvre `explora://extensions/` : liste des
extensions installées, options, suppression, recherche de mises à jour, et un lien vers le Chrome Web Store.

- Sur le **Chrome Web Store**, le bouton « Ajouter à Chrome » (affiché « Ajouter à Explora » ou similaire)
  installe l'extension après une confirmation qui résume ses autorisations. Le Store affiche aussi un bandeau
  « Passez à Chrome » : il peut être ignoré. Seules les extensions **Manifest V3** sont acceptées.
- Les boutons des extensions apparaissent à droite de la barre d'adresse (clic = popup de l'extension).
- Les éléments ajoutés au **clic droit** par les extensions apparaissent dans le menu contextuel des pages
  (qui propose aussi : ouvrir le lien dans un nouvel onglet, copier, coller, inspecter…).
- Mises à jour automatiques au lancement puis toutes les 5 heures. Fichiers dans `%APPDATA%\Explora\Extensions`.
- **Aucune extension en navigation privée.**

Tout repose sur [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell) et
electron-chrome-web-store. Electron n'est pas Chrome : beaucoup d'API d'extensions manquent. Constaté lors des tests :

| Extension | Résultat |
| --- | --- |
| Dark Reader | fonctionne (bouton, popup, pages assombries) |
| uBlock Origin Lite | s'installe mais **ne bloque rien** : `declarativeNetRequest` n'existe pas dans Electron, et son service worker plante (`chrome.commands` absent). Utiliser le bloqueur intégré à la place. |

Ne fonctionnent pas non plus : les autres bloqueurs de pub Manifest V3 (même API), `chrome.identity` (connexion
Google), `chrome.history`, `chrome.bookmarks`, `chrome.downloads`, les captures d'onglet et le remplacement de la
page Nouvel onglet. Le reste (clic droit, onglets, cookies, notifications, raccourcis) marche plus ou moins selon
l'extension : à essayer au cas par cas.

### Navigation privée

`Ctrl+Shift+N` (ou « Nouvelle fenêtre privée » dans le menu ☰) ouvre une
**fenêtre privée**, reconnaissable à sa teinte violette, au badge « Navigation privée » dans la barre
d'onglets et au titre de la fenêtre.

- Chaque fenêtre privée a sa propre session **en mémoire uniquement** (pas de préfixe `persist:`) :
  cookies, connexions, cache et stockage des sites ne sont jamais écrits sur le disque, ne sont pas
  partagés avec la fenêtre normale ni avec les autres fenêtres privées, et sont vidés dès la
  fermeture de la fenêtre.
- Ses onglets ne sont **pas enregistrés** ni rouverts au lancement suivant (seule la fenêtre normale
  l'est). Les nouveaux onglets privés ouvrent toujours la page d'accueil Explora.
- Les réglages (moteur actif, liste des moteurs, thème…) restent communs : les modifier depuis une
  fenêtre privée les enregistre comme d'habitude.
- `Ctrl+N` ramène la fenêtre normale (ou la rouvre si elle a été fermée).

### Barre latérale (messageries et sites intégrés)

Une barre verticale à gauche de la fenêtre normale affiche une icône par intégration
(WhatsApp et Discord par défaut) :

- **Clic** : ouvre la messagerie dans un panneau à côté de la barre (les onglets se décalent) ;
  nouveau clic, ou `Ctrl+W` dans la messagerie, pour le refermer.
- **Badge rouge** : nombre de messages non lus (un simple point pour Discord quand il y a des
  messages sans mention). Le total s'affiche aussi en pastille sur l'icône de la barre des tâches,
  qui clignote quand un message arrive alors que la fenêtre est en arrière-plan.
- **Notifications Windows** : un clic sur la notification ramène la fenêtre et ouvre la messagerie.
- **Clic droit** : recharger, largeur du panneau (étroit, moyen, large, toute la fenêtre),
  désactiver / réactiver, se déconnecter, masquer la barre.
- `Ctrl+Shift+M` masque / réaffiche la barre.

**Paramètres > Barre latérale** (ou clic droit > « Gérer la barre latérale… ») :

- ajouter une intégration prête à l'emploi : WhatsApp, Discord, Messenger, Telegram, Slack,
  Instagram, Microsoft Teams, Gmail, Outlook, Google Agenda, X, Snapchat, LinkedIn, Spotify, Deezer,
  YouTube Music, ChatGPT, Claude ;
- ajouter un **site personnalisé** : nom, adresse et, si on veut, l'adresse d'une image pour
  l'icône (sinon l'icône du site est récupérée automatiquement) ;
- réordonner (▲ ▼), renommer, changer l'adresse, la largeur du panneau, activer / désactiver,
  afficher ou non le badge de non-lus, retirer (efface aussi les données de connexion).

La liste est enregistrée dans `%APPDATA%\Explora\messengers.json` (icônes comprises).

Les intégrations activées restent chargées en arrière-plan (panneau fermé) pour recevoir messages et
notifications ; une intégration désactivée ne consomme plus rien. Chacune a sa propre session
persistante (`persist:messenger-<id>`) : on reste connecté entre
les lancements, et « Effacer les données de navigation » ne vous déconnecte pas. Les liens cliqués
dans une intégration s'ouvrent dans un onglet normal. La barre n'existe pas dans les fenêtres privées.

Première connexion : WhatsApp demande de scanner un QR code avec le téléphone (WhatsApp >
Appareils connectés), Discord se connecte par e-mail / mot de passe ou QR code.

### Courrier (client mail intégré)

Un vrai client mail façon Thunderbird, dans un onglet : menu ☰ > **Courrier** ou `Ctrl+Shift+E`
(page `customnav://mail/`).

- **Plusieurs comptes IMAP / SMTP** : on saisit l'adresse et le mot de passe, les serveurs sont trouvés
  tout seuls (fournisseurs courants : Gmail, Yahoo, iCloud, Free, Orange, SFR, La Poste, GMX, Fastmail,
  Proton Bridge ; sinon la base de Thunderbird, sinon `imap.<domaine>` / `smtp.<domaine>`), modifiables
  dans « Serveurs ». La connexion est testée (réception et envoi) avant d'enregistrer.
- **Gmail, Yahoo, iCloud** : il faut un *mot de passe d'application* (ex. Gmail :
  myaccount.google.com/apppasswords, validation en deux étapes activée). **Outlook / Hotmail** n'accepte
  plus que la connexion OAuth, pas encore prise en charge : utiliser l'intégration Outlook de la barre
  latérale en attendant.
- Dossiers (réception, envoyés, brouillons, corbeille… et sous-dossiers) avec le nombre de non-lus,
  liste des messages (50 par page, « Charger plus »), lecture, pièces jointes (Ouvrir / Enregistrer).
- **Rédaction** en texte brut : nouveau message, répondre, répondre à tous, transférer (avec les pièces
  jointes d'origine), Cc / Cci, pièces jointes, signature par compte. Le message envoyé est rangé dans
  « Envoyés » (Gmail et Outlook le font eux-mêmes).
- Actions : étoile, marquer non lu, déplacer vers un dossier, supprimer (corbeille).
- **Recherche** dans le dossier courant (objet, expéditeur, destinataire, texte), faite par le serveur.
- **Nouveaux messages** : vérifiés en direct (IDLE) et toutes les 2 minutes, même page fermée ;
  notification Windows (désactivable par compte), clic = ouvre le message. Le nombre de non-lus
  s'affiche dans le titre de l'onglet et dans le menu ☰.
- Raccourcis dans la page : `N` nouveau, `R` répondre, `A` répondre à tous, `F` transférer,
  `Suppr` supprimer, `S` étoile, `U` non lu, `↑` / `↓` (ou `K` / `J`) message précédent / suivant,
  `/` rechercher, `Ctrl+Entrée` envoyer, `Échap` fermer.

Sécurité et vie privée :

- les mots de passe sont chiffrés par Windows (`safeStorage`, DPAPI) dans
  `%APPDATA%\custom-nav\mail-accounts.json` et ne sont jamais renvoyés à la page ;
- les messages HTML s'affichent dans un cadre isolé **sans aucun script** ni formulaire ; les
  **images distantes sont bloquées** (pixels espions) jusqu'au clic sur « Afficher les images » ;
  les liens s'ouvrent dans un nouvel onglet ;
- la page ne manipule que des identifiants (compte, dossier, n° de message, jeton de pièce jointe),
  jamais de chemin de fichier ; seuls les types de fichiers sans risque s'ouvrent directement ;
- pas de courrier dans les fenêtres privées.

### Sélecteur moteurs de recherche / IA

À gauche de la barre d'adresse, une pastille par moteur ou IA (le moteur actif affiche son nom) :

- **Moteurs** : Google, DuckDuckGo, Bing, YouTube, Wikipédia (fr)
- **IA** : Claude, ChatGPT, Perplexity, Le Chat (Mistral), Gemini

Utilisation :

- **Clic** sur une pastille (ou `Ctrl+1` … `Ctrl+9`) : choisit le moteur actif, retenu au prochain lancement. Si une question est en cours de saisie dans la barre d'adresse, elle est aussitôt posée au moteur choisi.
- **Entrée** dans la barre d'adresse : recherche avec le moteur actif (sauf si c'est une URL).
- **Renvoyer vers** — **Shift+clic** sur une pastille (ou `Ctrl+Shift+1` … `Ctrl+Shift+9`) : ouvre un **nouvel onglet** avec la même question posée à ce moteur. La question utilisée est le texte en cours de saisie s'il y en a un, sinon la dernière question de l'onglet courant (mémorisée par onglet ; une recherche faite directement dans la page Google, Bing… est aussi reconnue).

Comment la question arrive dans chaque IA :

| IA | Méthode | Comportement constaté |
| --- | --- | --- |
| Claude | URL `claude.ai/new?q=` | connexion requise ; la question est conservée à travers la page de connexion (pré-remplissage une fois connecté non vérifié lors des tests, faits sans compte) |
| ChatGPT | URL `chatgpt.com/?q=` | la question est **envoyée automatiquement**, même sans compte |
| Perplexity | URL `perplexity.ai/search?q=` | lance la recherche (une vérification anti-robot Cloudflare peut s'afficher la première fois) |
| Le Chat | URL `chat.mistral.ai/chat?q=` | connexion requise |
| Gemini | **injection** | Gemini ignore la question dans l'URL : l'app ouvre `gemini.google.com/app` puis écrit la question dans le champ de saisie une fois la page chargée. Elle **n'est pas envoyée** automatiquement (appuie sur Entrée) : cliquer à la place de l'utilisateur serait fragile dès que Gemini change son interface. |

Le user-agent envoyé aux sites est celui d'un Chrome standard (sans « Electron »), sinon Google refuse parfois la connexion.

### Réglages

Ouverts dans un onglet (`explora://settings/`), enregistrés dans `settings.json` du dossier
utilisateur de l'app (`%APPDATA%\Explora\settings.json`).

- **Moteurs de recherche et IA** : ajouter (nom, URL avec `{q}` ou `%s` à la place de la question,
  catégorie moteur / IA, option « Injection dans la page » avec un sélecteur CSS facultatif),
  modifier, supprimer, réordonner avec ▲ ▼ (l'ordre définit `Ctrl+1` … `Ctrl+9`), choisir le moteur
  par défaut, puis **Enregistrer**. « Réinitialiser la liste » (à confirmer d'un 2e clic) remet la
  liste d'origine. Seules les URL `http://` et `https://` sont acceptées.
- **Page d'accueil** : la page Explora, ou une adresse de ton choix. Les **favoris** affichés sur la
  page d'accueil sont éditables.
- **Apparence** : suivre Windows, clair ou sombre. Le choix s'applique à l'interface, aux pages internes
  et est transmis aux sites (`prefers-color-scheme`).
- **Session et données** : « Rouvrir les onglets du dernier lancement » (activé par défaut), et
  « Effacer les données de navigation » (cookies, cache, stockage des sites ; confirmation dans la page).

### Raccourcis

| Raccourci | Action |
| --- | --- |
| `Ctrl+T` | Nouvel onglet |
| `Ctrl+Shift+N` | Nouvelle fenêtre privée |
| `Ctrl+Shift+S` | Ouvrir / fermer l'écran partagé |
| `F12` / `Ctrl+Shift+I` | Outils de développement |
| `Ctrl+D` | Ajouter / retirer la page des favoris |
| `Ctrl+Shift+B` | Afficher / masquer la barre de favoris |
| `Ctrl+Shift+O` | Gestionnaire de favoris |
| `Ctrl+N` | Revenir à la fenêtre normale (la rouvre si elle est fermée) |
| `Ctrl+W` | Fermer l'onglet (dans une messagerie : refermer son panneau) |
| `Ctrl+Shift+M` | Masquer / afficher la barre latérale |
| `Ctrl+L` | Aller à la barre d'adresse |
| `Ctrl+,` | Réglages |
| `Ctrl+H` | Historique |
| `Ctrl+Shift+E` | Courrier |
| `F5` / `Ctrl+R` | Recharger |
| `Alt+←` / `Alt+→` | Précédent / suivant |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Onglet suivant / précédent |
| `Ctrl+1` … `Ctrl+9` | Choisir le moteur / l'IA (ordre des pastilles, modifiable dans les réglages ; au-delà du 9e, pas de raccourci) |
| `Ctrl+Shift+1` … `Ctrl+Shift+9` | Renvoyer la question vers ce moteur / cette IA (nouvel onglet) |
| `Shift+clic` sur une pastille | Renvoyer la question vers ce moteur / cette IA |

## Structure

```
src/
  main/
    main.js      fenêtres (normale et privées), raccourcis, IPC
    tabs.js      gestion des onglets (un WebContentsView par onglet)
    search.js    liste des moteurs / IA, validation, transformation saisie → URL
    config.js    réglages (valeurs par défaut, validation, session)
    bookmarks.js favoris (arbre liens / dossiers, import Chrome / Edge / Brave)
    extensions.js extensions Chrome et Chrome Web Store (session normale uniquement)
    adblock.js   bloqueur de pub intégré (moteur Ghostery, toutes les sessions)
    mcp.js       serveur MCP local (pilotage par une IA, fenêtre normale uniquement)
    settings.js  lecture / écriture de settings.json
    internal.js  protocole explora:// des pages internes
    messengers.js  barre latérale : catalogue, liste personnalisable, panneaux
    translation/   traduction locale (Bergamot) : index.js (pages, sélection, menu), models.js
                   (téléchargement des modèles), engine.js + worker.js (processus de traduction),
                   languages.js (détection de la langue), content/ (scripts injectés dans les pages)
    mail.js      client mail : comptes, IMAP (imapflow), SMTP (nodemailer), notifications
    mail-providers.js  réglages IMAP / SMTP devinés à partir de l'adresse
  preload/
    ui-preload.js        API de l'interface (barre d'onglets / d'outils)
    internal-preload.js  API des pages internes (n'existe que sur explora://)
    messengers-rail-preload.js  API de la barre des messageries
    messenger-preload.js  retour au panneau au clic sur une notification
  renderer/
    index.html, styles.css, renderer.js   interface (onglets, barre d'outils)
    messengers.html, .css, .js            barre des messageries
  internal/
    home.*, settings.*, bookmarks.*, extensions.*, mail.*, common.css   pages internes
    img/                                  logos de la page d'accueil
assets/brand/ logos sources (SVG et PNG transparents)
build/        icône de l'app (icon.ico, icon.png)
scripts/      make-icon.js (génération de l'icône)
```

Sécurité :

- les pages web tournent sans accès à Node (`nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`) ; seule l'interface (fichier local `index.html`, qui ne peut pas naviguer ailleurs) a un
  preload non sandboxé, pour charger les boutons d'extensions ;
- l'API des réglages (`window.customNav`) n'est exposée qu'aux pages `explora://`, et le processus
  principal vérifie à chaque message que l'expéditeur est bien une page interne (cadre principal) ;
- un site web ne peut pas ouvrir une page `explora://` (navigation, redirection, cadre ou
  `window.open` sont bloqués).

## Feuille de route

1. ~~Squelette du navigateur~~
2. ~~Sélecteur moteurs de recherche / IA~~ — pour ajouter un moteur, une entrée dans `ENGINES` (`src/main/search.js`)
3. ~~Personnalisation : liste éditable, page d'accueil, thème clair/sombre, sessions~~
4. ~~Installeur `.exe`~~
