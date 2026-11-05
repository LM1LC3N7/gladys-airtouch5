# AirTouch 5

Intégration Gladys non officielle pour les consoles **AirTouch 5** de
Polyaire, qui pilotent une climatisation gainable (une ou plusieurs
climatisations et leurs zones, chacune derrière un volet motorisé). Courante
en Australie et en Nouvelle-Zélande. L'intégration parle au protocole local de
la console (« AirTouch 5 Communication Protocol » publié par Polyaire), sur
votre réseau (port TCP 9005), sans cloud.

Jamais testé avec un vrai appareil : l'intégration suit le protocole tel que la
bibliothèque airtouch5py (utilisée par Home Assistant) le lit et l'écrit, et les
trames d'exemple du document de Polyaire. Sans lien avec Polyaire.

## Ce que vous obtenez

Un appareil Gladys par **climatisation**, avec :

- **Marche/arrêt** ;
- **Mode** et **Ventilation** : seulement les valeurs que la console annonce
  pour cette climatisation (automatique, froid, chauffage, déshumidification,
  ventilation seule ; automatique, silencieuse, faible, moyenne, forte, turbo).
  La vitesse « puissante » n'a pas d'équivalent dans Gladys : elle n'est ni
  proposée ni affichée ;
- **Consigne** : bornée aux limites lues sur la console (l'intersection de ses
  limites en froid et en chauffage, au degré près) ;
- **Température** lue par la climatisation.

Un appareil Gladys par **zone**, avec :

- **Marche/arrêt** de la zone ;
- **Ouverture du volet** (0 à 100 %) ;
- pour une zone munie d'un capteur : **Consigne** (bornée aux limites de sa
  climatisation) et **Température**.

Les noms des climatisations et des zones sont ceux de la console. Les
températures sont en °C.

## Configuration

1. Donnez une adresse IP fixe à la console dans votre routeur.
2. Dans Gladys, ouvrez l'intégration **AirTouch 5**, saisissez l'adresse IP de
   la console (ajoutez `:port` seulement si ce n'est pas 9005) et enregistrez.
3. Les climatisations et les zones apparaissent dans l'onglet **Découverte** :
   ajoutez-les.
4. Pour les allumer et les régler depuis Gladys, activez **Autoriser les
   commandes**. Sans cette option, seuls les arrêts partent.

**Intervalle de rafraîchissement** : 60 s par défaut (30 à 600 s). La console
envoie aussi ses changements d'elle-même : ils s'affichent dès qu'ils arrivent.
Une seule connexion est ouverte vers la console à la fois.

## Identité de la console

À chaque connexion, l'intégration demande son identifiant à la console en UDP
(port 49005, à l'adresse saisie seulement ; la demande part du port 49005, où
le document de Polyaire dit que la console répond ; si ce port est pris, le
statut le dit). Les appareils sont nommés d'après
cet identifiant, choisi la première fois et gardé dans `/data`. Si la console ne
répond pas à cette demande la première fois, les appareils suivent l'adresse
saisie (identifiant de repli `a-<adresse>`), pour toujours. Le choix n'est fait
qu'une fois écrit dans `/data` : tant qu'il ne peut pas l'être, rien n'est
affiché et seuls les arrêts partent.

Une fois l'identifiant connu, il est vérifié à chaque connexion : tant que la
console ne le donne pas, ou si une autre console répond à cette adresse, ses
états ne sont pas affichés et seuls les arrêts sont envoyés. Le statut de
l'intégration le dit.

Une console remplacée par une autre (un nouvel identifiant à la même adresse)
reste « une autre console » : pour l'adopter, effacez les données de
l'intégration (désinstallez-la puis réinstallez-la) et ajoutez ses appareils
depuis l'onglet Découverte.

## Sécurité

Le protocole de la console n'a pas de mot de passe : toute machine de votre
réseau peut la piloter. Gardez-la sur un réseau de confiance, jamais exposée à
Internet.

### Les arrêts

Éteindre une climatisation ou une zone est un **arrêt**. Un arrêt :

- part même si les commandes ne sont pas autorisées, avant la première
  lecture, pendant une lecture ou une autre commande, juste après un
  redémarrage, et même avant que Gladys ait donné la configuration (l'adresse
  est gardée dans `/data`) ;
- part même si la climatisation ou la zone est déjà éteinte ;
- passe devant les lectures et les commandes ; une lecture qui ne reçoit plus
  rien depuis une seconde est coupée pour le laisser passer ;
- annule les commandes de la même climatisation ou zone qui n'étaient pas
  encore parties ;
- est gardé dans `/data` jusqu'à ce qu'une lecture le montre appliqué ; s'il
  n'a pas pu partir (console injoignable), il est réessayé pendant 250 ms,
  puis à chaque connexion (toutes les 10 s, 30 s, puis chaque minute), en
  premier ;
- n'est confirmé que par un état lu après son envoi qui montre l'appareil
  éteint (l'état que la console renvoie peut le confirmer) ; sinon Gladys
  affiche « Arrêt envoyé, sans confirmation » et chaque lecture écrite après
  lui qui montre l'appareil en marche (5 s et 20 s plus tard, puis les
  lectures périodiques) le renvoie, 3 fois au plus ;
- une fois confirmé, il est levé si l'appareil est relu en marche deux fois de
  suite (rallumé depuis la console ou l'application) ; confirmé ou non, il est
  levé par une mise en marche depuis Gladys (toujours écrite alors, même si
  l'appareil se lit déjà en marche) ; jamais par le temps. Tant qu'un arrêt
  de zone n'est pas vu appliqué, son volet et sa consigne sont refusés.

Un arrêt n'est refusé que dans deux cas : la valeur ou l'appareil ne sont pas
reconnus, ou l'appareil appartient à une autre console que celle dont
l'identifiant est gardé pour cette adresse.

### Les autres commandes

- désactivées par défaut (option **Autoriser les commandes**), revérifiée
  juste avant l'envoi ;
- refusées tant que l'identité de la console n'est pas vérifiée, pendant un
  arrêt de la même climatisation ou zone, ou si `/data` ne peut pas être écrit
  (un arrêt ne pourrait pas y être gardé) ;
- décidées sur l'état relu juste avant (jamais sur un état gardé) ; une
  consigne hors des limites lues sur la console, un mode ou une vitesse que la
  console n'annonce pas sont refusés, jamais ramenés dans les bornes ;
- envoyées dans les 3 s du clic, sinon refusées sans rien envoyer ; les
  commandes qui arrivent ensemble (une scène) partagent une lecture et une
  écriture de leur sorte (climatisations ou zones) : une console lente les
  reçoit toutes ;
- confirmées seulement si la console montre la valeur demandée (un état égal à
  celui d'avant n'est pas une confirmation), d'ici 3,5 s ; sinon « Envoyée, sans
  confirmation » et la console est relue 5 s et 20 s plus tard ;
- une à la fois par climatisation ou zone, dans l'ordre des clics.

## Diagnostic

Le statut de la page de configuration indique l'état de la connexion, de
l'identité et des arrêts en attente. Le bouton **Tester la connexion** lit la
console si sa lecture est due (jamais plus tôt que l'intervalle) et affiche le
résultat.

Une lecture qui échoue est refaite après 30 s, 1, 2 puis 5 min, jamais plus tôt
que l'intervalle.
