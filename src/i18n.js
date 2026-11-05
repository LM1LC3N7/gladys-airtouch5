// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status of
// the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

export const both = (en, fr) => ({ en, fr });
export const join = (...texts) =>
  both(texts.map((t) => t.en).join(' '), texts.map((t) => t.fr).join(' '));

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const AC_NAME = (n) => both(`Air conditioner ${n + 1}`, `Climatisation ${n + 1}`);
export const ZONE_NAME = (n) => both(`Zone ${n + 1}`, `Zone ${n + 1}`);

export const FEATURE_NAMES = {
  [FEATURES.POWER]: both('On/off', 'Marche/arrêt'),
  [FEATURES.MODE]: both('Mode', 'Mode'),
  [FEATURES.FAN]: both('Fan speed', 'Ventilation'),
  [FEATURES.SETPOINT]: both('Setpoint', 'Consigne'),
  [FEATURES.TEMPERATURE]: both('Temperature', 'Température'),
  [FEATURES.OPENING]: both('Damper opening', 'Ouverture du volet'),
};

export const MODE_NAMES = {
  auto: both('Automatic', 'Automatique'),
  cool: both('Cooling', 'Froid'),
  heat: both('Heating', 'Chauffage'),
  dry: both('Drying', 'Déshumidification'),
  fan: both('Fan only', 'Ventilation seule'),
};

export const FAN_NAMES = {
  auto: both('Automatic', 'Automatique'),
  quiet: both('Quiet', 'Silencieuse'),
  low: both('Low', 'Faible'),
  medium: both('Medium', 'Moyenne'),
  high: both('High', 'Forte'),
  turbo: both('Turbo', 'Turbo'),
};

/** A target in the texts: "AC 1", "zone 3" (numbered from 1, as on the console). */
export const targetName = ({ kind, number }) =>
  kind === 'ac'
    ? both(`AC ${number + 1}`, `climatisation ${number + 1}`)
    : both(`zone ${number + 1}`, `zone ${number + 1}`);

const list = (items) => both(items.map((t) => t.en).join(', '), items.map((t) => t.fr).join(', '));

/** The status of the configuration screen. */
export const T = {
  noAddress: both(
    'Enter the IP address of the AirTouch 5 console, then save.',
    "Saisissez l'adresse IP de la console AirTouch 5, puis enregistrez.",
  ),
  invalid: both(
    'The address entered is not valid (an IPv4 address or a host name, optional port).',
    "L'adresse saisie n'est pas valide (une adresse IPv4 ou un nom d'hôte, port facultatif).",
  ),
  configUnread: (wait) =>
    both(
      `The configuration of Gladys could not be read; next try in ${wait.en}.`,
      `La configuration de Gladys n'a pas pu être lue ; nouvel essai dans ${wait.fr}.`,
    ),
  connecting: both('Connecting to the console…', 'Connexion à la console…'),
  connected: (acs, zones) =>
    both(
      `Connected to the console: ${acs} AC(s), ${zones} zone(s).`,
      `Connecté à la console : ${acs} climatisation(s), ${zones} zone(s).`,
    ),
  unreachable: (reason, wait) =>
    both(
      `Console unreachable (${reason}); next try in ${wait.en}.`,
      `Console injoignable (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  identityPending: both(
    'Checking the identity of the console…',
    "Vérification de l'identité de la console…",
  ),
  unverified: both(
    'The console did not give its identity (UDP, port 49005): its states are not shown and only stops are sent, until it answers.',
    "La console n'a pas donné son identité (UDP, port 49005) : ses états ne sont pas affichés et seuls les arrêts sont envoyés, jusqu'à ce qu'elle réponde.",
  ),
  otherConsole: both(
    'Another AirTouch 5 console answers at this address: its states are not shown and only stops are sent. Check the address.',
    "Une autre console AirTouch 5 répond à cette adresse : ses états ne sont pas affichés et seuls les arrêts sont envoyés. Vérifiez l'adresse.",
  ),
  identityUnsaved: both(
    'The id of the devices cannot be kept in /data: nothing is shown and only stops are sent, until it can be.',
    "L'identifiant des appareils ne peut pas être gardé dans /data : rien n'est affiché et seuls les arrêts partent, tant qu'il ne peut pas l'être.",
  ),
  dataUnreadable: both(
    'The /data file cannot be read: the identity of the devices is not chosen and nothing is written there until it can be.',
    "Le fichier de /data est illisible : l'identité des appareils n'est pas choisie et rien n'y est écrit tant qu'il l'est.",
  ),
  dataUnwritable: both(
    'The /data file cannot be written: commands other than stops are refused.',
    'Le fichier de /data ne peut pas être écrit : les commandes autres que les arrêts sont refusées.',
  ),
  stopsWaiting: (targets) =>
    both(
      `Stop kept, not sent yet (console unreachable): ${list(targets).en}.`,
      `Arrêt gardé, pas encore envoyé (console injoignable) : ${list(targets).fr}.`,
    ),
  stopsUnconfirmed: (targets) =>
    both(
      `Stop sent, not seen applied yet: ${list(targets).en}.`,
      `Arrêt envoyé, pas encore vu appliqué : ${list(targets).fr}.`,
    ),
  stopsContradicted: (targets) =>
    both(
      `Stop sent again 3 times, the console still shows it on (a click on the device lifts it): ${list(targets).en}.`,
      `Arrêt renvoyé 3 fois, la console le montre toujours en marche (un clic sur l'appareil le lève) : ${list(targets).fr}.`,
    ),
  test: {
    cooldown: both('Tested a few seconds ago.', 'Testé il y a quelques secondes.'),
    waiting: (wait) =>
      both(
        `Next read in ${wait.en} (never sooner than the interval).`,
        `Prochaine lecture dans ${wait.fr} (jamais plus tôt que l'intervalle).`,
      ),
  },
};

/** The errors of the commands (shown by Gladys when a command fails). */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both(
    'Value not accepted by this feature.',
    'Valeur non acceptée par cette fonctionnalité.',
  ),
  disabled: both(
    'Commands are disabled: allow them in the configuration of the integration (stops need no option).',
    "Les commandes sont désactivées : autorisez-les dans la configuration de l'intégration (les arrêts ne dépendent d'aucune option).",
  ),
  configUnread: both(
    'The configuration is not read yet: only stops are sent. Try again in a few seconds.',
    "La configuration n'est pas encore lue : seuls les arrêts partent. Réessayez dans quelques secondes.",
  ),
  unknownDevice: both(
    'This device is not one of the console configured.',
    "Cet appareil n'est pas un de ceux de la console configurée.",
  ),
  notConnected: both(
    'The console is not connected: nothing was sent.',
    "La console n'est pas connectée : rien n'a été envoyé.",
  ),
  identity: both(
    'The identity of the console is not confirmed: nothing was sent (only stops are).',
    "L'identité de la console n'est pas confirmée : rien n'a été envoyé (seuls les arrêts partent).",
  ),
  otherConsole: both(
    'Another console answers at this address: nothing was sent (only stops are).',
    "Une autre console répond à cette adresse : rien n'a été envoyé (seuls les arrêts partent).",
  ),
  dataUnwritable: both(
    'The /data file cannot be written: nothing was sent (only stops are).',
    "Le fichier de /data ne peut pas être écrit : rien n'a été envoyé (seuls les arrêts partent).",
  ),
  stopping: both(
    'A stop of this device is in progress: nothing was sent.',
    "Un arrêt de cet appareil est en cours : rien n'a été envoyé.",
  ),
  queueFull: both(
    'Too many commands waiting: nothing was sent.',
    "Trop de commandes en attente : rien n'a été envoyé.",
  ),
  cancelled: both(
    'Cancelled by a stop of the same device: nothing was sent.',
    "Annulée par un arrêt du même appareil : rien n'a été envoyé.",
  ),
  tooSlow: both(
    'The console did not answer in time: nothing was sent.',
    "La console n'a pas répondu à temps : rien n'a été envoyé.",
  ),
  unknownState: both(
    'The current state could not be read: nothing was sent.',
    "L'état actuel n'a pas pu être lu : rien n'a été envoyé.",
  ),
  notListed: both(
    'The console does not list this device any more: nothing was sent.',
    "La console ne liste plus cet appareil : rien n'a été envoyé.",
  ),
  limitsUnknown: both(
    'The setpoint limits of the AC are not read: nothing was sent.',
    "Les limites de consigne de la climatisation ne sont pas lues : rien n'a été envoyé.",
  ),
  outOfRange: (min, max) =>
    both(
      `Setpoint out of the limits of the AC (${min} to ${max} °C): nothing was sent.`,
      `Consigne hors des limites de la climatisation (${min} à ${max} °C) : rien n'a été envoyé.`,
    ),
  notSupported: both(
    'The AC does not offer this value: nothing was sent.',
    "La climatisation ne propose pas cette valeur : rien n'a été envoyé.",
  ),
  noSensor: both(
    'This zone has no sensor: its setpoint cannot be set.',
    "Cette zone n'a pas de capteur : sa consigne ne peut pas être réglée.",
  ),
  previousPending: both(
    'A previous command on this device is not seen applied yet: nothing was sent.',
    "Une commande précédente sur cet appareil n'est pas encore vue appliquée : rien n'a été envoyé.",
  ),
  sentUnconfirmed: both(
    'Sent, without confirmation: the console does not show it yet (read again in 5 s).',
    'Envoyée, sans confirmation : la console ne la montre pas encore (relue dans 5 s).',
  ),
  stopUnconfirmed: both(
    'Stop sent, without confirmation: the console does not show it yet. It is kept and sent again if a read shows the device on (3 times at most).',
    "Arrêt envoyé, sans confirmation : la console ne le montre pas encore. Il est gardé et renvoyé si une lecture montre l'appareil en marche (3 fois au plus).",
  ),
  stopKept: both(
    'Stop not sent (console unreachable): it is kept and leaves first as soon as the console answers.',
    'Arrêt non envoyé (console injoignable) : il est gardé et part en premier dès que la console répond.',
  ),
};
